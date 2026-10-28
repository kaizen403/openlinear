import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isRunState, isTerminalRunState, UNTRUSTED_CONTENT_TAG, type FollowUpRequest } from '@openlinear/execution-core';
import { DurableRunJournal } from '../journal/durable';
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
 * W07a follow-up turns at the service level: the turn adopts the previous
 * run's worktree and branch, resumes the runner's session where it can
 * (else a fresh session seeded with the previous diff), is journaled like
 * any run, and its publication fast-forwards the same branch and reuses the
 * open pull request. Recovery never re-sends the follow-up prompt.
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
  const root = mkdtempSync(join(tmpdir(), 'ol-follow-up-'));
  roots.push(root);
  const journalPath = join(root, 'journal', 'runs-v2.sqlite');
  const cp = new FakeControlPlane();
  const host = new FakeRuntimeHost();
  const publication = new FakePublication();
  const workspace = new FakeWorkspace(join(root, 'worktrees'));

  function boot(faults?: FaultHook | null) {
    const journal = new DurableRunJournal(journalPath);
    const service = new RunService({
      journal,
      controlPlane: cp,
      runtimes: new Map([['opencode', new FakeRuntime(host)]]),
      publication,
      workspace,
      faults: faults ?? null,
      options: TEST_OPTIONS,
    });
    services.push(service);
    return { service, journal };
  }

  function crash(instance: { service: RunService; journal: DurableRunJournal }): void {
    instance.service.stop();
    instance.journal.close();
  }

  /** Script for the next run the host starts or resumes (keyed by run id at start). */
  function scriptNext(steps: HostStep[]): void {
    const original = host.create.bind(host);
    host.create = (id, directory) => {
      host.scripts.set(id, steps);
      host.create = original;
      return original(id, directory);
    };
  }

  return { root, cp, host, publication, workspace, boot, crash, scriptNext };
}

function terminalStates(journal: DurableRunJournal, runId: string): string[] {
  return journal.events(runId, 0, 100_000)
    .filter((event) => event.kind === 'run.state')
    .map((event) => String(event.payload.to))
    .filter((to) => isRunState(to) && isTerminalRunState(to));
}

async function settled(journal: DurableRunJournal, cp: FakeControlPlane, runId: string): Promise<void> {
  await waitFor(() => {
    const record = journal.get(runId);
    const attempt = [...cp.attempts.values()].find((candidate) => candidate.id === record?.attemptId);
    return record && isTerminalRunState(record.state) && journal.effects(runId).every((effect) => effect.status !== 'pending')
      && (attempt?.status === 'closed' || attempt?.status === 'released' || record.state === 'abandoned');
  }, `run ${runId} settled`);
}

const review: FollowUpRequest = {
  message: 'Handle the empty input too.',
  comments: [{ path: 'change.txt', line: 1, side: 'new', body: 'Use a constant here.' }],
};

function editScript(file: string): HostStep[] {
  return [
    { t: 'turn.started', turn: 1 },
    { t: 'message.delta', text: `Editing ${file}.` },
    { writeFile: file },
    { t: 'file.changed', path: file, kind: 'create' },
    { t: 'turn.finished', turn: 1, reason: 'idle' },
  ];
}

async function firstRun(h: ReturnType<typeof harness>, instance: { service: RunService; journal: DurableRunJournal }, taskId = 'task-1') {
  const started = await instance.service.submit({ credential: fakeCredential(), taskId });
  await settled(instance.journal, h.cp, started.runId);
  return started;
}

describe('follow-up turns (W07a)', () => {
  it('resumes the same session in the same worktree, fast-forwards the branch and reuses the PR', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    const first = await firstRun(h, instance);
    const parent = instance.journal.get(first.runId);
    expect(parent?.state).toBe('succeeded');
    const sessionId = parent?.sessionId ?? '';
    const firstSha = h.publication.remote.get(parent?.workspace?.branch ?? '');

    h.host.scripts.set('next', editScript('review.txt'));
    const original = h.host.scripts.get.bind(h.host.scripts);
    h.host.scripts.get = (key: string) => original(key) ?? original('next');
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    expect(turn).toMatchObject({ state: 'running', attemptId: 'attempt-3' });
    await settled(instance.journal, h.cp, turn.runId);

    const record = instance.journal.get(turn.runId);
    expect(record).toMatchObject({ state: 'succeeded', sessionId, terminal: { state: 'succeeded', reason: 'pull request updated' } });
    expect(record?.terminal?.outcome).toContain('Follow-up:');
    expect(record?.snapshot.followUp).toEqual({ parentRunId: first.runId, message: review.message, comments: review.comments });
    expect(record?.workspace).toMatchObject({ worktreePath: parent?.workspace?.worktreePath, branch: parent?.workspace?.branch, continuedFrom: first.runId });
    expect(record?.runtime?.resumedSessionId).toBe(sessionId);
    // Durable acceptance names the parent; one terminal; gap-free journal.
    expect(instance.journal.events(turn.runId, 0, 1)[0]).toMatchObject({ kind: 'run.accepted', payload: { followUpOf: first.runId, comments: 1 } });
    expect(terminalStates(instance.journal, turn.runId)).toEqual(['succeeded']);
    const seqs = instance.journal.events(turn.runId, 0, 100_000).map((event) => event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));

    // Same session, one more prompt: the deterministic review prompt.
    expect(h.host.sessions.size).toBe(1);
    expect(h.host.promptCount(sessionId)).toBe(2);
    const prompt = h.host.promptTexts.get(sessionId)?.[1] ?? '';
    expect(prompt).toContain(`Follow-up review of your previous turn on branch "${parent?.workspace?.branch}".`);
    expect(prompt).toContain('Comment 1 — file "change.txt", line 1 (new side of the diff):\n> Use a constant here.');
    expect(prompt).toContain('Reviewer message:\nHandle the empty input too.');
    expect(prompt).not.toContain(`<${UNTRUSTED_CONTENT_TAG}`);

    // Publication: a second commit on the same branch, fast-forward push, the same PR (no second POST).
    expect(h.publication.commits).toHaveLength(2);
    const secondSha = h.publication.commits[1]?.sha ?? '';
    expect(await h.publication.isAncestor({ ancestor: firstSha ?? '', descendant: secondSha })).toBe(true);
    expect(h.publication.remote.get(parent?.workspace?.branch ?? '')).toBe(secondSha);
    expect(h.publication.prPosts).toBe(1);
    expect(instance.journal.effects(turn.runId).find((effect) => effect.kind === 'git.push')?.receipt).toMatchObject({ sha: secondSha, fastForwardFrom: firstSha });
    expect(instance.journal.effects(turn.runId).find((effect) => effect.kind === 'pr.create')?.receipt).toMatchObject({ reused: true });
    // A new control-plane attempt; the task ends done with the same PR.
    expect(h.cp.attemptFor('task-1')).toMatchObject({ id: 'attempt-3', status: 'closed', terminalStatus: 'done', runStatus: 'succeeded' });
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'done', prUrl: 'https://github.com/acme/repo/pull/1', sessionId: null });
    expect(instance.service.describe('task-1')).toMatchObject({ runId: turn.runId, runner: 'opencode', followUp: { parentRunId: first.runId, mode: 'resume' } });
    expect(instance.service.reservationCount()).toBe(0);
  });

  it('seeds a fresh session with the previous diff when the session cannot be continued', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    const first = await firstRun(h, instance);
    const parentSession = instance.journal.get(first.runId)?.sessionId ?? '';
    h.host.resumable = false;
    h.scriptNext(editScript('seeded.txt'));
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    await settled(instance.journal, h.cp, turn.runId);
    const record = instance.journal.get(turn.runId);
    expect(record?.state).toBe('succeeded');
    expect(record?.sessionId).not.toBe(parentSession);
    expect(record?.runtime?.resumedSessionId ?? null).toBeNull();
    expect(h.host.promptCount(parentSession)).toBe(1);
    const prompt = h.host.promptTexts.get(record?.sessionId ?? '')?.[0] ?? '';
    expect(prompt).toContain('That session is not available, so its changes are shown below as a diff.');
    expect(prompt).toContain(`<${UNTRUSTED_CONTENT_TAG} source="git diff base000"`);
    expect(prompt).toContain('+++ b/change.txt');
    expect(prompt).toContain('Original task: Task task-1');
    expect(instance.service.describe('task-1')?.followUp).toEqual({ parentRunId: first.runId, mode: 'seeded' });
    expect(instance.service.logsFor('task-1').some((entry) => entry.message.includes('cannot be continued here'))).toBe(true);
    expect(h.publication.prPosts).toBe(1);
  });

  it('refuses while a turn runs, without a run, or without a retained worktree — before any attempt', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    h.cp.addTask('task-2');
    const instance = h.boot();
    await expect(instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FOLLOW_UP_UNSUPPORTED', details: { reason: 'no_run' } });

    // A live run: RUN_ACTIVE.
    h.scriptNext([{ t: 'turn.started', turn: 1 }, { hold: 'go' }, { writeFile: 'x.txt' }, { t: 'turn.finished', turn: 1, reason: 'idle' }]);
    const live = await instance.service.submit({ credential: fakeCredential(), taskId: 'task-2' });
    await expect(instance.service.followUp({ credential: fakeCredential(), taskId: 'task-2', request: review }))
      .rejects.toMatchObject({ statusCode: 409, code: 'RUN_ACTIVE' });
    [...h.host.sessions.values()].at(-1)?.release('go');
    await settled(instance.journal, h.cp, live.runId);

    // The control plane still sees the task running (e.g. on another device): RUN_ACTIVE.
    h.cp.tasks.set('task-2', { ...h.cp.tasks.get('task-2')!, status: 'in_progress', sessionId: 'ses_elsewhere' });
    const attemptsBefore = h.cp.attempts.size;
    await expect(instance.service.followUp({ credential: fakeCredential(), taskId: 'task-2', request: review }))
      .rejects.toMatchObject({ statusCode: 409, code: 'RUN_ACTIVE' });
    expect(h.cp.attempts.size).toBe(attemptsBefore);
    h.cp.tasks.set('task-2', { ...h.cp.tasks.get('task-2')!, status: 'done', sessionId: null });

    // Branch switched in the worktree, then the worktree removed: FOLLOW_UP_UNSUPPORTED, no attempt started.
    const worktree = instance.journal.get(live.runId)?.workspace?.worktreePath ?? '';
    h.workspace.switched.add(worktree);
    await expect(instance.service.followUp({ credential: fakeCredential(), taskId: 'task-2', request: review }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FOLLOW_UP_UNSUPPORTED', details: { reason: 'branch_changed' } });
    h.workspace.switched.clear();
    rmSync(worktree, { recursive: true, force: true });
    await expect(instance.service.followUp({ credential: fakeCredential(), taskId: 'task-2', request: review }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FOLLOW_UP_UNSUPPORTED', details: { reason: 'worktree_missing' } });
    expect(h.cp.attempts.size).toBe(attemptsBefore);
    expect(instance.service.reservationCount()).toBe(0);
  });

  it('publishes earlier unpublished commits when the turn changes nothing, and fails when nothing was ever made', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    h.cp.addTask('task-2');
    const instance = h.boot();
    // Parent committed but its PR creation failed (branch pushed, no PR).
    const createPullRequest = h.publication.createPullRequest.bind(h.publication);
    let failPr = true;
    h.publication.createPullRequest = async (input) => {
      if (failPr) throw Object.assign(new Error('GitHub 502'), { name: 'HttpError' });
      return createPullRequest(input);
    };
    const parent = await firstRun(h, instance);
    expect(instance.journal.get(parent.runId)?.state).toBe('failed');
    failPr = false;
    h.host.scripts.set('none', [{ t: 'turn.finished', turn: 1, reason: 'idle' }]);
    const get = h.host.scripts.get.bind(h.host.scripts);
    h.host.scripts.get = (key: string) => get(key) ?? get('none');
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'Open the PR please', comments: [] } });
    await settled(instance.journal, h.cp, turn.runId);
    expect(instance.journal.get(turn.runId)).toMatchObject({ state: 'succeeded', terminal: { prUrl: 'https://github.com/acme/repo/pull/1' } });
    expect(instance.journal.get(turn.runId)?.terminal?.outcome).toContain('no new changes');
    expect(h.publication.commits).toHaveLength(1);
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'done' });

    // A parent that never changed anything: the follow-up without changes fails honestly.
    h.scriptNext([{ t: 'turn.finished', turn: 1, reason: 'idle' }]);
    const empty = await firstRun(h, instance, 'task-2');
    expect(instance.journal.get(empty.runId)?.terminal?.reason).toBe('no changes');
    const nothing = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-2', request: { message: 'Anything?', comments: [] } });
    await settled(instance.journal, h.cp, nothing.runId);
    expect(instance.journal.get(nothing.runId)).toMatchObject({ state: 'failed', terminal: { reason: 'no changes', outcome: 'Follow-up finished without code changes' } });
  });

  it('never clobbers a branch someone else moved', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    const first = await firstRun(h, instance);
    const branch = instance.journal.get(first.runId)?.workspace?.branch ?? '';
    h.publication.remote.set(branch, 'f'.repeat(40));
    h.host.scripts.set('next', editScript('review.txt'));
    const get = h.host.scripts.get.bind(h.host.scripts);
    h.host.scripts.get = (key: string) => get(key) ?? get('next');
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    await settled(instance.journal, h.cp, turn.runId);
    expect(instance.journal.get(turn.runId)?.state).toBe('failed');
    expect(instance.journal.get(turn.runId)?.terminal?.reason).toContain('refusing to overwrite it');
    expect(h.publication.remote.get(branch)).toBe('f'.repeat(40));
    expect(h.publication.pushCalls).toBe(1);
  });

  it('keeps the adopted worktree when the follow-up fails during setup', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    const first = await firstRun(h, instance);
    h.host.failStart = new Error('runtime refused to start');
    await expect(instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review })).rejects.toThrow('runtime refused to start');
    const turn = instance.journal.latestForTask('task-1');
    expect(turn?.runId).not.toBe(first.runId);
    await settled(instance.journal, h.cp, turn?.runId ?? '');
    expect(turn?.workspace?.continuedFrom).toBe(first.runId);
    expect(h.workspace.released).toHaveLength(0);
    expect(h.workspace.exists(turn?.workspace ?? { worktreePath: '/nope', branch: '', baseRef: null, owned: false, handle: null })).toBe(true);
  });

  it('a sidecar crash during the follow-up turn reattaches without re-sending its prompt', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const holder: { instance?: { service: RunService; journal: DurableRunJournal } } = {};
    let armed = false;
    const instance = h.boot((phase, point) => {
      if (!armed || `${phase}:${point}` !== 'after:prompt:confirmed' || !holder.instance) return;
      armed = false;
      h.crash(holder.instance);
      throw new CrashSignal('crashed after the follow-up prompt');
    });
    holder.instance = instance;
    const first = await firstRun(h, instance);
    const sessionId = instance.journal.get(first.runId)?.sessionId ?? '';
    h.host.scripts.set('next', [{ t: 'turn.started', turn: 2 }, { hold: 'finish' }, { writeFile: 'review.txt' }, { t: 'turn.finished', turn: 2, reason: 'idle' }]);
    const get = h.host.scripts.get.bind(h.host.scripts);
    h.host.scripts.get = (key: string) => get(key) ?? get('next');
    armed = true;
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    await waitFor(() => instance.journal.isClosed, 'crash');

    const restarted = h.boot();
    await restarted.service.recover();
    await waitFor(() => restarted.journal.events(turn.runId, 0, 100_000).some((event) => event.kind === 'recovery' && event.payload.decision === 'reattach'), 'reattach');
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.host.sessions.get(sessionId)?.release('finish');
    await settled(restarted.journal, h.cp, turn.runId);
    expect(restarted.journal.get(turn.runId)?.state).toBe('succeeded');
    expect(h.host.promptCount(sessionId)).toBe(2);
    expect(terminalStates(restarted.journal, turn.runId)).toEqual(['succeeded']);
    expect(h.publication.prPosts).toBe(1);
  });
});

describe('W12 continuing a turn whose stop was never confirmed', () => {
  async function strandedRun(h: ReturnType<typeof harness>) {
    h.cp.addTask('task-1');
    h.scriptNext([{ t: 'turn.started', turn: 1 }, { t: 'tool.started', callId: 'c1', name: 'edit', input: {} }, { hold: 'never' }]);
    const first = h.boot();
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.events(started.runId, 0, 1_000).some((event) => event.payload.t === 'tool.started'), 'agent working');
    // Sidecar crash while the agent works; the runtime is unreachable at boot, so the stop cannot be confirmed.
    h.crash(first);
    h.host.reachable = false;
    const second = h.boot();
    await second.service.recover();
    await waitFor(() => second.journal.get(started.runId)?.state === 'recovery_required', 'recovery_required');
    const sessionId = second.journal.get(started.runId)?.sessionId ?? '';
    expect(h.host.sessions.get(sessionId)?.status).toBe('busy');
    return { second, parentRunId: started.runId, sessionId };
  }

  it('refuses while the agent cannot be confirmed stopped (AGENT_MAY_BE_RUNNING), nothing started', async () => {
    const h = harness();
    const { second, parentRunId, sessionId } = await strandedRun(h);
    const attempts = h.cp.attempts.size;
    await expect(second.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review }))
      .rejects.toMatchObject({ statusCode: 409, code: 'AGENT_MAY_BE_RUNNING', details: { parentRunId, state: 'recovery_required' } });
    expect(h.cp.attempts.size).toBe(attempts);
    expect(h.host.promptCount(sessionId)).toBe(1);
    // The reservation was released: once the runtime answers, the agent is stopped first and the turn continues.
    h.host.reachable = true;
    h.scriptNext(editScript('rest.txt'));
    const turn = await second.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    expect(h.host.aborts.get(sessionId) ?? 0).toBeGreaterThan(0);
    expect(h.host.sessions.get(sessionId)?.status).not.toBe('busy');
    await settled(second.journal, h.cp, turn.runId);
    expect(second.journal.get(turn.runId)?.state).toBe('succeeded');
  });

  it('Continue naming another run (another device, or a newer run here) is refused before the agent is probed or anything starts', async () => {
    const h = harness();
    const { second, parentRunId, sessionId } = await strandedRun(h);
    // The runtime answers again: without the run-id check this follow-up would abort and resume this session.
    h.host.reachable = true;
    const attempts = h.cp.attempts.size;
    await expect(second.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review, parentRunId: 'run-on-another-device' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FOLLOW_UP_RUN_MISMATCH', details: { expected: 'run-on-another-device', latest: parentRunId } });
    expect(h.cp.attempts.size).toBe(attempts);
    expect(h.host.aborts.get(sessionId) ?? 0).toBe(0);
    expect(h.host.promptCount(sessionId)).toBe(1);
    expect(h.host.sessions.get(sessionId)?.status).toBe('busy');
    expect(second.journal.latestForTask('task-1')?.runId).toBe(parentRunId);
    expect(second.service.reservationCount()).toBe(0);

    // A task with no run on this device: refused the same way, naming no latest run.
    h.cp.addTask('task-2');
    await expect(second.service.followUp({ credential: fakeCredential(), taskId: 'task-2', request: review, parentRunId }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FOLLOW_UP_RUN_MISMATCH', details: { expected: parentRunId, latest: null } });
    expect(h.cp.attempts.size).toBe(attempts);
    expect(second.service.reservationCount()).toBe(0);

    // The run on screen is the latest one here: Continue resumes it.
    const turn = await second.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review, parentRunId });
    expect(h.host.aborts.get(sessionId) ?? 0).toBeGreaterThan(0);
    await settled(second.journal, h.cp, turn.runId);
    expect(second.journal.get(turn.runId)).toMatchObject({ state: 'succeeded', snapshot: { followUp: { parentRunId } } });
  });

  it('a follow-up without a run id still continues the latest run (review follow-ups)', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    const first = await firstRun(h, instance);
    // Follow-ups resume the same session: each turn edits a new file so it has something to publish.
    let nextTurn = editScript('review.txt');
    const get = h.host.scripts.get.bind(h.host.scripts);
    h.host.scripts.get = (key: string) => get(key) ?? nextTurn;
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    await settled(instance.journal, h.cp, turn.runId);
    expect(instance.journal.get(turn.runId)).toMatchObject({ state: 'succeeded', snapshot: { followUp: { parentRunId: first.runId } } });
    // The first run is no longer the latest: naming it is refused, naming the turn continues.
    const attempts = h.cp.attempts.size;
    await expect(instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review, parentRunId: first.runId }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FOLLOW_UP_RUN_MISMATCH', details: { expected: first.runId, latest: turn.runId } });
    expect(h.cp.attempts.size).toBe(attempts);
    expect(instance.service.reservationCount()).toBe(0);
    nextTurn = editScript('again.txt');
    const next = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review, parentRunId: turn.runId });
    await settled(instance.journal, h.cp, next.runId);
    expect(instance.journal.get(next.runId)).toMatchObject({ state: 'succeeded', snapshot: { followUp: { parentRunId: turn.runId } } });
  });
});

describe('W12a turn limit', () => {
  it('a turn that hits its limit fails with the work kept and nothing published; a follow-up continues it', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    h.scriptNext([
      { t: 'turn.started', turn: 1 },
      { writeFile: 'partial.txt' },
      { t: 'file.changed', path: 'partial.txt', kind: 'create' },
      { t: 'diagnostic', code: 'max_turns', message: 'stopped at the maximum number of turns' },
      { t: 'turn.finished', turn: 1, reason: 'max_turns' },
    ]);
    const first = await firstRun(h, instance);
    const record = instance.journal.get(first.runId);
    expect(record?.state).toBe('failed');
    expect(h.publication.pushCalls).toBe(0);
    expect(h.publication.prPosts).toBe(0);
    expect(h.cp.tasks.get('task-1')?.status).not.toBe('done');
    expect(h.cp.tasks.get('task-1')?.outcome ?? '').toMatch(/turn limit/);
    expect(h.workspace.released).toEqual([]);

    // The kept worktree is continued by a follow-up, which publishes the earlier work too.
    h.scriptNext(editScript('rest.txt'));
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    await settled(instance.journal, h.cp, turn.runId);
    expect(instance.journal.get(turn.runId)?.state).toBe('succeeded');
    expect(h.publication.prPosts).toBe(1);
  });
});

/** Script the follow-up turn of a resumed session (same pattern as the W07a tests above). */
function resumedTurn(h: ReturnType<typeof harness>, steps: HostStep[]): void {
  h.host.scripts.set('next', steps);
  const original = h.host.scripts.get.bind(h.host.scripts);
  h.host.scripts.get = (key: string) => original(key) ?? original('next');
}

describe('W12a follow-up that does not succeed', () => {
  it('leaves the task done with its published pull request; the turn itself is recorded as failed', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    h.scriptNext(editScript('change.txt'));
    const first = await firstRun(h, instance);
    const prUrl = instance.journal.get(first.runId)?.terminal?.prUrl;
    expect(prUrl).toBeTruthy();

    resumedTurn(h, [{ t: 'turn.started', turn: 1 }, { t: 'error', code: 'auth', message: 'bad key', retryable: false }]);
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    await settled(instance.journal, h.cp, turn.runId);
    expect(instance.journal.get(turn.runId)?.state).toBe('failed');
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'done', prUrl });
    expect(h.cp.tasks.get('task-1')?.outcome).toMatch(/^Follow-up failed.*; the pull request is unchanged$/);
    const attempt = [...h.cp.attempts.values()].find((candidate) => candidate.id === instance.journal.get(turn.runId)?.attemptId);
    expect(attempt).toMatchObject({ terminalStatus: 'done', runStatus: 'failed' });
    expect(h.publication.prPosts).toBe(1);
  });

  it('a cancelled follow-up keeps the pull request too', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    h.scriptNext(editScript('change.txt'));
    const first = await firstRun(h, instance);
    const prUrl = instance.journal.get(first.runId)?.terminal?.prUrl;

    resumedTurn(h, [{ t: 'turn.started', turn: 1 }, { hold: 'never' }]);
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    await waitFor(() => instance.journal.get(turn.runId)?.state === 'running' ? true : null, 'turn running');
    const cancelled = await instance.service.cancel('task-1');
    expect(cancelled.success).toBe(true);
    await settled(instance.journal, h.cp, turn.runId);
    expect(h.cp.tasks.get('task-1')).toMatchObject({ status: 'done', prUrl });
    expect(h.cp.tasks.get('task-1')?.outcome).toMatch(/^Follow-up cancelled; the pull request is unchanged$/);
  });
});

describe('W12 stop and redirect', () => {
  it('stops the running turn (work kept) and continues with the instruction on the same worktree', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    // First turn: edits a file, then keeps going until stopped.
    h.scriptNext([{ t: 'turn.started', turn: 1 }, { writeFile: 'wip.txt' }, { t: 'file.changed', path: 'wip.txt', kind: 'create' }, { hold: 'never' }]);
    const first = await instance.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => instance.journal.get(first.runId)?.state === 'running' ? true : null, 'first turn running');
    await waitFor(() => instance.journal.get(first.runId)?.workspace ? true : null, 'worktree prepared');

    resumedTurn(h, editScript('redirected.txt'));
    const turn = await instance.service.redirect({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'Stop that; use the existing helper instead.', comments: [] } });
    // The first turn was stopped as a cancel, its work retained.
    expect(instance.journal.get(first.runId)).toMatchObject({ state: 'cancelled' });
    expect(instance.journal.get(first.runId)?.terminal?.outcome).toContain('Work retained on');
    await settled(instance.journal, h.cp, turn.runId);
    const record = instance.journal.get(turn.runId);
    expect(record?.snapshot.followUp).toMatchObject({ parentRunId: first.runId, message: 'Stop that; use the existing helper instead.' });
    expect(record?.workspace).toMatchObject({ worktreePath: instance.journal.get(first.runId)?.workspace?.worktreePath, continuedFrom: first.runId });
    const prompts = [...h.host.promptTexts.values()].flat();
    expect(prompts.some((prompt) => prompt.includes('Stop that; use the existing helper instead.'))).toBe(true);
  });

  it('with nothing running it is a plain follow-up; a turn that will not stop answers REDIRECT_PENDING', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    const instance = h.boot();
    h.scriptNext(editScript('change.txt'));
    await firstRun(h, instance);
    resumedTurn(h, editScript('more.txt'));
    const plain = await instance.service.redirect({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'One more thing.', comments: [] } });
    await settled(instance.journal, h.cp, plain.runId);
    expect(instance.journal.get(plain.runId)?.snapshot.followUp?.message).toBe('One more thing.');

    resumedTurn(h, [{ t: 'turn.started', turn: 1 }, { hold: 'never' }]);
    const stuck = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'Keep going.', comments: [] } });
    await waitFor(() => instance.journal.get(stuck.runId)?.state === 'running' ? true : null, 'turn running');
    // The turn does not stop in time: the redirect says so and starts nothing.
    const realCancel = instance.service.cancel.bind(instance.service);
    instance.service.cancel = async () => ({ success: false, error: 'Cancellation is still in progress', state: 'running' });
    const attemptsBefore = h.cp.attempts.size;
    await expect(instance.service.redirect({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'Now.', comments: [] } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'REDIRECT_PENDING', details: { state: 'running' } });
    expect(h.cp.attempts.size).toBe(attemptsBefore);
    instance.service.cancel = realCancel;
    expect((await instance.service.cancel('task-1')).success).toBe(true);
  });
});

describe('review fix: redirect before the agent started', () => {
  it('refuses to redirect a queued turn (nothing to continue) and leaves it queued', async () => {
    const h = harness();
    h.cp.addTask('task-1');
    h.cp.addTask('task-2');
    h.cp.parallelLimit = 1;
    const instance = h.boot();
    h.scriptNext([{ t: 'turn.started', turn: 1 }, { hold: 'never' }]);
    const first = await instance.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => instance.journal.get(first.runId)?.state === 'running' ? true : null, 'first running');
    const queued = await instance.service.submit({ credential: fakeCredential(), taskId: 'task-2' });
    expect(queued.state).toBe('queued');
    await expect(instance.service.redirect({ credential: fakeCredential(), taskId: 'task-2', request: { message: 'Now this.', comments: [] } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'REDIRECT_NOT_READY', details: { state: 'queued' } });
    expect(instance.journal.get(queued.runId)?.state).toBe('queued');
    expect((await instance.service.cancel('task-2')).success).toBe(true);
    expect((await instance.service.cancel('task-1')).success).toBe(true);
  });
});

