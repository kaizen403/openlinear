/**
 * Fan-out bus between processes (W04b).
 *
 * The bus is an accelerator, not the source of truth. The durable, ordered
 * stream is `domain_events`; every process's StreamConsumer delivers from it
 * in id order and fills any gap (missed message, Redis outage, reconnect) by
 * reading the stream. So a bus message may be lost, duplicated or reordered
 * without losing or duplicating an SSE delivery.
 *
 * - MemoryBus: in-process pub/sub (single process, tests). Not distributed:
 *   other processes see events through their stream poll.
 * - RedisBus: one PUBLISH per event on a single channel; every replica
 *   receives every event and filters per subscriber (the hub authorizes each
 *   stream against the event's resource binding). `publish` throws on
 *   failure so the relay can retry with backoff; oversized messages raise
 *   PermanentPublishError and are dead-lettered (still delivered through the
 *   stream). After a reconnect the bus emits `resync` so consumers catch up
 *   on messages missed while disconnected.
 */
import { logger } from '../logger';
import {
  DOMAIN_EVENTS_CHANNEL,
  parseWireEvent,
  type WireDomainEvent,
} from './types';

export type EventHandler = (event: WireDomainEvent) => void;

export interface EventBus {
  readonly distributed: boolean;
  /** Deliver to every subscriber (every process, for a distributed bus). Throws on failure. */
  publish(event: WireDomainEvent): Promise<void>;
  subscribe(handler: EventHandler): Promise<void>;
  /** Called after a reconnection, when messages may have been missed. */
  onResync(handler: () => void): void;
  close(): Promise<void>;
}

/** Retrying cannot succeed (for example the message exceeds the bus limit). */
export class PermanentPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentPublishError';
  }
}

/** Largest event a bus message may carry; larger events reach replicas through the stream. */
export const MAX_BUS_MESSAGE_BYTES = 1024 * 1024;

function dispatch(handlers: Iterable<EventHandler>, event: WireDomainEvent): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (err) {
      logger.warn({ err, eventId: event.id }, '[events] bus subscriber failed');
    }
  }
}

export class MemoryBus implements EventBus {
  readonly distributed = false;
  private readonly handlers = new Set<EventHandler>();

  async publish(event: WireDomainEvent): Promise<void> {
    dispatch(this.handlers, event);
  }

  async subscribe(handler: EventHandler): Promise<void> {
    this.handlers.add(handler);
  }

  onResync(_handler: () => void): void {
    // A process-local bus never disconnects.
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

/** The subset of an ioredis client the bus uses (lets tests inject a fake). */
export interface RedisClientLike {
  connect(): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  onMessage(listener: (channel: string, message: string) => void): void;
  /** Fired on every (re)connection that is ready for commands. */
  onReady(listener: () => void): void;
  quit(): Promise<unknown>;
}

export type RedisClientFactory = (url: string, purpose: 'publisher' | 'subscriber') => Promise<RedisClientLike>;

const ioredisFactory: RedisClientFactory = async (url, purpose) => {
  const { default: Redis } = await import('ioredis');
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    // Fail fast while disconnected: the relay retries with backoff and the
    // consumers' stream poll covers the gap.
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  client.on('error', (err: Error) => {
    logger.warn({ err, purpose }, '[events] redis connection error');
  });
  return {
    connect: () => client.connect(),
    publish: (channel, message) => client.publish(channel, message),
    subscribe: (channel) => client.subscribe(channel),
    onMessage: (listener) => {
      client.on('message', listener);
    },
    onReady: (listener) => {
      client.on('ready', listener);
    },
    quit: () => client.quit(),
  };
};

export class RedisBus implements EventBus {
  readonly distributed = true;
  private publisher: RedisClientLike | null = null;
  private subscriber: RedisClientLike | null = null;
  private connecting: Promise<void> | null = null;
  private subscriberReadyCount = 0;
  private readonly handlers = new Set<EventHandler>();
  private readonly resyncHandlers = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly factory: RedisClientFactory = ioredisFactory,
  ) {}

  /** One connection attempt at a time; a failed attempt can be retried. */
  private connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.open().catch((err: unknown) => {
        this.connecting = null;
        throw err;
      });
    }
    return this.connecting;
  }

  private async open(): Promise<void> {
    const [publisher, subscriber] = await Promise.all([
      this.factory(this.url, 'publisher'),
      this.factory(this.url, 'subscriber'),
    ]);
    subscriber.onMessage((channel, message) => {
      if (channel !== DOMAIN_EVENTS_CHANNEL) return;
      const event = parseWireEvent(message);
      if (!event) {
        logger.warn({ bytes: message.length }, '[events] dropped malformed bus message');
        return;
      }
      dispatch(this.handlers, event);
    });
    subscriber.onReady(() => {
      this.subscriberReadyCount += 1;
      // The first ready is the initial connection; later ones are reconnects
      // after which messages published meanwhile are gone.
      if (this.subscriberReadyCount > 1) this.emitResync();
    });
    await Promise.all([publisher.connect(), subscriber.connect()]);
    await subscriber.subscribe(DOMAIN_EVENTS_CHANNEL);
    this.publisher = publisher;
    this.subscriber = subscriber;
  }

  private emitResync(): void {
    for (const handler of this.resyncHandlers) {
      try {
        handler();
      } catch (err) {
        logger.warn({ err }, '[events] resync handler failed');
      }
    }
  }

  async publish(event: WireDomainEvent): Promise<void> {
    const message = JSON.stringify(event);
    const bytes = Buffer.byteLength(message, 'utf8');
    if (bytes > MAX_BUS_MESSAGE_BYTES) {
      throw new PermanentPublishError(
        `event ${event.id} is ${bytes} bytes; the bus carries at most ${MAX_BUS_MESSAGE_BYTES}`,
      );
    }
    await this.connect();
    if (!this.publisher) throw new Error('redis publisher is not connected');
    await this.publisher.publish(DOMAIN_EVENTS_CHANNEL, message);
  }

  async subscribe(handler: EventHandler): Promise<void> {
    this.handlers.add(handler);
    await this.connect();
  }

  onResync(handler: () => void): void {
    this.resyncHandlers.add(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.resyncHandlers.clear();
    const clients = [this.publisher, this.subscriber];
    this.publisher = null;
    this.subscriber = null;
    this.connecting = null;
    for (const client of clients) {
      try {
        await client?.quit();
      } catch {
        // ignore
      }
    }
  }
}

let bus: EventBus = new MemoryBus();
let started = false;

export function getEventBus(): EventBus {
  return bus;
}

export interface StartEventBusOptions {
  redisUrl?: string;
  redisFactory?: RedisClientFactory;
}

export async function startEventBus(options: StartEventBusOptions = {}): Promise<EventBus> {
  if (started) return bus;
  started = true;
  const url = (options.redisUrl ?? process.env.REDIS_URL)?.trim();
  if (url) {
    bus = new RedisBus(url, options.redisFactory);
    logger.info('[events] using Redis pub/sub as the realtime accelerator');
  } else {
    bus = new MemoryBus();
    logger.info('[events] REDIS_URL unset; other processes receive events through the stream poll');
  }
  return bus;
}

export async function stopEventBus(): Promise<void> {
  await bus.close();
  bus = new MemoryBus();
  started = false;
}

/** Test seam: install a bus (for example a RedisBus over a fake client). */
export function useEventBus(next: EventBus): void {
  bus = next;
  started = true;
}
