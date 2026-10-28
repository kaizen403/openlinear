import { OpenLinearApiError, OpenLinearNetworkError, type ExecutionEvent } from '@openlinear/api-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttemptEventRelay } from './relay';

function progress(status: string, message = status) {
  return { taskId: 'task-1', status, message };
}

function makeRelay(send: (events: ExecutionEvent[]) => Promise<{ cancelRequested: boolean }>, options: Partial<ConstructorParameters<typeof AttemptEventRelay>[0]> = {}) {
  return new AttemptEventRelay({ send, flushDelayMs: 10, retryBaseMs: 5, retryMaxMs: 20, ...options });
}

describe('attempt event relay (W03a)', () => {
  afterEach(() => vi.useRealTimers());

  it('batches events with increasing per-attempt sequences and strips the task id', async () => {
    const batches: ExecutionEvent[][] = [];
    const relay = makeRelay(async (events) => { batches.push(events); return { cancelRequested: false }; });
    relay.enqueue('execution:progress', progress('cloning'));
    relay.enqueue('execution:log', { taskId: 'task-1', entry: { timestamp: '2026-10-25T00:00:00.000Z', type: 'info', message: 'hello', details: 'x' } });
    await relay.close();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      { seq: 1, type: 'execution:progress', payload: { status: 'cloning', message: 'cloning' } },
      { seq: 2, type: 'execution:log', payload: { entry: { timestamp: '2026-10-25T00:00:00.000Z', type: 'info', message: 'hello', details: 'x' } } },
    ]);
  });

  it('sends at most 50 events per request and one request at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sizes: number[] = [];
    const relay = makeRelay(async (events) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      sizes.push(events.length);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { cancelRequested: false };
    });
    for (let index = 0; index < 120; index += 1) relay.enqueue('execution:progress', progress('executing', `m${index}`));
    await relay.close();
    expect(sizes.every((size) => size <= 50)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(120);
    expect(maxInFlight).toBe(1);
  });

  it('retries a batch after a network failure with the same sequences (server dedupes by seq)', async () => {
    const seen: number[][] = [];
    let fail = true;
    const relay = makeRelay(async (events) => {
      seen.push(events.map((event) => event.seq));
      if (fail) { fail = false; throw new OpenLinearNetworkError('down'); }
      return { cancelRequested: false };
    });
    relay.enqueue('execution:progress', progress('executing'));
    await relay.close(2_000);
    expect(seen).toEqual([[1], [1]]);
  });

  it('drops a batch the control plane refuses and stops after an authorization failure', async () => {
    const sent: number[] = [];
    const relay = makeRelay(async (events) => {
      sent.push(...events.map((event) => event.seq));
      throw new OpenLinearApiError(401, JSON.stringify({ code: 'CAPABILITY_REVOKED' }));
    });
    relay.enqueue('execution:progress', progress('executing'));
    await relay.flush();
    expect(relay.isStopped).toBe(true);
    relay.enqueue('execution:progress', progress('executing'));
    expect(relay.pending).toBe(0);
    expect(sent).toEqual([1]);
  });

  it('keeps critical progress preferentially when the queue is full', async () => {
    const relay = makeRelay(async () => ({ cancelRequested: false }), { maxQueue: 3, flushDelayMs: 60_000 });
    relay.enqueue('execution:progress', progress('done'));
    relay.enqueue('execution:progress', progress('executing', 'a'));
    relay.enqueue('execution:progress', progress('executing', 'b'));
    relay.enqueue('execution:progress', progress('executing', 'c'));
    expect(relay.pending).toBe(3);
    expect(relay.dropped).toBe(1);
    const batches: ExecutionEvent[][] = [];
    const drain = makeRelay(async (events) => { batches.push(events); return { cancelRequested: false }; }, { maxQueue: 2, flushDelayMs: 60_000 });
    drain.enqueue('execution:progress', progress('cancelled'));
    drain.enqueue('execution:progress', progress('executing', 'x'));
    drain.enqueue('execution:progress', progress('executing', 'y'));
    await drain.close();
    expect(batches.flat().map((event) => event.type === 'execution:progress' ? event.payload.status : 'log')).toContain('cancelled');
    await relay.close();
  });

  it('reports a control-plane cancellation request', async () => {
    const onCancelRequested = vi.fn();
    const relay = makeRelay(async () => ({ cancelRequested: true }), { onCancelRequested });
    relay.enqueue('execution:progress', progress('executing'));
    await relay.close();
    expect(onCancelRequested).toHaveBeenCalledTimes(1);
  });

  it('bounds field sizes and ignores malformed events', async () => {
    const batches: ExecutionEvent[][] = [];
    const relay = makeRelay(async (events) => { batches.push(events); return { cancelRequested: false }; });
    relay.enqueue('execution:progress', { status: 'executing', message: 'x'.repeat(20_000), nested: { a: 1 }, elapsedMs: 5 });
    relay.enqueue('execution:progress', { message: 'no status' });
    relay.enqueue('execution:log', { entry: { type: 'nope', message: 'bad type' } });
    await relay.close();
    expect(batches.flat()).toHaveLength(1);
    const [event] = batches.flat();
    expect(event?.type).toBe('execution:progress');
    if (event?.type === 'execution:progress') {
      expect(event.payload.message).toHaveLength(8_000);
      expect(event.payload).not.toHaveProperty('nested');
      expect(event.payload.elapsedMs).toBe(5);
    }
  });
});
