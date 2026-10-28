/**
 * The two Claude stream-event shapes the fixtures emit (the subset of the
 * Anthropic Messages streaming types the adapter reads). Declared locally so
 * the sidecar doesn't depend on `@anthropic-ai/sdk` just for test typings.
 */
type ClaudeStreamEvent =
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } }
  | { type: 'message_start'; message: Record<string, unknown> };
import type { ThreadEvent } from '@openai/codex-sdk';
import type { TokenUsage } from '@openlinear/execution-core';
import type { FakeStep } from './fake-cli';

/**
 * Recorded-stream fixtures for the conformance suite. Shapes follow the
 * pinned contracts: Codex `ThreadEvent` (@openai/codex-sdk 0.164.0, type
 * checked here), Claude Code stream-json (Agent SDK 0.3.310 typings; Anthropic
 * stream deltas type checked against the local ClaudeStreamEvent subset), and OpenCode bus
 * events as the existing adapter tests record them. `$SESSION` is replaced
 * by the fake CLI with the session id it was launched with.
 */

export type Phase = 'startup' | 'streaming' | 'tool';

// ---------------------------------------------------------------- Claude Code

const CLAUDE_MODEL = 'claude-opus-5-5';

export function claudeInit(): Record<string, unknown> {
  return {
    type: 'system', subtype: 'init', uuid: 'u-init', session_id: '$SESSION', apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: '2.1.310', cwd: '/worktree', tools: ['Bash', 'Edit', 'Read', 'Write'], mcp_servers: [],
    model: CLAUDE_MODEL, permissionMode: 'acceptEdits', slash_commands: [], output_style: 'default', skills: [], plugins: [],
    capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
  };
}

function streamEvent(event: ClaudeStreamEvent): Record<string, unknown> {
  return { type: 'stream_event', uuid: 'u-stream', session_id: '$SESSION', parent_tool_use_id: null, event };
}

function messageStart(id: string): Record<string, unknown> {
  // Only the fields the adapter reads; the full BetaMessage is not needed.
  return { type: 'stream_event', uuid: 'u-start', session_id: '$SESSION', parent_tool_use_id: null, event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: CLAUDE_MODEL, content: [] } } };
}

function textDelta(text: string): Record<string, unknown> {
  return streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
}

function assistant(id: string, content: unknown[], usage: Record<string, number>): Record<string, unknown> {
  return {
    type: 'assistant', uuid: `u-${id}`, session_id: '$SESSION', parent_tool_use_id: null,
    message: { id, type: 'message', role: 'assistant', model: CLAUDE_MODEL, content, stop_reason: null, usage },
  };
}

export const CLAUDE_USAGE_1 = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 };
export const CLAUDE_USAGE_2 = { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 150, cache_creation_input_tokens: 0 };
/** What one fresh run of `claudeSuccess` costs: the sum of both API messages. */
export const CLAUDE_EXPECTED_USAGE: TokenUsage = { input: 130, output: 25, cacheRead: 200, cacheWrite: 10, reasoning: 0 };

export function claudeResult(overrides: Record<string, unknown> = {}, totals: TokenUsage = CLAUDE_EXPECTED_USAGE, cost = 0.0123): Record<string, unknown> {
  return {
    type: 'result', subtype: 'success', uuid: 'u-result', session_id: '$SESSION', duration_ms: 1200, duration_api_ms: 900,
    is_error: false, num_turns: 2, result: 'Done.', stop_reason: 'end_turn', total_cost_usd: cost, terminal_reason: 'completed',
    usage: { input_tokens: totals.input, output_tokens: totals.output, cache_read_input_tokens: totals.cacheRead, cache_creation_input_tokens: totals.cacheWrite },
    modelUsage: {
      [CLAUDE_MODEL]: {
        inputTokens: totals.input, outputTokens: totals.output, cacheReadInputTokens: totals.cacheRead,
        cacheCreationInputTokens: totals.cacheWrite, webSearchRequests: 0, costUSD: cost, contextWindow: 1_000_000, maxOutputTokens: 128_000,
      },
    },
    permission_denials: [],
    ...overrides,
  };
}

/** Text + an Edit tool call + text; the first API message is split per content block (same id, same usage). */
export function claudeSuccess(worktree: string): FakeStep[] {
  return [
    { line: claudeInit() },
    { line: messageStart('msg_1') },
    { line: textDelta('Fixing') },
    { line: textDelta(' the test.') },
    { line: assistant('msg_1', [{ type: 'text', text: 'Fixing the test.' }], CLAUDE_USAGE_1) },
    { line: assistant('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: `${worktree}/src/a.ts`, old_string: 'a', new_string: 'b' } }], CLAUDE_USAGE_1) },
    { line: { type: 'tool_progress', tool_use_id: 'toolu_1', tool_name: 'Edit', parent_tool_use_id: null, elapsed_time_seconds: 1, uuid: 'u-p', session_id: '$SESSION' } },
    {
      line: {
        type: 'user', uuid: 'u-tr', session_id: '$SESSION', parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'The file has been updated.' }] },
        tool_use_result: { type: 'update', filePath: `${worktree}/src/a.ts` },
      },
    },
    { line: messageStart('msg_2') },
    { line: textDelta('Done.') },
    { line: assistant('msg_2', [{ type: 'text', text: 'Done.' }], CLAUDE_USAGE_2) },
    { line: claudeResult() },
  ];
}

export function claudeHangAt(phase: Phase, worktree: string): FakeStep[] {
  const full = claudeSuccess(worktree);
  if (phase === 'startup') return [{ sleep: 60_000 }, ...full];
  if (phase === 'streaming') return [...full.slice(0, 3), { hang: true }];
  return [...full.slice(0, 6), { hang: true }];
}

export function claudeEof(): FakeStep[] {
  return [{ line: claudeInit() }, { line: messageStart('msg_1') }, { line: textDelta('Partial') }, { exit: 0 }];
}

export function claudeMalformed(worktree: string): FakeStep[] {
  const full = claudeSuccess(worktree);
  return [
    full[0],
    { raw: 'this is not json' },
    { raw: '{"truncated": ' },
    { line: { type: 'mystery_event', payload: 1 } },
    { line: { type: 'system', subtype: 'brand_new_subtype' } },
    { line: { no_type: true } },
    ...full.slice(1),
  ];
}

// ---------------------------------------------------------------------- Codex

const CODEX_USAGE = { input_tokens: 1200, cached_input_tokens: 800, cache_write_input_tokens: 64, output_tokens: 90, reasoning_output_tokens: 30 };
/** OpenAI semantics: cacheRead ⊂ input, reasoning ⊂ output. Reported once per turn. */
export const CODEX_EXPECTED_USAGE: TokenUsage = { input: 1200, output: 90, cacheRead: 800, cacheWrite: 64, reasoning: 30 };

export function codexSuccess(threadId = 'thread-1'): ThreadEvent[] {
  return [
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: 'Fixing' } },
    { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Fixing the test.' } },
    { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test', aggregated_output: '', status: 'in_progress' } },
    { type: 'item.updated', item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test', aggregated_output: 'ok', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test', aggregated_output: 'ok\npassed', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'patch-1', type: 'file_change', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update' }] } },
    { type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: 'Done.' } },
    { type: 'turn.completed', usage: CODEX_USAGE },
  ];
}

const lines = (events: ThreadEvent[]): FakeStep[] => events.map((line) => ({ line }));

export function codexSuccessSteps(threadId?: string): FakeStep[] {
  return lines(codexSuccess(threadId));
}

export function codexHangAt(phase: Phase): FakeStep[] {
  const full = codexSuccessSteps();
  if (phase === 'startup') return [{ sleep: 60_000 }, ...full];
  if (phase === 'streaming') return [...full.slice(0, 3), { hang: true }];
  return [...full.slice(0, 5), { hang: true }];
}

export function codexEof(): FakeStep[] {
  return [...codexSuccessSteps().slice(0, 3), { exit: 0 }];
}

export function codexMalformed(): FakeStep[] {
  const full = codexSuccessSteps();
  return [
    full[0],
    { raw: 'not json at all' },
    { line: { type: 'thread.mystery', detail: 1 } },
    { line: { no_type: true } },
    { line: { type: 'item.completed', item: null } },
    ...full.slice(1),
  ];
}

// ------------------------------------------------------------------- OpenCode

export const OPENCODE_SESSION = 'session-a';
/** Two snapshots of the same assistant message: the second replaces the first. */
export const OPENCODE_EXPECTED_USAGE: TokenUsage = { input: 30, output: 12, cacheRead: 4, cacheWrite: 2, reasoning: 1 };

export function openCodeSuccess(sessionID = OPENCODE_SESSION): unknown[] {
  return [
    { type: 'server.connected', properties: {} },
    { type: 'message.part.updated', properties: { part: { sessionID, id: 'text-1', type: 'text', text: 'Fixing' }, delta: 'Fixing' } },
    { type: 'message.part.updated', properties: { part: { sessionID, id: 'tool-1', callID: 'call-1', type: 'tool', tool: 'edit', state: { status: 'running' } } } },
    { type: 'message.updated', properties: { info: { sessionID, role: 'assistant', id: 'msg-1', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 1 } }, cost: 0.001 } } },
    { type: 'message.part.updated', properties: { part: { sessionID, id: 'tool-1', callID: 'call-1', type: 'tool', tool: 'edit', state: { status: 'completed', output: 'edited' } } } },
    { type: 'file.edited', properties: { sessionID, file: 'src/a.ts' } },
    { type: 'message.updated', properties: { info: { sessionID, role: 'assistant', id: 'msg-1', tokens: { input: 30, output: 12, reasoning: 1, cache: { read: 4, write: 2 } }, cost: 0.003 } } },
    { type: 'message.part.updated', properties: { part: { sessionID, id: 'text-2', type: 'text', text: 'Done.' }, delta: 'Done.' } },
    { type: 'session.idle', properties: { sessionID } },
  ];
}

export function openCodeUntil(phase: Phase): unknown[] {
  const full = openCodeSuccess();
  if (phase === 'startup') return [];
  if (phase === 'streaming') return full.slice(0, 2);
  return full.slice(0, 3);
}

export function openCodeMalformed(): unknown[] {
  const full = openCodeSuccess();
  return [full[0], null, 'not an event', { properties: { sessionID: OPENCODE_SESSION } }, { type: 'brand.new', properties: { sessionID: OPENCODE_SESSION } }, ...full.slice(1)];
}
