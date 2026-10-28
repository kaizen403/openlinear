/**
 * Per-process stream consumer (W04b): the only path from the event stream to
 * this process's SSE hub.
 *
 * It keeps one position: the highest stream id delivered here. Events arrive
 * from the local sequencer (fast path), from the bus (other processes) and
 * from a periodic poll of the stream. Whatever the source:
 *   - an id at or below the position is a duplicate and is dropped;
 *   - the next id is delivered from the message itself;
 *   - anything further ahead means something was missed (lost bus message,
 *     reordered publishers, reconnect), so the consumer reads the stream from
 *     its position first. Stream ids become visible in commit order, so that
 *     read returns every event below the one that revealed the gap.
 * Each stream event therefore reaches the hub at most once per process, in
 * id order, and (while the process runs) at least once.
 *
 * The position starts at the stream head when the consumer is initialized:
 * history before that is served by Last-Event-ID replay, not live delivery.
 */
import { logger } from '../logger';
import { deliverToLocalClients } from './hub';
import { readStreamAfter, readStreamHead } from './stream';
import {
  toWireEvent,
  wireEventPosition,
  type PersistedDomainEvent,
  type WireDomainEvent,
} from './types';

export type DeliverFn = (event: WireDomainEvent) => void;

export interface StreamConsumerOptions {
  /** Delivery target. Defaults to this process's SSE hub. */
  deliver?: DeliverFn;
  pageSize?: number;
  /** Bound on pages read per catch-up; the next poll continues. */
  maxPagesPerCatchUp?: number;
  readAfter?: (after: bigint, limit: number) => Promise<PersistedDomainEvent[]>;
  readHead?: () => Promise<bigint>;
  name?: string;
}

type OfferedEvent = WireDomainEvent | PersistedDomainEvent;

function isPersisted(event: OfferedEvent): event is PersistedDomainEvent {
  return typeof event.id === 'bigint';
}

function positionOf(event: OfferedEvent): bigint | null {
  return isPersisted(event) ? event.id : wireEventPosition(event);
}

export class StreamConsumer {
  private position: bigint | null = null;
  private initializing: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollQueued = false;
  private deliveredCount = 0;
  /** Pending-outbox ids a caller waits for (persistAndDeliver). */
  private readonly watched = new Map<bigint, PersistedDomainEvent | null>();
  private readonly deliver: DeliverFn;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly readAfter: (after: bigint, limit: number) => Promise<PersistedDomainEvent[]>;
  private readonly readHead: () => Promise<bigint>;
  readonly name: string;

  constructor(options: StreamConsumerOptions = {}) {
    this.deliver = options.deliver ?? deliverToLocalClients;
    this.pageSize = Math.max(1, options.pageSize ?? 500);
    this.maxPages = Math.max(1, options.maxPagesPerCatchUp ?? 20);
    this.readAfter = options.readAfter ?? ((after, limit) => readStreamAfter(after, limit));
    this.readHead = options.readHead ?? readStreamHead;
    this.name = options.name ?? 'local';
  }

  /** Highest stream id delivered by this process; null before initialization. */
  get livePosition(): bigint | null {
    return this.position;
  }

  get delivered(): number {
    return this.deliveredCount;
  }

  ensureInitialized(): Promise<void> {
    if (this.position !== null) return Promise.resolve();
    if (!this.initializing) {
      this.initializing = this.readHead()
        .then((head) => {
          if (this.position === null) this.position = head;
        })
        .finally(() => {
          this.initializing = null;
        });
    }
    return this.initializing;
  }

  /** Explicit positioning (tests, or a process that must start elsewhere). */
  setPosition(position: bigint | null): void {
    this.position = position;
  }

  /** Offer events from any source; resolves once they are handled. */
  offer(events: OfferedEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    return this.enqueue(() => this.applyOffered(events));
  }

  /** Read and deliver everything after the current position. */
  catchUp(): Promise<void> {
    return this.enqueue(() => this.catchUpNow());
  }

  /** Remember the stream event sequenced from this outbox row when it is delivered. */
  watchSource(sourceId: bigint): void {
    this.watched.set(sourceId, null);
  }

  takeWatched(sourceId: bigint): PersistedDomainEvent | null {
    const event = this.watched.get(sourceId) ?? null;
    this.watched.delete(sourceId);
    return event;
  }

  start(pollIntervalMs: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get polling(): boolean {
    return this.timer !== null;
  }

  private poll(): void {
    if (this.pollQueued) return;
    this.pollQueued = true;
    void this.catchUp().finally(() => {
      this.pollQueued = false;
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((err: unknown) => {
      logger.warn({ err, consumer: this.name }, '[events] stream consumer step failed; the next poll retries');
    });
    this.queue = run;
    return run;
  }

  private async applyOffered(events: OfferedEvent[]): Promise<void> {
    await this.ensureInitialized();
    const ordered = events
      .map((event) => ({ event, position: positionOf(event) }))
      .filter((entry): entry is { event: OfferedEvent; position: bigint } => entry.position !== null)
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    for (const { event, position } of ordered) {
      const current = this.position ?? 0n;
      if (position <= current) continue;
      if (position === current + 1n) {
        this.deliverOne(event, position);
        continue;
      }
      // Gap: read the stream; every smaller id that will ever exist is
      // already committed, so this read is complete up to `position`.
      await this.catchUpNow();
      if ((this.position ?? 0n) < position) {
        // Not visible to our read (a row written outside the sequencer by an
        // older API version). Deliver what we were given; order is kept.
        this.deliverOne(event, position);
      }
    }
  }

  private async catchUpNow(): Promise<void> {
    await this.ensureInitialized();
    for (let page = 0; page < this.maxPages; page += 1) {
      const from = this.position ?? 0n;
      const rows = await this.readAfter(from, this.pageSize);
      for (const row of rows) {
        if (row.id > (this.position ?? 0n)) this.deliverOne(row, row.id);
      }
      if (rows.length < this.pageSize) return;
    }
  }

  private deliverOne(event: OfferedEvent, position: bigint): void {
    this.position = position;
    this.deliveredCount += 1;
    const wire = isPersisted(event) ? toWireEvent(event) : event;
    try {
      this.deliver(wire);
    } catch (err) {
      logger.warn({ err, eventId: wire.id, consumer: this.name }, '[events] local delivery failed');
    }
    if (isPersisted(event) && event.sourceId !== undefined && event.sourceId !== null && this.watched.has(event.sourceId)) {
      this.watched.set(event.sourceId, event);
    }
  }
}

let consumer: StreamConsumer | null = null;

/** This process's consumer (delivers to the local SSE hub). */
export function getStreamConsumer(): StreamConsumer {
  if (!consumer) consumer = new StreamConsumer();
  return consumer;
}

/** Test seam: replace (or reset, with null) the process consumer. */
export function setStreamConsumer(next: StreamConsumer | null): void {
  consumer?.stop();
  consumer = next;
}

/**
 * The live/replay boundary for a stream registered now: every event at or
 * below it has already been delivered live in this process (so a new stream
 * must get it from replay), and every later one will be delivered live.
 * Null when the consumer has not started (replay then runs to the head).
 */
export function liveStreamPosition(): bigint | null {
  return consumer?.livePosition ?? null;
}
