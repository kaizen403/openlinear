import { describe, expect, it, vi } from 'vitest';
import type { EventMessagePartDelta, EventSessionIdle } from '@opencode-ai/sdk/v2';
import type { AgentEvent, AgentSession, StartInput } from '@openlinear/execution-core';

vi.mock('../../services/opencode', () => ({
  getClientForUser: vi.fn(),
  getOpenCodeStatus: vi.fn(),
}));

import { OpenCodeRunner } from './index';

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
    expect(outB.map((event) => event.t)).toEqual([
      'session.started', 'message.delta', 'tool.finished', 'usage', 'error',
    ]);
    expect(outB.at(-1)).toMatchObject({ t: 'error', message: 'B private error' });
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
    expect(out.map((event) => event.t)).toEqual(['session.started', 'message.delta', 'turn.finished']);
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
    ]);
  });
});
