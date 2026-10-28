/**
 * Outbox relay (W04b).
 *
 * One cycle (`OutboxRelay.runOnce`):
 *   1. sequence: move committed pending appends into the stream (advisory
 *      lock, see stream.ts) and hand them to this process's consumer;
 *   2. claim: lease unpublished stream events (`UPDATE … WHERE id IN
 *      (SELECT … FOR UPDATE SKIP LOCKED)`, one statement, so the row locks
 *      and the lease are written together);
 *   3. publish each event to the bus;
 *   4. ack the published ones, fenced by the lease token: a relay whose
 *      lease expired and was re-claimed cannot overwrite the new holder;
 *   5. release failures with exponential backoff and jitter, or dead-letter
 *      them after `maxAttempts` (or at once for a PermanentPublishError).
 *
 * Delivery is at least once: a relay that dies between publish and ack, or
 * whose lease expires mid-publish, leaves the event to be published again.
 * Consumers drop duplicates by stream id. A crash anywhere loses nothing: a
 * pending row is moved atomically, and a claimed row becomes claimable again
 * when its lease expires.
 *
 * Dead-lettering only stops bus publication. The event stays in the stream:
 * consumers still deliver it through catch-up and replay still returns it.
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { logger } from '../logger';
import { getEventBus, PermanentPublishError, startEventBus } from './bus';
import {
  ownsRelay,
  pollIntervalFor,
  readRealtimeConfig,
  resolveProcessRole,
  type ProcessRole,
} from './config';
import { getStreamConsumer } from './consumer';
import {
  ackPublished,
  claimEventsForPublish,
  DEFAULT_SEQUENCE_LIMIT,
  releaseFailedClaim,
  sequencePendingEvents,
  type ClaimedEvent,
} from './stream';
import { toWireEvent, type PersistedDomainEvent, type WireDomainEvent } from './types';

export interface RelayPublisher {
  publish(event: WireDomainEvent): Promise<void>;
}

export interface RelayHooks {
  /** Runs after the claim commits, before publishing (crash simulation). */
  afterClaim?: (claimed: ClaimedEvent[]) => Promise<void> | void;
  /** Runs after publishing, before the ack (crash simulation). */
  beforeAck?: (published: ClaimedEvent[]) => Promise<void> | void;
}

export interface OutboxRelayOptions {
  /** Instance name; part of every lease token. */
  name?: string;
  /** Defaults to the process event bus at publish time. */
  publisher?: RelayPublisher;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  /** Sequence pending appends before claiming (default true). */
  sequence?: boolean;
  /** Receives freshly sequenced events. Defaults to the process consumer. */
  onSequenced?: (events: PersistedDomainEvent[]) => Promise<void>;
  hooks?: RelayHooks;
}

export interface RelayRunResult {
  sequenced: number;
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  /** Acks/releases that found the lease taken over by another relay. */
  fenced: number;
}

const MAX_BACKOFF_MS = 60_000;

/** 250 ms, 500 ms, 1 s … capped at 60 s, with ±20 % jitter. */
export function defaultBackoffMs(attempt: number): number {
  const base = Math.min(250 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(base + jitter));
}

const busPublisher: RelayPublisher = {
  publish: (event) => getEventBus().publish(event),
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export class OutboxRelay {
  readonly name: string;
  readonly batchSize: number;
  private readonly publisher: RelayPublisher;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;

  constructor(private readonly options: OutboxRelayOptions = {}) {
    const config = readRealtimeConfig();
    this.name = options.name ?? `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
    this.publisher = options.publisher ?? busPublisher;
    this.batchSize = Math.max(1, options.batchSize ?? config.batchSize);
    this.leaseMs = Math.max(1, options.leaseMs ?? config.leaseMs);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? config.maxAttempts);
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
  }

  /** One relay cycle: sequence, then claim/publish/ack the next batch. */
  async runOnce(): Promise<RelayRunResult> {
    let sequenced = 0;
    if (this.options.sequence !== false) {
      const moved = await sequencePendingEvents({ limit: Math.max(this.batchSize, DEFAULT_SEQUENCE_LIMIT) });
      sequenced = moved.length;
      if (moved.length > 0) {
        await (this.options.onSequenced ?? ((events) => getStreamConsumer().offer(events)))(moved);
      }
    }
    const result = await this.publishClaimed();
    return { ...result, sequenced };
  }

  /** Claim and publish specific stream events (fast path after a flush). */
  async publishEvents(ids: bigint[]): Promise<RelayRunResult> {
    if (ids.length === 0) return { sequenced: 0, claimed: 0, published: 0, retried: 0, deadLettered: 0, fenced: 0 };
    return this.publishClaimed(ids);
  }

  private async publishClaimed(ids?: bigint[]): Promise<RelayRunResult> {
    const leaseToken = `${this.name}:${randomBytes(8).toString('hex')}`;
    const claimed = await claimEventsForPublish({
      leaseToken,
      leaseMs: this.leaseMs,
      limit: ids ? ids.length : this.batchSize,
      ids,
    });
    const result: RelayRunResult = {
      sequenced: 0,
      claimed: claimed.length,
      published: 0,
      retried: 0,
      deadLettered: 0,
      fenced: 0,
    };
    if (claimed.length === 0) return result;
    await this.options.hooks?.afterClaim?.(claimed);

    const published: ClaimedEvent[] = [];
    const failed: Array<{ event: ClaimedEvent; err: unknown }> = [];
    for (const event of claimed) {
      try {
        await this.publisher.publish(toWireEvent(event));
        published.push(event);
      } catch (err) {
        failed.push({ event, err });
      }
    }

    await this.options.hooks?.beforeAck?.(published);
    const acked = await ackPublished(published.map((event) => event.id), leaseToken);
    result.published = acked;
    result.fenced += published.length - acked;
    if (acked < published.length) {
      logger.info(
        { relay: this.name, lost: published.length - acked },
        '[events] lease taken over before ack; the new holder publishes again (consumers drop the duplicate)',
      );
    }

    for (const { event, err } of failed) {
      const permanent = err instanceof PermanentPublishError;
      const exhausted = event.attempts >= this.maxAttempts;
      const retryInMs = permanent || exhausted ? null : this.backoffMs(event.attempts);
      const changed = await releaseFailedClaim({ id: event.id, leaseToken, error: errorMessage(err), retryInMs });
      if (changed === 0) {
        result.fenced += 1;
        continue;
      }
      if (retryInMs === null) {
        result.deadLettered += 1;
        logger.error(
          { err, eventId: event.id.toString(), type: event.type, attempts: event.attempts, permanent, relay: this.name },
          '[events] outbox event dead-lettered: bus publication stopped; it stays in the stream (catch-up and replay still deliver it)',
        );
      } else {
        result.retried += 1;
        logger.warn(
          { err, eventId: event.id.toString(), type: event.type, attempts: event.attempts, retryInMs, relay: this.name },
          '[events] outbox publish failed; retrying with backoff',
        );
      }
    }
    return result;
  }
}

// ─── Process wiring ──────────────────────────────────────────────────────────

let processRelay: OutboxRelay | null = null;
let relayTimer: ReturnType<typeof setInterval> | null = null;
let relayTicking = false;
let busSubscribed = false;
let realtimeRole: ProcessRole | null = null;

/** The relay instance used by this process's loop and fast path. */
export function getProcessRelay(): OutboxRelay {
  if (!processRelay) processRelay = new OutboxRelay();
  return processRelay;
}

/** Test seam. */
export function setProcessRelay(next: OutboxRelay | null): void {
  processRelay = next;
}

/** Run one relay cycle now. Returns the number of events published. */
export async function relayOnce(): Promise<number> {
  const result = await getProcessRelay().runOnce();
  return result.published;
}

const MAX_CYCLES_PER_TICK = 10;

async function relayTick(): Promise<void> {
  if (relayTicking) return;
  relayTicking = true;
  try {
    const relay = getProcessRelay();
    for (let cycle = 0; cycle < MAX_CYCLES_PER_TICK; cycle += 1) {
      const result = await relay.runOnce();
      // Keep draining a backlog; otherwise wait for the next tick.
      if (result.claimed === 0 && result.sequenced === 0) break;
      if (result.claimed + result.sequenced < relay.batchSize) break;
    }
  } catch (err) {
    logger.warn({ err }, '[events] outbox relay tick failed; retrying next tick');
  } finally {
    relayTicking = false;
  }
}

export function startOutboxRelay(options: { intervalMs?: number } = {}): void {
  if (relayTimer) return;
  const intervalMs = options.intervalMs ?? readRealtimeConfig().relayIntervalMs;
  relayTimer = setInterval(() => {
    void relayTick();
  }, intervalMs);
  relayTimer.unref();
  logger.info({ intervalMs, relay: getProcessRelay().name }, '[events] outbox relay started');
}

export function stopOutboxRelay(): void {
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
}

export function isOutboxRelayRunning(): boolean {
  return relayTimer !== null;
}

// Fast path: after a commit with appended events, sequence and deliver now
// (coalesced across concurrent commits). One attempt; failures are left to
// the owner relay's retry loop.

let flushRequested = 0;
let flushCompleted = 0;
let flushLoop: Promise<void> | null = null;
const flushWaiters: Array<{ target: number; resolve: () => void }> = [];
const MAX_FLUSH_BATCHES = 20;

async function flushOnce(): Promise<void> {
  const consumer = getStreamConsumer();
  await consumer.ensureInitialized();
  const distributed = getEventBus().distributed;
  for (let batch = 0; batch < MAX_FLUSH_BATCHES; batch += 1) {
    // Without a distributed bus, in-process delivery is the publication, so
    // the moved events are marked published right away.
    const moved = await sequencePendingEvents({ markPublished: !distributed });
    if (moved.length === 0) return;
    await consumer.offer(moved);
    if (distributed) {
      try {
        await getProcessRelay().publishEvents(moved.map((event) => event.id));
      } catch (err) {
        logger.warn({ err }, '[events] fast publish failed; the owner relay retries');
      }
    }
    if (moved.length < DEFAULT_SEQUENCE_LIMIT) return;
  }
}

async function runFlushLoop(): Promise<void> {
  // Let the committing caller finish its synchronous post-commit work (for
  // example invalidating tenancy caches, which pauses affected streams)
  // before any event of that commit can be delivered.
  await new Promise<void>((resolve) => setImmediate(resolve));
  while (flushCompleted < flushRequested) {
    const target = flushRequested;
    try {
      await flushOnce();
    } catch (err) {
      logger.warn({ err }, '[events] outbox flush failed; the relay retries');
    }
    flushCompleted = target;
    for (let index = flushWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = flushWaiters[index];
      if (waiter && waiter.target <= flushCompleted) {
        flushWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

function ensureFlushLoop(): void {
  if (flushLoop) return;
  flushLoop = runFlushLoop().finally(() => {
    flushLoop = null;
    if (flushCompleted < flushRequested) ensureFlushLoop();
  });
}

/** Resolves after a flush that started after this call has finished. */
export function flushOutbox(): Promise<void> {
  flushRequested += 1;
  const target = flushRequested;
  const done = new Promise<void>((resolve) => {
    flushWaiters.push({ target, resolve });
  });
  ensureFlushLoop();
  return done;
}

/** Fire-and-forget flush (no-op when OPENLINEAR_OUTBOX_FAST_FLUSH=0). */
export function requestOutboxFlush(): void {
  if (!readRealtimeConfig().fastFlush) return;
  void flushOutbox();
}

export interface StartRealtimeOptions {
  /** This process's role; see events/config.ts for the fallback chain. */
  role?: ProcessRole;
}

/**
 * Start realtime for this process: bus subscription, stream consumer (live
 * delivery to local SSE clients) and, when this process's role owns it, the
 * periodic outbox relay.
 */
export async function startRealtime(options: StartRealtimeOptions = {}): Promise<void> {
  const config = readRealtimeConfig();
  const role = resolveProcessRole(options.role);
  realtimeRole = role;
  const bus = await startEventBus();
  const consumer = getStreamConsumer();
  // Only API processes hold SSE streams; a worker needs no live delivery.
  const servesStreams = role === 'api';
  if (servesStreams && !busSubscribed) {
    busSubscribed = true;
    bus.onResync(() => {
      void consumer.catchUp();
    });
    try {
      await bus.subscribe((event) => {
        void consumer.offer([event]);
      });
    } catch (err) {
      logger.warn({ err }, '[events] bus subscription failed; live delivery falls back to the stream poll');
    }
  }
  try {
    await consumer.ensureInitialized();
  } catch (err) {
    logger.warn({ err }, '[events] stream consumer could not read the head yet; the poll retries');
  }
  const pollMs = pollIntervalFor(config, bus.distributed);
  if (servesStreams) consumer.start(pollMs);
  const runsRelay = ownsRelay(config, role);
  if (runsRelay) startOutboxRelay({ intervalMs: config.relayIntervalMs });
  logger.info(
    { role, relayOwner: config.relayOwner, runsRelay, servesStreams, pollMs, distributedBus: bus.distributed },
    '[events] realtime started',
  );
}

/** Stop the relay loop and the stream poll (call before stopEventBus). */
export function stopRealtime(): void {
  stopOutboxRelay();
  getStreamConsumer().stop();
  busSubscribed = false;
  realtimeRole = null;
}

export function currentRealtimeRole(): ProcessRole | null {
  return realtimeRole;
}

export { getEventBus };
