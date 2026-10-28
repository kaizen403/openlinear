import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isTerminalRunState, runEffectKey, type AgentSession, type StartInput } from '@openlinear/execution-core';
import { DurableRunJournal } from '../journal/durable';
import type { ClaudeCodeRunner } from '../runners/claude-code/index';
import type { CodexRunner } from '../runners/codex/index';
import { runnerRuntimeDir } from '../runners/shared/sandboxed-process';
import type { FakeStep } from '../runners/testing/fake-cli';
import { claudeInit, claudeResult, codexSuccess } from '../runners/testing/fixtures';
import { claudeHarness, codexHarness, isAlive, type ProcessHarness } from '../runners/testing/harness';
import type { FaultHook } from './faults';
import { createProcessRuntime, nativeModelFor, stopOrphanProcess, systemProcessProbe, type ProcessRunner } from './process-runtime';
import { RunService, type RunServiceOptions } from './service';
import { FakeControlPlane, FakePublication, FakeWorkspace, fakeCredential, fakeSnapshot } from './test-support';

/**
 * W07a — Claude Code and Codex on the durable run engine, through the real
 * runner adapters over the fake CLIs (no model is contacted) under the
 * pass-through sandbox provider: journal before dispatch, positive stop
 * receipts, honest recovery (`detached` → recovery_required, orphan
 * stopped, never re-prompted), preflight failures before any effect, and
 * follow-up turns that resume the CLI's own saved session.
 */

let root = '';
const services: RunService[] = [];

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ol-process-runtime-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
});

const TEST_OPTIONS: Partial<RunServiceOptions> = {
  heartbeatMs: 3_600_000,
  retryBaseMs: 5,
  retryMaxMs: 20,
  relayDelayMs: 0,
  relayRetryBaseMs: 5,
  relayRetryMaxMs: 20,
  interruptGraceMs: 0,
  startWaitMs: 15_000,
  watchdogIntervalMs: 20,
  watchdog: { transportMs: 1e9, noProgressMs: 1e9, wallClockMs: 1e9 },
};

async function waitFor<T>(probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let counter = 0;

interface Setup<R> {
  h: ProcessHarness<R>;
  cp: FakeControlPlane;
  publication: FakePublication;
  workspace: FakeWorkspace;
  journalPath: string;
  boot(options?: { faults?: FaultHook | null; detachSignal?: boolean }): { service: RunService; journal: DurableRunJournal };
  setSteps(steps: FakeStep[]): void;
  starts(): Array<{ argv?: string[]; prompt?: string; pid?: number }>;
}

/** Keeps the child process out of the service's abort signal (a crashed sidecar cannot kill its children). */
function detached(runner: ProcessRunner): ProcessRunner {
  const keep = (signal: AbortSignal) => (signal.aborted ? signal : new AbortController().signal);
  return {
    id: runner.id,
    start: (input: StartInput): Promise<AgentSession> => runner.start({ ...input, signal: keep(input.signal) }),
    resume: (id, input) => runner.resume(id, { ...input, signal: keep(input.signal) }),
    preflight: (input) => runner.preflight(input),
    canResume: (id, worktree) => runner.canResume(id, worktree),
  };
}

function setup<R extends ClaudeCodeRunner | CodexRunner>(kind: 'claude' | 'codex', steps: FakeStep[], options: { login?: boolean } = {}): Setup<R> {
  counter += 1;
  const base = join(root, `case-${counter}`);
  mkdirSync(base, { recursive: true });
  const h = (kind === 'claude' ? claudeHarness(base, steps) : codexHarness(base, steps)) as unknown as ProcessHarness<R>;
  if (options.login !== false) {
    // The user's own CLI login file (never read by the sidecar; linked read-only into the sandbox).
    const file = kind === 'claude' ? join(h.home, '.claude', '.credentials.json') : join(h.home, '.codex', 'auth.json');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{"fixture":true}');
  }
  const cp = new FakeControlPlane();
  const runnerId = kind === 'claude' ? 'claude-code' : 'codex';
  cp.snapshot = (taskId) => fakeSnapshot(taskId, { agent: runnerId, model: kind === 'claude' ? 'anthropic/claude-opus-5-5' : 'openai/gpt-5.5-codex' });
  const publication = new FakePublication();
  const workspace = new FakeWorkspace(join(base, 'worktrees'));
  const journalPath = join(base, 'journal', 'runs-v2.sqlite');
  return {
    h,
    cp,
    publication,
    workspace,
    journalPath,
    boot(bootOptions = {}) {
      const journal = new DurableRunJournal(journalPath);
      const runner = h.runner as unknown as ProcessRunner;
      const service = new RunService({
        journal,
        controlPlane: cp,
        runtimes: new Map([[runnerId, createProcessRuntime(bootOptions.detachSignal ? detached(runner) : runner)]]),
        publication,
        workspace,
        faults: bootOptions.faults ?? null,
        options: TEST_OPTIONS,
      });
      services.push(service);
      return { service, journal };
    },
    setSteps(next) {
      writeFileSync(`${h.binary}.scenario.json`, JSON.stringify({ steps: next }));
    },
    starts: () => h.invocations().filter((entry) => entry.event === 'start'),
  };
}

async function settled(journal: DurableRunJournal, cp: FakeControlPlane, runId: string): Promise<void> {
  await waitFor(() => {
    const record = journal.get(runId);
    const attempt = [...cp.attempts.values()].find((candidate) => candidate.id === record?.attemptId);
    return record && isTerminalRunState(record.state) && journal.effects(runId).every((effect) => effect.status !== 'pending')
      && (attempt?.status === 'closed' || attempt?.status === 'released' || record.state === 'abandoned');
  }, `run ${runId} settled`, 15_000);
}

function claudeEdit(file: string): FakeStep[] {
  return [
    { line: claudeInit() },
    { write: { path: file, content: `edit ${file}\n` } },
    { line: { type: 'user', uuid: 'u-tr', session_id: '$SESSION', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } } },
    { line: claudeResult() },
  ];
}

function codexEdit(file: string, threadId = 'thread-1'): FakeStep[] {
  const events = codexSuccess(threadId);
  return [...events.slice(0, -1).map((line) => ({ line })), { write: { path: file, content: `edit ${file}\n` } }, { line: events.at(-1) }];
}

const review = { message: 'Rename the helper.', comments: [{ path: 'a.txt', line: 1, side: 'new' as const, body: 'Prefer a verb.' }] };

describe('process runtimes on the run engine (W07a)', () => {
  it('maps task models to the CLI and refuses another provider before anything runs', () => {
    expect(nativeModelFor('claude-code', 'anthropic/claude-opus-5-5')).toEqual({ provider: 'anthropic', id: 'claude-opus-5-5' });
    expect(nativeModelFor('claude-code', 'sonnet')).toEqual({ provider: 'anthropic', id: 'sonnet' });
    expect(nativeModelFor('codex', 'openai/gpt-5.5-codex')).toEqual({ provider: 'openai', id: 'gpt-5.5-codex' });
    expect(nativeModelFor('codex', null)).toBeNull();
    expect(() => nativeModelFor('claude-code', 'openai/gpt-5')).toThrow(expect.objectContaining({ code: 'RUNNER_NOT_SUPPORTED' }));
    expect(() => nativeModelFor('codex', 'anthropic/claude-opus-5-5')).toThrow(expect.objectContaining({ code: 'RUNNER_NOT_SUPPORTED' }));
    expect(() => nativeModelFor('claude-code', 'bad model; rm -rf')).toThrow(expect.objectContaining({ code: 'RUNNER_NOT_SUPPORTED' }));
  });

  it('Claude Code: spawns before the claim, prompts only after the prompt intent is journaled, publishes once', { timeout: 30_000 }, async () => {
    const s = setup<ClaudeCodeRunner>('claude', claudeEdit('a.txt'));
    s.cp.addTask('task-1');
    const checks: string[] = [];
    let journalRef: DurableRunJournal | null = null;
    const instance = s.boot({
      faults: async (phase, point, runId) => {
        if (phase === 'before' && point === 'effect:attempt.claim:dispatch') {
          // The process is up (sandbox/binary/credential checked), but no prompt went out.
          await new Promise((resolve) => setTimeout(resolve, 300));
          checks.push(`claim:starts=${s.starts().length}:prompt=${journalRef?.effect(runId, runEffectKey(runId, 'prompt.submit')) ? 'journaled' : 'absent'}`);
        }
      },
    });
    journalRef = instance.journal;
    const started = await instance.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    expect(started.state).toBe('running');
    await settled(instance.journal, s.cp, started.runId);
    expect(checks).toEqual(['claim:starts=0:prompt=absent']);
    const record = instance.journal.get(started.runId);
    expect(record).toMatchObject({ state: 'succeeded', runner: 'claude-code', runtime: { kind: 'claude-code', sandboxMode: 'enforce' } });
    expect(record?.runtime?.process?.pid).toEqual(expect.any(Number));
    expect(s.starts()).toHaveLength(1);
    const argv = s.starts()[0]?.argv ?? [];
    expect(argv).toEqual(expect.arrayContaining(['--session-id', record?.sessionId ?? '', '--model', 'claude-opus-5-5']));
    expect(s.starts()[0]?.prompt).toContain('Task task-1');
    expect(s.publication.commits).toHaveLength(1);
    expect(s.publication.prPosts).toBe(1);
    expect(s.cp.attemptFor('task-1')).toMatchObject({ status: 'closed', terminalStatus: 'done' });
    expect(record?.usage?.messages.turn?.cost).toBeGreaterThan(0);
  });

  it('Codex: journals the real thread id once it arrives', { timeout: 30_000 }, async () => {
    const s = setup<CodexRunner>('codex', codexEdit('a.txt', 'thread-abc12345'));
    s.cp.addTask('task-1');
    const instance = s.boot();
    const started = await instance.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(instance.journal, s.cp, started.runId);
    const record = instance.journal.get(started.runId);
    expect(record).toMatchObject({ state: 'succeeded', sessionId: 'thread-abc12345', runtime: { kind: 'codex' } });
    expect(s.starts()).toHaveLength(1);
    expect(s.starts()[0]?.argv).toEqual(expect.arrayContaining(['exec', '--experimental-json', '--model', 'gpt-5.5-codex', '--sandbox', 'danger-full-access']));
    expect(s.starts()[0]?.argv).not.toContain('resume');
  });

  it('fails unsupported combinations before any effect: no login (412), wrong model (400)', { timeout: 30_000 }, async () => {
    const claude = setup<ClaudeCodeRunner>('claude', claudeEdit('a.txt'), { login: false });
    claude.cp.addTask('task-1');
    const a = claude.boot();
    await expect(a.service.submit({ credential: fakeCredential(), taskId: 'task-1' })).rejects.toMatchObject({ statusCode: 412, code: 'RUNNER_AUTH_UNAVAILABLE' });
    expect(a.journal.latestForTask('task-1')).toBeNull();
    expect(claude.cp.attemptFor('task-1')).toMatchObject({ status: 'released', closeReason: 'runner_auth_unavailable' });
    expect(claude.h.spawns()).toBe(0);
    expect(a.service.reservationCount()).toBe(0);

    const codex = setup<CodexRunner>('codex', codexEdit('a.txt'), { login: false });
    codex.cp.addTask('task-1');
    const b = codex.boot();
    await expect(b.service.submit({ credential: fakeCredential(), taskId: 'task-1' })).rejects.toMatchObject({ statusCode: 412, code: 'RUNNER_AUTH_UNAVAILABLE' });
    expect(codex.h.spawns()).toBe(0);

    const model = setup<ClaudeCodeRunner>('claude', claudeEdit('a.txt'));
    model.cp.snapshot = (taskId) => fakeSnapshot(taskId, { agent: 'claude', model: 'openai/gpt-5' });
    model.cp.addTask('task-1');
    const c = model.boot();
    await expect(c.service.submit({ credential: fakeCredential(), taskId: 'task-1' })).rejects.toMatchObject({ statusCode: 400, code: 'RUNNER_NOT_SUPPORTED' });
    expect(c.journal.latestForTask('task-1')).toBeNull();
    expect(model.h.spawns()).toBe(0);
  });

  it('cancels a running Claude turn with a positive stop receipt', { timeout: 30_000 }, async () => {
    const s = setup<ClaudeCodeRunner>('claude', [{ line: claudeInit() }, { hang: true }]);
    s.cp.addTask('task-1');
    const instance = s.boot();
    const started = await instance.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => instance.journal.effect(started.runId, runEffectKey(started.runId, 'prompt.submit'))?.status === 'confirmed', 'prompt confirmed');
    const pid = s.starts()[0]?.pid;
    expect(await instance.service.cancel('task-1')).toMatchObject({ success: true, state: 'cancelled' });
    await settled(instance.journal, s.cp, started.runId);
    const receipts = instance.journal.events(started.runId, 0, 10_000).filter((event) => event.kind === 'agent' && event.payload.t === 'cancel.receipt');
    expect(receipts.map((event) => event.payload.confirmedBy)).toEqual(['runner-ack']);
    expect(s.cp.attemptFor('task-1')).toMatchObject({ cancelAcknowledged: true, runStatus: 'cancelled' });
    await waitFor(() => !isAlive(pid), 'claude process gone');
  });

  it('after a sidecar crash a Claude run ends recovery_required: orphan stopped, work retained, never re-prompted', { timeout: 30_000 }, async () => {
    const s = setup<ClaudeCodeRunner>('claude', [{ line: claudeInit() }, { write: { path: 'partial.txt', content: 'half done\n' } }, { hang: true }]);
    s.cp.addTask('task-1');
    const first = s.boot({ detachSignal: true });
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => first.journal.effect(started.runId, runEffectKey(started.runId, 'prompt.submit'))?.status === 'confirmed', 'prompt confirmed');
    const pid = s.starts()[0]?.pid;
    expect(isAlive(pid)).toBe(true);
    // SIGKILL simulation: the service and journal die; the CLI process survives as an orphan.
    first.service.stop();
    first.journal.close();
    expect(isAlive(pid)).toBe(true);

    const second = s.boot();
    await second.service.recover();
    await settled(second.journal, s.cp, started.runId);
    const record = second.journal.get(started.runId);
    expect(record).toMatchObject({ state: 'recovery_required', terminal: { claimed: true } });
    expect(record?.terminal?.outcome).toContain('Work retained on openlinear/');
    const recovery = second.journal.events(started.runId, 0, 10_000).find((event) => event.kind === 'recovery' && 'decision' in event.payload);
    expect(recovery?.payload).toMatchObject({ decision: 'recovery-required', runtime: 'detached' });
    await waitFor(() => !isAlive(pid), 'orphan stopped');
    expect(s.starts()).toHaveLength(1);
    expect(s.cp.tasks.get('task-1')).toMatchObject({ status: 'cancelled', sessionId: null });
    expect(s.cp.attemptFor('task-1')).toMatchObject({ status: 'closed', runStatus: 'failed' });
    expect(second.service.reservationCount()).toBe(0);
  });

  it('follow-up resumes the saved Claude session with --resume, else seeds a fresh one', { timeout: 40_000 }, async () => {
    const s = setup<ClaudeCodeRunner>('claude', claudeEdit('a.txt'));
    s.cp.addTask('task-1');
    const instance = s.boot();
    const first = await instance.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(instance.journal, s.cp, first.runId);
    const parent = instance.journal.get(first.runId);
    const worktree = parent?.workspace?.worktreePath ?? '';
    const sessionId = parent?.sessionId ?? '';
    // Claude saves the transcript in the worktree's private config dir.
    const runtimeDir = runnerRuntimeDir('claude-code', worktree, s.h.env) ?? '';
    mkdirSync(join(runtimeDir, 'projects', 'worktree'), { recursive: true });
    writeFileSync(join(runtimeDir, 'projects', 'worktree', `${sessionId}.jsonl`), '{}\n');

    s.setSteps(claudeEdit('b.txt'));
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    await settled(instance.journal, s.cp, turn.runId);
    expect(instance.journal.get(turn.runId)).toMatchObject({ state: 'succeeded', sessionId, runtime: { resumedSessionId: sessionId } });
    const resumed = s.starts()[1];
    expect(resumed?.argv).toEqual(expect.arrayContaining(['--resume', sessionId]));
    expect(resumed?.argv).not.toContain('--session-id');
    expect(resumed?.prompt).toContain('Comment 1 — file "a.txt", line 1 (new side of the diff):\n> Prefer a verb.');
    expect(s.publication.commits).toHaveLength(2);
    expect(s.publication.prPosts).toBe(1);

    // Without a saved transcript: a fresh session seeded with the previous diff.
    rmSync(join(runtimeDir, 'projects'), { recursive: true, force: true });
    s.setSteps(claudeEdit('c.txt'));
    const seeded = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'One more thing.', comments: [] } });
    await settled(instance.journal, s.cp, seeded.runId);
    const fresh = s.starts()[2];
    expect(fresh?.argv).toContain('--session-id');
    expect(fresh?.argv).not.toContain('--resume');
    expect(fresh?.prompt).toContain('untrusted-repository-content');
    expect(instance.journal.get(seeded.runId)?.state).toBe('succeeded');
    expect(s.publication.prPosts).toBe(1);
  });

  it('follow-up resumes a saved Codex thread with `exec resume <thread>`', { timeout: 40_000 }, async () => {
    const s = setup<CodexRunner>('codex', codexEdit('a.txt', 'thread-follow01'));
    s.cp.addTask('task-1');
    const instance = s.boot();
    const first = await instance.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(instance.journal, s.cp, first.runId);
    const worktree = instance.journal.get(first.runId)?.workspace?.worktreePath ?? '';
    const home = runnerRuntimeDir('codex', worktree, s.h.env) ?? '';
    mkdirSync(join(home, 'sessions', '2026', '10', '26'), { recursive: true });
    writeFileSync(join(home, 'sessions', '2026', '10', '26', 'rollout-2026-10-26T10-00-00-thread-follow01.jsonl'), '{}\n');
    s.setSteps(codexEdit('b.txt', 'thread-follow01'));
    const turn = await instance.service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: review });
    await settled(instance.journal, s.cp, turn.runId);
    expect(instance.journal.get(turn.runId)).toMatchObject({ state: 'succeeded', sessionId: 'thread-follow01' });
    const argv = s.starts()[1]?.argv ?? [];
    expect(argv.slice(-2)).toEqual(['resume', 'thread-follow01']);
    expect(s.starts()[1]?.prompt).toContain('Reviewer message:\nRename the helper.');
  });
});

describe('orphan process control (identity-checked)', () => {
  it('stops a verified orphan group, treats a gone or recycled pid as stopped, and never signals an unverifiable one', { timeout: 20_000 }, async () => {
    const launchedAt = Date.now();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid ?? 0;
    const spawnedBy = Date.now();
    await waitFor(async () => (await systemProcessProbe.identify(pid)) !== null, 'child visible to ps');
    // A recycled pid (start time outside the launch window) is "ours is gone": not signalled.
    expect(await stopOrphanProcess({ pid, launchedAt: launchedAt - 3_600_000, spawnedBy: spawnedBy - 3_590_000 })).toBe(true);
    expect(isAlive(pid)).toBe(true);
    // Unverifiable identity: not confirmed, not signalled.
    expect(await stopOrphanProcess({ pid, launchedAt: null, spawnedBy }, { ...systemProcessProbe, identify: async () => ({ pgid: pid, startedAt: null }) })).toBe(false);
    expect(isAlive(pid)).toBe(true);
    // The real identity: stopped and confirmed.
    expect(await stopOrphanProcess({ pid, launchedAt, spawnedBy })).toBe(true);
    await waitFor(() => !isAlive(pid), 'orphan gone');
    // Gone: confirmed without signalling; no identity: unconfirmed.
    expect(await stopOrphanProcess({ pid, launchedAt, spawnedBy })).toBe(true);
    expect(await stopOrphanProcess(null)).toBe(false);
    expect(await stopOrphanProcess({ pid: null, launchedAt, spawnedBy })).toBe(true);
  });
});
