/**
 * Transactional outbox (W04b): the append side.
 *
 * Inside a domain transaction:
 *
 *   await transactionWithEvents(async (tx) => {
 *     const task = await tx.task.update(…);                      // write first
 *     await appendDomainEvent(tx, { type: 'task:updated', … });  // then append
 *     return task;
 *   });
 *
 * The event commits or rolls back with the write. After commit,
 * `transactionWithEvents` asks this process to sequence and deliver the
 * event right away; if that fails, or the process dies first, the owner
 * relay picks the pending row up (nothing is lost).
 *
 * Append after the writes the event describes: two transactions that
 * conflict on a row are then appended in commit order, so a client applying
 * full-state payloads (task:updated) in stream order ends with the
 * committed state.
 *
 * `persistAndDeliver` is the legacy post-commit path used by `sse.ts`
 * broadcast helpers: append in its own transaction, then flush. It cannot
 * be atomic with a write that already committed; converting call sites to
 * `appendDomainEvent` is what removes that gap.
 */
import { prisma, type Prisma } from '@openlinear/db';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { logger } from '../logger';
import { getStreamConsumer } from './consumer';
import { deliverToLocalClients } from './hub';
import { flushOutbox, requestOutboxFlush } from './relay';
import { readRealtimeConfig } from './config';
import type { DomainEventInput, PendingDomainEvent, PersistedDomainEvent, WireDomainEvent } from './types';

type Db = Prisma.TransactionClient | typeof prisma;

/** Transactions (by client object) that appended at least one event. */
const appendedIn = new WeakSet<object>();

function jsonPayload(payload: unknown, type: string): Prisma.InputJsonValue {
  try {
    return JSON.parse(JSON.stringify(payload ?? null)) as Prisma.InputJsonValue;
  } catch (err) {
    logger.warn({ err, type }, '[events] event payload is not JSON-serializable; storing a placeholder');
    return { unserializable: true };
  }
}

function eventWorkspaceId(input: DomainEventInput): string | null {
  return input.resource?.workspaceId ?? input.workspaceId ?? input.audience.workspaceIds?.[0] ?? null;
}

/**
 * Append an event inside the caller's transaction (or, with the global
 * client, in its own). Local-only events (`audience.all`) cannot be
 * appended.
 */
export async function appendDomainEvent(db: Db, input: DomainEventInput): Promise<PendingDomainEvent> {
  if (input.audience.all) {
    throw new Error('Local-only events (audience.all) are not part of the stream');
  }
  // Explicit UTC timestamps: `timestamp(3)` columns are read as UTC.
  const now = new Date();
  const row = await db.domainEventOutbox.create({
    data: {
      type: input.type,
      occurredAt: now,
      createdAt: now,
      actorId: input.actorId ?? null,
      workspaceId: eventWorkspaceId(input),
      payload: jsonPayload(input.payload, input.type),
      userIds: input.audience.userIds ?? [],
      teamIds: input.audience.teamIds ?? [],
      workspaceIds: input.audience.workspaceIds ?? [],
      resourceType: input.resource?.type ?? null,
      projectId: input.resource?.projectId ?? null,
    },
    select: { id: true, type: true, occurredAt: true },
  });
  appendedIn.add(db);
  return { outboxId: row.id, type: row.type, occurredAt: row.occurredAt };
}

/** Pre-W04b name, kept for `sse.ts` re-exports. */
export const emitOutbox = appendDomainEvent;

/** True when `tx` appended events (used to trigger a post-commit flush). */
export function transactionAppendedEvents(tx: object): boolean {
  return appendedIn.has(tx);
}

/**
 * `prisma.$transaction` that flushes appended events after commit. Use it
 * for every transaction that calls `appendDomainEvent`; a plain
 * `$transaction` is still correct, only slower to deliver (relay interval).
 */
export async function transactionWithEvents<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number; maxWait?: number } = PRISMA_TX_OPTIONS,
): Promise<T> {
  const used: { tx?: Prisma.TransactionClient } = {};
  const result = await prisma.$transaction(async (tx) => {
    used.tx = tx;
    return fn(tx);
  }, options);
  if (used.tx && appendedIn.has(used.tx)) requestOutboxFlush();
  return result;
}

function localWireEvent(input: DomainEventInput): WireDomainEvent {
  return {
    // No stream position: an empty id writes no `id:` line, so the client's
    // Last-Event-ID is not moved (the old '0' reset it to the beginning).
    id: '',
    type: input.type,
    occurredAt: new Date().toISOString(),
    actorId: input.actorId ?? null,
    workspaceId: eventWorkspaceId(input),
    payload: input.payload,
    userIds: input.audience.userIds ?? [],
    teamIds: input.audience.teamIds ?? [],
    workspaceIds: input.audience.workspaceIds ?? [],
    resourceType: input.resource?.type ?? null,
    projectId: input.resource?.projectId ?? null,
  };
}

/**
 * Legacy post-commit path (fire-and-forget `broadcast*` helpers): append the
 * event in its own transaction, sequence it and deliver it to this process's
 * clients. Resolves with the stream event once delivered here, or null when
 * it could not be persisted or was sequenced elsewhere.
 */
export async function persistAndDeliver(input: DomainEventInput): Promise<PersistedDomainEvent | null> {
  if (input.audience.all) {
    return null;
  }
  if (process.env.OPENLINEAR_OUTBOX === '0') {
    deliverToLocalClients(localWireEvent(input));
    return null;
  }

  let pending: PendingDomainEvent;
  try {
    pending = await appendDomainEvent(prisma, input);
  } catch (err) {
    // The domain write already committed; without the outbox only this
    // process's clients can still be told, and without a stream position.
    logger.warn({ err, type: input.type }, '[events] outbox append failed; delivering to this process only');
    deliverToLocalClients(localWireEvent(input));
    return null;
  }

  if (!readRealtimeConfig().fastFlush) return null;
  const consumer = getStreamConsumer();
  consumer.watchSource(pending.outboxId);
  try {
    await flushOutbox();
    let delivered = consumer.takeWatched(pending.outboxId);
    if (!delivered) {
      // Another process sequenced it first: read it from the stream.
      consumer.watchSource(pending.outboxId);
      await consumer.catchUp();
      delivered = consumer.takeWatched(pending.outboxId);
    }
    return delivered;
  } catch (err) {
    consumer.takeWatched(pending.outboxId);
    logger.warn({ err, type: input.type }, '[events] outbox flush failed; the relay delivers the event');
    return null;
  }
}

export {
  isReplayTruncated,
  parseLastEventId,
  readReplayPage,
  replayEvents,
  replaySince,
  type ReplayAudience,
  type ReplayOptions,
  type ReplayPage,
} from './replay';
export { liveStreamPosition } from './consumer';
export {
  listDeadLetteredEvents,
  readOutboxHealth,
  requeueDeadLetteredEvents,
  type DeadLetteredEvent,
  type OutboxHealth,
} from './stream';
export type { WireDomainEvent };
