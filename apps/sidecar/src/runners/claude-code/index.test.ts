import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@openlinear/execution-core';
import { reduceUsage } from '@openlinear/execution-core';
import type { ShortCommandResult } from '../shared/binary';
import { CLAUDE_EXPECTED_USAGE, claudeInit, claudeResult, claudeSuccess } from '../testing/fixtures';
import type { FakeStep } from '../testing/fake-cli';
import { claudeHarness, closed, collect, drain, isAlive, readUntil, startInput } from '../testing/harness';
import { claudeCredentialsFile, claudeModelArg, resolveClaudeBinary } from './binary';
import { buildClaudeArgs, ClaudeCodeRunner, permissionArgs } from './index';
import { classifyClaudeFailure, usageFromModelUsage } from './session';

let root = '';
let worktree = '';

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-claude-runner-')));
  worktree = join(root, 'worktree');
  mkdirSync(join(worktree, 'src'), { recursive: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const KEY = { ANTHROPIC_API_KEY: 'sk-ant-per-run-FIXTURE' };
const input = (overrides: Parameters<typeof startInput>[1] = {}) => startInput(worktree, { env: KEY, ...overrides });

function grantEnv() {
  return {
    OPENLINEAR_SANDBOX_MODE: 'trusted-host',
    OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: JSON.stringify({ actor: 'tester@example.invalid', reason: 'claude runner fixture run', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
  };
}

describe('Claude Code CLI contract', () => {
  it('builds the headless stream-json argv with isolation flags and per-policy permissions', () => {
    expect(buildClaudeArgs({ systemContract: 'C', sessionId: 'S', model: 'opus', maxTurns: 40, maxUsd: 2.5, permissions: { default: 'allow' } })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json',
      '--setting-sources', 'user', '--strict-mcp-config', '--append-system-prompt', 'C', '--session-id', 'S', '--model', 'opus',
      '--max-turns', '40', '--max-budget-usd', '2.5',
      '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Edit,Write,NotebookEdit', '--permission-prompts', 'none',
    ]);
    const resumed = buildClaudeArgs({ sessionId: 'S', resumeId: 'R', maxTurns: 0, maxUsd: Number.NaN, permissions: { default: 'deny' } });
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 'R', '--permission-mode', 'dontAsk']));
    expect(resumed).not.toContain('--session-id');
    expect(resumed).not.toContain('--max-turns');
    expect(resumed).not.toContain('--max-budget-usd');
    expect(resumed).not.toContain('--append-system-prompt');
    expect(permissionArgs({ default: 'ask' })).toEqual(['--permission-prompt-tool', 'stdio']);
  });

  it('normalizes model ids and refuses unsafe ones', () => {
    expect(claudeModelArg({ provider: 'anthropic', id: 'anthropic/claude-opus-5-5' })).toBe('claude-opus-5-5');
    expect(claudeModelArg({ id: 'opus[1m]' })).toBe('opus[1m]');
    expect(claudeModelArg({ id: '--dangerously-skip-permissions x' })).toBeUndefined();
    expect(claudeModelArg(undefined)).toBeUndefined();
  });

  it('resolves only the user’s own absolute binary', () => {
    expect(resolveClaudeBinary({ OPENLINEAR_CLAUDE_PATH: 'claude' })).toBeNull();
    expect(resolveClaudeBinary({ OPENLINEAR_CLAUDE_PATH: '/bin/sh' })).toMatchObject({ source: 'override', readRoot: null });
    const npmInstall = join(root, 'npm', 'cli.js');
    mkdirSync(join(root, 'npm'), { recursive: true });
    writeFileSync(npmInstall, '#!/usr/bin/env node\n', { mode: 0o755 });
    expect(resolveClaudeBinary({ OPENLINEAR_CLAUDE_PATH: npmInstall })).toMatchObject({ readRoot: join(root, 'npm') });
    expect(resolveClaudeBinary({ PATH: '/nonexistent', HOME: join(root, 'nohome') })).toBeNull();
    expect(claudeCredentialsFile({ HOME: '/h' })).toBe('/h/.claude/.credentials.json');
    expect(claudeCredentialsFile({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c' })).toBe('/c/.credentials.json');
  });

  it('classifies failed results into stable, retry-aware codes', () => {
    expect(classifyClaudeFailure({ apiErrorStatus: 429 })).toEqual({ code: 'rate_limit', retryable: true });
    expect(classifyClaudeFailure({ assistantError: 'overloaded' })).toEqual({ code: 'overloaded', retryable: true });
    expect(classifyClaudeFailure({ apiErrorStatus: 503 })).toEqual({ code: 'server_error', retryable: true });
    expect(classifyClaudeFailure({ apiErrorStatus: 401 })).toEqual({ code: 'auth', retryable: false });
    expect(classifyClaudeFailure({ assistantError: 'oauth_org_not_allowed' })).toEqual({ code: 'auth', retryable: false });
    expect(classifyClaudeFailure({ assistantError: 'billing_error' })).toEqual({ code: 'billing', retryable: false });
    expect(classifyClaudeFailure({ terminalReason: 'prompt_too_long' })).toEqual({ code: 'context_overflow', retryable: false });
    expect(classifyClaudeFailure({ subtype: 'error_max_budget_usd' })).toEqual({ code: 'budget_exhausted', retryable: false });
    expect(classifyClaudeFailure({ assistantError: 'model_not_found' })).toEqual({ code: 'model_not_found', retryable: false });
    expect(classifyClaudeFailure({ subtype: 'error_during_execution' })).toEqual({ code: 'claude_code', retryable: false });
  });

  it('sums modelUsage across models, thinking as reasoning', () => {
    expect(usageFromModelUsage({
      a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, thinkingTokens: 1 },
      b: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
      junk: 7,
    })).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, reasoning: 1 });
    expect(usageFromModelUsage({})).toBeNull();
    expect(usageFromModelUsage(null)).toBeNull();
  });
});

describe('ClaudeCodeRunner sessions (official claude binary under the SandboxProvider)', () => {
  it('starts with a pre-assigned session id, an isolated config dir and only the per-run key', async () => {
    const h = claudeHarness(root, claudeSuccess(worktree), { claude: { newSessionId: () => '11111111-2222-4333-8444-555555555555' } });
    const session = await h.runner.start(input());
    expect(session.externalId).toBe('11111111-2222-4333-8444-555555555555');
    const events = await collect(session);
    const invocation = h.invocation();
    expect(invocation?.argv).toEqual(expect.arrayContaining(['--session-id', '11111111-2222-4333-8444-555555555555', '--model', 'fixture-model', '--append-system-prompt', 'Fixture contract: verify before finishing.']));
    expect(invocation?.prompt).toBe('Fix the failing test.');
    const env = invocation?.env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-per-run-FIXTURE');
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/runners\/claude-code\/[0-9a-f]{20}\/runtime$/);
    expect(env.HOME).not.toBe(h.home);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(events[0]).toEqual({ t: 'session.started', externalId: '11111111-2222-4333-8444-555555555555', model: { provider: 'anthropic', id: 'claude-opus-5-5' } });
    // Text streamed once from partial messages; the complete assistant message does not repeat it.
    expect(events.filter((event) => event.t === 'message.delta').map((event) => (event.t === 'message.delta' ? event.text : ''))).toEqual(['Fixing', ' the test.', 'Done.']);
    expect(events).toContainEqual({ t: 'file.changed', path: 'src/a.ts', kind: 'edit' });
    const usage = events.filter((event) => event.t === 'usage');
    expect(usage).toEqual([{ t: 'usage', usage: CLAUDE_EXPECTED_USAGE, cost: { usd: 0.0123, basis: 'claude-code total_cost_usd (client-side estimate)' } }]);
    expect(events.at(-1)).toEqual({ t: 'turn.finished', turn: 1, reason: 'idle' });
    await closed(session);
    expect(isAlive(invocation?.pid)).toBe(false);
    expect(h.invocations().some((entry) => entry.event === 'stdin-end')).toBe(true);
  });

  it('emits complete-message text once when the CLI sends no partial messages', async () => {
    const steps: FakeStep[] = [
      { line: claudeInit() },
      { line: { type: 'assistant', parent_tool_use_id: null, session_id: '$SESSION', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'Hello' }], usage: { input_tokens: 1, output_tokens: 1 } } } },
      { line: { type: 'assistant', parent_tool_use_id: null, session_id: '$SESSION', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'Hello' }], usage: { input_tokens: 1, output_tokens: 1 } } } },
      { line: { type: 'assistant', parent_tool_use_id: 'toolu_parent', session_id: '$SESSION', message: { id: 'sub', content: [{ type: 'text', text: 'subagent chatter' }], usage: { input_tokens: 5, output_tokens: 5 } } } },
      { line: claudeResult({}, { input: 6, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, 0.01) },
    ];
    const events = await collect(await claudeHarness(root, steps).runner.start(input()));
    expect(events.filter((event) => event.t === 'message.delta' || event.t === 'reasoning.delta')).toEqual([
      { t: 'reasoning.delta', text: 'plan' },
      { t: 'message.delta', text: 'Hello' },
    ]);
  });

  it('reports compaction, provider retries and usage-limit rejections', async () => {
    const steps: FakeStep[] = [
      { line: claudeInit() },
      { line: { type: 'system', subtype: 'status', status: 'compacting', session_id: '$SESSION' } },
      { line: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180_000 }, session_id: '$SESSION' } },
      { line: { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded', session_id: '$SESSION' } },
      { line: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000 }, session_id: '$SESSION' } },
      { line: { type: 'system', subtype: 'permission_denied', tool_name: 'WebFetch', tool_use_id: 't', message: 'denied by policy', session_id: '$SESSION' } },
      { line: { type: 'system', subtype: 'hook_started', session_id: '$SESSION' } },
      { line: claudeResult() },
    ];
    const events = await collect(await claudeHarness(root, steps).runner.start(input()));
    expect(events).toContainEqual({ t: 'compaction', phase: 'start' });
    expect(events).toContainEqual({ t: 'compaction', phase: 'end', before: 180_000 });
    expect(events).toContainEqual({ t: 'diagnostic', code: 'api_retry', message: 'Claude API overloaded (529); retry 1/10 in 500ms' });
    expect(events).toContainEqual(expect.objectContaining({ t: 'diagnostic', code: 'rate_limited' }));
    expect(events).toContainEqual({ t: 'diagnostic', code: 'permission_denied', message: 'WebFetch denied: denied by policy' });
    expect(events.some((event) => event.t === 'diagnostic' && event.code === 'unknown_event')).toBe(false);
    expect(events.at(-1)).toMatchObject({ reason: 'idle' });
  });

  it.each([
    { name: 'a 429 error result', result: { subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429 rate limited' }, code: 'rate_limit', retryable: true, reason: 'error' },
    { name: 'an auth failure', result: { subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key sk-ant-api03-SECRETSECRETSECRET' }, code: 'auth', retryable: false, reason: 'error' },
    { name: 'a budget stop', result: { subtype: 'error_max_budget_usd', is_error: true, errors: ['budget'] }, code: 'budget_exhausted', retryable: false, reason: 'error' },
  ])('maps $name to a classified error', async ({ result, code, retryable, reason }) => {
    const events = await collect(await claudeHarness(root, [{ line: claudeInit() }, { line: claudeResult(result) }]).runner.start(input()));
    expect(events.at(-2)).toMatchObject({ t: 'error', code, retryable });
    expect(events.at(-1)).toMatchObject({ t: 'turn.finished', reason });
    expect(JSON.stringify(events)).not.toContain('SECRETSECRETSECRET');
  });

  it('ends at the turn limit with reason max_turns', async () => {
    const events = await collect(await claudeHarness(root, [{ line: claudeInit() }, { line: claudeResult({ subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' }) }]).runner.start(input()));
    expect(events.slice(-2)).toEqual([
      { t: 'diagnostic', code: 'max_turns', message: 'Claude Code stopped at the maximum number of turns' },
      { t: 'turn.finished', turn: 1, reason: 'max_turns' },
    ]);
  });

  it('subtracts the previous run from a resumed session’s cumulative totals', async () => {
    const sessionId = '22222222-3333-4444-8555-666666666666';
    const first = claudeHarness(root, claudeSuccess(worktree), { claude: { newSessionId: () => sessionId } });
    await collect(await first.runner.start(input()));
    const later = { input: 200, output: 45, cacheRead: 260, cacheWrite: 30, reasoning: 0 };
    const resumed = claudeHarness(root, [{ line: claudeInit() }, { line: claudeResult({}, later, 0.0223) }], { env: { OPENLINEAR_SANDBOX_DIR: first.env.OPENLINEAR_SANDBOX_DIR } });
    const events = await collect(await resumed.runner.resume(sessionId, { worktreePath: worktree, signal: new AbortController().signal, env: KEY }));
    expect(reduceUsage(events).usage).toEqual({ input: 70, output: 20, cacheRead: 60, cacheWrite: 20, reasoning: 0 });
    expect(reduceUsage(events).costUsd).toBeCloseTo(0.01, 6);
  });

  it('falls back to the per-message lower bound for a resumed session without a baseline', async () => {
    const steps: FakeStep[] = [
      { line: claudeInit() },
      { line: { type: 'assistant', parent_tool_use_id: null, session_id: '$SESSION', message: { id: 'm1', content: [], usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } } },
      { line: claudeResult({}, { input: 900, output: 900, cacheRead: 900, cacheWrite: 900, reasoning: 0 }, 9) },
    ];
    const h = claudeHarness(root, steps);
    const events = await collect(await h.runner.resume('33333333-4444-4555-8666-777777777777', { worktreePath: worktree, signal: new AbortController().signal, env: KEY }));
    expect(events.filter((event) => event.t === 'usage')).toEqual([{ t: 'usage', usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, reasoning: 0 } }]);
  });

  it('asks the host for approval under the ask policy and answers in-band', async () => {
    const toolUse = { type: 'assistant', parent_tool_use_id: null, session_id: '$SESSION', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'rm -rf build' } }], usage: { input_tokens: 1, output_tokens: 1 } } };
    const steps = (requestId: string): FakeStep[] => [
      { line: claudeInit() },
      { line: toolUse },
      { permission: { requestId, toolName: 'Bash', toolUseId: 'toolu_9', input: { command: 'rm -rf build' } } },
      { line: claudeResult() },
    ];
    for (const [decision, scope, ok] of [['allow', 'session', true], ['deny', 'once', false]] as const) {
      const h = claudeHarness(root, steps(`req-${decision}`));
      const session = await h.runner.start(input({ permissions: { default: 'ask' } }));
      const iterator = session.events[Symbol.asyncIterator]();
      const events: AgentEvent[] = [];
      await readUntil(iterator, events, (event) => event.t === 'permission.requested');
      expect(events.at(-1)).toEqual({ t: 'permission.requested', id: `req-${decision}`, tool: 'Bash', detail: '{\n  "command": "rm -rf build"\n}' });
      await session.replyPermission(`req-${decision}`, decision, scope);
      // A second (late) reply is harmless: nothing waits for it.
      await expect(session.replyPermission(`req-${decision}`, decision)).resolves.toBeUndefined();
      await drain(iterator, events);
      expect(events).toContainEqual(expect.objectContaining({ t: 'tool.finished', callId: 'toolu_9', ok }));
      const reply = h.invocations().find((entry) => entry.event === 'input' && JSON.stringify(entry.msg).includes('control_response'));
      const response = (reply?.msg as { response?: { response?: Record<string, unknown> } } | undefined)?.response?.response;
      if (decision === 'allow') {
        expect(response).toEqual({ behavior: 'allow', updatedInput: { command: 'rm -rf build' }, toolUseID: 'toolu_9', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] });
      } else {
        expect(response).toEqual({ behavior: 'deny', message: 'Denied by the OpenLinear user', toolUseID: 'toolu_9' });
      }
      expect(h.invocation()?.argv).toEqual(expect.arrayContaining(['--permission-prompt-tool', 'stdio']));
    }
  });

  it('FE-04 review fix: tells the host when Claude Code withdraws a permission request', async () => {
    const h = claudeHarness(root, [
      { line: claudeInit() },
      { line: { type: 'control_request', request_id: 'cr-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } } },
      { line: { type: 'control_cancel_request', request_id: 'cr-2' } },
      { line: claudeResult() },
    ]);
    const session = await h.runner.start(input({ permissions: { default: 'ask' } }));
    const withdrawn: string[] = [];
    const unsubscribe = session.onPermissionWithdrawn?.((id) => withdrawn.push(id));
    const events = await collect(session);
    unsubscribe?.();
    expect(events).toContainEqual(expect.objectContaining({ t: 'permission.requested', id: 'cr-2' }));
    expect(events).toContainEqual(expect.objectContaining({ t: 'diagnostic', code: 'permission_withdrawn' }));
    expect(withdrawn).toEqual(['cr-2']);
    await expect(session.replyPermission('cr-2', 'allow', 'once')).resolves.toBeUndefined();
  });

  it('declines host requests it does not serve instead of hanging the CLI', async () => {
    const h = claudeHarness(root, [
      { line: claudeInit() },
      { line: { type: 'control_request', request_id: 'cr-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } } },
      { line: claudeResult() },
    ]);
    const events = await collect(await h.runner.start(input()));
    expect(events).toContainEqual({ t: 'diagnostic', code: 'control_request_rejected', message: 'Declined a can_use_tool control request from Claude Code' });
    // The fake CLI logs what it read from stdin asynchronously; under load the
    // result line can be processed before that log entry lands, so wait for it.
    const findAnswer = () => h.invocations().find((entry) => entry.event === 'input' && JSON.stringify(entry.msg).includes('cr-1'));
    const deadline = Date.now() + 2_000;
    while (!findAnswer() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(findAnswer()?.msg).toEqual({ type: 'control_response', response: { subtype: 'error', request_id: 'cr-1', error: 'OpenLinear does not answer can_use_tool requests' } });
  });

  it('handles the engine’s cancel order (signal, interrupt, abort) with a single in-band interrupt', async () => {
    const h = claudeHarness(root, [...claudeSuccess(worktree).slice(0, 3), { hang: true }]);
    const controller = new AbortController();
    const session = await h.runner.start(input({ signal: controller.signal }));
    const iterator = session.events[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    await readUntil(iterator, events, (event) => event.t === 'message.delta');
    controller.abort();
    await session.interrupt();
    await session.abort();
    await drain(iterator, events);
    expect(events.slice(-2)).toEqual([
      { t: 'cancel.receipt', via: 'signal', confirmedBy: 'runner-ack' },
      { t: 'turn.finished', turn: 1, reason: 'interrupted' },
    ]);
    const interrupts = h.invocations().filter((entry) => entry.event === 'input' && JSON.stringify(entry.msg).includes('"subtype":"interrupt"'));
    expect(interrupts).toHaveLength(1);
    await closed(session);
    expect(isAlive(h.invocation()?.pid)).toBe(false);
  });

  it('escalates an unacknowledged interrupt to stopping the process', async () => {
    const h = claudeHarness(root, [...claudeSuccess(worktree).slice(0, 3), { hang: true }], { interrupt: 'ignore' });
    const session = await h.runner.start(input());
    const iterator = session.events[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    await readUntil(iterator, events, (event) => event.t === 'message.delta');
    await session.interrupt();
    await drain(iterator, events);
    expect(events).toContainEqual(expect.objectContaining({ t: 'diagnostic', code: 'interrupt_unacknowledged' }));
    expect(events.at(-2)).toMatchObject({ t: 'cancel.receipt', via: 'interrupt', confirmedBy: 'process-exit', exitCode: 143 });
    const sent = h.invocations().filter((entry) => entry.event === 'input').map((entry) => entry.msg);
    expect(sent).toContainEqual({ type: 'control_request', request_id: 'openlinear-1', request: { subtype: 'interrupt' } });
  });
});

describe('ClaudeCodeRunner credentials (never read, copied or relayed)', () => {
  it('links the user’s own file login read-only and allows only the Anthropic hosts', async () => {
    const h = claudeHarness(root, claudeSuccess(worktree));
    mkdirSync(join(h.home, '.claude', 'projects', 'other'), { recursive: true });
    const credentials = join(h.home, '.claude', '.credentials.json');
    writeFileSync(credentials, '{"fixture":"OPENLINEAR-FAKE-CLAUDE-LOGIN"}', { mode: 0o600 });
    await collect(await h.runner.start(input({ env: {} })));
    const env = h.invocation()?.env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    const link = join(env.CLAUDE_CONFIG_DIR ?? '', '.credentials.json');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(realpathSync.native(credentials));
    const rules = h.policies[0]?.filesystem.rules ?? [];
    expect(rules.at(-1)).toEqual({ action: 'read', path: realpathSync.native(credentials), scope: 'file' });
    // The rest of ~/.claude (other projects' transcripts, settings, hooks) stays denied.
    expect(rules).toContainEqual({ action: 'deny', path: join(h.home, '.claude'), scope: 'subtree' });
    expect(h.policies[0]?.network.allowedHosts).toEqual(['api.anthropic.com', 'console.anthropic.com', 'platform.claude.com']);
  });

  it('fails closed before spawning when the login lives in the macOS Keychain', async () => {
    const h = claudeHarness(root, claudeSuccess(worktree), { claude: { platform: 'darwin' } });
    await expect(h.runner.start(input({ env: {} }))).rejects.toMatchObject({ code: 'RUNNER_AUTH_UNAVAILABLE', statusCode: 412 });
    expect(h.spawns()).toBe(0);
    expect(h.started()).toBe(false);
  });

  it('runs the unmodified CLI with the user’s own login under an explicit trusted-host grant', async () => {
    const h = claudeHarness(root, claudeSuccess(worktree), { env: grantEnv() });
    const events = await collect(await h.runner.start(input({ env: {} })));
    expect(events.at(-1)).toMatchObject({ reason: 'idle' });
    const env = h.invocation()?.env ?? {};
    expect(env.HOME).toBe(h.home);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(h.policies).toHaveLength(0);
  });

  it('refuses a missing or too-old binary before spawning', async () => {
    const missing = claudeHarness(root, [], { claude: { resolveBinary: () => null } });
    await expect(missing.runner.start(input())).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' });
    const old = claudeHarness(root, [], { version: '2.1.200 (Claude Code)\n' });
    await expect(old.runner.start(input())).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE', details: { version: '2.1.200' } });
    expect(old.spawns()).toBe(0);
  });
});

describe('ClaudeCodeRunner health (no inference)', () => {
  const commands = (status: Record<string, unknown> | string, version = '2.1.310 (Claude Code)\n') => {
    const calls: string[] = [];
    const run = async (_binary: string, args: readonly string[]): Promise<ShortCommandResult> => {
      calls.push(args.join(' '));
      if (args[0] === '--version') return { code: 0, stdout: version, stderr: '', timedOut: false };
      return { code: 0, stdout: typeof status === 'string' ? status : JSON.stringify(status), stderr: '', timedOut: false };
    };
    return { run, calls };
  };
  const binary = () => ({ path: '/opt/fixture/claude', readRoot: null, source: 'path' as const });
  const loggedIn = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.invalid', orgName: 'Fixture Org', orgId: 'org-123' };

  function home(withCredentials: boolean): string {
    const dir = mkdtempSync(join(root, 'claude-home-'));
    if (withCredentials) {
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', '.credentials.json'), '{}');
    }
    return dir;
  }

  it('reports version and login without identifying fields', async () => {
    const { run, calls } = commands(loggedIn);
    const runner = new ClaudeCodeRunner({ env: { HOME: home(true) }, platform: 'linux', resolveBinary: binary, runCommand: run });
    const health = await runner.healthCheck();
    expect(health).toMatchObject({ ok: true, version: '2.1.310', binary: '/opt/fixture/claude', auth: { status: 'ok', method: 'claude.ai' } });
    expect(JSON.stringify(health)).not.toMatch(/person@|Fixture Org|org-123/);
    await runner.healthCheck();
    expect(calls).toEqual(['--version', 'auth status --json']);
  });

  it('distinguishes a Keychain login the sandbox cannot reach from a missing one', async () => {
    const keychain = await new ClaudeCodeRunner({ env: { HOME: home(false) }, platform: 'darwin', resolveBinary: binary, runCommand: commands(loggedIn).run }).healthCheck();
    expect(keychain).toMatchObject({ ok: false, auth: { status: 'unreachable-in-sandbox', method: 'claude.ai' } });
    expect(keychain.auth?.detail).toContain('Keychain');
    const missing = await new ClaudeCodeRunner({ env: { HOME: home(false) }, resolveBinary: binary, runCommand: commands({ loggedIn: false, authMethod: 'none' }).run }).healthCheck();
    expect(missing).toMatchObject({ ok: false, auth: { status: 'missing' } });
    const cloud = await new ClaudeCodeRunner({ env: { HOME: home(true) }, resolveBinary: binary, runCommand: commands({ ...loggedIn, apiProvider: 'bedrock' }).run }).healthCheck();
    expect(cloud).toMatchObject({ ok: false, auth: { status: 'unreachable-in-sandbox' } });
    const granted = await new ClaudeCodeRunner({ env: { HOME: home(false), ...grantEnv() }, platform: 'darwin', resolveBinary: binary, runCommand: commands(loggedIn).run }).healthCheck();
    expect(granted).toMatchObject({ ok: true, auth: { status: 'ok' } });
    const garbled = await new ClaudeCodeRunner({ env: { HOME: home(true) }, resolveBinary: binary, runCommand: commands('not json').run }).healthCheck();
    expect(garbled).toMatchObject({ ok: false, auth: { status: 'unknown' } });
  });

  it('reports a missing binary and an unsupported version', async () => {
    expect(await new ClaudeCodeRunner({ resolveBinary: () => null }).healthCheck()).toMatchObject({ ok: false });
    expect(await new ClaudeCodeRunner({ env: { HOME: home(true) }, resolveBinary: binary, runCommand: commands(loggedIn, '2.0.1 (Claude Code)').run }).healthCheck())
      .toMatchObject({ ok: false, version: '2.0.1' });
    const failing = async (): Promise<ShortCommandResult> => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false });
    expect(await new ClaudeCodeRunner({ resolveBinary: binary, runCommand: failing }).healthCheck()).toMatchObject({ ok: false, detail: '`claude --version` failed' });
  });

  it('advertises accurate capabilities and no fabricated model catalogue', async () => {
    const runner = new ClaudeCodeRunner({ resolveBinary: () => null });
    expect(runner.capabilities).toMatchObject({ permissionReply: true, interrupt: true, compact: false, revert: false, fork: false });
    expect(runner.features).toMatchObject({ resume: 'native-session', interrupt: 'graceful-ack', approvals: 'interactive', minVersion: '2.1.259', models: { discovery: 'none', passthrough: true } });
    expect(await runner.listModels()).toEqual([]);
  });
});
