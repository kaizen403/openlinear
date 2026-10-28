import { type ExecutionEvent, type ExecutionLogEntry, OpenLinearApiError } from '@openlinear/api-client';
import { isHttpError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Bounded, batched relay of one attempt's progress/log events to the control
 * plane (`POST /api/executions/attempts/:id/events`).
 *
 * - Every event gets the next per-attempt sequence; the server acknowledges
 *   sequences at or below its high-water mark as duplicates, so a retried
 *   batch is never delivered twice.
 * - At most one request is in flight; batches hold at most 50 events.
 * - The queue holds at most `maxQueue` events. When full, the oldest
 *   non-critical event is dropped (and counted); critical progress (done,
 *   error, cancelled) is kept preferentially.
 * - Network failures and 5xx/429 retry with capped exponential backoff.
 *   Other 4xx answers (revoked or stale capability, invalid batch) are final:
 *   the batch is dropped, and an auth failure stops the relay.
 * - A server response may carry `cancelRequested`; the callback lets the
 *   execution honour a cancellation requested through the control plane.
 */
export type RelayedEventType = 'execution:progress' | 'execution:log';

export interface AttemptEventRelayOptions {
  send: (events: ExecutionEvent[]) => Promise<{ cancelRequested: boolean }>;
  onCancelRequested?: () => void;
  maxQueue?: number;
  batchSize?: number;
  flushDelayMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

interface QueuedEvent {
  event: ExecutionEvent;
  critical: boolean;
}

const MAX_MESSAGE = 8_000;
const MAX_DETAILS = 16_000;
const MAX_FIELD = 2_000;
const CRITICAL_STATUSES = new Set(['done', 'error', 'cancelled']);

function isPermanent(error: unknown): boolean {
  const status = error instanceof OpenLinearApiError ? error.status : isHttpError(error) ? error.statusCode : null;
  return status !== null && status >= 400 && status < 500 && status !== 429;
}

function isAuthFailure(error: unknown): boolean {
  const status = error instanceof OpenLinearApiError ? error.status : isHttpError(error) ? error.statusCode : null;
  return status === 401 || status === 403;
}

function toProgressPayload(payload: Record<string, unknown>): ExecutionEvent | null {
  const status = typeof payload.status === 'string' ? payload.status.slice(0, 64) : null;
  const message = typeof payload.message === 'string' ? payload.message.slice(0, MAX_MESSAGE) : null;
  if (!status || message === null) return null;
  const extra: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'status' || key === 'message' || key === 'taskId') continue;
    if (typeof value === 'string') extra[key] = value.slice(0, MAX_FIELD);
    else if (typeof value === 'number' && Number.isFinite(value)) extra[key] = value;
    else if (typeof value === 'boolean' || value === null) extra[key] = value;
  }
  return { seq: 0, type: 'execution:progress', payload: { ...extra, status, message } };
}

function toLogPayload(payload: Record<string, unknown>): ExecutionEvent | null {
  const entry = payload.entry;
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Record<string, unknown>;
  const type = raw.type;
  if (type !== 'info' && type !== 'agent' && type !== 'tool' && type !== 'error' && type !== 'success') return null;
  const bounded: ExecutionLogEntry = {
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    type,
    message: typeof raw.message === 'string' ? raw.message.slice(0, MAX_MESSAGE) : '',
    ...(typeof raw.details === 'string' ? { details: raw.details.slice(0, MAX_DETAILS) } : {}),
  };
  return { seq: 0, type: 'execution:log', payload: { entry: bounded } };
}

export class AttemptEventRelay {
  private seq = 0;
  private queue: QueuedEvent[] = [];
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;
  dropped = 0;

  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly flushDelayMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly options: AttemptEventRelayOptions) {
    this.maxQueue = options.maxQueue ?? 1_000;
    this.batchSize = Math.min(options.batchSize ?? 50, 50);
    this.flushDelayMs = options.flushDelayMs ?? 500;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.retryMaxMs = options.retryMaxMs ?? 10_000;
  }

  get pending(): number {
    return this.queue.length;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  enqueue(type: RelayedEventType, payload: Record<string, unknown>): void {
    if (this.stopped) return;
    const event = type === 'execution:progress' ? toProgressPayload(payload) : toLogPayload(payload);
    if (!event) return;
    this.seq += 1;
    event.seq = this.seq;
    const critical = type === 'execution:progress' && CRITICAL_STATUSES.has(String(payload.status));
    this.queue.push({ event, critical });
    if (this.queue.length > this.maxQueue) {
      const victim = this.queue.findIndex((item) => !item.critical);
      this.queue.splice(victim === -1 ? 0 : victim, 1);
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 100 === 0) {
        logger.warn({ dropped: this.dropped }, '[Relay] event queue full; dropping oldest non-critical events');
      }
    }
    this.schedule(critical || this.queue.length >= this.batchSize ? 0 : this.flushDelayMs);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.inFlight) return;
    if (this.timer) {
      if (delayMs > 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  /** Send one batch (or join the in-flight one). Never throws. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped || this.queue.length === 0) return Promise.resolve();
    const batch = this.queue.slice(0, this.batchSize).map((item) => item.event);
    const lastSeq = batch[batch.length - 1]?.seq ?? 0;
    this.inFlight = (async () => {
      try {
        const result = await this.options.send(batch);
        this.queue = this.queue.filter((item) => item.event.seq > lastSeq);
        this.failures = 0;
        if (result.cancelRequested) this.options.onCancelRequested?.();
      } catch (error) {
        if (isPermanent(error)) {
          this.queue = this.queue.filter((item) => item.event.seq > lastSeq);
          if (isAuthFailure(error)) {
            this.stopped = true;
            this.queue = [];
          }
          logger.warn({ err: error, lastSeq }, '[Relay] control plane refused an event batch; dropped');
        } else {
          this.failures += 1;
          logger.warn({ err: error, failures: this.failures }, '[Relay] event batch not delivered; will retry');
        }
      } finally {
        this.inFlight = null;
      }
      if (this.queue.length > 0 && !this.stopped) {
        const backoff = this.failures === 0 ? 0 : Math.min(this.retryBaseMs * 2 ** (this.failures - 1), this.retryMaxMs);
        this.schedule(backoff);
      }
    })();
    return this.inFlight;
  }

  /** Drain within `timeoutMs`, then stop. Undelivered events are dropped. */
  async close(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (!this.stopped && this.queue.length > 0 && Date.now() < deadline) {
      const before = this.failures;
      await this.flush();
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.failures > before) {
        const wait = Math.min(this.retryBaseMs * 2 ** (this.failures - 1), Math.max(0, deadline - Date.now()));
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    if (this.queue.length > 0) {
      logger.warn({ undelivered: this.queue.length }, '[Relay] closing with undelivered events');
    }
    this.stopped = true;
    this.queue = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
