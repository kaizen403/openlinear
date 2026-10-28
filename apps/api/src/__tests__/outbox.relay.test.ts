/**
 * W04b durable outbox: sequencing, leased relay delivery, retry/backoff,
 * dead letters, fencing, crash recovery, immutability and consumer
 * exactly-once delivery. Real PostgreSQL; no network.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@openlinear/db';
import { PermanentPublishError, stopEventBus } from '../events/bus';
import { ownsRelay, readRealtimeConfig, resolveProcessRole } from '../events/config';
import { getStreamConsumer, StreamConsumer } from '../events/consumer';
import { appendDomainEvent, transactionWithEvents } from '../events/outbox';
import {
  isOutboxRelayRunning,
  OutboxRelay,
  startRealtime,
  stopRealtime,
  type RelayPublisher,
} from '../events/relay';
import {
  listDeadLetteredEvents,
  readOutboxHealth,
  readStreamHead,
  requeueDeadLetteredEvents,
  SEQUENCER_LOCK_KEY,
  sequencePendingEvents,
} from '../events/stream';
import { EVENT_IMMUTABLE_SQLSTATE, type DomainEventInput, type PersistedDomainEvent, type WireDomainEvent } from '../events/types';
import { logger } from '../logger';

const run = randomUUID().slice(0, 8);
const prefix = `w04b.${run}.`;
const user = `w04b-user-${run}`;

function input(tag: string): DomainEventInput {
  return { type: `${prefix}${tag}`, payload: { tag }, audience: { userIds: [user] }, resource: { type: 'user' } };
}

function mine(event: { type: string }): boolean {
  return event.type.startsWith(prefix);
}

function tagOf(event: { type: string }): string {
  return event.type.slice(prefix.length);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeStreamEvents(tags: string[]): Promise<PersistedDomainEvent[]> {
  for (const tag of tags) await appendDomainEvent(prisma, input(tag));
  const moved: PersistedDomainEvent[] = [];
  for (;;) {
    const batch = await sequencePendingEvents({ limit: 500 });
    moved.push(...batch);
    if (batch.length < 500) break;
  }
  return moved.filter(mine);
}

async function rowOf(id: bigint) {
  return prisma.domainEvent.findUniqueOrThrow({ where: { id } });
}

function recorder(fail?: (event: WireDomainEvent) => Error | null): RelayPublisher & { events: WireDomainEvent[] } {
  const events: WireDomainEvent[] = [];
  return {
    events,
    async publish(event) {
      const error = fail?.(event) ?? null;
      if (error) throw error;
      events.push(event);
    },
  };
}

/** Run a relay until none of our events is left unpublished (or it gives up). */
async function drain(relay: OutboxRelay, rounds = 200): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const result = await relay.runOnce();
    if (result.claimed === 0) {
      const left = await prisma.domainEvent.count({
        where: { type: { startsWith: prefix }, publishedAt: null, deadLetteredAt: null },
      });
      if (left === 0) return;
      await sleep(10);
    }
  }
}

/** SQLSTATE of a driver error, model-query (cause chain) or raw-query (P2010 meta) shaped. */
function postgresCode(err: unknown): string | null {
  const queue: unknown[] = [err];
  for (let steps = 0; queue.length > 0 && steps < 12; steps += 1) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null) continue;
    const candidate = current as { code?: unknown; originalCode?: unknown; cause?: unknown; meta?: { driverAdapterError?: unknown } };
    if (candidate.originalCode === EVENT_IMMUTABLE_SQLSTATE || candidate.code === EVENT_IMMUTABLE_SQLSTATE) {
      return EVENT_IMMUTABLE_SQLSTATE;
    }
    queue.push(candidate.cause, candidate.meta?.driverAdapterError);
  }
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.domainEventOutbox.deleteMany({ where: { type: { startsWith: prefix } } });
  await prisma.domainEvent.deleteMany({ where: { type: { startsWith: prefix } } });
});

describe('W04b transactional append and sequencing', () => {
  it('appends inside the caller transaction: rollback leaves no pending or stream event', async () => {
    await expect(transactionWithEvents(async (tx) => {
      await appendDomainEvent(tx, input('rolled-back'));
      throw new Error('domain write failed');
    })).rejects.toThrow('domain write failed');
    await sequencePendingEvents();
    expect(await prisma.domainEventOutbox.count({ where: { type: `${prefix}rolled-back` } })).toBe(0);
    expect(await prisma.domainEvent.count({ where: { type: `${prefix}rolled-back` } })).toBe(0);

    await transactionWithEvents(async (tx) => {
      await appendDomainEvent(tx, input('committed'));
    });
    // Pending until sequenced; the post-commit flush or the relay moves it.
    for (let i = 0; i < 100 && (await prisma.domainEvent.count({ where: { type: `${prefix}committed` } })) === 0; i += 1) {
      await sleep(10);
    }
    expect(await prisma.domainEvent.count({ where: { type: `${prefix}committed` } })).toBe(1);
    expect(await prisma.domainEventOutbox.count({ where: { type: `${prefix}committed` } })).toBe(0);
  });

  it('keeps append order within a batch and moves each pending row exactly once', async () => {
    const tags = Array.from({ length: 30 }, (_, index) => `order-${index}`);
    const moved = await makeStreamEvents(tags);
    expect(moved.map(tagOf)).toEqual(tags);
    const ids = moved.map((event) => event.id);
    expect([...ids].sort((a, b) => (a < b ? -1 : 1))).toEqual(ids);
    const sources = moved.map((event) => event.sourceId);
    expect(new Set(sources.map(String)).size).toBe(sources.length);
    expect(sources.every((source) => typeof source === 'bigint')).toBe(true);
  });

  it('assigns stream ids in commit order, not append order', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstMayCommit = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstAppended: () => void = () => undefined;
    const appended = new Promise<void>((resolve) => { firstAppended = resolve; });
    // Appends first (lower pending id) but commits last.
    const first = prisma.$transaction(async (tx) => {
      await appendDomainEvent(tx, input('appended-first'));
      firstAppended();
      await firstMayCommit;
    });
    await appended;
    await appendDomainEvent(prisma, input('appended-second'));

    const early = (await sequencePendingEvents()).filter(mine);
    expect(early.map(tagOf)).toEqual(['appended-second']);
    releaseFirst();
    await first;
    const late = (await sequencePendingEvents()).filter(mine);
    expect(late.map(tagOf)).toEqual(['appended-first']);
    expect(late[0]!.id > early[0]!.id).toBe(true);
  });

  it('never lets a reader see a smaller id after a larger one under concurrent writers and sequencers', async () => {
    const seen: bigint[] = [];
    let position = await readStreamHead();
    let writing = true;
    const reader = (async () => {
      while (writing) {
        const rows = await prisma.domainEvent.findMany({ where: { id: { gt: position } }, orderBy: { id: 'asc' }, take: 500 });
        for (const row of rows) {
          position = row.id;
          if (mine(row)) seen.push(row.id);
        }
        await sleep(1);
      }
    })();
    await Promise.all(Array.from({ length: 6 }, async (_, writer) => {
      for (let n = 0; n < 16; n += 1) {
        await transactionWithEvents(async (tx) => {
          await appendDomainEvent(tx, input(`race-${writer}-${n}`));
          await sleep(Math.floor(Math.random() * 4));
        });
        // A sequencer that times out on the lock leaves rows pending for the
        // next run; that is allowed, losing or reordering them is not.
        await sequencePendingEvents().catch(() => undefined);
      }
    }));
    await sequencePendingEvents();
    writing = false;
    await reader;
    const rest = await prisma.domainEvent.findMany({ where: { id: { gt: position } }, orderBy: { id: 'asc' } });
    for (const row of rest) if (mine(row)) seen.push(row.id);

    const all = await prisma.domainEvent.findMany({
      where: { type: { startsWith: `${prefix}race-` } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    expect(all).toHaveLength(96);
    // Every event was observed by a reader that only ever moved forward.
    expect(seen.filter((id) => all.some((row) => row.id === id))).toEqual(all.map((row) => row.id));
  });

  it('serializes sequencers: a second one waits until the first commits (and times out cleanly)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    // Stands in for a sequencer that has inserted its batch and not yet committed.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEQUENCER_LOCK_KEY})`;
      locked();
      await gate;
    }, { timeout: 20_000 });
    await holding;
    await appendDomainEvent(prisma, input('serialized'));
    let settled = false;
    const waiting = sequencePendingEvents({ lockTimeoutMs: 10_000 }).finally(() => { settled = true; });
    await sleep(300);
    expect(settled).toBe(false);
    await expect(sequencePendingEvents({ lockTimeoutMs: 100 })).rejects.toThrow();
    release();
    await holder;
    const moved = (await waiting).filter(mine);
    expect(moved.map(tagOf)).toEqual(['serialized']);
  });

  it('recovers from a sequencer that fails mid-batch: nothing lost, nothing duplicated', async () => {
    const trigger = `w04b_fail_seq_${run}`;
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type = '${prefix}poison-sequence' THEN RAISE EXCEPTION 'w04b injected sequencer failure'; END IF;
        RETURN NEW;
      END $$;`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      for (const tag of ['batch-a', 'poison-sequence', 'batch-b']) await appendDomainEvent(prisma, input(tag));
      await expect(sequencePendingEvents()).rejects.toThrow();
      // The whole move rolled back: all three are still pending, none in the stream.
      expect(await prisma.domainEventOutbox.count({ where: { type: { in: ['batch-a', 'poison-sequence', 'batch-b'].map((t) => `${prefix}${t}`) } } })).toBe(3);
      expect(await prisma.domainEvent.count({ where: { type: { in: ['batch-a', 'batch-b'].map((t) => `${prefix}${t}`) } } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON domain_events`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
    const moved = (await sequencePendingEvents()).filter(mine);
    expect(moved.map(tagOf)).toEqual(['batch-a', 'poison-sequence', 'batch-b']);
    expect(await prisma.domainEventOutbox.count({ where: { type: { startsWith: `${prefix}batch-` } } })).toBe(0);
  });
});

describe('W04b immutable events', () => {
  it('rejects UPDATEs of event columns at the database, allows relay bookkeeping', async () => {
    const [event] = await makeStreamEvents(['immutable']);
    const id = event!.id;

    const payloadUpdate = await prisma.domainEvent.update({ where: { id }, data: { payload: { tampered: true } } })
      .then(() => null, (err: unknown) => err);
    expect(payloadUpdate).not.toBeNull();
    expect(postgresCode(payloadUpdate)).toBe(EVENT_IMMUTABLE_SQLSTATE);

    for (const column of ['type', 'project_id', 'resource_type', 'user_ids', 'occurred_at', 'source_id', 'id']) {
      const value = column === 'user_ids' ? `ARRAY['intruder']::text[]` : column === 'occurred_at'
        ? `now()` : column === 'source_id' || column === 'id' ? `${id + 1000000n}` : `'tampered'`;
      const err = await prisma.$executeRawUnsafe(`UPDATE domain_events SET ${column} = ${value} WHERE id = ${id}`)
        .then(() => null, (error: unknown) => error);
      expect(postgresCode(err), column).toBe(EVENT_IMMUTABLE_SQLSTATE);
    }

    await prisma.domainEvent.update({ where: { id }, data: { lastError: 'note', attempts: 3 } });
    const row = await rowOf(id);
    expect(row.payload).toEqual({ tag: 'immutable' });
    expect(row.type).toBe(`${prefix}immutable`);
    expect(row.lastError).toBe('note');

    const pending = await appendDomainEvent(prisma, input('immutable-pending'));
    const pendingErr = await prisma.domainEventOutbox.update({ where: { id: pending.outboxId }, data: { payload: { tampered: true } } })
      .then(() => null, (err: unknown) => err);
    expect(postgresCode(pendingErr)).toBe(EVENT_IMMUTABLE_SQLSTATE);
    await sequencePendingEvents();
  });
});

describe('W04b relay', () => {
  it('two concurrent relays: every event published once, claims disjoint, all acked', async () => {
    const events = await makeStreamEvents(Array.from({ length: 300 }, (_, index) => `pair-${index}`));
    const byRelay = new Map<string, string[]>();
    const publisherFor = (name: string): RelayPublisher => ({
      async publish(event) {
        if (!mine(event)) return;
        if (Math.random() < 0.05) await sleep(1);
        byRelay.set(event.id, [...(byRelay.get(event.id) ?? []), name]);
      },
    });
    const relayA = new OutboxRelay({ name: `A-${run}`, publisher: publisherFor('A'), sequence: false, batchSize: 20, leaseMs: 30_000 });
    const relayB = new OutboxRelay({ name: `B-${run}`, publisher: publisherFor('B'), sequence: false, batchSize: 20, leaseMs: 30_000 });
    await Promise.all([drain(relayA), drain(relayB)]);

    for (const event of events) {
      expect(byRelay.get(event.id.toString()), `event ${event.id}`).toHaveLength(1);
    }
    const unpublished = await prisma.domainEvent.count({ where: { id: { in: events.map((e) => e.id) }, publishedAt: null } });
    expect(unpublished).toBe(0);
    const leased = await prisma.domainEvent.count({ where: { id: { in: events.map((e) => e.id) }, leaseOwner: { not: null } } });
    expect(leased).toBe(0);
  });

  it('survives a crash between claim and publish: the lease expires and another relay delivers', async () => {
    const events = await makeStreamEvents(['crash-1', 'crash-2', 'crash-3']);
    const crashed = recorder();
    const crashing = new OutboxRelay({
      name: `crashing-${run}`, publisher: crashed, sequence: false, leaseMs: 300,
      hooks: { afterClaim: () => { throw new Error('simulated crash after claim'); } },
    });
    await expect(crashing.runOnce()).rejects.toThrow('simulated crash after claim');
    expect((await rowOf(events[0]!.id)).leaseOwner).toMatch(/^crashing-/);

    const rescued = recorder();
    const rescuer = new OutboxRelay({ name: `rescuer-${run}`, publisher: rescued, sequence: false, leaseMs: 300 });
    await rescuer.runOnce();
    expect(rescued.events.filter(mine)).toHaveLength(0); // lease still held

    await sleep(350);
    await drain(rescuer);
    expect(rescued.events.filter(mine).map(tagOf)).toEqual(['crash-1', 'crash-2', 'crash-3']);
    expect(crashed.events.filter(mine)).toHaveLength(0);
    for (const event of events) {
      const row = await rowOf(event.id);
      expect(row.publishedAt).not.toBeNull();
      expect(row.attempts).toBe(2);
    }
  });

  it('survives a crash between publish and ack: republished after expiry, consumers drop the duplicate', async () => {
    const events = await makeStreamEvents(['ack-crash-1', 'ack-crash-2']);
    const first = recorder();
    const crashing = new OutboxRelay({
      name: `ackcrash-${run}`, publisher: first, sequence: false, leaseMs: 250,
      hooks: { beforeAck: () => { throw new Error('simulated crash before ack'); } },
    });
    await expect(crashing.runOnce()).rejects.toThrow('simulated crash before ack');
    expect(first.events.filter(mine).map(tagOf)).toEqual(['ack-crash-1', 'ack-crash-2']);

    await sleep(300);
    const second = recorder();
    await drain(new OutboxRelay({ name: `ackrescue-${run}`, publisher: second, sequence: false, leaseMs: 250 }));
    expect(second.events.filter(mine).map(tagOf)).toEqual(['ack-crash-1', 'ack-crash-2']);

    // Both publications reach a consumer: it delivers each event once.
    const delivered: WireDomainEvent[] = [];
    const consumer = new StreamConsumer({ deliver: (event) => delivered.push(event), name: 'ack-crash' });
    consumer.setPosition(events[0]!.id - 1n);
    await consumer.offer([...first.events, ...second.events].filter(mine));
    expect(delivered.filter(mine).map(tagOf)).toEqual(['ack-crash-1', 'ack-crash-2']);
  });

  it('fences a relay whose lease was taken over: its ack changes nothing', async () => {
    const [event] = await makeStreamEvents(['fenced']);
    const late = recorder();
    const fresh = recorder();
    const takeover = new OutboxRelay({ name: `takeover-${run}`, publisher: fresh, sequence: false, leaseMs: 60_000 });
    const slow = new OutboxRelay({
      name: `slow-${run}`, publisher: late, sequence: false, leaseMs: 100,
      hooks: {
        afterClaim: async () => {
          await sleep(150);
          await takeover.runOnce();
        },
      },
    });
    const result = await slow.runOnce();
    expect(result.fenced).toBeGreaterThanOrEqual(1);
    expect(fresh.events.filter(mine).map(tagOf)).toEqual(['fenced']);
    expect(late.events.filter(mine).map(tagOf)).toEqual(['fenced']);
    const row = await rowOf(event!.id);
    expect(row.publishedAt).not.toBeNull();
    expect(row.leaseOwner).toBeNull();
  });

  it('retries a transient publish failure with backoff, then succeeds', async () => {
    const [event] = await makeStreamEvents(['transient']);
    let failuresLeft = 2;
    const publisher = recorder((wire) => (wire.id === event!.id.toString() && failuresLeft-- > 0 ? new Error('redis: connection lost') : null));
    const warn = vi.spyOn(logger, 'warn');
    const relay = new OutboxRelay({ name: `transient-${run}`, publisher, sequence: false, maxAttempts: 5, backoffMs: () => 80 });

    await relay.runOnce();
    let row = await rowOf(event!.id);
    expect(row.publishedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('connection lost');
    expect(row.nextAttemptAt).not.toBeNull();
    expect(warn.mock.calls.some(([, message]) => String(message).includes('retrying with backoff'))).toBe(true);

    // Not due yet: an immediate cycle does not touch it.
    await relay.runOnce();
    expect((await rowOf(event!.id)).attempts).toBe(1);

    await sleep(100);
    await relay.runOnce(); // second failure
    await sleep(100);
    await relay.runOnce(); // success
    row = await rowOf(event!.id);
    expect(row.attempts).toBe(3);
    expect(row.publishedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.deadLetteredAt).toBeNull();
    expect(publisher.events.filter((wire) => wire.id === event!.id.toString())).toHaveLength(1);
  });

  it('dead-letters a poison event after maxAttempts with log + queryable state; others still flow', async () => {
    const [poison, healthy] = await makeStreamEvents(['poison', 'healthy']);
    const publisher = recorder((wire) => (wire.id === poison!.id.toString() ? new Error('bus rejected message') : null));
    const errorLog = vi.spyOn(logger, 'error');
    const relay = new OutboxRelay({ name: `poison-${run}`, publisher, sequence: false, maxAttempts: 3, backoffMs: () => 20 });
    for (let round = 0; round < 3; round += 1) {
      await relay.runOnce();
      await sleep(30);
    }
    const row = await rowOf(poison!.id);
    expect(row.attempts).toBe(3);
    expect(row.deadLetteredAt).not.toBeNull();
    expect(row.publishedAt).toBeNull();
    expect(row.lastError).toContain('bus rejected message');
    expect(row.leaseOwner).toBeNull();
    expect((await rowOf(healthy!.id)).publishedAt).not.toBeNull();
    expect(errorLog.mock.calls.some(([, message]) => String(message).includes('dead-lettered'))).toBe(true);

    const dead = await listDeadLetteredEvents();
    expect(dead.map((entry) => entry.id)).toContain(poison!.id);
    expect((await readOutboxHealth()).deadLettered).toBeGreaterThanOrEqual(1);

    // A dead letter is no longer claimed …
    await relay.runOnce();
    expect((await rowOf(poison!.id)).attempts).toBe(3);
    // … but it is still in the stream: a consumer catching up delivers it.
    const delivered: WireDomainEvent[] = [];
    const consumer = new StreamConsumer({ deliver: (wire) => delivered.push(wire), name: 'poison' });
    consumer.setPosition(poison!.id - 1n);
    await consumer.catchUp();
    expect(delivered.filter(mine).map(tagOf)).toEqual(['poison', 'healthy']);

    // Operators can requeue it once the cause is fixed.
    expect(await requeueDeadLetteredEvents([poison!.id])).toBe(1);
    const fixed = recorder();
    await new OutboxRelay({ name: `requeue-${run}`, publisher: fixed, sequence: false }).runOnce();
    const requeued = await rowOf(poison!.id);
    expect(requeued.publishedAt).not.toBeNull();
    expect(requeued.deadLetteredAt).toBeNull();
    expect(requeued.attempts).toBe(1);
  });

  it('dead-letters a permanent publish error at once', async () => {
    const [event] = await makeStreamEvents(['too-large']);
    const publisher = recorder((wire) => (wire.id === event!.id.toString() ? new PermanentPublishError('message exceeds bus limit') : null));
    await new OutboxRelay({ name: `permanent-${run}`, publisher, sequence: false, maxAttempts: 8 }).runOnce();
    const row = await rowOf(event!.id);
    expect(row.attempts).toBe(1);
    expect(row.deadLetteredAt).not.toBeNull();
    expect(row.lastError).toContain('PermanentPublishError');
  });

  it('sequences pending appends and hands them to the consumer before publishing', async () => {
    await appendDomainEvent(prisma, input('relay-sequenced'));
    const offered: PersistedDomainEvent[] = [];
    const publisher = recorder();
    const relay = new OutboxRelay({
      name: `seq-${run}`, publisher,
      onSequenced: async (events) => { offered.push(...events); },
    });
    const result = await relay.runOnce();
    expect(result.sequenced).toBeGreaterThanOrEqual(1);
    expect(offered.filter(mine).map(tagOf)).toEqual(['relay-sequenced']);
    expect(publisher.events.filter(mine).map(tagOf)).toEqual(['relay-sequenced']);
  });
});

describe('W04b stream consumer', () => {
  it('delivers each event exactly once and in order despite duplicates, reordering and gaps', async () => {
    const events = await makeStreamEvents(Array.from({ length: 40 }, (_, index) => `consume-${index}`));
    const delivered: WireDomainEvent[] = [];
    const consumer = new StreamConsumer({ deliver: (wire) => delivered.push(wire), name: 'dedupe', pageSize: 7 });
    consumer.setPosition(events[0]!.id - 1n);
    const wires = events.map((event) => ({
      id: event.id.toString(), type: event.type, occurredAt: event.occurredAt.toISOString(), actorId: null,
      workspaceId: null, payload: event.payload, userIds: event.userIds, teamIds: [], workspaceIds: [],
      resourceType: 'user', projectId: null,
    }));
    // Lost messages (every 3rd never arrives), duplicates and reversed batches.
    const arriving = wires.filter((_, index) => index % 3 !== 0);
    await Promise.all([
      consumer.offer([...arriving].reverse()),
      consumer.offer(arriving.slice(5, 15)),
      consumer.offer(arriving),
    ]);
    const ids = delivered.filter(mine).map((wire) => BigInt(wire.id));
    expect(ids).toEqual(events.map((event) => event.id));
    expect(new Set(ids.map(String)).size).toBe(ids.length);
    expect(consumer.livePosition).toBeGreaterThanOrEqual(events.at(-1)!.id);
  });

  it('starts at the stream head: history before initialization is replay, not live', async () => {
    await makeStreamEvents(['before-start']);
    const delivered: WireDomainEvent[] = [];
    const consumer = new StreamConsumer({ deliver: (wire) => delivered.push(wire), name: 'head' });
    await consumer.ensureInitialized();
    const after = await makeStreamEvents(['after-start']);
    await consumer.catchUp();
    expect(delivered.filter(mine).map(tagOf)).toEqual(['after-start']);
    expect(consumer.livePosition).toBeGreaterThanOrEqual(after[0]!.id);
  });
});

describe('W04b relay ownership configuration', () => {
  it('exactly one role owns the relay; legacy opt-out still works', () => {
    expect(readRealtimeConfig({}).relayOwner).toBe('api');
    expect(ownsRelay(readRealtimeConfig({}), 'api')).toBe(true);
    expect(ownsRelay(readRealtimeConfig({}), 'worker')).toBe(false);
    const worker = readRealtimeConfig({ OPENLINEAR_OUTBOX_RELAY: 'worker' });
    expect(ownsRelay(worker, 'worker')).toBe(true);
    expect(ownsRelay(worker, 'api')).toBe(false);
    for (const off of ['0', 'false', 'off']) {
      const config = readRealtimeConfig({ OPENLINEAR_OUTBOX_RELAY: off });
      expect(ownsRelay(config, 'api')).toBe(false);
      expect(ownsRelay(config, 'worker')).toBe(false);
    }
    expect(readRealtimeConfig({ OPENLINEAR_OUTBOX_FAST_FLUSH: '0' }).fastFlush).toBe(false);
    expect(readRealtimeConfig({}).fastFlush).toBe(true);
  });

  it('startRealtime runs the relay only in the owning role, and live delivery only in API processes', async () => {
    const savedRedis = process.env.REDIS_URL;
    const savedOwner = process.env.OPENLINEAR_OUTBOX_RELAY;
    delete process.env.REDIS_URL;
    delete process.env.OPENLINEAR_OUTBOX_RELAY;
    try {
      await startRealtime({ role: 'worker' }); // default owner: api
      expect(isOutboxRelayRunning()).toBe(false);
      expect(getStreamConsumer().polling).toBe(false);
      stopRealtime();
      await stopEventBus();

      await startRealtime({ role: 'api' });
      expect(isOutboxRelayRunning()).toBe(true);
      expect(getStreamConsumer().polling).toBe(true);
      stopRealtime();
      await stopEventBus();

      process.env.OPENLINEAR_OUTBOX_RELAY = 'worker';
      await startRealtime({ role: 'worker' });
      expect(isOutboxRelayRunning()).toBe(true);
      expect(getStreamConsumer().polling).toBe(false);
    } finally {
      stopRealtime();
      await stopEventBus();
      if (savedRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = savedRedis;
      if (savedOwner === undefined) delete process.env.OPENLINEAR_OUTBOX_RELAY; else process.env.OPENLINEAR_OUTBOX_RELAY = savedOwner;
    }
  });

  it('resolves the process role from the option, env, then entry file', () => {
    expect(resolveProcessRole('worker', {}, '/app/dist/index.js')).toBe('worker');
    expect(resolveProcessRole(undefined, { OPENLINEAR_PROCESS_ROLE: 'worker' }, '/app/dist/index.js')).toBe('worker');
    expect(resolveProcessRole(undefined, {}, '/app/src/worker.ts')).toBe('worker');
    expect(resolveProcessRole(undefined, {}, '/app/dist/index.js')).toBe('api');
    expect(resolveProcessRole(undefined, {}, undefined)).toBe('api');
  });
});
