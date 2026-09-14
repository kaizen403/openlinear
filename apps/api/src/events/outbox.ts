import { prisma, type Prisma } from '@openlinear/db';
import { logger } from '../logger';
import { getEventBus } from './bus';
import { deliverToLocalClients } from './hub';
import type { DomainEventInput, PersistedDomainEvent, WireDomainEvent } from './types';
import { toWireEvent } from './types';

type Db = Prisma.TransactionClient | typeof prisma;

function jsonPayload(payload: unknown): Prisma.InputJsonValue {
  try {
    return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
  } catch {
    return { unserializable: true };
  }
}

function toCreateData(input: DomainEventInput): Prisma.DomainEventCreateInput {
  return {
    type: input.type,
    actorId: input.actorId ?? null,
    workspaceId: input.workspaceId ?? input.audience.workspaceIds?.[0] ?? null,
    payload: jsonPayload(input.payload),
    userIds: input.audience.userIds ?? [],
    teamIds: input.audience.teamIds ?? [],
    workspaceIds: input.audience.workspaceIds ?? [],
  };
}

function toPersisted(row: {
  id: bigint;
  type: string;
  occurredAt: Date;
  actorId: string | null;
  workspaceId: string | null;
  payload: Prisma.JsonValue;
  userIds: string[];
  teamIds: string[];
  workspaceIds: string[];
  publishedAt: Date | null;
}): PersistedDomainEvent {
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
    publishedAt: row.publishedAt,
  };
}

/** Insert an outbox row inside the caller's transaction. The relay (or a
 * post-commit `publishOutboxEvent`) fans it out. */
export async function emitOutbox(tx: Db, input: DomainEventInput): Promise<PersistedDomainEvent> {
  const row = await tx.domainEvent.create({ data: toCreateData(input) });
  return toPersisted(row);
}

async function markPublished(id: bigint): Promise<void> {
  await prisma.domainEvent.update({
    where: { id },
    data: { publishedAt: new Date() },
  });
}

export async function publishOutboxEvent(event: PersistedDomainEvent): Promise<void> {
  const wire = toWireEvent(event);
  const distributed = await getEventBus().publish(wire);
  if (!distributed) {
    deliverToLocalClients(wire);
  }
  try {
    await markPublished(event.id);
  } catch (err) {
    logger.warn({ err, id: event.id.toString() }, '[events] failed to mark outbox row published');
  }
}

/**
 * Fire-and-forget path for existing `broadcast*` callers that do not have a
 * transaction handle. Writes the outbox row, then publishes.
 */
export async function persistAndDeliver(input: DomainEventInput): Promise<PersistedDomainEvent | null> {
  if (input.audience.all) {
    return null;
  }
  if (process.env.OPENLINEAR_OUTBOX === '0') {
    deliverToLocalClients({
      id: '0',
      type: input.type,
      occurredAt: new Date().toISOString(),
      actorId: input.actorId ?? null,
      workspaceId: input.workspaceId ?? null,
      payload: input.payload,
      userIds: input.audience.userIds ?? [],
      teamIds: input.audience.teamIds ?? [],
      workspaceIds: input.audience.workspaceIds ?? [],
    });
    return null;
  }

  try {
    const row = await emitOutbox(prisma, input);
    await publishOutboxEvent(row);
    return { ...row, publishedAt: row.publishedAt ?? new Date() };
  } catch (err) {
    logger.warn({ err, type: input.type }, '[events] outbox persist failed; delivering locally');
    deliverToLocalClients({
      id: '0',
      type: input.type,
      occurredAt: new Date().toISOString(),
      actorId: input.actorId ?? null,
      workspaceId: input.workspaceId ?? null,
      payload: input.payload,
      userIds: input.audience.userIds ?? [],
      teamIds: input.audience.teamIds ?? [],
      workspaceIds: input.audience.workspaceIds ?? [],
    });
    return null;
  }
}

export async function replaySince(
  lastId: bigint,
  audience: { userId: string; teamIds: string[]; workspaceIds: string[] },
  limit = 200,
): Promise<PersistedDomainEvent[]> {
  const or: Prisma.DomainEventWhereInput[] = [
    { userIds: { has: audience.userId } },
  ];
  if (audience.teamIds.length > 0) {
    or.push({ teamIds: { hasSome: audience.teamIds } });
  }
  if (audience.workspaceIds.length > 0) {
    or.push({ workspaceIds: { hasSome: audience.workspaceIds } });
  }

  const rows = await prisma.domainEvent.findMany({
    where: {
      id: { gt: lastId },
      publishedAt: { not: null },
      OR: or,
    },
    orderBy: { id: 'asc' },
    take: limit,
  });
  return rows.map(toPersisted);
}

export async function claimUnpublished(limit = 50): Promise<PersistedDomainEvent[]> {
  const rows = await prisma.$queryRaw<Array<{
    id: bigint;
    type: string;
    occurred_at: Date;
    actor_id: string | null;
    workspace_id: string | null;
    payload: Prisma.JsonValue;
    user_ids: string[];
    team_ids: string[];
    workspace_ids: string[];
    published_at: Date | null;
  }>>`
    SELECT id, type, occurred_at, actor_id, workspace_id, payload, user_ids, team_ids, workspace_ids, published_at
    FROM domain_events
    WHERE published_at IS NULL
    ORDER BY id
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `;

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    workspaceId: row.workspace_id,
    payload: row.payload,
    userIds: row.user_ids,
    teamIds: row.team_ids,
    workspaceIds: row.workspace_ids,
    publishedAt: row.published_at,
  }));
}

export function parseLastEventId(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const value = BigInt(raw.trim());
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}

export type { WireDomainEvent };
