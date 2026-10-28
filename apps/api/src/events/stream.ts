/**
 * Storage of the ordered event stream (W04b).
 *
 *   domain transaction ──append──► domain_event_outbox (pending, immutable)
 *   sequencer (one at a time, advisory lock) ──move──► domain_events (stream)
 *
 * Only the sequencer inserts stream rows, holding a transaction-scoped
 * advisory lock until it commits. Ids are therefore assigned and made
 * visible in commit order: once a reader sees stream id N, no id below N can
 * appear later (ids skipped by a rolled-back sequencer stay gaps forever).
 * That is what makes `id` a sound Last-Event-ID cursor and lets consumers
 * fill gaps by reading `id > position`.
 *
 * All timestamps written here are UTC (`now() AT TIME ZONE 'UTC'`): the
 * columns are `timestamp(3)` without time zone and Prisma reads them as UTC,
 * so using the session time zone would shift them on non-UTC servers.
 */
import { prisma, Prisma, type DomainEvent } from '@openlinear/db';
import type { PersistedDomainEvent } from './types';

const NOW_UTC = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** pg_advisory_xact_lock key serializing the sequencer ("OLEVSEQ1"). */
export const SEQUENCER_LOCK_KEY = 0x4f4c_4556_5345_5131n;

export const DEFAULT_SEQUENCE_LIMIT = 500;
export const DEFAULT_SEQUENCER_LOCK_TIMEOUT_MS = 2_000;

interface StreamRow {
  id: bigint;
  type: string;
  occurred_at: Date;
  actor_id: string | null;
  workspace_id: string | null;
  payload: Prisma.JsonValue;
  user_ids: string[];
  team_ids: string[];
  workspace_ids: string[];
  resource_type: string | null;
  project_id: string | null;
  source_id: bigint | null;
  published_at: Date | null;
}

const STREAM_COLUMNS = Prisma.sql`id, type, occurred_at, actor_id, workspace_id, payload, user_ids, team_ids,
  workspace_ids, resource_type, project_id, source_id, published_at`;

export function fromStreamRow(row: StreamRow): PersistedDomainEvent {
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    workspaceId: row.workspace_id,
    payload: row.payload,
    userIds: row.user_ids,
    teamIds: row.team_ids,
    workspaceIds: row.workspace_ids,
    resourceType: row.resource_type,
    projectId: row.project_id,
    sourceId: row.source_id,
    publishedAt: row.published_at,
  };
}

export function fromDomainEventRecord(row: DomainEvent): PersistedDomainEvent {
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurredAt,
    actorId: row.actorId,
    workspaceId: row.workspaceId,
    payload: row.payload,
    userIds: row.userIds,
    teamIds: row.teamIds,
    workspaceIds: row.workspaceIds,
    resourceType: row.resourceType,
    projectId: row.projectId,
    sourceId: row.sourceId,
    publishedAt: row.publishedAt,
  };
}

function byId(a: PersistedDomainEvent, b: PersistedDomainEvent): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Stream events with `after < id (<= upTo)`, in id order. */
export async function readStreamAfter(
  after: bigint,
  limit: number,
  upTo?: bigint | null,
): Promise<PersistedDomainEvent[]> {
  const rows = await prisma.domainEvent.findMany({
    where: { id: upTo === undefined || upTo === null ? { gt: after } : { gt: after, lte: upTo } },
    orderBy: { id: 'asc' },
    take: limit,
  });
  return rows.map(fromDomainEventRecord);
}

/** Highest stream id (0 when the stream is empty). */
export async function readStreamHead(): Promise<bigint> {
  const result = await prisma.domainEvent.aggregate({ _max: { id: true } });
  return result._max.id ?? 0n;
}

export interface SequenceOptions {
  limit?: number;
  lockTimeoutMs?: number;
  /**
   * Mark the moved events as published. Used when no distributed bus exists:
   * in-process delivery is then the whole publication, so the relay has
   * nothing left to do for them.
   */
  markPublished?: boolean;
}

/**
 * Move up to `limit` committed pending events into the stream, oldest first,
 * in one transaction under the sequencer lock. Pending rows of transactions
 * that have not committed are invisible here and are moved by a later run.
 * Returns the new stream events in id order.
 */
export async function sequencePendingEvents(options: SequenceOptions = {}): Promise<PersistedDomainEvent[]> {
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_SEQUENCE_LIMIT));
  const lockTimeout = `${Math.max(1, Math.trunc(options.lockTimeoutMs ?? DEFAULT_SEQUENCER_LOCK_TIMEOUT_MS))}ms`;
  const markPublished = options.markPublished ?? false;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${lockTimeout}, true)`;
    // Held until commit: the next sequencer starts only after these ids are
    // visible, so ids become visible in increasing order.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEQUENCER_LOCK_KEY})`;
    const rows = await tx.$queryRaw<StreamRow[]>`
      WITH moved AS (
        DELETE FROM domain_event_outbox
        WHERE id IN (
          SELECT id FROM domain_event_outbox
          ORDER BY id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type, occurred_at, actor_id, workspace_id, payload, user_ids, team_ids,
                  workspace_ids, resource_type, project_id
      )
      INSERT INTO domain_events (type, occurred_at, actor_id, workspace_id, payload, user_ids, team_ids,
                                 workspace_ids, resource_type, project_id, source_id, published_at, created_at)
      SELECT type, occurred_at, actor_id, workspace_id, payload, user_ids, team_ids,
             workspace_ids, resource_type, project_id, id,
             CASE WHEN ${markPublished}::boolean THEN ${NOW_UTC} ELSE NULL END,
             ${NOW_UTC}
      FROM moved
      ORDER BY id
      RETURNING ${STREAM_COLUMNS}
    `;
    return rows.map(fromStreamRow).sort(byId);
  }, { timeout: 15_000, maxWait: 5_000 });
}

/** Pending rows not yet sequenced (operational visibility). */
export async function countPendingEvents(): Promise<number> {
  return prisma.domainEventOutbox.count();
}

// ─── Relay claims (lease, ack, retry, dead letter) ──────────────────────────

export interface ClaimedEvent extends PersistedDomainEvent {
  /** Delivery attempt number for this claim (1 = first). */
  attempts: number;
}

interface ClaimRow extends StreamRow {
  attempts: number;
}

/**
 * Lease up to `limit` stream events that still need publishing. One
 * statement: the inner `FOR UPDATE SKIP LOCKED` keeps concurrent claimers off
 * the same rows while the lease is written, and the lease keeps them off
 * until it expires. `ids` restricts the claim (fast path after a flush).
 */
export async function claimEventsForPublish(input: {
  leaseToken: string;
  leaseMs: number;
  limit: number;
  ids?: bigint[];
}): Promise<ClaimedEvent[]> {
  const restrict = input.ids && input.ids.length > 0
    ? Prisma.sql`AND id = ANY(${input.ids}::bigint[])`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<ClaimRow[]>`
    UPDATE domain_events AS e
    SET lease_owner = ${input.leaseToken},
        lease_expires_at = ${NOW_UTC} + make_interval(secs => ${input.leaseMs}::double precision / 1000),
        attempts = e.attempts + 1
    WHERE e.id IN (
      SELECT id FROM domain_events
      WHERE published_at IS NULL
        AND dead_lettered_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${NOW_UTC})
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${NOW_UTC})
        ${restrict}
      ORDER BY id
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING ${STREAM_COLUMNS}, attempts
  `;
  return rows
    .map((row) => ({ ...fromStreamRow(row), attempts: row.attempts }))
    .sort(byId);
}

/** Mark published. Fenced: only rows still leased under `leaseToken` change. */
export async function ackPublished(ids: bigint[], leaseToken: string): Promise<number> {
  if (ids.length === 0) return 0;
  return prisma.$executeRaw`
    UPDATE domain_events
    SET published_at = ${NOW_UTC}, lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = NULL, last_error = NULL
    WHERE id = ANY(${ids}::bigint[]) AND lease_owner = ${leaseToken}
  `;
}

/**
 * Release a failed claim: schedule a retry after `retryInMs`, or dead-letter
 * it when `retryInMs` is null. Fenced like `ackPublished`.
 */
export async function releaseFailedClaim(input: {
  id: bigint;
  leaseToken: string;
  error: string;
  retryInMs: number | null;
}): Promise<number> {
  const dead = input.retryInMs === null;
  const delayMs = input.retryInMs ?? 0;
  return prisma.$executeRaw`
    UPDATE domain_events
    SET lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = ${input.error.slice(0, 2000)},
        next_attempt_at = CASE WHEN ${dead}::boolean THEN NULL
                               ELSE ${NOW_UTC} + make_interval(secs => ${delayMs}::double precision / 1000) END,
        dead_lettered_at = CASE WHEN ${dead}::boolean THEN ${NOW_UTC} ELSE NULL END
    WHERE id = ${input.id} AND lease_owner = ${input.leaseToken}
  `;
}

export interface DeadLetteredEvent {
  id: bigint;
  type: string;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: Date;
  occurredAt: Date;
}

/** Dead-lettered events, newest first (queryable state for operators). */
export async function listDeadLetteredEvents(limit = 100): Promise<DeadLetteredEvent[]> {
  const rows = await prisma.domainEvent.findMany({
    where: { deadLetteredAt: { not: null } },
    orderBy: { id: 'desc' },
    take: Math.min(Math.max(limit, 1), 1000),
    select: { id: true, type: true, attempts: true, lastError: true, deadLetteredAt: true, occurredAt: true },
  });
  return rows.flatMap((row) => (row.deadLetteredAt
    ? [{
        id: row.id,
        type: row.type,
        attempts: row.attempts,
        lastError: row.lastError,
        deadLetteredAt: row.deadLetteredAt,
        occurredAt: row.occurredAt,
      }]
    : []));
}

/** Put dead-lettered events back in the publish queue with a fresh budget. */
export async function requeueDeadLetteredEvents(ids: bigint[]): Promise<number> {
  if (ids.length === 0) return 0;
  return prisma.$executeRaw`
    UPDATE domain_events
    SET dead_lettered_at = NULL, attempts = 0, next_attempt_at = NULL, last_error = NULL,
        lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ANY(${ids}::bigint[]) AND dead_lettered_at IS NOT NULL
  `;
}

export interface OutboxHealth {
  pending: number;
  oldestPendingAt: Date | null;
  unpublished: number;
  retrying: number;
  deadLettered: number;
  head: bigint;
  prunedThroughId: bigint;
}

/** Counters for dashboards/alerts (outbox lag, stuck or dead events). */
export async function readOutboxHealth(): Promise<OutboxHealth> {
  const [pending, oldest, unpublished, retrying, deadLettered, head, retention] = await Promise.all([
    prisma.domainEventOutbox.count(),
    prisma.domainEventOutbox.findFirst({ orderBy: { id: 'asc' }, select: { createdAt: true } }),
    prisma.domainEvent.count({ where: { publishedAt: null, deadLetteredAt: null } }),
    prisma.domainEvent.count({ where: { publishedAt: null, deadLetteredAt: null, attempts: { gt: 0 } } }),
    prisma.domainEvent.count({ where: { deadLetteredAt: { not: null } } }),
    readStreamHead(),
    prisma.domainEventRetention.findUnique({ where: { id: 1 }, select: { prunedThroughId: true } }),
  ]);
  return {
    pending,
    oldestPendingAt: oldest?.createdAt ?? null,
    unpublished,
    retrying,
    deadLettered,
    head,
    prunedThroughId: retention?.prunedThroughId ?? 0n,
  };
}

// ─── Retention ───────────────────────────────────────────────────────────────

/**
 * Delete stream events sequenced before `cutoff` and advance the retention
 * watermark in the same transaction, so replay can report truncation.
 * Bounded per batch; returns the number of deleted events.
 */
export async function pruneStream(cutoff: Date, batchSize = 5_000): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await prisma.$transaction(async (tx) => {
      const rows = await tx.domainEvent.findMany({
        where: { createdAt: { lte: cutoff } },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true },
      });
      if (rows.length === 0) return 0;
      const ids = rows.map((row) => row.id);
      let max = 0n;
      for (const id of ids) if (id > max) max = id;
      const result = await tx.domainEvent.deleteMany({ where: { id: { in: ids } } });
      await tx.$executeRaw`
        INSERT INTO domain_event_retention (id, pruned_through_id, updated_at)
        VALUES (1, ${max}, ${NOW_UTC})
        ON CONFLICT (id) DO UPDATE
        SET pruned_through_id = GREATEST(domain_event_retention.pruned_through_id, EXCLUDED.pruned_through_id),
            updated_at = EXCLUDED.updated_at
      `;
      return result.count;
    }, { timeout: 60_000, maxWait: 5_000 });
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

/** Highest stream id removed by retention (0 when nothing was pruned). */
export async function readPrunedThroughId(): Promise<bigint> {
  const row = await prisma.domainEventRetention.findUnique({ where: { id: 1 }, select: { prunedThroughId: true } });
  return row?.prunedThroughId ?? 0n;
}
