import { z } from 'zod';
import type { EventResourceType } from '../tenancy/visibility';

export interface DomainEventAudience {
  userIds?: string[];
  teamIds?: string[];
  workspaceIds?: string[];
  /** Local-only fan-out (OpenCode status). Never persisted to the outbox. */
  all?: boolean;
}

/**
 * Authorization binding of an event (W02a). The audience is only a routing
 * hint; live delivery and replay evaluate this binding against each
 * subscriber's current principal. Omitted = legacy/unbound: delivered only to
 * explicitly addressed `userIds`.
 */
export interface DomainEventResource {
  type: EventResourceType;
  /** Project of `project` events, or the team's project for `team` events. */
  projectId?: string | null;
  /** Workspace of that project (or of a `workspace` event). */
  workspaceId?: string | null;
}

export interface DomainEventInput {
  type: string;
  payload: unknown;
  actorId?: string | null;
  workspaceId?: string | null;
  audience: DomainEventAudience;
  resource?: DomainEventResource;
}

/** A row appended to `domain_event_outbox`, not yet part of the stream. */
export interface PendingDomainEvent {
  outboxId: bigint;
  type: string;
  occurredAt: Date;
}

/**
 * A stream event (`domain_events` row). `id` is its position in the ordered
 * stream and the SSE `id:` / Last-Event-ID.
 */
export interface PersistedDomainEvent {
  id: bigint;
  type: string;
  occurredAt: Date;
  actorId: string | null;
  workspaceId: string | null;
  payload: unknown;
  userIds: string[];
  teamIds: string[];
  workspaceIds: string[];
  resourceType: string | null;
  projectId: string | null;
  /** Relay bookkeeping: when the event was published to the fan-out bus. */
  publishedAt: Date | null;
  /** `domain_event_outbox.id` it was sequenced from; null for pre-W04b rows. */
  sourceId?: bigint | null;
}

export interface WireDomainEvent {
  id: string;
  type: string;
  occurredAt: string;
  actorId: string | null;
  workspaceId: string | null;
  payload: unknown;
  userIds: string[];
  teamIds: string[];
  workspaceIds: string[];
  /** Absent on pre-W02a wire events; treated as unbound. */
  resourceType?: string | null;
  projectId?: string | null;
}

export const DOMAIN_EVENTS_CHANNEL = 'ol:domain-events';

/**
 * SQLSTATE raised by the `domain_events_immutable` and
 * `domain_event_outbox_immutable` triggers (migration
 * 20261026020000_w04b_durable_outbox).
 */
export const EVENT_IMMUTABLE_SQLSTATE = 'OLI01';

export function toWireEvent(event: PersistedDomainEvent): WireDomainEvent {
  return {
    id: event.id.toString(),
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    actorId: event.actorId,
    workspaceId: event.workspaceId,
    payload: event.payload,
    userIds: event.userIds,
    teamIds: event.teamIds,
    workspaceIds: event.workspaceIds,
    resourceType: event.resourceType,
    projectId: event.projectId,
  };
}

const stringList = z.array(z.string());

/**
 * Bus messages are validated before they reach the SSE hub: the hub indexes
 * the audience arrays, and the consumer orders by `id`, so a malformed
 * message (wrong shape, non-numeric id) is dropped instead of crashing or
 * reordering delivery.
 */
const wireEventSchema = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  type: z.string().min(1),
  occurredAt: z.string(),
  actorId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  payload: z.unknown(),
  userIds: stringList,
  teamIds: stringList,
  workspaceIds: stringList,
  resourceType: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
});

export function parseWireEvent(raw: string): WireDomainEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = wireEventSchema.safeParse(parsed);
  if (!result.success) return null;
  return { ...result.data, payload: result.data.payload };
}

/** Stream position of a wire event, or null when it is not a stream event. */
export function wireEventPosition(event: WireDomainEvent): bigint | null {
  if (!/^[1-9][0-9]{0,18}$/.test(event.id)) return null;
  return BigInt(event.id);
}
