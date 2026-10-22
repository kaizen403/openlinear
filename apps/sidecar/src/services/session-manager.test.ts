import { createOpencodeClient } from '@opencode-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionState } from './execution/state';

vi.mock('@openlinear/api/sse', () => ({ broadcastToTask: vi.fn(), broadcastToTaskById: vi.fn(async () => undefined) }));
vi.mock('./batch/shared', () => ({
  emitBatchLog: vi.fn(), emitBatchLogs: vi.fn(), broadcastBatchProgress: vi.fn(),
  flushTaskBuffers: vi.fn(), cleanupTaskBuffers: vi.fn(),
}));
vi.mock('./execution/git', () => ({ hasCommittableChanges: vi.fn(async () => false) }));
vi.mock('./execution/agent-run', () => ({ finalizeAgentRun: vi.fn(async () => undefined) }));
vi.mock('./execution/state', () => ({
  activeExecutions: new Map(), sessionToTask: new Map(),
  addLogEntry: vi.fn(), broadcastProgress: vi.fn(), persistLogs: vi.fn(async () => undefined),
  estimateProgress: vi.fn(() => 0),
  updateTaskStatus: vi.fn(async () => undefined), recordMessageUsage: vi.fn(),
  cleanupExecution: vi.fn(async (id: string) => { const state = await import('./execution/state'); state.activeExecutions.delete(id); }),
}));

const manager = await import('./session-manager');
const events = await import('./execution/events');
const state = await import('./execution/state');
const encoder = new TextEncoder();
const connected = encoder.encode('data: {"type":"server.connected","properties":{}}\n\n');

function execution(client: ReturnType<typeof createOpencodeClient>): ExecutionState {
  return {
    taskId: 'task', projectId: 'repo', sessionId: 'ses_fixture', repoPath: '/fixture',
    branchName: 'openlinear/fixture', userId: 'user', accessToken: null, teamId: null, creatorId: null,
    timeoutId: setTimeout(() => undefined, 60_000), streamTimeoutId: null, progressTimeoutId: null,
    watchdogSuspended: false, finalized: false, status: 'executing', logs: [], client,
    startedAt: new Date(), filesChanged: 0, toolsExecuted: 0, promptSent: false,
    backgroundTaskRunning: false, backgroundTaskFailure: null, backgroundTaskIds: [],
    backgroundTaskResultBuffer: '', completedToolKeys: new Set(), cancelled: false, agentRunId: null,
    cost: { input: 0, output: 0, total: 0 },
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messageUsage: new Map(),
  };
}

describe.each(['batch', 'single'] as const)('%s event readiness using the installed SDK', (mode) => {
  let close: () => void | Promise<void>;
  const complete = vi.fn(async () => undefined);
  beforeEach(() => { vi.clearAllMocks(); close = () => undefined; });
  afterEach(async () => {
    await close();
    for (const current of state.activeExecutions.values()) {
      clearTimeout(current.timeoutId);
      if (current.streamTimeoutId) clearTimeout(current.streamTimeoutId);
      if (current.progressTimeoutId) clearTimeout(current.progressTimeoutId);
    }
    state.activeExecutions.clear(); state.sessionToTask.clear();
    vi.unstubAllGlobals(); vi.useRealTimers();
  });
  function start() {
    const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:1' });
    if (mode === 'batch') {
      const subscription = manager.subscribeToTaskEvents(client, 'ses_fixture', 'batch', 'task', complete);
      close = subscription.close;
      return subscription.ready;
    }
    const current = execution(client);
    state.activeExecutions.set('task', current); state.sessionToTask.set('ses_fixture', 'task');
    close = async () => {
      current.cancelled = true;
      await current.eventStreamCleanup?.();
      clearTimeout(current.timeoutId);
    };
    return events.subscribeToSessionEvents('task', client, 'ses_fixture');
  }

  it('does not report readiness until the lazy stream receives a frame', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } })));
    vi.stubGlobal('fetch', fetch);
    let ready = false;
    const pending = start().then(() => { ready = true; });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(ready).toBe(false);
    streamController.enqueue(connected);
    await pending;
    expect(ready).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects an HTTP authentication failure without hidden retry', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => new Response('denied', { status: 401, statusText: 'Unauthorized' }));
    vi.stubGlobal('fetch', fetch);
    await expect(start()).rejects.toThrow('401');
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/event'))).toHaveLength(1);
    if (mode === 'batch') await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });

  it('rejects EOF before readiness', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.close(); } }))));
    await expect(start()).rejects.toThrow(/closed|ended/);
    if (mode === 'batch') await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(false, 'Event stream closed before completion'));
  });

  it('aborts a pending stream and rejects readiness when closed', async () => {
    const fetch = vi.fn(async () => new Response(new ReadableStream()));
    vi.stubGlobal('fetch', fetch);
    const pending = start();
    const rejection = expect(pending).rejects.toThrow(/cancelled|stopped/);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await close();
    await rejection;
    expect(complete).not.toHaveBeenCalled();
  });

  it('bounds readiness when the connection sends no frames', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url: string | URL | Request) => new Response(new ReadableStream()));
    vi.stubGlobal('fetch', fetch);
    const pending = start();
    const rejection = expect(pending).rejects.toThrow('readiness timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/event'))).toHaveLength(1);
  });
});
