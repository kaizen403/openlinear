import { describe, expect, it, vi } from 'vitest';
import type { EventMessagePartDelta, EventSessionIdle } from '@opencode-ai/sdk/v2';
import type { AgentEvent, AgentSession, StartInput } from '@openlinear/execution-core';

vi.mock('../../services/opencode', () => ({
  getClientForUser: vi.fn(),
  getOpenCodeStatus: vi.fn(),
}));

import { OpenCodeRunner } from './index';
import { getClientForUser } from '../../services/opencode';
import { SandboxUnavailableError } from '../../sandbox/errors';

type RunnerClient = Awaited<ReturnType<NonNullable<ConstructorParameters<typeof OpenCodeRunner>[0]>>>;

function makeRunner(sessionId: string, rawEvents: unknown[], scoped = false) {
  const subscribe = vi.fn(async () => ({
    stream: {
      async *[Symbol.asyncIterator]() {
        yield* rawEvents;
      },
    },
  }));
  const promptAsync = vi.fn(async () => ({}));
  const client = {
    session: {
      create: vi.fn(async () => ({ data: { id: sessionId } })),
      promptAsync,
      ...(scoped ? { event: { subscribe } } : {}),
    },
    event: { subscribe },
  };
  const runner = new OpenCodeRunner(async () => client as unknown as RunnerClient);
  return { runner, subscribe, promptAsync };
}

function startInput(runId: string): StartInput {
  return {
    runId,
    worktreePath: '/tmp/openlinear-fixture',
    prompt: 'fixture task',
    systemContract: 'fixture contract',
    budgets: { wallClockMs: 1000 },
    permissions: { default: 'deny' },
    sandbox: { cwd: '/tmp/openlinear-fixture', env: {} },
    env: {},
    signal: new AbortController().signal,
  };
}

async function collect(session: AgentSession): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.events) events.push(event);
  return events;
}

function legacyText(sessionID: string, text: string, id = 'part') {
  return {
    type: 'message.part.updated',
    properties: { part: { sessionID, id, type: 'text', text }, delta: text },
  };
}

function nativeDelta(sessionID: string, delta: string, partID = 'part'): EventMessagePartDelta {
  return {
    id: `event-${sessionID}`,
    type: 'message.part.delta',
    properties: { sessionID, messageID: 'message', partID, field: 'text', delta },
  };
}

function idle(sessionID: string): EventSessionIdle {
  return { id: `idle-${sessionID}`, type: 'session.idle', properties: { sessionID } };
}

describe('OpenCodeRunner session isolation', () => {
  it('isolates two consumers of interleaved global messages, tools, usage and errors', async () => {
    const events = [
      legacyText('session-a', 'A message'),
      legacyText('session-b', 'B message'),
      {
        type: 'message.part.updated',
        properties: { part: { sessionID: 'session-a', type: 'tool', id: 'a-tool', tool: 'bash', state: { status: 'running' } } },
      },
      {
        type: 'message.part.updated',
        properties: { part: { sessionID: 'session-b', type: 'tool', id: 'b-tool', tool: 'read', state: { status: 'completed', output: 'B private output' } } },
      },
      {
        type: 'message.updated',
        properties: { info: { sessionID: 'session-b', role: 'assistant', id: 'b-message', tokens: { input: 999, output: 888 } } },
      },
      {
        type: 'message.updated',
        properties: { info: { sessionID: 'session-a', role: 'assistant', id: 'a-message', tokens: { input: 3, output: 4, cache: { read: 1, write: 2 } } } },
      },
      {
        type: 'session.error',
        properties: { sessionID: 'session-b', error: { data: { message: 'B private error' } } },
      },
      legacyText('session-a', 'A continues'),
      idle('session-a'),
    ];
    const a = makeRunner('session-a', events);
    const b = makeRunner('session-b', events);
    const [outA, outB] = await Promise.all([
      a.runner.start(startInput('run-a')).then(collect),
      b.runner.start(startInput('run-b')).then(collect),
    ]);

    expect(outA.map((event) => event.t)).toEqual([
      'session.started', 'message.delta', 'tool.started', 'usage', 'message.delta', 'turn.finished',
    ]);
    expect(outA.find((event) => event.t === 'usage')).toMatchObject({
      usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, reasoning: 0 },
      messageId: 'a-message',
    });
    expect(JSON.stringify(outA)).not.toContain('B ');
    // W07: an error is followed by exactly one terminal turn.finished(error).
    expect(outB.map((event) => event.t)).toEqual([
      'session.started', 'message.delta', 'tool.finished', 'usage', 'error', 'turn.finished',
    ]);
    expect(outB.at(-2)).toMatchObject({ t: 'error', message: 'B private error' });
    expect(outB.at(-1)).toEqual({ t: 'turn.finished', turn: 0, reason: 'error' });
    expect(JSON.stringify(outB)).not.toContain('A ');
    expect(a.subscribe.mock.invocationCallOrder[0]).toBeLessThan(a.promptAsync.mock.invocationCallOrder[0]);
  });

  it('handles v2 properties and native data ownership before decoding text and reasoning deltas', async () => {
    const events = [
      {
        type: 'message.part.updated',
        data: { sessionID: 'session-a', part: { id: 'text', sessionID: 'session-a', type: 'text', text: '' } },
      },
      // Same part id in another session must not change the current type map.
      {
        type: 'message.part.updated',
        properties: { sessionID: 'session-b', part: { id: 'text', sessionID: 'session-b', type: 'reasoning', text: '' } },
      },
      nativeDelta('session-b', 'foreign delta', 'text'),
      nativeDelta('session-a', 'own text', 'text'),
      {
        type: 'message.part.updated',
        properties: { sessionID: 'session-a', part: { id: 'reason', sessionID: 'session-a', type: 'reasoning', text: '' } },
      },
      { type: 'message.part.delta', data: nativeDelta('session-a', 'own reasoning', 'reason').properties },
      {
        type: 'message.updated',
        data: { sessionID: 'session-b', info: { sessionID: 'session-b', role: 'assistant', id: 'foreign', tokens: { input: 555 } } },
      },
      {
        type: 'message.updated',
        data: { sessionID: 'session-a', info: { sessionID: 'session-a', role: 'assistant', id: 'own', tokens: { input: 5, output: 6 } } },
      },
      { type: 'session.idle', data: { sessionID: 'session-a' } },
    ];
    const { runner } = makeRunner('session-a', events);
    const out = await collect(await runner.start(startInput('run-a')));
    expect(out.filter((event) => event.t.endsWith('.delta'))).toEqual([
      { t: 'message.delta', text: 'own text' },
      { t: 'reasoning.delta', text: 'own reasoning' },
    ]);
    expect(out.find((event) => event.t === 'usage')).toMatchObject({ messageId: 'own', usage: { input: 5, output: 6 } });
    expect(out.at(-1)).toEqual({ t: 'turn.finished', turn: 0, reason: 'idle' });
  });

  it.each([false, true])('rejects missing ownership even on a scoped subscription (%s)', async (scoped) => {
    const events = [
      { type: 'session.error', properties: { id: 'session-a', error: { data: { message: 'unscoped error' } } } },
      { type: 'file.edited', properties: { file: '/tmp/openlinear-fixture/private.ts' } },
      { type: 'message.part.updated', properties: { part: { id: 'session-a', type: 'text' }, delta: 'unscoped message' } },
      { type: 'message.updated', properties: { info: { id: 'session-a', role: 'assistant', tokens: { input: 99 } } } },
      { type: 'permission.updated', properties: { id: 'session-a', type: 'read', title: 'unscoped permission' } },
      { type: 'session.idle', properties: { id: 'session-a' } },
      legacyText('session-a', 'own message'),
      idle('session-a'),
    ];
    const { runner } = makeRunner('session-a', events, scoped);
    const out = await collect(await runner.start(startInput('run-a')));
    expect(out).toEqual([
      { t: 'session.started', externalId: 'session-a', model: { id: 'opencode' } },
      { t: 'message.delta', text: 'own message' },
      { t: 'turn.finished', turn: 0, reason: 'idle' },
    ]);
  });

  it('rejects conflicting, empty and malformed ownership instead of guessing', async () => {
    const events = [
      { type: 'message.part.updated', properties: { sessionID: 'session-a', part: { sessionID: 'session-b', type: 'text' }, delta: 'conflicting part' } },
      { type: 'message.updated', data: { sessionID: 'session-a', info: { sessionID: 'session-b', role: 'assistant', tokens: { input: 99 } } } },
      { type: 'session.error', properties: { sessionID: 'session-a', sessionId: 'session-b', error: { data: { message: 'conflicting error' } } } },
      { type: 'session.created', properties: { sessionID: 'session-a', info: { id: 'session-b' } } },
      { type: 'message.part.updated', properties: { sessionID: '', part: { sessionID: 'session-a', type: 'text' }, delta: 'empty id' } },
      { type: 'message.part.updated', properties: { sessionID: 12, part: { sessionID: 'session-a', type: 'text' }, delta: 'invalid id' } },
      null,
      [],
      'bad event',
      { properties: { sessionID: 'session-a' } },
      legacyText('session-a', 'own message'),
      idle('session-a'),
    ];
    const { runner } = makeRunner('session-a', events);
    const out = await collect(await runner.start(startInput('run-a')));
    // W07: malformed events are reported (without their content), never decoded.
    expect(out.filter((event) => event.t !== 'diagnostic').map((event) => event.t)).toEqual(['session.started', 'message.delta', 'turn.finished']);
    expect(out.filter((event) => event.t === 'diagnostic')).toEqual(
      Array.from({ length: 4 }, () => ({ t: 'diagnostic', code: 'malformed_line', message: 'Ignored a malformed OpenCode event' })),
    );
    expect(JSON.stringify(out)).not.toMatch(/conflicting|empty id|invalid id|bad event/);
  });

  it('allows only explicit connection liveness without a session id', async () => {
    const { runner } = makeRunner('session-a', [
      { type: 'server.connected', properties: {} },
      { type: 'server.heartbeat', properties: { private: 'ignored metadata' } },
      { type: 'session.error', data: { error: { data: { message: 'unscoped error' } } } },
      { type: 'server.instance.disposed', properties: {} },
      idle('session-a'),
    ]);
    const out = await collect(await runner.start(startInput('run-a')));
    expect(out.slice(1)).toEqual([
      { t: 'heartbeat' }, { t: 'heartbeat' }, { t: 'turn.finished', turn: 0, reason: 'idle' },
    ]);
    expect(JSON.stringify(out)).not.toContain('metadata');
  });

  it('resolves legacy lifecycle info.id and filters unrelated and child sessions', async () => {
    const { runner } = makeRunner('session-a', [
      { type: 'session.created', properties: { info: { id: 'session-b' } } },
      { type: 'session.created', properties: { info: { id: 'session-a' } } },
      legacyText('child-a', 'child output'),
      { type: 'session.error', properties: { sessionID: 'child-a', parentID: 'session-a', error: { data: { message: 'child error' } } } },
      { type: 'session.idle', properties: { sessionID: 'child-a', parentID: 'session-a' } },
      legacyText('session-a', 'parent continues'),
      idle('session-a'),
    ]);
    const out = await collect(await runner.start(startInput('run-a')));
    expect(out.filter((event) => event.t === 'session.started')).toEqual([
      { t: 'session.started', externalId: 'session-a', model: { id: 'opencode' } },
      { t: 'session.started', externalId: 'session-a', model: { id: 'unknown' } },
    ]);
    expect(out.filter((event) => event.t === 'message.delta')).toEqual([{ t: 'message.delta', text: 'parent continues' }]);
    expect(out.at(-1)).toMatchObject({ t: 'turn.finished', reason: 'idle' });
  });

  it('filters global envelopes by payload ownership rather than envelope ids', async () => {
    const { runner } = makeRunner('session-a', [
      { directory: '/tmp/openlinear-fixture', payload: legacyText('session-b', 'foreign envelope') },
      { directory: '/tmp/openlinear-fixture', payload: legacyText('session-a', 'own envelope') },
      { directory: '/tmp/openlinear-fixture', payload: idle('session-a') },
    ]);
    const out = await collect(await runner.start(startInput('run-a')));
    expect(out.filter((event) => event.t === 'message.delta')).toEqual([{ t: 'message.delta', text: 'own envelope' }]);
  });

  it('ignores generic deltas with unknown/removed part types', async () => {
    const { runner } = makeRunner('session-a', [
      nativeDelta('session-a', 'unknown text'),
      { type: 'message.part.updated', data: { sessionID: 'session-a', part: { sessionID: 'session-a', id: 'part', type: 'text' } } },
      { type: 'message.part.removed', data: { sessionID: 'session-a', partID: 'part' } },
      nativeDelta('session-a', 'removed text'),
      idle('session-a'),
    ]);
    const out = await collect(await runner.start(startInput('run-a')));
    expect(out.some((event) => event.t.endsWith('.delta'))).toBe(false);
  });

  it('preserves own permission and error events and applies isolation to resumed sessions', async () => {
    const { runner } = makeRunner('unused', [
      { type: 'permission.updated', properties: { id: 'foreign-request', sessionID: 'session-b', type: 'bash', title: 'foreign permission' } },
      { type: 'permission.updated', properties: { id: 'own-request', sessionID: 'session-a', type: 'bash', title: 'own permission' } },
      { type: 'session.error', data: { sessionID: 'session-b', error: { data: { message: 'foreign error' } } } },
      { type: 'session.error', data: { sessionID: 'session-a', error: { data: { message: 'own error' } } } },
      legacyText('session-a', 'after terminal'),
    ]);
    const out = await collect(await runner.resume('session-a', {
      worktreePath: '/tmp/openlinear-fixture', signal: new AbortController().signal,
    }));
    expect(out.slice(1)).toEqual([
      { t: 'permission.requested', id: 'own-request', tool: 'bash', detail: 'own permission' },
      { t: 'error', code: 'session', message: 'own error', retryable: false },
      { t: 'turn.finished', turn: 0, reason: 'error' },
    ]);
  });
});

describe('FE-04 — OpenCode 1.x permission requests (`permission.asked`) and replies', () => {
  it('decodes the bundled server\'s permission.asked with everything it covers (secrets scrubbed); foreign sessions ignored', async () => {
    const { runner } = makeRunner('session-a', [
      { type: 'permission.asked', properties: { id: 'per_foreign', sessionID: 'session-b', permission: 'bash', patterns: ['rm -rf /'] } },
      { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'session-a', permission: 'bash', patterns: ['pnpm test --filter api'], metadata: { command: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 pnpm test --filter api' } } },
      idle('session-a'),
    ]);
    const out = await collect(await runner.start(startInput('run-perm')));
    const requests = out.filter((event) => event.t === 'permission.requested');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ t: 'permission.requested', id: 'per_1', tool: 'bash' });
    const detail = requests[0]?.t === 'permission.requested' ? requests[0].detail : '';
    expect(detail).toContain('pnpm test --filter api');
    expect(detail).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out.some((event) => event.t === 'diagnostic' && event.code === 'unknown_event')).toBe(false);
  });

  it('replies through the session permission route (once / always / reject) and fails loudly without one', async () => {
    const reply = vi.fn(async (_args: unknown) => ({ data: true }));
    const subscribe = vi.fn(async () => ({ stream: { async *[Symbol.asyncIterator]() { yield idle('session-a'); } } }));
    const client = {
      session: { create: vi.fn(async () => ({ data: { id: 'session-a' } })), promptAsync: vi.fn(async () => ({})) },
      event: { subscribe },
      postSessionIdPermissionsPermissionId: reply,
    };
    const session = await new OpenCodeRunner(async () => client as unknown as RunnerClient).start(startInput('run-reply'));
    await session.replyPermission('per_1', 'allow', 'once');
    await session.replyPermission('per_2', 'allow', 'session');
    await session.replyPermission('per_3', 'deny', 'session');
    expect(reply.mock.calls.map(([args]) => args)).toEqual([
      { path: { id: 'session-a', permissionID: 'per_1' }, body: { response: 'once' } },
      { path: { id: 'session-a', permissionID: 'per_2' }, body: { response: 'always' } },
      { path: { id: 'session-a', permissionID: 'per_3' }, body: { response: 'reject' } },
    ]);

    const bare = { session: client.session, event: { subscribe } };
    const silent = await new OpenCodeRunner(async () => bare as unknown as RunnerClient).start(startInput('run-bare'));
    await expect(silent.replyPermission('per_4', 'allow', 'once')).rejects.toThrow('cannot answer permission requests');
  });
});

describe('W09a — sandbox refusal is never bypassed', () => {
  it('propagates SANDBOX_UNAVAILABLE instead of falling back to an ambient OpenCode server', async () => {
    const refusal = new SandboxUnavailableError('No verified sandbox', ['fake blocker']);
    vi.mocked(getClientForUser).mockRejectedValueOnce(refusal);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(new OpenCodeRunner().start(startInput('run-sandbox'))).rejects.toBe(refusal);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('W07a — OpenCodeSession.abort() needs a positive server receipt', () => {
  function hangingRunner(answers: unknown[]) {
    const abort = vi.fn(async (): Promise<unknown> => (answers.length > 1 ? answers.shift() : answers[0]));
    const client = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'ses-abort' } })),
        promptAsync: vi.fn(async () => ({})),
        abort,
      },
      event: {
        subscribe: vi.fn(async () => ({
          stream: {
            async *[Symbol.asyncIterator]() {
              yield legacyText('ses-abort', 'working');
              await new Promise<void>(() => undefined);
            },
          },
        })),
      },
    };
    return { runner: new OpenCodeRunner(async () => client as unknown as RunnerClient), abort };
  }

  async function startedSession(runner: OpenCodeRunner) {
    const session = await runner.start(startInput('run-abort'));
    const iterator = session.events[Symbol.asyncIterator]();
    const seen: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.t === 'message.delta') break;
    }
    return { session, iterator, seen };
  }

  async function drain(iterator: AsyncIterator<AgentEvent>, seen: AgentEvent[]) {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return seen;
      seen.push(next.value);
    }
  }

  it('rejects when OpenCode answers false, ends the stream unconfirmed, and retries on the next abort', async () => {
    const { runner, abort } = hangingRunner([{ data: false }, { data: true }]);
    const { session, iterator, seen } = await startedSession(runner);
    await expect(session.abort()).rejects.toThrow('OpenCode did not confirm the abort request');
    await drain(iterator, seen);
    expect(seen.slice(-2)).toEqual([
      { t: 'error', code: 'cancel_unconfirmed', message: 'OpenCode did not acknowledge the abort request', retryable: false },
      { t: 'turn.finished', turn: 0, reason: 'error' },
    ]);
    expect(seen.some((event) => event.t === 'cancel.receipt')).toBe(false);
    // A later explicit abort sends a fresh request; its positive answer is the receipt.
    await expect(session.abort()).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it('treats an error body or a transport failure as unconfirmed', async () => {
    const errorBody = hangingRunner([{ error: { name: 'NotFoundError' }, data: undefined }]);
    const first = await startedSession(errorBody.runner);
    await expect(first.session.abort()).rejects.toThrow('did not confirm');

    const thrown = hangingRunner([undefined]);
    thrown.abort.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const second = await startedSession(thrown.runner);
    await expect(second.session.abort()).rejects.toThrow('did not confirm');
  });

  it('resolves with a server-ack receipt when OpenCode answers true (one request, single flight)', async () => {
    const { runner, abort } = hangingRunner([{ data: true }]);
    const { session, iterator, seen } = await startedSession(runner);
    await Promise.all([session.interrupt(), session.abort()]);
    await drain(iterator, seen);
    expect(seen.slice(-2)).toEqual([
      { t: 'cancel.receipt', via: 'interrupt', confirmedBy: 'server-ack' },
      { t: 'turn.finished', turn: 0, reason: 'interrupted' },
    ]);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('is a no-op after the server reported the turn over', async () => {
    const abort = vi.fn(async () => ({ data: false }));
    const client = {
      session: { create: vi.fn(async () => ({ data: { id: 'ses-done' } })), promptAsync: vi.fn(async () => ({})), abort },
      event: { subscribe: vi.fn(async () => ({ stream: { async *[Symbol.asyncIterator]() { yield idle('ses-done'); } } })) },
    };
    const session = await new OpenCodeRunner(async () => client as unknown as RunnerClient).start(startInput('run-done'));
    const events = await collect(session);
    expect(events.at(-1)).toEqual({ t: 'turn.finished', turn: 0, reason: 'idle' });
    await expect(session.abort()).resolves.toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });
});
