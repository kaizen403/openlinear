import { describe, expect, it, vi } from 'vitest';
import type { CodexOptions, Input, RunStreamedResult, ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import type { AgentEvent, AgentSession, StartInput } from '@openlinear/execution-core';
import { emptyTokenUsage } from '@openlinear/execution-core';
import { CodexRunner, decodeCodexEvent } from './index';

const usage = { input_tokens: 100, output_tokens: 40, cached_input_tokens: 30, cache_write_input_tokens: 20, reasoning_output_tokens: 10 };

function decoderState() {
  return {
    textByItem: new Map<string, string>(), startedTools: new Set<string>(), completedItems: new Set<string>(),
    usage: emptyTokenUsage(), turn: 0, terminal: false,
  };
}

function startInput(signal = new AbortController().signal): StartInput {
  return {
    runId: 'run-1', worktreePath: '/tmp/worktree', systemContract: 'Verify the changes.', prompt: 'Fix the failing test.',
    model: { provider: 'openai', id: 'configured-model' }, budgets: { wallClockMs: 1000 }, permissions: { default: 'allow' },
    sandbox: { cwd: '/tmp/worktree', env: {} }, env: { OPENAI_API_KEY: 'fixture-key' }, signal,
  };
}

function harness(source: ThreadEvent[] | ((signal?: AbortSignal) => AsyncGenerator<ThreadEvent>)) {
  const constructors = vi.fn<(options?: CodexOptions) => void>();
  const runStreamed = vi.fn(async (_input: Input, options?: TurnOptions): Promise<RunStreamedResult> => {
    async function* events(): AsyncGenerator<ThreadEvent> {
      const stream = typeof source === 'function' ? source(options?.signal) : source;
      for await (const event of stream) {
        if (event.type === 'thread.started') thread.id = event.thread_id;
        yield event;
      }
    }
    return { events: events() };
  });
  const thread = { id: null as string | null, runStreamed };
  const startThread = vi.fn((_options?: ThreadOptions) => thread);
  const resumeThread = vi.fn((id: string, _options?: ThreadOptions) => { thread.id = id; return thread; });
  class FixtureCodex {
    constructor(options?: CodexOptions) { constructors(options); }
    startThread = startThread;
    resumeThread = resumeThread;
  }
  return { runner: new CodexRunner(async () => FixtureCodex), constructors, thread, startThread, resumeThread, runStreamed };
}

async function collect(session: AgentSession): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.events) events.push(event);
  return events;
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
      { t: 'tool.finished', callId: 'patch', name: 'apply_patch', ok: true },
      { t: 'file.changed', path: 'new.ts', kind: 'create' }, { t: 'file.changed', path: 'old.ts', kind: 'delete' },
      { t: 'file.changed', path: 'edit.ts', kind: 'edit' },
    ]);
    expect(decodeCodexEvent(completed, state)).toEqual([]);
    expect(decodeCodexEvent({ type: 'item.completed', item: {
      id: 'failed-patch', type: 'file_change', status: 'failed', changes: [{ path: 'missing.ts', kind: 'update' }],
    } }, state)).toEqual([{ t: 'tool.finished', callId: 'failed-patch', name: 'apply_patch', ok: false }]);
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

describe('CodexRunner sessions', () => {
  it('forwards the selected model and key, exposes the real ID and completes successfully', async () => {
    const fixture = harness([
      { type: 'thread.started', thread_id: 'codex-thread' }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Fixed and verified.' } },
      { type: 'turn.completed', usage },
    ]);
    const input = startInput();
    const session = await fixture.runner.start(input);
    expect(session.externalId).toBe('run-1');
    const events = await collect(session);
    expect(fixture.constructors).toHaveBeenCalledWith({ apiKey: 'fixture-key' });
    expect(fixture.startThread).toHaveBeenCalledWith({ workingDirectory: '/tmp/worktree', model: 'configured-model', sandboxMode: 'workspace-write', approvalPolicy: 'never' });
    expect(fixture.runStreamed.mock.calls[0]?.[0]).toBe('Verify the changes.\n\nFix the failing test.');
    expect(events[0]).toEqual({ t: 'session.started', externalId: 'codex-thread', model: input.model });
    expect(events.at(-1)).toEqual({ t: 'turn.finished', turn: 1, reason: 'idle' });
    expect(session.externalId).toBe('codex-thread');
    expect(fixture.runStreamed.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(collect(session)).rejects.toThrow('only be consumed once');
  });

  it('resumes a saved thread with continuation input and preserves the stored model', async () => {
    const fixture = harness([{ type: 'turn.started' }, { type: 'turn.completed', usage }]);
    const session = await fixture.runner.resume('saved-thread', { worktreePath: '/tmp/restored', signal: new AbortController().signal });
    const events = await collect(session);
    expect(events[0]).toEqual({ t: 'session.started', externalId: 'saved-thread', model: { provider: 'openai', id: 'unknown' } });
    expect(session.externalId).toBe('saved-thread');
    expect(fixture.resumeThread).toHaveBeenCalledWith('saved-thread', { workingDirectory: '/tmp/restored', sandboxMode: 'workspace-write', approvalPolicy: 'never' });
    expect(fixture.startThread).not.toHaveBeenCalled();
    expect(fixture.runStreamed.mock.calls[0]?.[0]).toContain('Continue the interrupted task');
  });

  it('does not start an already cancelled turn', async () => {
    const fixture = harness([]);
    const controller = new AbortController();
    controller.abort();
    expect(await collect(await fixture.runner.start(startInput(controller.signal)))).toEqual([{ t: 'turn.finished', turn: 0, reason: 'interrupted' }]);
    expect(fixture.runStreamed).not.toHaveBeenCalled();
  });

  it.each(['interrupt', 'abort', 'external'] as const)('cancels a blocked stream through %s', async (method) => {
    const fixture = harness(async function* (signal) {
      yield { type: 'thread.started', thread_id: 'cancel-thread' };
      yield { type: 'turn.started' };
      await new Promise<void>((_resolve, reject) => {
        const stop = () => reject(new Error('SDK child aborted'));
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
      });
    });
    const controller = new AbortController();
    const session = await fixture.runner.start(startInput(controller.signal));
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const pending = iterator.next();
    if (method === 'external') controller.abort();
    else await session[method]();
    expect(await pending).toEqual({ done: false, value: { t: 'turn.finished', turn: 1, reason: 'interrupted' } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(fixture.runStreamed.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('aborts the SDK when a consumer closes before completion', async () => {
    const fixture = harness([{ type: 'thread.started', thread_id: 'early-close' }, { type: 'turn.started' }]);
    const iterator = (await fixture.runner.start(startInput())).events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(fixture.runStreamed.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('fails a stream that closes without a provider terminal event', async () => {
    const fixture = harness([{ type: 'thread.started', thread_id: 'incomplete' }, { type: 'turn.started' }]);
    const events = await collect(await fixture.runner.start(startInput()));
    expect(events.at(-2)).toEqual({ t: 'error', code: 'codex', message: 'Codex stream closed before the turn ended', retryable: false });
    expect(events.at(-1)).toEqual({ t: 'turn.finished', turn: 1, reason: 'error' });
  });

  it('normalizes SDK execution exceptions as failures', async () => {
    const fixture = harness(async function* () { throw new Error('CLI exited with code 1'); });
    expect(await collect(await fixture.runner.start(startInput()))).toEqual([
      { t: 'error', code: 'codex', message: 'CLI exited with code 1', retryable: false },
      { t: 'turn.finished', turn: 0, reason: 'error' },
    ]);
  });

  it('reports unsupported capabilities without claiming a live model catalogue', async () => {
    const fixture = harness([]);
    expect(fixture.runner.capabilities).toMatchObject({ permissionReply: false, compact: false, revert: false, fork: false, interrupt: true });
    expect(await fixture.runner.listModels()).toEqual([]);
    expect(await fixture.runner.healthCheck()).toEqual({ ok: true, detail: 'Codex SDK and CLI binary located; execution and authentication are not checked' });
    await expect((await fixture.runner.start(startInput())).replyPermission('approval', 'allow')).rejects.toThrow('does not support interactive permission replies');
  });
});
