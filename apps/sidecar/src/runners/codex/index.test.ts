import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import type { AgentEvent } from '@openlinear/execution-core';
import { emptyTokenUsage } from '@openlinear/execution-core';
import type { ShortCommandResult } from '../shared/binary';
import { codexSuccessSteps } from '../testing/fixtures';
import { closed, codexHarness, collect, drain, isAlive, readUntil, startInput as baseStartInput } from '../testing/harness';
import { buildCodexExecArgs, CODEX_SDK_VERSION, codexTargetTriple, resolveCodexBinary } from './exec';
import { CodexRunner, decodeCodexEvent } from './index';

const usage = { input_tokens: 100, output_tokens: 40, cached_input_tokens: 30, cache_write_input_tokens: 20, reasoning_output_tokens: 10 };

function decoderState() {
  return {
    textByItem: new Map<string, string>(), startedTools: new Set<string>(), completedItems: new Set<string>(),
    usage: emptyTokenUsage(), turn: 0, terminal: false,
  };
}

describe('CodexRunner pinned SDK event contract', () => {
  it('tracks cumulative text independently for each message and reasoning item', () => {
    const state = decoderState();
    const fixtures: ThreadEvent[] = [
      { type: 'item.started', item: { id: 'message-1', type: 'agent_message', text: 'Hel' } },
      { type: 'item.updated', item: { id: 'message-1', type: 'agent_message', text: 'Hello' } },
      { type: 'item.updated', item: { id: 'message-1', type: 'agent_message', text: 'Hello' } },
      { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Hello' } },
      { type: 'item.completed', item: { id: 'message-2', type: 'agent_message', text: 'Hello again' } },
      { type: 'item.updated', item: { id: 'reason-1', type: 'reasoning', text: 'Check' } },
      { type: 'item.updated', item: { id: 'reason-1', type: 'reasoning', text: 'Check tests' } },
      { type: 'item.completed', item: { id: 'reason-1', type: 'reasoning', text: 'Check tests' } },
    ];
    expect(fixtures.flatMap((event) => decodeCodexEvent(event, state))).toEqual([
      { t: 'message.delta', text: 'Hel' }, { t: 'message.delta', text: 'lo' }, { t: 'message.delta', text: 'Hello again' },
      { t: 'reasoning.delta', text: 'Check' }, { t: 'reasoning.delta', text: ' tests' },
    ]);
  });

  it('emits command lifecycle and output once, keeping failed exits', () => {
    const state = decoderState();
    const fixtures: ThreadEvent[] = [
      { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test', status: 'in_progress', aggregated_output: '' } },
      { type: 'item.updated', item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test', status: 'in_progress', aggregated_output: 'one' } },
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test', status: 'completed', exit_code: 1, aggregated_output: 'one\nfailed' } },
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test', status: 'completed', exit_code: 1, aggregated_output: 'one\nfailed' } },
    ];
    expect(fixtures.flatMap((event) => decodeCodexEvent(event, state))).toEqual([
      { t: 'tool.started', callId: 'cmd-1', name: 'bash', input: { command: 'pnpm test' } },
      { t: 'tool.output', callId: 'cmd-1', chunk: 'one', cumulative: false },
      { t: 'tool.output', callId: 'cmd-1', chunk: '\nfailed', cumulative: false },
      { t: 'tool.finished', callId: 'cmd-1', name: 'bash', ok: false, summary: 'one\nfailed' },
    ]);
  });

  it.each([
    { status: 'completed' as const, exit_code: 0, ok: true },
    { status: 'failed' as const, exit_code: undefined, ok: false },
    { status: 'failed' as const, exit_code: 0, ok: false },
  ])('respects command status $status and exit $exit_code', ({ status, exit_code, ok }) => {
    expect(decodeCodexEvent({ type: 'item.completed', item: {
      id: 'cmd', type: 'command_execution', command: 'test', status, exit_code, aggregated_output: 'output',
    } }, decoderState())).toContainEqual({ t: 'tool.finished', callId: 'cmd', name: 'bash', ok, summary: 'output' });
  });

  it('decodes successful patch changes, skipping failed and repeated patches', () => {
    const state = decoderState();
    const completed: ThreadEvent = { type: 'item.completed', item: {
      id: 'patch', type: 'file_change', status: 'completed', changes: [
        { path: 'new.ts', kind: 'add' }, { path: 'old.ts', kind: 'delete' }, { path: 'edit.ts', kind: 'update' },
      ],
    } };
    expect(decodeCodexEvent(completed, state)).toEqual([
      // W07: the lifecycle is complete (started before finished) for patches too.
      { t: 'tool.started', callId: 'patch', name: 'apply_patch', input: { changes: [
        { path: 'new.ts', kind: 'add' }, { path: 'old.ts', kind: 'delete' }, { path: 'edit.ts', kind: 'update' },
      ] } },
      { t: 'tool.finished', callId: 'patch', name: 'apply_patch', ok: true },
      { t: 'file.changed', path: 'new.ts', kind: 'create' }, { t: 'file.changed', path: 'old.ts', kind: 'delete' },
      { t: 'file.changed', path: 'edit.ts', kind: 'edit' },
    ]);
    expect(decodeCodexEvent(completed, state)).toEqual([]);
    expect(decodeCodexEvent({ type: 'item.completed', item: {
      id: 'failed-patch', type: 'file_change', status: 'failed', changes: [{ path: 'missing.ts', kind: 'update' }],
    } }, state)).toEqual([
      { t: 'tool.started', callId: 'failed-patch', name: 'apply_patch', input: { changes: [{ path: 'missing.ts', kind: 'update' }] } },
      { t: 'tool.finished', callId: 'failed-patch', name: 'apply_patch', ok: false },
    ]);
  });

  it('preserves MCP failure details without failing a recoverable turn', () => {
    const state = decoderState();
    const event: ThreadEvent = { type: 'item.completed', item: {
      id: 'mcp', type: 'mcp_tool_call', server: 'docs', tool: 'fetch', arguments: { url: 'fixture' },
      status: 'failed', error: { message: 'unavailable' },
    } };
    expect(decodeCodexEvent(event, state)).toEqual([
      { t: 'tool.started', callId: 'mcp', name: 'docs.fetch', input: { url: 'fixture' } },
      { t: 'tool.finished', callId: 'mcp', name: 'docs.fetch', ok: false, summary: 'unavailable' },
    ]);
    expect(state.terminal).toBe(false);
  });

  it('preserves cache-write, cache-read and reasoning usage without adding subsets', () => {
    const state = decoderState();
    decodeCodexEvent({ type: 'turn.started' }, state);
    expect(decodeCodexEvent({ type: 'turn.completed', usage }, state)).toEqual([
      { t: 'usage', usage: { input: 100, output: 40, cacheRead: 30, cacheWrite: 20, reasoning: 10 } },
      { t: 'turn.finished', turn: 1, reason: 'idle' },
    ]);
    expect(decodeCodexEvent({ type: 'turn.completed', usage }, state)).toEqual([]);
  });

  it.each<ThreadEvent>([
    { type: 'error', message: 'authentication failed' },
    { type: 'turn.failed', error: { message: 'authentication failed' } },
  ])('emits a terminal failure for $type', (event) => {
    const state = decoderState();
    decodeCodexEvent({ type: 'turn.started' }, state);
    expect(decodeCodexEvent(event, state)).toEqual([
      { t: 'error', code: 'codex', message: 'authentication failed', retryable: false },
      { t: 'turn.finished', turn: 1, reason: 'error' },
    ]);
    expect(decodeCodexEvent({ type: 'turn.completed', usage }, state)).toEqual([]);
  });
});


let root = '';
let worktree = '';

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-codex-runner-')));
  worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function input(overrides: Parameters<typeof baseStartInput>[1] = {}) {
  return baseStartInput(worktree, {
    model: { provider: 'openai', id: 'configured-model' },
    systemContract: 'Verify the changes.',
    prompt: 'Fix the failing test.',
    env: { OPENAI_API_KEY: 'fixture-key' },
    ...overrides,
  });
}

const blocked = (threadId: string) => [...codexSuccessSteps(threadId).slice(0, 2), { hang: true as const }];

describe('CodexRunner sessions (codex exec under the SandboxProvider)', () => {
  it('forwards the selected model and key, exposes the real ID and completes successfully', async () => {
    const h = codexHarness(root, codexSuccessSteps('codex-thread'));
    const session = await h.runner.start(input());
    expect(session.externalId).toBe('run-1');
    const events = await collect(session);
    const invocation = h.invocation();
    // Same argv as @openai/codex-sdk 0.164.0; our OS sandbox replaces Codex's own.
    expect(invocation?.argv).toEqual([
      'exec', '--experimental-json', '--model', 'configured-model', '--sandbox', 'danger-full-access',
      '--cd', worktree, '--skip-git-repo-check', '--config', 'approval_policy="never"',
    ]);
    expect(invocation?.prompt).toBe('Verify the changes.\n\nFix the failing test.');
    expect(invocation?.env?.CODEX_API_KEY).toBe('fixture-key');
    expect(invocation?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(invocation?.env?.CODEX_HOME).toMatch(/runners\/codex\/[0-9a-f]{20}\/runtime$/);
    expect(h.specs[0]?.command).toBe(h.binary);
    expect(events[0]).toEqual({ t: 'session.started', externalId: 'codex-thread', model: { provider: 'openai', id: 'configured-model' } });
    expect(events.at(-1)).toEqual({ t: 'turn.finished', turn: 1, reason: 'idle' });
    expect(session.externalId).toBe('codex-thread');
    await closed(session);
    expect(isAlive(invocation?.pid)).toBe(false);
    await expect(collect(session)).rejects.toThrow('only be consumed once');
  });

  it('resumes a saved thread with continuation input and preserves the stored model', async () => {
    const h = codexHarness(root, [{ line: { type: 'turn.started' } }, { line: { type: 'turn.completed', usage } }]);
    const session = await h.runner.resume('saved-thread', { worktreePath: worktree, signal: new AbortController().signal });
    const events = await collect(session);
    expect(events[0]).toEqual({ t: 'session.started', externalId: 'saved-thread', model: { provider: 'openai', id: 'unknown' } });
    expect(session.externalId).toBe('saved-thread');
    const invocation = h.invocation();
    expect(invocation?.argv?.slice(-2)).toEqual(['resume', 'saved-thread']);
    expect(invocation?.argv).not.toContain('--model');
    expect(invocation?.prompt).toContain('Continue the interrupted task');
  });

  it('does not start an already cancelled turn', async () => {
    const h = codexHarness(root, codexSuccessSteps());
    const controller = new AbortController();
    controller.abort();
    expect(await collect(await h.runner.start(input({ signal: controller.signal })))).toEqual([
      { t: 'cancel.receipt', via: 'signal', confirmedBy: 'not-started' },
      { t: 'turn.finished', turn: 0, reason: 'interrupted' },
    ]);
    expect(h.spawns()).toBe(0);
  });

  it.each(['interrupt', 'abort', 'external'] as const)('cancels a blocked stream through %s and reaps the process group', async (method) => {
    const h = codexHarness(root, blocked('cancel-thread'));
    const controller = new AbortController();
    const session = await h.runner.start(input({ signal: controller.signal }));
    const iterator = session.events[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    await readUntil(iterator, events, (event) => event.t === 'turn.started');
    if (method === 'external') controller.abort();
    else await session[method]();
    await drain(iterator, events);
    expect(events.slice(-2)).toEqual([
      { t: 'cancel.receipt', via: method === 'external' ? 'signal' : method, confirmedBy: 'process-exit', exitCode: 143, exitSignal: null },
      { t: 'turn.finished', turn: 1, reason: 'interrupted' },
    ]);
    await closed(session);
    expect(isAlive(h.invocation()?.pid)).toBe(false);
  });

  it('escalates to SIGKILL when the CLI ignores SIGTERM', async () => {
    const h = codexHarness(root, blocked('stubborn'), { onSigterm: 'ignore' });
    const session = await h.runner.start(input());
    const iterator = session.events[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    await readUntil(iterator, events, (event) => event.t === 'turn.started');
    await session.abort();
    await drain(iterator, events);
    expect(events.at(-2)).toEqual({ t: 'cancel.receipt', via: 'abort', confirmedBy: 'process-exit', exitCode: null, exitSignal: 'SIGKILL' });
    expect(h.invocations().some((entry) => entry.event === 'sigterm')).toBe(true);
    expect(isAlive(h.invocation()?.pid)).toBe(false);
  });

  it('stops the CLI when a consumer closes before completion', async () => {
    const h = codexHarness(root, blocked('early-close'));
    const session = await h.runner.start(input());
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await closed(session);
    expect(isAlive(h.invocation()?.pid)).toBe(false);
  });

  it('fails a stream that closes without a provider terminal event and keeps a scrubbed stderr tail', async () => {
    const h = codexHarness(root, [...codexSuccessSteps('incomplete').slice(0, 2), { stderr: 'fatal: token sk-proj-ABCDEFGHIJKLMNOPQRSTUV rejected' }, { exit: 3 }]);
    const events = await collect(await h.runner.start(input()));
    expect(events.at(-2)).toEqual({ t: 'error', code: 'codex', message: 'Codex stream closed before the turn ended', retryable: false });
    expect(events.at(-1)).toEqual({ t: 'turn.finished', turn: 1, reason: 'error' });
    const exit = events.find((event) => event.t === 'diagnostic' && event.code === 'process_exit');
    expect(exit).toMatchObject({ message: 'Runner exited with code 3' });
    expect(JSON.stringify(exit)).toContain('[redacted]');
    expect(JSON.stringify(events)).not.toContain('sk-proj-ABCDEFGHIJKLMNOPQRSTUV');
  });

  it('normalizes a CLI that cannot be started as a failure', async () => {
    const h = codexHarness(root, [], {
      codex: { resolveBinary: () => ({ path: join(root, 'missing', 'codex'), pathDirs: [], readRoot: null, version: null, source: 'override' }) },
    });
    const events = await collect(await h.runner.start(input()));
    expect(events.at(-2)).toMatchObject({ t: 'error', code: 'spawn_failed', retryable: false });
    expect(events.at(-1)).toEqual({ t: 'turn.finished', turn: 0, reason: 'error' });
  });

  it('links the user’s own Codex login read-only when no key is passed', async () => {
    const h = codexHarness(root, codexSuccessSteps());
    mkdirSync(join(h.home, '.codex'), { recursive: true });
    const authFile = join(h.home, '.codex', 'auth.json');
    writeFileSync(authFile, '{"fixture":"OPENLINEAR-FAKE-LOGIN"}', { mode: 0o600 });
    await collect(await h.runner.start(input({ env: {} })));
    const invocation = h.invocation();
    expect(invocation?.env?.CODEX_API_KEY).toBeUndefined();
    const link = join(invocation?.env?.CODEX_HOME ?? '', 'auth.json');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(realpathSync.native(authFile));
    // The allowance is the LAST rule: it overrides the credential-store deny, read-only, for one file.
    expect(h.policies[0]?.filesystem.rules.at(-1)).toEqual({ action: 'read', path: realpathSync.native(authFile), scope: 'file' });
    expect(h.policies[0]?.filesystem.rules).toContainEqual({ action: 'deny', path: join(h.home, '.codex'), scope: 'subtree' });
  });

  it('runs the unmodified CLI with Codex’s own sandbox under an explicit trusted-host grant', async () => {
    const grant = JSON.stringify({ actor: 'tester@example.invalid', reason: 'runner conformance fixture', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const h = codexHarness(root, codexSuccessSteps(), { env: { OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: grant } });
    const events = await collect(await h.runner.start(input()));
    expect(events.at(-1)).toMatchObject({ t: 'turn.finished', reason: 'idle' });
    const invocation = h.invocation();
    expect(invocation?.argv).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(invocation?.env?.HOME).toBe(h.home);
    expect(invocation?.env?.CODEX_API_KEY).toBe('fixture-key');
    expect(invocation?.env?.DATABASE_URL).toBeUndefined();
    expect(invocation?.env?.OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT).toBeUndefined();
    expect(h.policies).toHaveLength(0);
  });

  it('reports unsupported capabilities without claiming a live model catalogue', async () => {
    const h = codexHarness(root, codexSuccessSteps());
    expect(h.runner.capabilities).toMatchObject({ permissionReply: false, compact: false, revert: false, fork: false, interrupt: true });
    expect(h.runner.features).toMatchObject({ interrupt: 'process-abort', approvals: 'policy-only', resume: 'native-session', usage: { semantics: 'delta-per-turn' } });
    expect(await h.runner.listModels()).toEqual([]);
    const session = await h.runner.start(input());
    await expect(session.replyPermission('approval', 'allow')).rejects.toThrow('does not support interactive permission replies');
    await collect(session);
  });
});

describe('CodexRunner health (no inference)', () => {
  type Results = Record<string, Partial<ShortCommandResult>>;
  const fakeCommands = (results: Results) => {
    const calls: string[] = [];
    const run = async (_binary: string, args: readonly string[]): Promise<ShortCommandResult> => {
      calls.push(args.join(' '));
      return { code: 1, stdout: '', stderr: '', timedOut: false, ...results[args.join(' ')] };
    };
    return { run, calls };
  };
  const vendored = () => ({ path: '/opt/fixture/codex', pathDirs: [], readRoot: null, version: CODEX_SDK_VERSION, source: 'sdk-vendored' as const });

  function homeWith(auth: boolean): string {
    const home = mkdtempSync(join(root, 'home-'));
    if (auth) {
      mkdirSync(join(home, '.codex'));
      writeFileSync(join(home, '.codex', 'auth.json'), '{}');
    }
    return home;
  }

  it('reports the version and login method without echoing the masked key', async () => {
    const { run } = fakeCommands({
      '--version': { code: 0, stdout: 'codex-cli 0.164.0\n' },
      'login status': { code: 0, stdout: 'API key configured - sk-d32c8***6d71e\nAuthentication is checked when you send a request.\n' },
    });
    const runner = new CodexRunner({ env: { HOME: homeWith(true), PATH: process.env.PATH }, resolveBinary: vendored, runCommand: run });
    const health = await runner.healthCheck();
    expect(health).toMatchObject({ ok: true, version: '0.164.0', binary: '/opt/fixture/codex', auth: { status: 'ok', method: 'api-key' } });
    expect(JSON.stringify(health)).not.toContain('sk-');
  });

  it('flags a login the sandbox cannot read, and a missing login', async () => {
    const keyring = fakeCommands({ '--version': { code: 0, stdout: 'codex-cli 0.164.0' }, 'login status': { code: 0, stdout: 'Logged in using ChatGPT' } });
    const unreachable = await new CodexRunner({ env: { HOME: homeWith(false) }, resolveBinary: vendored, runCommand: keyring.run }).healthCheck();
    expect(unreachable).toMatchObject({ ok: false, auth: { status: 'unreachable-in-sandbox', method: 'chatgpt' } });
    const none = fakeCommands({ '--version': { code: 0, stdout: 'codex-cli 0.164.0' }, 'login status': { code: 1, stdout: 'Not logged in' } });
    expect(await new CodexRunner({ env: { HOME: homeWith(false) }, resolveBinary: vendored, runCommand: none.run }).healthCheck())
      .toMatchObject({ ok: false, auth: { status: 'missing' } });
  });

  it('reports a binary that does not run, and caches results for the TTL', async () => {
    const broken = fakeCommands({});
    const runner = new CodexRunner({ env: { HOME: homeWith(true) }, resolveBinary: vendored, runCommand: broken.run });
    expect(await runner.healthCheck()).toMatchObject({ ok: false, detail: 'codex --version failed' });
    await runner.healthCheck();
    expect(broken.calls).toEqual(['--version']);
    const missing = new CodexRunner({ resolveBinary: () => { throw new Error('Codex has no vendored binary'); } });
    expect(await missing.healthCheck()).toEqual({ ok: false, detail: 'Codex has no vendored binary' });
  });
});

describe('Codex CLI resolution and argv (pinned @openai/codex-sdk 0.164.0)', () => {
  it('resolves the binary vendored with the pinned SDK the same way the SDK does', () => {
    if (!codexTargetTriple(process.platform, process.arch)) return;
    const binary = resolveCodexBinary({});
    expect(binary.source).toBe('sdk-vendored');
    expect(binary.version).toBe(CODEX_SDK_VERSION);
    expect(binary.path.endsWith('/codex')).toBe(true);
    expect(existsSync(binary.path)).toBe(true);
    expect(binary.readRoot && binary.path.startsWith(binary.readRoot)).toBe(true);
  });

  it('honours OPENLINEAR_CODEX_PATH only for an absolute executable', () => {
    expect(() => resolveCodexBinary({ OPENLINEAR_CODEX_PATH: 'codex' })).toThrow('absolute path');
    expect(resolveCodexBinary({ OPENLINEAR_CODEX_PATH: '/bin/sh' })).toMatchObject({ source: 'override', pathDirs: [], readRoot: null });
  });

  it('maps supported platforms to target triples and refuses the rest', () => {
    expect(codexTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(codexTargetTriple('linux', 'x64')).toBe('x86_64-unknown-linux-musl');
    expect(codexTargetTriple('win32', 'x64')).toBeNull();
    expect(() => resolveCodexBinary({}, 'win32', 'x64')).toThrow('no vendored binary');
  });

  it('builds argv in the SDK order, with resume last', () => {
    expect(buildCodexExecArgs({ model: 'm', sandboxMode: 'workspace-write', workingDirectory: '/w', approvalPolicy: 'never', threadId: 't' })).toEqual([
      'exec', '--experimental-json', '--model', 'm', '--sandbox', 'workspace-write', '--cd', '/w', '--config', 'approval_policy="never"', 'resume', 't',
    ]);
    expect(buildCodexExecArgs({ sandboxMode: 'danger-full-access', workingDirectory: '/w' })).toEqual([
      'exec', '--experimental-json', '--sandbox', 'danger-full-access', '--cd', '/w',
    ]);
  });
});
