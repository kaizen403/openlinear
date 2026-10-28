import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunner } from '@openlinear/execution-core';
import { reduceUsage } from '@openlinear/execution-core';

vi.mock('../../services/opencode', () => ({
  getClientForUser: vi.fn(),
  getOpenCodeStatus: vi.fn(() => ({ mode: 'host', serverUrl: 'http://127.0.0.1:4096', running: true, restartAttempts: 0 })),
}));

import { getRunnerCatalogue, sandboxSummary } from '../catalogue';
import { pickRunner, getRunnerRegistry } from '../index';
import { fakeProvider, fakeReport } from '../testing/fake-cli';
import { AsyncQueue } from './async-queue';
import { parseSemver, runShortCommand, semverAtLeast } from './binary';
import { JsonLineSplitter, type JsonLine } from './jsonl';
import { terminateProcessGroup, type ExitInfo, type GroupHandle } from './process-group';
import { scrubSecrets } from './process-session';
import { readSessionUsage, writeSessionUsage } from './records';
import { launchRunnerProcess, resetRunnerGcForTests, runnerAttemptKey, type RunnerProcessSpec } from './sandboxed-process';

let root = '';
let worktree = '';

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-runner-shared-')));
  worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('JsonLineSplitter', () => {
  it('splits across chunk boundaries, skips blanks and reports bad and oversized lines without stopping', () => {
    const lines: JsonLine[] = [];
    const splitter = new JsonLineSplitter((line) => lines.push(line), 64);
    splitter.push(Buffer.from('{"a":1}\n\n{"b"'));
    splitter.push(':2}\nnot json\n');
    splitter.push(`{"big":"${'x'.repeat(100)}`);
    splitter.push('"}\n{"after":true}\n{"tail":1}');
    splitter.end();
    expect(lines).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
      { ok: false, reason: 'invalid_json', sample: 'not json' },
      { ok: false, reason: 'too_long', sample: expect.stringMatching(/^\{"big":"x{100}$/) },
      { ok: true, value: { after: true } },
      { ok: true, value: { tail: 1 } },
    ]);
  });

  it('decodes multi-byte characters split across chunks', () => {
    const lines: JsonLine[] = [];
    const splitter = new JsonLineSplitter((line) => lines.push(line));
    const bytes = Buffer.from('{"t":"é✓"}\n');
    splitter.push(bytes.subarray(0, 8));
    splitter.push(bytes.subarray(8));
    splitter.end();
    expect(lines).toEqual([{ ok: true, value: { t: 'é✓' } }]);
  });
});

describe('small helpers', () => {
  it('queues items for a single consumer and finishes after close', async () => {
    const queue = new AsyncQueue<number>();
    const pending = queue.next();
    queue.push(1);
    queue.push(2);
    expect(await pending).toEqual({ value: 1, done: false });
    queue.close();
    queue.push(3);
    expect(await queue.next()).toEqual({ value: 2, done: false });
    expect(await queue.next()).toEqual({ value: undefined, done: true });
  });

  it('scrubs credential-shaped strings from runner output', () => {
    expect(scrubSecrets('key sk-ant-api03-abcdefghij and sk-proj-ABCDEFGHIJKLMNOPQRST, ghp_abcdefghijklmnop1234, Bearer abcdefghijklmnopqrstuv'))
      .toBe('key [redacted] and [redacted], [redacted], [redacted]');
  });

  it('parses and compares versions', () => {
    expect(parseSemver('2.1.310 (Claude Code)')).toEqual([2, 1, 310]);
    expect(parseSemver('nothing')).toBeNull();
    expect(semverAtLeast([2, 1, 310], [2, 1, 259])).toBe(true);
    expect(semverAtLeast([2, 1, 200], [2, 1, 259])).toBe(false);
    expect(semverAtLeast(null, [0, 0, 1])).toBe(false);
  });

  it('runs short commands with an exact env and a group-killing timeout', async () => {
    const ok = await runShortCommand('/bin/sh', ['-c', 'printf "%s" "$ONLY"'], { env: { ONLY: 'yes', PATH: '/usr/bin:/bin' } });
    expect(ok).toMatchObject({ code: 0, stdout: 'yes', timedOut: false });
    const slow = await runShortCommand('/bin/sh', ['-c', 'sleep 5 & sleep 5'], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    const missing = await runShortCommand(join(root, 'nope'), [], { env: {} });
    expect(missing.error).toBeDefined();
  });

  it('records session usage baselines host-side', () => {
    const env = { OPENLINEAR_SANDBOX_DIR: join(root, 'records-sandbox') };
    expect(readSessionUsage('claude-code', 'sess', env)).toBeNull();
    writeSessionUsage('claude-code', 'sess', { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0 }, costUsd: 0.5, updatedAt: 'now' }, env);
    expect(readSessionUsage('claude-code', 'sess', env)).toEqual({ usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0 }, costUsd: 0.5, updatedAt: 'now' });
  });
});

describe('reduceUsage (one accounting rule for every runner)', () => {
  it('replaces snapshots per message id and adds per-turn deltas', () => {
    const u = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    const events: AgentEvent[] = [
      { t: 'usage', usage: u(10), messageId: 'm1', cost: { usd: 0.1 } },
      { t: 'usage', usage: u(30), messageId: 'm1', cost: { usd: 0.3 } },
      { t: 'usage', usage: u(5), messageId: 'm2' },
      { t: 'usage', usage: u(100), cost: { usd: 1 } },
      { t: 'usage', usage: u(100) },
      { t: 'heartbeat' },
    ];
    expect(reduceUsage(events)).toEqual({ usage: { input: 235, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costUsd: 1.3 });
  });
});

describe('process group termination', () => {
  function handleFor(command: string, args: string[]): GroupHandle {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    let exit: ExitInfo | null = null;
    const exited = new Promise<ExitInfo>((resolve) => child.once('exit', (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    }));
    return { pid: child.pid, killProcess: (signal) => child.kill(signal), exited, isExited: () => exit !== null };
  }

  it('stops a cooperative process with SIGTERM and an uncooperative one with SIGKILL', async () => {
    expect(await terminateProcessGroup(handleFor('/bin/sleep', ['30']), 2_000)).toEqual({ exit: { code: null, signal: 'SIGTERM' }, escalation: 'SIGTERM' });
    const stubborn = handleFor('/bin/sh', ['-c', 'trap "" TERM; sleep 30 & wait']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await terminateProcessGroup(stubborn, 200)).toEqual({ exit: { code: null, signal: 'SIGKILL' }, escalation: 'SIGKILL' });
    const done = handleFor('/usr/bin/true', []);
    await done.exited;
    expect(await terminateProcessGroup(done, 100)).toEqual({ exit: { code: 0, signal: null }, escalation: 'none' });
  });
});

describe('launchRunnerProcess', () => {
  const spec = (overrides: Partial<RunnerProcessSpec> = {}): RunnerProcessSpec => ({
    runner: 'codex',
    worktree,
    binary: '/bin/echo',
    argv: () => ['hello'],
    enforceEnv: () => ({ EXPLICIT: 'yes' }),
    hostEnv: () => ({ PATH: '/usr/bin:/bin' }),
    egressProviders: ['openai'],
    egressHosts: ['example.org', 'bad host!'],
    ...overrides,
  });
  const env = () => ({ PATH: '/usr/bin:/bin', HOME: join(root, 'home'), OPENLINEAR_SANDBOX_DIR: join(root, 'sandbox'), OPENLINEAR_SANDBOX_REGISTRIES: '0' });

  it('refuses a missing worktree, a relative binary and a binary inside the worktree, before any spawn', async () => {
    const spawnProcess = vi.fn();
    const deps = { env: env(), spawnProcess, verifiedProvider: async () => ({ provider: fakeProvider().provider, report: fakeReport() }) };
    await expect(launchRunnerProcess(spec({ worktree: join(root, 'missing') }), deps)).rejects.toMatchObject({ code: 'SANDBOX_START_FAILED' });
    await expect(launchRunnerProcess(spec({ binary: 'echo' }), deps)).rejects.toMatchObject({ code: 'SANDBOX_START_FAILED' });
    writeFileSync(join(worktree, 'planted'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(launchRunnerProcess(spec({ binary: join(worktree, 'planted') }), deps)).rejects.toMatchObject({ code: 'SANDBOX_START_FAILED' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('refuses a trusted-host grant that does not cover the worktree, and an invalid mode', async () => {
    const spawnProcess = vi.fn();
    const grant = JSON.stringify({ actor: 'a', reason: 'covering test grant', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), paths: [join(root, 'elsewhere')] });
    await expect(launchRunnerProcess(spec(), { env: { ...env(), OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: grant }, spawnProcess }))
      .rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    await expect(launchRunnerProcess(spec(), { env: { ...env(), OPENLINEAR_SANDBOX_MODE: 'yolo' }, spawnProcess }))
      .rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('builds one attempt policy with a private root, validated egress and host-only records', async () => {
    const { provider, policies } = fakeProvider();
    resetRunnerGcForTests();
    const proc = await launchRunnerProcess(spec(), { env: env(), verifiedProvider: async () => ({ provider, report: fakeReport() }) });
    const exit = await proc.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    await proc.dispose();
    const policy = policies[0];
    const key = runnerAttemptKey('codex', worktree);
    expect(proc.metadata).toMatchObject({ mode: 'enforce', runner: 'codex', attemptKey: key, provider: 'macos-seatbelt', egressAllowedHosts: ['api.openai.com', 'auth.openai.com', 'chatgpt.com', 'example.org'] });
    expect(proc.metadata.warnings).toContain('ignored invalid runner egress host bad host!');
    expect(policy?.env.EXPLICIT).toBe('yes');
    expect(policy?.env.HOME).toBe(join(root, 'sandbox', 'runners', 'codex', key, 'home'));
    expect(policy?.filesystem.rules).toContainEqual({ action: 'write', path: join(root, 'sandbox', 'runners', 'codex', key), scope: 'subtree' });
    expect(policy?.filesystem.rules).toContainEqual({ action: 'deny', path: join(root, 'sandbox'), scope: 'subtree' });
    const record = JSON.parse(readFileSync(join(root, 'sandbox', 'runners', 'records', `codex-${key}.json`), 'utf8')) as { worktree: string; policyHash: string };
    expect(record.worktree).toBe(worktree);
    expect(record.policyHash).toBe(proc.metadata.policyHash);
  });

  it('removes private roots whose worktree is gone', async () => {
    const goneTree = join(root, 'gone-worktree');
    mkdirSync(goneTree);
    const { provider } = fakeProvider();
    const deps = { env: env(), verifiedProvider: async () => ({ provider, report: fakeReport() }) };
    resetRunnerGcForTests();
    const first = await launchRunnerProcess(spec({ worktree: goneTree }), deps);
    await first.exited;
    const attempt = first.dirs?.root ?? '';
    expect(existsSync(attempt)).toBe(true);
    rmSync(goneTree, { recursive: true });
    resetRunnerGcForTests();
    const second = await launchRunnerProcess(spec(), deps);
    await second.exited;
    expect(existsSync(attempt)).toBe(false);
  });

  it('wraps start failures after the provider was verified as SANDBOX_START_FAILED and releases the proxy', async () => {
    const { provider } = fakeProvider();
    const broken = { ...provider, wrap: async () => { throw new Error('wrap exploded'); } };
    await expect(launchRunnerProcess(spec(), { env: env(), verifiedProvider: async () => ({ provider: broken, report: fakeReport() }) }))
      .rejects.toMatchObject({ code: 'SANDBOX_START_FAILED', message: 'Sandboxed codex failed to start: wrap exploded' });
  });
});

describe('runner registry and catalogue', () => {
  it('returns the Claude Code adapter instead of throwing, and validates selections', () => {
    expect(pickRunner({ taskAgent: 'claude' }).id).toBe('claude-code');
    expect(pickRunner({ projectDefaultAgent: 'openai-codex' }).id).toBe('codex');
    expect(pickRunner({}).id).toBe('opencode');
    expect(() => pickRunner({ taskAgent: 'gpt-pilot' })).toThrow('The selected agent runner is unknown');
    expect([...getRunnerRegistry().keys()]).toEqual(['opencode', 'codex', 'claude-code']);
  });

  it('describes every runner with capabilities, features, bounded health and the sandbox state', async () => {
    const slow: AgentRunner = {
      id: 'codex',
      capabilities: getRunnerRegistry().get('codex')?.capabilities ?? { streamingDeltas: false, reasoningDeltas: false, permissionReply: false, interrupt: false, compact: false, revert: false, fork: false, cacheSplitUsage: false },
      healthCheck: () => new Promise(() => undefined),
      listModels: async () => [],
      start: async () => { throw new Error('unused'); },
      resume: async () => { throw new Error('unused'); },
    };
    const failing: AgentRunner = { ...slow, id: 'claude-code', healthCheck: async () => { throw new Error('probe failed'); } };
    const opencode = getRunnerRegistry().get('opencode') as AgentRunner;
    const catalogue = await getRunnerCatalogue([opencode, slow, failing], { timeoutMs: 50, env: {} });
    expect(catalogue.sandbox).toMatchObject({ mode: 'enforce' });
    expect(catalogue.runners.map((entry) => [entry.id, entry.available, entry.legacyExecuteSupported])).toEqual([
      ['opencode', true, true], ['codex', false, false], ['claude-code', false, false],
    ]);
    expect(catalogue.runners[0]?.features).toMatchObject({ interrupt: 'server-abort', usage: { semantics: 'snapshot-per-message' } });
    expect(catalogue.runners[1]?.health).toEqual({ ok: false, detail: 'health check timed out after 50ms' });
    expect(catalogue.runners[2]?.health).toEqual({ ok: false, detail: 'probe failed' });
    expect(sandboxSummary({ OPENLINEAR_SANDBOX_MODE: 'bogus' })).toMatchObject({ mode: 'invalid' });
  });
});
