import { logger } from '../logger';
import {
  DOMAIN_EVENTS_CHANNEL,
  parseWireEvent,
  type WireDomainEvent,
} from './types';

export type EventHandler = (event: WireDomainEvent) => void;

export interface EventBus {
  readonly distributed: boolean;
  publish(event: WireDomainEvent): Promise<boolean>;
  subscribe(handler: EventHandler): Promise<void>;
  close(): Promise<void>;
}

class MemoryBus implements EventBus {
  readonly distributed = false;
  private readonly handlers = new Set<EventHandler>();

  async publish(_event: WireDomainEvent): Promise<boolean> {
    return false;
  }

  async subscribe(handler: EventHandler): Promise<void> {
    this.handlers.add(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

class RedisBus implements EventBus {
  readonly distributed = true;
  private publisher: import('ioredis').default | null = null;
  private subscriber: import('ioredis').default | null = null;
  private readonly handlers = new Set<EventHandler>();

  constructor(private readonly url: string) {}

  private async connect(): Promise<void> {
    if (this.publisher && this.subscriber) return;
    const Redis = (await import('ioredis')).default;
    const opts = {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    };
    this.publisher = new Redis(this.url, opts);
    this.subscriber = new Redis(this.url, opts);
    await this.publisher.connect();
    await this.subscriber.connect();
    this.subscriber.on('message', (_channel: string, message: string) => {
      const event = parseWireEvent(message);
      if (!event) return;
      for (const handler of this.handlers) {
        try {
          handler(event);
        } catch (err) {
          logger.warn({ err }, '[events] redis subscriber handler failed');
        }
      }
    });
  }

  async publish(event: WireDomainEvent): Promise<boolean> {
    try {
      await this.connect();
      if (!this.publisher) return false;
      await this.publisher.publish(DOMAIN_EVENTS_CHANNEL, JSON.stringify(event));
      return true;
    } catch (err) {
      logger.warn({ err }, '[events] redis publish failed; degrading to local fan-out');
      return false;
    }
  }

  async subscribe(handler: EventHandler): Promise<void> {
    this.handlers.add(handler);
    try {
      await this.connect();
      if (!this.subscriber) return;
      await this.subscriber.subscribe(DOMAIN_EVENTS_CHANNEL);
    } catch (err) {
      logger.warn({ err }, '[events] redis subscribe failed');
    }
  }

  async close(): Promise<void> {
    this.handlers.clear();
    try {
      await this.publisher?.quit();
    } catch {
      // ignore
    }
    try {
      await this.subscriber?.quit();
    } catch {
      // ignore
    }
    this.publisher = null;
    this.subscriber = null;
  }
}

let bus: EventBus = new MemoryBus();
let started = false;

export function getEventBus(): EventBus {
  return bus;
}

export async function startEventBus(): Promise<EventBus> {
  if (started) return bus;
  started = true;
  const url = process.env.REDIS_URL?.trim();
  if (url) {
    bus = new RedisBus(url);
    logger.info('[events] using Redis pub/sub');
  } else {
    bus = new MemoryBus();
    logger.info('[events] REDIS_URL unset; SSE fan-out is in-process only');
  }
  return bus;
}

export async function stopEventBus(): Promise<void> {
  await bus.close();
  bus = new MemoryBus();
  started = false;
}
