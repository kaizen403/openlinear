/**
 * W04b cross-replica fan-out over the Redis bus, exercised with an in-memory
 * fake Redis (no Redis server is used). Two "replicas" each run a RedisBus
 * and a StreamConsumer against the same database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import {
  MAX_BUS_MESSAGE_BYTES,
  PermanentPublishError,
  RedisBus,
  type RedisClientFactory,
  type RedisClientLike,
} from '../events/bus';
import { StreamConsumer } from '../events/consumer';
import { appendDomainEvent } from '../events/outbox';
import { OutboxRelay } from '../events/relay';
import { sequencePendingEvents } from '../events/stream';
import { DOMAIN_EVENTS_CHANNEL, type WireDomainEvent } from '../events/types';

const run = randomUUID().slice(0, 8);
const prefix = `w04b-bus.${run}.`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One in-memory Redis server shared by every fake client. */
class FakeBroker {
  readonly clients = new Set<FakeRedisClient>();
  failPublishes = 0;
  publishCalls = 0;

  factory(): RedisClientFactory & { created: number } {
    const factory = Object.assign(
      async (_url: string, purpose: 'publisher' | 'subscriber') => {
        factory.created += 1;
        const client = new FakeRedisClient(this, purpose);
        this.clients.add(client);
        return client;
      },
      { created: 0 },
    );
    return factory;
  }

  deliver(channel: string, message: string): number {
    let receivers = 0;
    for (const client of this.clients) {
      if (client.receives(channel)) {
        receivers += 1;
        // Redis pushes asynchronously.
        queueMicrotask(() => client.emitMessage(channel, message));
      }
    }
    return receivers;
  }
}

class FakeRedisClient implements RedisClientLike {
  private readonly channels = new Set<string>();
  private readonly messageListeners: Array<(channel: string, message: string) => void> = [];
  private readonly readyListeners: Array<() => void> = [];
  private connected = false;

  constructor(private readonly broker: FakeBroker, readonly purpose: 'publisher' | 'subscriber') {}

  async connect(): Promise<void> {
    await sleep(1);
    this.connected = true;
    for (const listener of this.readyListeners) listener();
  }

  async publish(channel: string, message: string): Promise<number> {
    this.broker.publishCalls += 1;
    if (!this.connected) throw new Error('Connection is closed.');
    if (this.broker.failPublishes > 0) {
      this.broker.failPublishes -= 1;
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    }
    return this.broker.deliver(channel, message);
  }

  async subscribe(channel: string): Promise<unknown> {
    this.channels.add(channel);
    return 1;
  }

  onMessage(listener: (channel: string, message: string) => void): void {
    this.messageListeners.push(listener);
  }

  onReady(listener: () => void): void {
    this.readyListeners.push(listener);
  }

  async quit(): Promise<unknown> {
    this.connected = false;
    this.broker.clients.delete(this);
    return 'OK';
  }

  receives(channel: string): boolean {
    return this.connected && this.channels.has(channel);
  }

  emitMessage(channel: string, message: string): void {
    for (const listener of this.messageListeners) listener(channel, message);
  }

  /** Network drop: messages published meanwhile never arrive. */
  drop(): void {
    this.connected = false;
  }

  /** Reconnect (ioredis re-subscribes, then emits `ready`). */
  restore(): void {
    this.connected = true;
    for (const listener of this.readyListeners) listener();
  }
}

interface Replica {
  bus: RedisBus;
  consumer: StreamConsumer;
  delivered: WireDomainEvent[];
  subscriber: () => FakeRedisClient;
}

async function replica(broker: FakeBroker, name: string): Promise<Replica> {
  const delivered: WireDomainEvent[] = [];
  const consumer = new StreamConsumer({ deliver: (event) => delivered.push(event), name });
  await consumer.ensureInitialized();
  const before = new Set(broker.clients);
  const bus = new RedisBus('redis://fake', broker.factory());
  bus.onResync(() => { void consumer.catchUp(); });
  await bus.subscribe((event) => { void consumer.offer([event]); });
  const created = [...broker.clients].filter((client) => !before.has(client));
  const subscriber = created.find((client) => client.purpose === 'subscriber');
  if (!subscriber) throw new Error('fake subscriber missing');
  return { bus, consumer, delivered, subscriber: () => subscriber };
}

async function makeEvents(tags: string[]): Promise<bigint[]> {
  for (const tag of tags) {
    await appendDomainEvent(prisma, {
      type: `${prefix}${tag}`, payload: { tag }, audience: { userIds: [`u-${run}`] }, resource: { type: 'user' },
    });
  }
  const moved = await sequencePendingEvents({ limit: 1000 });
  return moved.filter((event) => event.type.startsWith(prefix)).map((event) => event.id);
}

function tags(events: WireDomainEvent[]): string[] {
  return events.filter((event) => event.type.startsWith(prefix)).map((event) => event.type.slice(prefix.length));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await sleep(5);
}

async function drainRelay(relay: OutboxRelay): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    await relay.runOnce();
    const left = await prisma.domainEvent.count({
      where: { type: { startsWith: prefix }, publishedAt: null, deadLetteredAt: null },
    });
    if (left === 0) return;
    await sleep(25);
  }
}

afterAll(async () => {
  await prisma.domainEvent.deleteMany({ where: { type: { startsWith: prefix } } });
});

describe('W04b Redis fan-out (fake Redis)', () => {
  it('delivers every relayed event to every replica exactly once, in order, through publish failures, a subscriber outage and duplicates', async () => {
    const broker = new FakeBroker();
    const a = await replica(broker, 'replica-a');
    const b = await replica(broker, 'replica-b');
    const relay = new OutboxRelay({
      name: `bus-relay-${run}`,
      publisher: { publish: (event) => a.bus.publish(event) },
      sequence: false,
      backoffMs: () => 20,
    });

    await makeEvents(['e1', 'e2', 'e3']);
    await drainRelay(relay);
    await settle();
    expect(tags(a.delivered)).toEqual(['e1', 'e2', 'e3']);
    expect(tags(b.delivered)).toEqual(['e1', 'e2', 'e3']);

    // Transient Redis failure: publishes are retried with backoff.
    broker.failPublishes = 2;
    await makeEvents(['e4', 'e5']);
    await drainRelay(relay);
    await settle();
    expect(tags(b.delivered)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    const retried = await prisma.domainEvent.findMany({ where: { type: { in: [`${prefix}e4`, `${prefix}e5`] } } });
    expect(retried.every((row) => row.publishedAt !== null)).toBe(true);
    expect(retried.some((row) => row.attempts > 1)).toBe(true);

    // Replica B's subscriber drops off: those messages are gone for good.
    b.subscriber().drop();
    await makeEvents(['e6', 'e7']);
    await drainRelay(relay);
    await settle();
    expect(tags(b.delivered)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    // On reconnect the bus asks the consumer to resync from the stream (no
    // manual catch-up here: the `ready` event alone must recover them).
    b.subscriber().restore();
    for (let i = 0; i < 100 && tags(b.delivered).length < 7; i += 1) await sleep(10);
    expect(tags(b.delivered)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);

    // A duplicate publication (two relays, or a republish after a lost ack)
    // reaches both replicas and is dropped by both consumers.
    const last = a.delivered.filter((event) => event.type === `${prefix}e7`)[0]!;
    await a.bus.publish(last);
    await settle();
    expect(tags(a.delivered)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
    expect(tags(b.delivered)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);

    // Each consumer's own positions only move forward.
    for (const replicaState of [a, b]) {
      const ids = replicaState.delivered.map((event) => BigInt(event.id));
      expect(ids.every((id, index) => index === 0 || id > ids[index - 1]!)).toBe(true);
    }
    await a.bus.close();
    await b.bus.close();
  });

  it('rejects oversized events as permanent, drops malformed messages, and connects once under concurrency', async () => {
    const broker = new FakeBroker();
    const factory = broker.factory();
    const bus = new RedisBus('redis://fake', factory);
    const received: WireDomainEvent[] = [];
    await Promise.all([
      bus.subscribe((event) => received.push(event)),
      bus.subscribe((event) => received.push(event)),
      bus.publish({
        id: '1', type: `${prefix}warmup`, occurredAt: new Date().toISOString(), actorId: null, workspaceId: null,
        payload: {}, userIds: [], teamIds: [], workspaceIds: [],
      }),
    ]);
    expect(factory.created).toBe(2); // one publisher + one subscriber, despite three concurrent callers

    const huge = {
      id: '2', type: `${prefix}huge`, occurredAt: new Date().toISOString(), actorId: null, workspaceId: null,
      payload: { blob: 'x'.repeat(MAX_BUS_MESSAGE_BYTES + 10) }, userIds: [], teamIds: [], workspaceIds: [],
    };
    await expect(bus.publish(huge)).rejects.toBeInstanceOf(PermanentPublishError);

    received.length = 0;
    broker.deliver(DOMAIN_EVENTS_CHANNEL, 'not json');
    broker.deliver(DOMAIN_EVENTS_CHANNEL, JSON.stringify({ id: 'abc', type: 'x' }));
    broker.deliver(DOMAIN_EVENTS_CHANNEL, JSON.stringify({ id: '0', type: 'x', occurredAt: '', actorId: null, workspaceId: null, payload: {}, userIds: [], teamIds: [], workspaceIds: [] }));
    broker.deliver('another-channel', JSON.stringify(huge));
    await settle();
    expect(received).toEqual([]);
    await bus.close();
  });
});
