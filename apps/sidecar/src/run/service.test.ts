import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTerminalRunState, isRunState, type RunState } from '@openlinear/execution-core';
import { DurableRunJournal } from '../journal/durable';
import { HttpError } from '../lib/errors';
import { SandboxUnavailableError } from '../sandbox/errors';
import type { FaultHook } from './faults';
import { RunService, type RunServiceOptions } from './service';
import {
  FakeControlPlane,
  FakePublication,
  FakeRuntime,
  FakeRuntimeHost,
  FakeWorkspace,
  fakeCredential,
  type HostStep,
} from './test-support';

/**
 * W05a/W06a acceptance at the service level (FakeRunner-style runtime that
 * lives outside the service, in-memory control plane with W03a semantics):
 * start → events → done; exhaustive reducer actions; fault injection at
 * every await point; cancel in queued/preparing/running/finishing; and
 * crash/restart recovery at the required kill points.
 */

const roots: string[] = [];
const services: RunService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TEST_OPTIONS: Partial<RunServiceOptions> = {
  heartbeatMs: 3_600_000,
  retryBaseMs: 5,
  retryMaxMs: 20,
  relayDelayMs: 0,
  relayRetryBaseMs: 5,
  relayRetryMaxMs: 20,
  interruptGraceMs: 0,
  startWaitMs: 10_000,
  watchdogIntervalMs: 20,
  watchdog: { transportMs: 1e9, noProgressMs: 1e9, wallClockMs: 1e9 },
};

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class CrashSignal extends Error {}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'ol-run-engine-'));
  roots.push(root);
  const journalPath = join(root, 'journal', 'runs-v2.sqlite');
  const cp = new FakeControlPlane();
  const host = new FakeRuntimeHost();
  const publication = new FakePublication();
  const workspace = new FakeWorkspace(join(root, 'worktrees'));
  const published: Array<{ taskId: string; event: string; payload: Record<string, unknown> }> = [];

  function boot(faults?: FaultHook | null, options: Partial<RunServiceOptions> = {}) {
    const journal = new DurableRunJournal(journalPath);
    const service = new RunService({
      journal,
      controlPlane: cp,
      runtimes: new Map([['opencode', new FakeRuntime(host)]]),
      publication,
      workspace,
      events: { publish: (taskId, _owner, event, payload) => published.push({ taskId, event, payload }) },
      faults: faults ?? null,
      options: { ...TEST_OPTIONS, ...options },
    });
    services.push(service);
    return { service, journal };
  }

  /** SIGKILL simulation: no cleanup, no further writes from this instance. */
  function crash(instance: { service: RunService; journal: DurableRunJournal }): void {
    instance.service.stop();
    instance.journal.close();
  }

  /** A fault hook that "kills" `instance` at phase:point (set after boot). */
  function crashAt(target: string, holder: { instance?: { service: RunService; journal: DurableRunJournal } }): FaultHook {
    let fired = false;
    return (phase, point) => {
      if (fired || `${phase}:${point}` !== target || !holder.instance) return;
      fired = true;
      crash(holder.instance);
      throw new CrashSignal(`crashed at ${target}`);
    };
  }

  return { root, journalPath, cp, host, publication, workspace, published, boot, crash, crashAt };
}

function terminalTransitions(journal: DurableRunJournal, runId: string): string[] {
  return journal.events(runId, 0, 100_000)
    .filter((event) => event.kind === 'run.state')
    .map((event) => String(event.payload.to))
    .filter((to) => isRunState(to) && isTerminalRunState(to));
}

function assertJournalIntegrity(journal: DurableRunJournal, runId: string): void {
  const events = journal.events(runId, 0, 100_000);
  const record = journal.get(runId);
  expect(record).not.toBeNull();
  expect(events.map((event) => event.seq)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
  expect(events.at(-1)?.seq).toBe(record?.lastSeq);
  expect(terminalTransitions(journal, runId)).toHaveLength(1);
}

function assertRelayContinuity(journal: DurableRunJournal, cp: FakeControlPlane, runId: string, attemptId: string): void {
  const relayable = journal.events(runId, 0, 100_000).filter((event) => event.relay && (event.kind === 'log' || event.kind === 'progress' || event.kind === 'run.state'));
  const delivered = cp.delivered.filter((event) => event.attemptId === attemptId).map((event) => event.seq);
  // No duplicates, strictly increasing, nothing lost.
  expect(delivered).toEqual([...new Set(delivered)].sort((a, b) => a - b));
  expect(delivered).toEqual(relayable.map((event) => event.seq));
  expect(journal.get(runId)?.relayAckSeq).toBe(relayable.at(-1)?.seq);
}

async function settled(journal: DurableRunJournal, cp: FakeControlPlane, runId: string, taskId: string): Promise<void> {
  await waitFor(() => {
    const record = journal.get(runId);
    const attempt = cp.attemptFor(taskId);
    return record && isTerminalRunState(record.state) && journal.effects(runId).every((effect) => effect.status !== 'pending')
      && (attempt?.status === 'closed' || attempt?.status === 'released' || record.state === 'abandoned');
  }, `run ${runId} settled`);
}

describe('RunService: single attempt start → events → done', () => {
  it('journals acceptance first, relays every event with its sequence and publishes once', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    expect(started).toMatchObject({ state: 'running', attemptId: 'attempt-1' });
    await settled(journal, h.cp, started.runId, 'task-1');

    const record = journal.get(started.runId);
    expect(record).toMatchObject({ state: 'succeeded', terminal: { state: 'succeeded', claimed: true } });
    expect(record?.terminal?.prUrl).toBe('https://github.com/acme/repo/pull/1');
    const states = journal.events(started.runId, 0, 1_000).filter((event) => event.kind === 'run.state').map((event) => event.payload.to);
    expect(states).toEqual(['running', 'finishing', 'succeeded']);
    expect(journal.events(started.runId, 0, 1)[0]?.kind).toBe('run.accepted');
    expect(journal.effects(started.runId).map((effect) => [effect.kind, effect.status])).toEqual([
      ['attempt.claim', 'confirmed'],
      ['prompt.submit', 'confirmed'],
      ['git.commit', 'confirmed'],
      ['git.push', 'confirmed'],
      ['pr.create', 'confirmed'],
      ['task.terminal', 'confirmed'],
      ['run.finalize', 'confirmed'],
      ['attempt.close', 'confirmed'],
    ]);
    assertJournalIntegrity(journal, started.runId);
    assertRelayContinuity(journal, h.cp, started.runId, 'attempt-1');

    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'done', sessionId: null, prUrl: 'https://github.com/acme/repo/pull/1' });
    expect(h.cp.attemptFor('task-1')).toMatchObject({ status: 'closed', terminalStatus: 'done', runStatus: 'succeeded' });
    expect(h.publication.commits).toHaveLength(1);
    expect(h.publication.pushCalls).toBe(1);
    expect(h.publication.prPosts).toBe(1);
    expect(h.host.promptCount([...h.host.sessions.keys()][0] ?? '')).toBe(1);
    expect(record?.usage?.messages.m1?.cost).toBe(0.01);
    expect(record?.counters).toMatchObject({ promptSent: true, filesChanged: 1, agentRunId: 'run-attempt-1' });
    expect(service.reservationCount()).toBe(0);
    expect(service.activeCount()).toBe(0);
    // Local SSE carries the journal sequence for de-duplication across restarts.
    expect(h.published.some((event) => event.event === 'execution:progress' && event.payload.runState === 'succeeded')).toBe(true);
    expect(service.logsFor('task-1').some((entry) => entry.message === 'Pull request created')).toBe(true);
    expect(service.describe('task-1')).toMatchObject({ state: 'succeeded', runId: started.runId });
  });

  it('refuses a second execute of the same task while the first holds it (local reservation)', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const { service } = h.boot();
    const first = service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await expect(service.submit({ credential: fakeCredential(), taskId: 'task-1' })).rejects.toMatchObject({ statusCode: 409, code: 'TASK_ALREADY_RUNNING' });
    await first;
  });

  it('handles every reducer action: permissions, compaction, usage, tools, deltas, heartbeats', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const script: HostStep[] = [
      { t: 'heartbeat' },
      { t: 'turn.started', turn: 1 },
      { t: 'reasoning.delta', text: 'thinking hard' },
      { t: 'message.delta', text: 'hello ' },
      { t: 'message.delta', text: 'world' },
      { t: 'tool.started', callId: 'c1', name: 'bash', input: { cmd: 'ls' } },
      { t: 'tool.output', callId: 'c1', chunk: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      { t: 'tool.finished', callId: 'c1', name: 'bash', ok: false, summary: 'failed once' },
      { t: 'permission.requested', id: 'p1', tool: 'edit', detail: 'edit file' },
      { t: 'compaction', phase: 'start', before: 100 },
      { t: 'compaction', phase: 'end', after: 10 },
      { writeFile: 'a.txt' },
      { t: 'file.changed', path: 'a.txt', kind: 'edit' },
      { t: 'usage', usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, reasoning: 1 }, cost: { usd: 0.5 }, messageId: 'm2' },
      { t: 'turn.finished', turn: 1, reason: 'idle' },
    ];
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, script);
      return original(id, directory);
    };
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    const record = journal.get(started.runId);
    expect(record?.state).toBe('succeeded');
    const states = journal.events(started.runId, 0, 1_000).filter((event) => event.kind === 'run.state').map((event) => event.payload.to);
    expect(states).toEqual(['running', 'awaiting_approval', 'running', 'compacting', 'running', 'finishing', 'succeeded']);
    const logs = service.logsFor('task-1').map((entry) => `${entry.type}:${entry.message}:${entry.details ?? ''}`).join('\n');
    expect(logs).toContain('agent:hello world');
    expect(logs).toContain('agent:Thinking: thinking hard');
    expect(logs).toContain('bash failed');
    expect(logs).toContain('Permission granted by policy: edit');
    // Agent output is redacted before it is journaled or relayed.
    const journaled = JSON.stringify(journal.events(started.runId, 0, 1_000));
    expect(journaled).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(JSON.stringify(h.cp.delivered)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(record?.counters).toMatchObject({ toolsExecuted: 1, filesChanged: 1 });
    expect(record?.usage?.messages.m2).toMatchObject({ cost: 0.5, input: 3, cacheRead: 1 });
  });

  it('fails a run whose agent reports an error, and an event stream that ends without a result', async () => {
    const h = harness();
    h.cp.addTask('task-err');
    h.cp.addTask('task-eof');
    const original = h.host.create.bind(h.host);
    let created = 0;
    h.host.create = (id, directory) => {
      created += 1;
      h.host.scripts.set(id, created === 1
        ? [{ t: 'error', code: 'auth', message: 'bad key', retryable: false }]
        : [{ t: 'message.delta', text: 'partial' }, { disconnect: true }]);
      return original(id, directory);
    };
    const { service, journal } = h.boot();
    const failed = await service.submit({ credential: fakeCredential(), taskId: 'task-err' });
    await settled(journal, h.cp, failed.runId, 'task-err');
    expect(journal.get(failed.runId)).toMatchObject({ state: 'failed' });
    expect(h.cp.tasks.get('task-err')).toMatchObject({ status: 'cancelled', sessionId: null });
    expect(h.cp.attemptFor('task-err')).toMatchObject({ runStatus: 'failed', status: 'closed' });

    const eof = await service.submit({ credential: fakeCredential(), taskId: 'task-eof' });
    await settled(journal, h.cp, eof.runId, 'task-eof');
    expect(journal.get(eof.runId)?.terminal?.reason).toBe('Agent event stream ended without a result');
    expect(h.cp.tasks.get('task-eof')?.outcome).toContain('Work retained on openlinear/');
    expect(h.publication.pushCalls).toBe(0);
  });

  it('reports no changes as a failure, never as success', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, [{ t: 'turn.finished', turn: 1, reason: 'idle' }]);
      return original(id, directory);
    };
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)).toMatchObject({ state: 'failed', terminal: { reason: 'no changes' } });
    expect(h.cp.tasks.get('task-1')?.status).toBe('cancelled');
    expect(h.cp.attemptFor('task-1')?.runStatus).toBe('failed');
  });

  it('keeps setup failures on their HTTP status and releases everything (sandbox unavailable → 503)', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    h.host.failStart = new SandboxUnavailableError('No verified sandbox', ['no provider']);
    const { service, journal } = h.boot();
    await expect(service.submit({ credential: fakeCredential(), taskId: 'task-1' })).rejects.toMatchObject({ statusCode: 503, code: 'SANDBOX_UNAVAILABLE' });
    const record = journal.latestForTask('task-1');
    await settled(journal, h.cp, record?.runId ?? '', 'task-1');
    expect(journal.get(record?.runId ?? '')).toMatchObject({ state: 'failed', terminal: { claimed: false } });
    expect(h.cp.attemptFor('task-1')).toMatchObject({ status: 'released' });
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'todo', writes: 0 });
    expect(h.workspace.released).toHaveLength(1);
    expect(service.reservationCount()).toBe(0);
  });

  it('refuses an unsupported runner before acceptance and releases the attempt', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    h.cp.snapshot = (taskId) => ({ ...h.cp.snapshot === undefined ? {} : {}, title: taskId, description: null, model: null, agent: 'codex', labels: [], projectId: null, teamId: null, creatorId: null, localPath: null, repository: null });
    const { service, journal } = h.boot();
    await expect(service.submit({ credential: fakeCredential(), taskId: 'task-1' })).rejects.toMatchObject({ statusCode: 400, code: 'RUNNER_NOT_SUPPORTED' });
    expect(journal.latestForTask('task-1')).toBeNull();
    expect(h.cp.attemptFor('task-1')).toMatchObject({ status: 'released', closeReason: 'runner_not_supported' });
    expect(service.reservationCount()).toBe(0);
  });
});

describe('RunService: fault injection at every await point', () => {
  async function recordPoints(): Promise<string[]> {
    const h = harness();
    h.cp.addTask('task-1');
    const points: string[] = [];
    const { service, journal } = h.boot((phase, point) => {
      points.push(`${phase}:${point}`);
    });
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    return [...new Set(points)];
  }

  it('covers the whole happy path', async () => {
    const points = await recordPoints();
    for (const expected of [
      'before:control:start', 'before:accepted', 'before:prepare:git-credential', 'before:prepare:workspace', 'before:prepare:runtime-start',
      'before:effect:attempt.claim:dispatch', 'after:effect:attempt.claim:receipt', 'before:pump:next', 'after:prompt:confirmed',
      'before:effect:git.commit:dispatch', 'before:publish:git-credential', 'before:effect:git.push:dispatch', 'before:effect:pr.create:dispatch',
      'before:effect:task.terminal:dispatch', 'before:effect:run.finalize:dispatch', 'before:effect:attempt.close:dispatch', 'before:relay:send',
    ]) {
      expect(points).toContain(expected);
    }
  });

  it('never leaks a reservation and decides exactly one terminal state, whatever await fails', async () => {
    const points = await recordPoints();
    expect(points.length).toBeGreaterThan(20);
    const failures: string[] = [];
    for (const target of points) {
      const h = harness();
      h.cp.addTask('task-1');
      let fired = false;
      const { service, journal } = h.boot((phase, point) => {
        if (!fired && `${phase}:${point}` === target) {
          fired = true;
          throw new Error(`injected at ${target}`);
        }
      });
      try {
        await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
      } catch {
        // Failures before acceptance or during setup surface to the caller.
      }
      const record = journal.latestForTask('task-1');
      if (!record) {
        // Before durable acceptance: nothing journaled, nothing held. A lost
        // start response leaves an unclaimed attempt that the control-plane
        // sweeper releases (preparing + expired lease).
        expect(target.endsWith(':control:start')).toBe(true);
        expect(service.reservationCount()).toBe(0);
        expect(h.cp.tasks.get('task-1')?.status).toBe('todo');
        continue;
      }
      try {
        await settled(journal, h.cp, record.runId, 'task-1');
        await waitFor(() => service.reservationCount() === 0 && service.activeCount() === 0, 'reservation released');
        expect(terminalTransitions(journal, record.runId)).toHaveLength(1);
        assertJournalIntegrity(journal, record.runId);
        // The task is never left stuck in progress.
        expect(h.cp.tasks.get('task-1')?.status).not.toBe('in_progress');
        expect(['closed', 'released']).toContain(h.cp.attemptFor('task-1')?.status);
        // A succeeded run really published; any other outcome did not claim success.
        const final = journal.get(record.runId);
        if (final?.state === 'succeeded') expect(h.cp.tasks.get('task-1')?.status).toBe('done');
        else expect(h.cp.tasks.get('task-1')?.status).not.toBe('done');
      } catch (error) {
        failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('RunService: cancellation in every live state', () => {
  it('cancels a queued run: removed from the queue, attempt released, task untouched', async () => {
    const h = harness();
    h.cp.parallelLimit = 1;
    h.cp.addTask('task-a');
    h.cp.addTask('task-b');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, [{ t: 'turn.started', turn: 1 }, { hold: 'go' }, { writeFile: 'x.txt' }, { t: 'turn.finished', turn: 1, reason: 'idle' }]);
      return original(id, directory);
    };
    const { service, journal } = h.boot();
    const a = await service.submit({ credential: fakeCredential(), taskId: 'task-a' });
    const b = await service.submit({ credential: fakeCredential(), taskId: 'task-b' });
    expect(b.state).toBe('queued');
    expect(service.queuedCount()).toBe(1);
    expect(await service.cancel('task-b')).toMatchObject({ success: true, state: 'cancelled' });
    await settled(journal, h.cp, b.runId, 'task-b');
    expect(journal.get(b.runId)).toMatchObject({ state: 'cancelled', terminal: { claimed: false } });
    expect(h.cp.attemptFor('task-b')).toMatchObject({ status: 'released' });
    expect(h.cp.tasks.get('task-b')).toMatchObject({ status: 'todo', writes: 0 });
    expect(service.queuedCount()).toBe(0);
    // The slot holder is unaffected and still finishes.
    for (const session of h.host.sessions.values()) session.release('go');
    await settled(journal, h.cp, a.runId, 'task-a');
    expect(journal.get(a.runId)?.state).toBe('succeeded');
  });

  it('refills the queue fairly when a slot frees', async () => {
    const h = harness();
    h.cp.parallelLimit = 1;
    h.cp.addTask('task-a');
    h.cp.addTask('task-b');
    const { service, journal } = h.boot();
    const a = await service.submit({ credential: fakeCredential(), taskId: 'task-a' });
    const b = await service.submit({ credential: fakeCredential(), taskId: 'task-b' });
    await settled(journal, h.cp, a.runId, 'task-a');
    await settled(journal, h.cp, b.runId, 'task-b');
    expect(journal.get(b.runId)?.state).toBe('succeeded');
    const states = journal.events(b.runId, 0, 1_000).filter((event) => event.kind === 'run.state').map((event) => event.payload.to);
    expect(states[0]).toBe('preparing');
  });

  it('cancels during preparing: setup stops, nothing is claimed, the attempt is released', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const { service, journal } = h.boot(async (phase, point) => {
      if (phase === 'before' && point === 'prepare:workspace') await gate;
    });
    const submitted = service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => journal.latestForTask('task-1'), 'accepted');
    const cancelled = service.cancel('task-1');
    releaseGate();
    expect(await cancelled).toMatchObject({ success: true, state: 'cancelled' });
    await submitted.catch(() => undefined);
    const record = journal.latestForTask('task-1');
    await settled(journal, h.cp, record?.runId ?? '', 'task-1');
    expect(record?.runId && journal.get(record.runId)).toMatchObject({ state: 'cancelled', terminal: { claimed: false } });
    expect(h.host.sessions.size).toBe(0);
    expect(h.cp.attemptFor('task-1')).toMatchObject({ status: 'released' });
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'todo', writes: 0 });
  });

  it('cancels a running run with a positive stop receipt before the cancelled projection', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, [{ t: 'turn.started', turn: 1 }, { hold: 'never' }]);
      return original(id, directory);
    };
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => h.cp.tasks.get('task-1')?.status === 'in_progress', 'claimed');
    expect(await service.cancel('task-1')).toMatchObject({ success: true, state: 'cancelled' });
    await settled(journal, h.cp, started.runId, 'task-1');
    const session = [...h.host.sessions.values()][0];
    expect(h.host.aborts.get(session?.id ?? '')).toBeGreaterThan(0);
    expect(h.cp.attemptFor('task-1')).toMatchObject({ cancelAcknowledged: true, runStatus: 'cancelled', terminalStatus: 'cancelled', status: 'closed' });
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'cancelled', sessionId: null });
    expect(journal.effects(started.runId).find((effect) => effect.kind === 'cancel.ack')?.status).toBe('confirmed');
  });

  it('keeps a running run reserved when the stop cannot be confirmed', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, [{ t: 'turn.started', turn: 1 }, { hold: 'go' }, { writeFile: 'x.txt' }, { t: 'turn.finished', turn: 1, reason: 'idle' }]);
      return original(id, directory);
    };
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => h.cp.tasks.get('task-1')?.status === 'in_progress', 'claimed');
    h.host.reachable = false;
    expect(await service.cancel('task-1')).toMatchObject({ success: false, error: 'Cancellation could not be confirmed; execution remains reserved' });
    expect(service.isRunning('task-1')).toBe(true);
    expect(h.cp.tasks.get('task-1')?.status).toBe('in_progress');
    h.host.reachable = true;
    for (const session of h.host.sessions.values()) {
      session.aborted = false;
      session.status = 'busy';
      session.release('go');
    }
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(terminalTransitions(journal, started.runId)).toHaveLength(1);
  });

  it('cancels during finishing: no new publication effect; an effect already dispatched is reported', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached = false;
    const { service, journal } = h.boot(async (phase, point) => {
      if (phase === 'after' && point === 'effect:git.push:dispatch') {
        reached = true;
        await gate;
      }
    });
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => reached, 'push dispatched');
    const cancelled = service.cancel('task-1');
    release();
    expect(await cancelled).toMatchObject({ success: true, state: 'cancelled' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(h.publication.pushCalls).toBe(1);
    expect(h.publication.prPosts).toBe(0);
    const record = journal.get(started.runId);
    expect(record?.terminal?.outcome).toContain('branch already pushed');
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'cancelled' });
    expect(h.cp.attemptFor('task-1')?.runStatus).toBe('cancelled');
  });

  it('honours a cancellation requested through the control plane (heartbeat)', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, [{ t: 'turn.started', turn: 1 }, { hold: 'never' }]);
      return original(id, directory);
    };
    const { service, journal } = h.boot(null, { heartbeatMs: 20 });
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => h.cp.tasks.get('task-1')?.status === 'in_progress', 'claimed');
    const attempt = h.cp.attemptFor('task-1');
    if (attempt) attempt.cancelRequested = true;
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.state).toBe('cancelled');
    expect(h.cp.attemptFor('task-1')).toMatchObject({ cancelAcknowledged: true, runStatus: 'cancelled' });
  });
});

describe('RunService: process-kill recovery', () => {
  function holdScript(): HostStep[] {
    return [
      { t: 'turn.started', turn: 1 },
      { t: 'message.delta', text: 'before the crash' },
      { t: 'tool.started', callId: 'c1', name: 'edit', input: {} },
      { hold: 'resume' },
      { writeFile: 'after.txt' },
      { t: 'file.changed', path: 'after.txt', kind: 'create' },
      { t: 'turn.finished', turn: 1, reason: 'idle' },
    ];
  }

  it('after prompt dispatch: reattaches without a second prompt, keeps sequence continuity, publishes once', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, holdScript());
      return original(id, directory);
    };
    const first = h.boot();
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.events(started.runId, 0, 1_000).some((event) => event.kind === 'agent' && event.payload.t === 'tool.started'), 'agent working');
    await waitFor(() => (first.journal.get(started.runId)?.relayAckSeq ?? 0) > 0, 'some events relayed');
    h.crash(first);

    const second = h.boot();
    const recovered = await second.service.recover();
    expect(recovered.recovered).toBe(1);
    await waitFor(() => second.journal.events(started.runId, 0, 1_000).some((event) => event.kind === 'recovery' && event.payload.decision === 'reattach'), 'reattach decision');
    const session = [...h.host.sessions.values()][0];
    await waitFor(() => (session?.subscribers.size ?? 0) > 0, 'reattached subscriber');
    session?.release('resume');
    await settled(second.journal, h.cp, started.runId, 'task-1');

    expect(second.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.host.promptCount(session?.id ?? '')).toBe(1);
    assertJournalIntegrity(second.journal, started.runId);
    assertRelayContinuity(second.journal, h.cp, started.runId, 'attempt-1');
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'done' });
    expect(h.publication.commits).toHaveLength(1);
    expect(h.publication.prPosts).toBe(1);
  });

  it('after commit, before push: resumes publication with the journaled commit, one push, one PR', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const holder: { instance?: { service: RunService; journal: DurableRunJournal } } = {};
    const first = h.boot(h.crashAt('after:effect:git.commit:receipt', holder));
    holder.instance = first;
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.isClosed, 'crashed');
    expect(h.publication.commits).toHaveLength(1);
    expect(h.publication.pushCalls).toBe(0);

    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(second.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.publication.commits).toHaveLength(1);
    expect(h.publication.pushCalls).toBe(1);
    expect(h.publication.prPosts).toBe(1);
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'done' });
    assertJournalIntegrity(second.journal, started.runId);
    assertRelayContinuity(second.journal, h.cp, started.runId, 'attempt-1');
  });

  it('after commit dispatch, before its receipt: the commit trailer is the receipt (no second commit)', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const holder: { instance?: { service: RunService; journal: DurableRunJournal } } = {};
    const first = h.boot(h.crashAt('after:effect:git.commit:dispatch', holder));
    holder.instance = first;
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.isClosed, 'crashed');
    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(h.publication.commits).toHaveLength(1);
    const commit = second.journal.effects(started.runId).find((effect) => effect.kind === 'git.commit');
    expect(commit).toMatchObject({ status: 'confirmed', receipt: { reconciled: true } });
    expect(second.journal.get(started.runId)?.state).toBe('succeeded');
  });

  it('after push dispatch, before its receipt: reconciles the remote ref instead of pushing again', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const holder: { instance?: { service: RunService; journal: DurableRunJournal } } = {};
    const first = h.boot(h.crashAt('after:effect:git.push:dispatch', holder));
    holder.instance = first;
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.isClosed, 'crashed');
    expect(h.publication.pushCalls).toBe(1);
    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(h.publication.pushCalls).toBe(1);
    expect(second.journal.effects(started.runId).find((effect) => effect.kind === 'git.push')).toMatchObject({ status: 'confirmed', receipt: { reconciled: true } });
    expect(h.cp.tasks.get('task-1')?.status).toBe('done');
  });

  it('after PR dispatch, before its receipt: reuses the existing PR (W01 reconciliation), never a second POST', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const holder: { instance?: { service: RunService; journal: DurableRunJournal } } = {};
    const first = h.boot(h.crashAt('after:effect:pr.create:dispatch', holder));
    holder.instance = first;
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.isClosed, 'crashed');
    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(h.publication.prPosts).toBe(1);
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'done', prUrl: 'https://github.com/acme/repo/pull/1' });
  });

  it('after the terminal decision, before its projection: projects once on restart', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const holder: { instance?: { service: RunService; journal: DurableRunJournal } } = {};
    const first = h.boot(h.crashAt('after:effect:task.terminal:dispatch', holder));
    holder.instance = first;
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.isClosed, 'crashed');
    expect(h.cp.tasks.get('task-1')?.status).toBe('done');
    const writes = h.cp.tasks.get('task-1')?.writes ?? 0;
    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(h.cp.tasks.get('task-1')?.writes).toBe(writes);
    expect(h.cp.attemptFor('task-1')).toMatchObject({ status: 'closed', runStatus: 'succeeded' });
    expect(terminalTransitions(second.journal, started.runId)).toEqual(['succeeded']);
  });

  it('turn finished while the sidecar was down: continues with publication', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, holdScript());
      return original(id, directory);
    };
    const first = h.boot();
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.events(started.runId, 0, 1_000).some((event) => event.payload.t === 'tool.started'), 'agent working');
    h.crash(first);
    const session = [...h.host.sessions.values()][0];
    session?.release('resume');
    await waitFor(() => session?.status === 'idle', 'turn finished while down');
    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(second.journal.events(started.runId, 0, 1_000).find((event) => event.kind === 'recovery')?.payload.decision).toBe('finish');
    expect(second.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.host.promptCount(session?.id ?? '')).toBe(1);
  });

  it('runtime gone after the restart: recovery_required, work retained, task released, nothing published', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, holdScript());
      return original(id, directory);
    };
    const first = h.boot();
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.events(started.runId, 0, 1_000).some((event) => event.payload.t === 'tool.started'), 'agent working');
    h.crash(first);
    h.host.sessions.clear();
    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(second.journal.get(started.runId)).toMatchObject({ state: 'recovery_required' });
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'cancelled', sessionId: null });
    expect(h.cp.tasks.get('task-1')?.outcome).toContain('Work retained on');
    expect(h.cp.attemptFor('task-1')).toMatchObject({ runStatus: 'failed', status: 'closed' });
    expect(h.publication.pushCalls).toBe(0);
  });

  it('control plane swept the attempt while the sidecar was down: fenced, writes nothing, stops the orphan agent', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, holdScript());
      return original(id, directory);
    };
    const first = h.boot();
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.events(started.runId, 0, 1_000).some((event) => event.payload.t === 'tool.started'), 'agent working');
    h.crash(first);
    h.cp.sweep('attempt-1');
    const writes = h.cp.tasks.get('task-1')?.writes;
    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(second.journal.get(started.runId)).toMatchObject({ state: 'abandoned' });
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'cancelled', outcome: 'sidecar_lost', writes });
    const session = [...h.host.sessions.values()][0];
    expect(h.host.aborts.get(session?.id ?? '')).toBe(1);
    expect(second.service.reservationCount()).toBe(0);
  });

  it('control plane unreachable at restart: decides nothing, then recovers once it is back', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, holdScript());
      return original(id, directory);
    };
    const first = h.boot();
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.events(started.runId, 0, 1_000).some((event) => event.payload.t === 'tool.started'), 'agent working');
    h.crash(first);
    h.cp.unreachable = true;
    const second = h.boot();
    await second.service.recover();
    await waitFor(() => second.journal.events(started.runId, 0, 1_000).some((event) => event.kind === 'recovery' && event.payload.decision === 'wait'), 'wait');
    expect(second.service.isRunning('task-1')).toBe(true);
    expect(second.journal.get(started.runId)?.state).toBe('running');
    h.cp.unreachable = false;
    await waitFor(() => second.journal.events(started.runId, 0, 1_000).some((event) => event.kind === 'recovery' && event.payload.decision === 'reattach'), 'reattach');
    const session = [...h.host.sessions.values()][0];
    await waitFor(() => (session?.subscribers.size ?? 0) > 0, 'subscriber');
    session?.release('resume');
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(second.journal.get(started.runId)?.state).toBe('succeeded');
  });

  it('crash during setup (before the claim): fails the run and releases the attempt; the task was never touched', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const holder: { instance?: { service: RunService; journal: DurableRunJournal } } = {};
    const first = h.boot(h.crashAt('before:prepare:runtime-start', holder));
    holder.instance = first;
    await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' }).catch(() => undefined);
    await waitFor(() => first.journal.isClosed, 'crashed');
    const second = h.boot();
    await second.service.recover();
    const record = second.journal.latestForTask('task-1');
    await settled(second.journal, h.cp, record?.runId ?? '', 'task-1');
    expect(record && second.journal.get(record.runId)).toMatchObject({ state: 'failed', terminal: { claimed: false } });
    expect(h.cp.attemptFor('task-1')?.status).toBe('released');
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'todo', writes: 0 });
  });

  it('records a cancellation requested while recovery waits for the control plane, then applies it', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, holdScript());
      return original(id, directory);
    };
    const first = h.boot();
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.events(started.runId, 0, 1_000).some((event) => event.payload.t === 'tool.started'), 'agent working');
    h.crash(first);
    h.cp.unreachable = true;
    const second = h.boot();
    await second.service.recover();
    await waitFor(() => second.journal.events(started.runId, 0, 1_000).some((event) => event.kind === 'recovery' && event.payload.decision === 'wait'), 'wait');
    expect(await second.service.cancel('task-1')).toMatchObject({ success: false, error: 'Cancellation is still in progress' });
    expect(second.journal.get(started.runId)?.cancelRequestedAt).not.toBeNull();
    h.cp.unreachable = false;
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(second.journal.get(started.runId)?.state).toBe('cancelled');
    expect(h.cp.attemptFor('task-1')).toMatchObject({ cancelAcknowledged: true, runStatus: 'cancelled' });
  });

  it('a cancellation requested while the sidecar was down is honoured at restart', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, holdScript());
      return original(id, directory);
    };
    const first = h.boot();
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.events(started.runId, 0, 1_000).some((event) => event.payload.t === 'tool.started'), 'agent working');
    h.crash(first);
    const attempt = h.cp.attemptFor('task-1');
    if (attempt) attempt.cancelRequested = true;
    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(second.journal.get(started.runId)?.state).toBe('cancelled');
    expect(h.cp.attemptFor('task-1')).toMatchObject({ cancelAcknowledged: true, runStatus: 'cancelled' });
  });
});

describe('RunService: lease, renewal and fencing while alive', () => {
  it('renews the capability before it expires and journals the new token before using it', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    h.cp.capabilityTtlMs = 10 * 60_000;
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, [{ t: 'turn.started', turn: 1 }, { hold: 'go' }, { writeFile: 'x.txt' }, { t: 'turn.finished', turn: 1, reason: 'idle' }]);
      return original(id, directory);
    };
    const { service, journal } = h.boot(null, { heartbeatMs: 20 });
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    const before = journal.get(started.runId)?.capability;
    await waitFor(() => (h.cp.attemptFor('task-1')?.renewals ?? 0) > 0, 'renewed');
    await waitFor(() => journal.get(started.runId)?.capability !== before, 'journaled');
    for (const session of h.host.sessions.values()) session.release('go');
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.state).toBe('succeeded');
  });

  it('fences a live run when the control plane revokes its attempt (sweeper raced a slow heartbeat)', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, [{ t: 'turn.started', turn: 1 }, { hold: 'never' }]);
      return original(id, directory);
    };
    const { service, journal } = h.boot(null, { heartbeatMs: 20 });
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => h.cp.tasks.get('task-1')?.status === 'in_progress', 'claimed');
    h.cp.sweep('attempt-1');
    await waitFor(() => journal.get(started.runId)?.state === 'abandoned', 'abandoned');
    await waitFor(() => service.reservationCount() === 0, 'released');
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'cancelled', outcome: 'sidecar_lost' });
    expect(h.cp.attemptFor('task-1')?.cancelAcknowledged).toBe(false);
  });

  it('keeps events durable while the control plane is unreachable and relays them later without duplicates', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      const steps: HostStep[] = [{ t: 'turn.started', turn: 1 }, { hold: 'go' }];
      for (let index = 0; index < 120; index += 1) steps.push({ t: 'tool.started', callId: `c${index}`, name: 'bash', input: {} });
      steps.push({ writeFile: 'x.txt' }, { t: 'turn.finished', turn: 1, reason: 'idle' });
      h.host.scripts.set(id, steps);
      return original(id, directory);
    };
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => h.cp.tasks.get('task-1')?.status === 'in_progress', 'claimed');
    h.cp.unreachable = true;
    for (const session of h.host.sessions.values()) session.release('go');
    await waitFor(() => journal.events(started.runId, 0, 10_000).filter((event) => event.payload.t === 'tool.started').length === 120, 'journaled offline');
    h.cp.unreachable = false;
    await settled(journal, h.cp, started.runId, 'task-1');
    assertRelayContinuity(journal, h.cp, started.runId, 'attempt-1');
  });

  it('trips the no-progress watchdog and fails the run with work retained', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const original = h.host.create.bind(h.host);
    h.host.create = (id, directory) => {
      h.host.scripts.set(id, [{ t: 'turn.started', turn: 1 }, { hold: 'never' }]);
      return original(id, directory);
    };
    const { service, journal } = h.boot(null, { watchdog: { transportMs: 1e9, noProgressMs: 50, wallClockMs: 1e9 } });
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)).toMatchObject({ state: 'failed', terminal: { reason: 'Agent stopped: watchdog: no-progress' } });
    expect(h.cp.tasks.get('task-1')?.status).toBe('cancelled');
  });
});

describe('RunService: control-plane errors before acceptance', () => {
  it('passes the control plane decision through and holds nothing', async () => {
    const h = harness();
    const { service } = h.boot();
    await expect(service.submit({ credential: fakeCredential(), taskId: 'missing' })).rejects.toBeInstanceOf(HttpError);
    h.cp.unreachable = true;
    h.cp.addTask('task-1');
    await expect(service.submit({ credential: fakeCredential(), taskId: 'task-1' })).rejects.toMatchObject({ statusCode: 503, code: 'CLOUD_API_UNREACHABLE' });
    expect(service.reservationCount()).toBe(0);
  });

  it('describes run states for the UI contract', () => {
    const states: RunState[] = ['queued', 'running', 'succeeded'];
    expect(states.every((state) => isRunState(state))).toBe(true);
  });
});
