export interface DomainEventAudience {
  userIds?: string[];
  teamIds?: string[];
  workspaceIds?: string[];
  /** Local-only fan-out (OpenCode status). Never persisted to the outbox. */
  all?: boolean;
}

export interface DomainEventInput {
  type: string;
  payload: unknown;
  actorId?: string | null;
  workspaceId?: string | null;
  audience: DomainEventAudience;
}

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
  publishedAt: Date | null;
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
}

export const DOMAIN_EVENTS_CHANNEL = 'ol:domain-events';

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
  };
}

export function parseWireEvent(raw: string): WireDomainEvent | null {
  try {
    const parsed = JSON.parse(raw) as WireDomainEvent;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
