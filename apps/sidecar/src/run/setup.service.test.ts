import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTerminalRunState, runEffectKey } from '@openlinear/execution-core';
import { DurableRunJournal } from '../journal/durable';
import type { FaultHook } from './faults';
import { RunService, type RunServiceOptions } from './service';
import { FakeControlPlane, FakePublication, FakeRuntime, FakeRuntimeHost, FakeSetup, FakeWorkspace, fakeCredential, fakeSnapshot } from './test-support';
import { setupStepRecordSchema, type SetupStepRecord } from './types';

/**
 * W16a at the service level: the sealed setup steps run in order in the
 * run's worktree after it is prepared and before the agent exists (no
 * runtime session, no claim, no prompt), each journaled and streamed; a
 * failing required step fails the run before any prompt with the worktree
 * kept; an optional failure is logged and the run continues; a crash during
 * setup is never "resumed" by re-running finished steps.
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

const SETUP = [
  { name: 'install', run: 'pnpm install --frozen-lockfile', network: 'registries', timeoutSeconds: 900 },
  { id: 'codegen', name: 'Generate clients', command: ['pnpm', 'codegen'] },
];

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

function harness(settings: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'ol-setup-svc-'));
  roots.push(root);
  const journalPath = join(root, 'journal', 'runs-v2.sqlite');
  const cp = new FakeControlPlane();
  cp.snapshot = (taskId) => fakeSnapshot(taskId, settings === undefined ? {} : { verificationSettings: settings });
  const host = new FakeRuntimeHost();
  const publication = new FakePublication();
  const workspace = new FakeWorkspace(join(root, 'worktrees'));
  const setup = new FakeSetup();
  const holder: { instance?: { service: RunService; journal: DurableRunJournal } } = {};

  function boot(faults?: FaultHook | null) {
    const journal = new DurableRunJournal(journalPath);
    const service = new RunService({
      journal,
      controlPlane: cp,
      runtimes: new Map([['opencode', new FakeRuntime(host)]]),
      publication,
      workspace,
      setup,
      reposRoot: () => root,
      events: { publish: () => undefined },
      faults: faults ?? null,
      options: TEST_OPTIONS,
    });
    services.push(service);
    holder.instance = { service, journal };
    return { service, journal };
  }

  function crashAt(target: string): FaultHook {
    let fired = false;
    return (phase, point) => {
      if (fired || `${phase}:${point}` !== target || !holder.instance) return;
      fired = true;
      holder.instance.service.stop();
      holder.instance.journal.close();
      throw new CrashSignal(`crashed at ${target}`);
    };
  }

  return { cp, host, publication, workspace, setup, boot, crashAt };
}

async function settled(journal: DurableRunJournal, cp: FakeControlPlane, runId: string, taskId: string): Promise<void> {
  await waitFor(() => {
    const record = journal.get(runId);
    const attempt = cp.attemptFor(taskId);
    return record && isTerminalRunState(record.state) && journal.effects(runId).every((effect) => effect.status !== 'pending')
      && (attempt?.status === 'closed' || attempt?.status === 'released');
  }, `run ${runId} settled`);
}

function setupRecords(journal: DurableRunJournal, runId: string): Array<SetupStepRecord & { seq: number }> {
  return journal.events(runId, 0, 10_000)
    .filter((event) => event.kind === 'progress' && event.payload.setupRecord !== undefined)
    .map((event) => ({ ...setupStepRecordSchema.parse(event.payload.setupRecord), seq: event.seq }));
}

function effectSeq(journal: DurableRunJournal, runId: string, key: string): number {
  const event = journal.events(runId, 0, 10_000).find((entry) => entry.kind === 'effect' && entry.payload.key === key);
  if (!event) throw new Error(`no effect event for ${key}`);
  return event.seq;
}

describe('W16a setup before the agent starts', () => {
  it('runs the sealed steps in order in the worktree before any runtime, claim or prompt, then the run proceeds', async () => {
    const h = harness({ policy: 'off', setup: SETUP });
    h.cp.addTask('task-1');
    const seen: Array<{ step: string; sessions: number; prompts: number; attempt: string | undefined; task: string | undefined }> = [];
    h.setup.onStep = (input) => {
      seen.push({ step: input.step.id, sessions: h.host.sessions.size, prompts: h.host.prompts.size, attempt: h.cp.attemptFor('task-1')?.status, task: h.cp.tasks.get('task-1')?.status });
    };
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');

    const record = journal.get(started.runId);
    expect(record?.state).toBe('succeeded');
    expect(h.setup.calls.map((call) => call.step.id)).toEqual(['install', 'codegen']);
    expect(h.setup.calls.every((call) => call.workspace.worktreePath === record?.workspace?.worktreePath && call.runId === started.runId)).toBe(true);
    expect(h.setup.calls[0]?.step).toMatchObject({ argv: ['/bin/sh', '-c', 'pnpm install --frozen-lockfile'], network: { mode: 'egress', registries: true }, timeoutMs: 900_000 });
    // Nothing of the agent existed while setup ran.
    expect(seen).toEqual([
      { step: 'install', sessions: 0, prompts: 0, attempt: 'preparing', task: 'todo' },
      { step: 'codegen', sessions: 0, prompts: 0, attempt: 'preparing', task: 'todo' },
    ]);
    // Journaled: start + result per step, all before the prompt intent.
    const records = setupRecords(journal, started.runId);
    expect(records.map((entry) => `${entry.phase}:${entry.index}`)).toEqual(['start:0', 'end:0', 'start:1', 'end:1']);
    expect(records.filter((entry) => entry.phase === 'end').map((entry) => entry.phase === 'end' && entry.result.status)).toEqual(['passed', 'passed']);
    const promptSeq = effectSeq(journal, started.runId, runEffectKey(started.runId, 'prompt.submit'));
    expect(Math.max(...records.map((entry) => entry.seq))).toBeLessThan(promptSeq);
    expect(h.host.prompts.size).toBe(1);
    expect(h.setup.cleanups).toEqual([started.runId]);

    const logs = service.logsFor('task-1').map((entry) => entry.message);
    expect(logs).toContain('Setting up the environment: 2 steps before the agent starts');
    expect(logs).toContain('Setup step "install" passed (exit 0 · 25 ms)');
    expect(logs).toContain('Setup step "Generate clients" passed (exit 0 · 25 ms)');
    expect(logs.indexOf('Environment ready; starting the agent')).toBeLessThan(logs.indexOf('Agent started'));
    // Relayed to the control plane as progress with scalar fields only (no local paths).
    const progress = h.cp.delivered.filter((event) => event.type === 'execution:progress' && event.payload.setupStep !== undefined);
    expect(progress.map((event) => `${String(event.payload.setupPhase)}:${String(event.payload.setupStep)}`)).toEqual(['start:install', 'end:install', 'start:codegen', 'end:codegen']);
    expect(progress[1]?.payload).toMatchObject({ status: 'cloning', runState: 'preparing', setupStatus: 'passed', exitCode: 0, setupIndex: 0, setupTotal: 2 });
    expect(progress.every((event) => event.payload.setupRecord === undefined)).toBe(true);
  });

  it('a failing required step fails the run before any prompt: no session, no claim, later steps skipped, worktree kept', async () => {
    const h = harness({ setup: SETUP });
    h.setup.exits = { install: 1 };
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');

    const record = journal.get(started.runId);
    expect(record?.state).toBe('failed');
    expect(record?.terminal?.outcome).toBe(`Setup failed: install exited 1. Worktree kept on ${record?.workspace?.branch} at ${record?.workspace?.worktreePath}`);
    expect(h.setup.calls.map((call) => call.step.id)).toEqual(['install']);
    expect(h.host.sessions.size).toBe(0);
    expect(h.host.prompts.size).toBe(0);
    expect(journal.effect(started.runId, runEffectKey(started.runId, 'prompt.submit'))).toBeNull();
    expect(journal.effect(started.runId, runEffectKey(started.runId, 'attempt.claim'))).toBeNull();
    // Never claimed: the attempt is released and the task row untouched.
    expect(h.cp.attemptFor('task-1')).toMatchObject({ status: 'released', sessionId: null });
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'todo', writes: 0 });
    expect(h.workspace.released).toEqual([]);
    expect(record?.workspace && h.workspace.exists(record.workspace)).toBe(true);
    expect(h.setup.cleanups).toEqual([started.runId]);
    const logs = service.logsFor('task-1');
    expect(logs.some((entry) => entry.type === 'error' && entry.message === 'Setup step "install" exited 1 (25 ms)' && entry.details === 'ERR_PNPM_OUTDATED_LOCKFILE')).toBe(true);
    expect(logs.some((entry) => entry.type === 'error' && entry.message === 'Setup failed: install exited 1')).toBe(true);
    expect(service.describe('task-1')).toMatchObject({ state: 'failed', terminal: { reason: 'setup failed' } });
  });

  it('setup that leaves committable changes fails the run before the agent: they would be published as its work', async () => {
    const h = harness({ setup: SETUP });
    h.setup.leaves = { install: ['pnpm-lock.yaml'], codegen: ['src/generated/client.ts'] };
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');

    const record = journal.get(started.runId);
    expect(record?.state).toBe('failed');
    expect(record?.terminal?.outcome).toMatch(/^Setup failed: setup changed files that would be published as the agent's work\. Worktree kept/);
    expect(h.setup.calls.map((call) => call.step.id)).toEqual(['install', 'codegen']);
    expect(h.host.prompts.size).toBe(0);
    expect(journal.effect(started.runId, runEffectKey(started.runId, 'attempt.claim'))).toBeNull();
    const failure = service.logsFor('task-1').find((entry) => entry.type === 'error' && entry.message.startsWith('Setup failed: setup changed files'));
    expect(failure?.details).toContain('pnpm-lock.yaml\nsrc/generated/client.ts');
    expect(failure?.details).toContain('--frozen-lockfile');
  });

  it('no sandbox (and no covering grant): execute answers 503 SANDBOX_UNAVAILABLE before accepting, no step runs', async () => {
    const h = harness({ setup: SETUP });
    h.setup.sandboxUnavailable = true;
    h.cp.addTask('task-1');
    const { service } = h.boot();
    await expect(service.submit({ credential: fakeCredential(), taskId: 'task-1' })).rejects.toMatchObject({ statusCode: 503, code: 'SANDBOX_UNAVAILABLE' });
    expect(h.setup.calls).toEqual([]);
    expect(h.host.prompts.size).toBe(0);
    expect(service.describe('task-1')).toMatchObject({ state: 'failed', terminal: { reason: 'setup failed' } });
  });

  it('a required step that times out fails the run the same way', async () => {
    const h = harness({ setup: SETUP });
    h.setup.timeouts.add('codegen');
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.terminal?.outcome).toMatch(/^Setup failed: Generate clients timed out after 600 s\. Worktree kept on /);
    expect(h.setup.calls.map((call) => call.step.id)).toEqual(['install', 'codegen']);
    expect(h.host.prompts.size).toBe(0);
  });

  it('an optional step that fails is logged and the run continues to the agent', async () => {
    const h = harness({ setup: [...SETUP, { name: 'warm cache', run: 'pnpm build:cache', required: false }] });
    h.setup.exits = { 'warm-cache': 2 };
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.setup.calls.map((call) => call.step.id)).toEqual(['install', 'codegen', 'warm-cache']);
    expect(h.host.prompts.size).toBe(1);
    const logs = service.logsFor('task-1');
    expect(logs.some((entry) => entry.type === 'info' && entry.message === 'Setup step "warm cache" (optional) exited 2 (25 ms)')).toBe(true);
    expect(logs.some((entry) => entry.message === 'Optional setup step "warm cache" did not pass; continuing')).toBe(true);
  });

  it('no setup configured: no setup step, no setup records', async () => {
    const h = harness({ policy: 'warn' });
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.setup.calls).toEqual([]);
    expect(setupRecords(journal, started.runId)).toEqual([]);
    expect(h.setup.cleanups).toEqual([]);
  });

  it('unreadable sealed steps fail the run before the agent and execute reports SETUP_FAILED', async () => {
    const h = harness({ setup: [{ name: 'install' }] });
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    await expect(service.submit({ credential: fakeCredential(), taskId: 'task-1' })).rejects.toMatchObject({ statusCode: 422, code: 'SETUP_FAILED' });
    const record = journal.latestForTask('task-1');
    if (!record) throw new Error('no run');
    await settled(journal, h.cp, record.runId, 'task-1');
    expect(journal.get(record.runId)?.terminal?.outcome).toMatch(/^Setup failed: the project's setup steps are invalid\./);
    expect(h.setup.calls).toEqual([]);
    expect(h.host.sessions.size).toBe(0);
  });

  it('cancel during a step stops it and cancels the run before any prompt', async () => {
    const h = harness({ setup: SETUP });
    h.setup.holds.add('install');
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    expect(started.state).toBe('preparing');
    await waitFor(() => h.setup.calls.length === 1, 'install running');
    const cancelled = await service.cancel('task-1');
    expect(cancelled.success).toBe(true);
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.state).toBe('cancelled');
    expect(h.setup.calls.map((call) => call.step.id)).toEqual(['install']);
    expect(h.host.sessions.size).toBe(0);
    const ends = setupRecords(journal, started.runId).filter((entry) => entry.phase === 'end');
    expect(ends.map((entry) => entry.phase === 'end' && entry.result.status)).toEqual(['error']);
    expect(h.setup.cleanups).toEqual([started.runId]);
  });
});

describe('W16a setup across a crash', () => {
  it('recovery never re-runs finished steps; a follow-up in the kept worktree skips them and runs the rest before its prompt', async () => {
    const h = harness({ setup: SETUP });
    h.cp.addTask('task-1');
    // The sidecar dies after "install" finished (result journaled), before "codegen" starts.
    const first = h.boot(h.crashAt('before:prepare:setup:codegen'));
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => {
      try {
        first.journal.get(started.runId);
        return null;
      } catch {
        return true;
      }
    }, 'crash');
    expect(h.setup.calls.map((call) => call.step.id)).toEqual(['install']);

    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    const crashed = second.journal.get(started.runId);
    expect(crashed?.state).toBe('failed');
    expect(crashed?.terminal?.reason).toBe('the sidecar restarted before the agent started');
    // Recovery ran nothing again and kept the worktree.
    expect(h.setup.calls.map((call) => call.step.id)).toEqual(['install']);
    expect(h.workspace.released).toEqual([]);
    expect(h.host.prompts.size).toBe(0);

    const follow = await second.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'Finish the setup and carry on', comments: [] } });
    await settled(second.journal, h.cp, follow.runId, 'task-1');
    expect(second.journal.get(follow.runId)?.state).toBe('succeeded');
    expect(second.journal.get(follow.runId)?.workspace?.worktreePath).toBe(crashed?.workspace?.worktreePath);
    expect(h.setup.calls.map((call) => `${call.runId === follow.runId ? 'follow' : 'first'}:${call.step.id}`)).toEqual(['first:install', 'follow:codegen']);
    const ends = setupRecords(second.journal, follow.runId).filter((entry): entry is Extract<SetupStepRecord, { phase: 'end' }> & { seq: number } => entry.phase === 'end');
    expect(ends.map((entry) => [entry.result.id, entry.reusedFrom])).toEqual([['install', started.runId], ['codegen', null]]);
    expect(second.service.logsFor('task-1').some((entry) => entry.message === `Setup step "install" already completed in this worktree (run ${started.runId.slice(0, 8)}); not run again`)).toBe(true);
    expect(h.host.prompts.size).toBe(1);
  });

  it('a crash while a step ran (no result journaled) leaves it unfinished: a follow-up runs it again', async () => {
    const h = harness({ setup: SETUP });
    h.cp.addTask('task-1');
    const first = h.boot(h.crashAt('after:prepare:setup:install'));
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => {
      try {
        first.journal.get(started.runId);
        return null;
      } catch {
        return true;
      }
    }, 'crash');
    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(setupRecords(second.journal, started.runId).map((entry) => entry.phase)).toEqual(['start']);

    const follow = await second.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'again', comments: [] } });
    await settled(second.journal, h.cp, follow.runId, 'task-1');
    expect(second.journal.get(follow.runId)?.state).toBe('succeeded');
    expect(h.setup.calls.map((call) => `${call.runId === follow.runId ? 'follow' : 'first'}:${call.step.id}`)).toEqual(['first:install', 'follow:install', 'follow:codegen']);
  });

  it('a follow-up after a completed setup does not repeat it; a step whose command changed runs', async () => {
    const settings: { setup: Array<Record<string, unknown>> } = { setup: SETUP };
    const h = harness(undefined);
    h.cp.snapshot = (taskId) => fakeSnapshot(taskId, { verificationSettings: settings });
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.state).toBe('succeeded');

    settings.setup = [SETUP[0] ?? {}, { id: 'codegen', name: 'Generate clients', command: ['pnpm', 'codegen', '--all'] }];
    const follow = await service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'more', comments: [] } });
    await settled(journal, h.cp, follow.runId, 'task-1');
    expect(journal.get(follow.runId)?.state).toBe('succeeded');
    expect(h.setup.calls.map((call) => `${call.runId === follow.runId ? 'follow' : 'first'}:${call.step.id}`)).toEqual(['first:install', 'first:codegen', 'follow:codegen']);
  });
});
