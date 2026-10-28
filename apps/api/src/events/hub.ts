import type { Response } from 'express';
import { logger } from '../logger';
import { invalidateTenancyCache, onTenancyInvalidated, resolveTenancyContext } from '../tenancy/context';
import type { TenancyContext } from '../tenancy/types';
import { canReceiveEvent } from '../tenancy/visibility';
import type { PersistedDomainEvent, WireDomainEvent } from './types';
import { toWireEvent } from './types';

export const MAX_SSE_CONNECTIONS_PER_USER = 8;

/**
 * Events buffered per stream while its principal is being refreshed after a
 * membership change, or while its Last-Event-ID replay is running. Overflow
 * closes the stream; the client reconnects with Last-Event-ID and replays
 * under a freshly resolved principal.
 */
export const MAX_HELD_EVENTS_PER_CLIENT = 500;

/**
 * Internal signal (W02b): sessions were revoked. Addressed to the session
 * owner; every replica closes local streams opened by those sessions when it
 * delivers this event (`afterSessionsRevoked` → SSE route → here).
 */
export const SESSION_REVOKED_EVENT = 'session:revoked';

export interface SSEClient {
  id: string;
  res: Response;
  userId: string;
  /** Routing hint derived from `principal`. */
  teamIds: string[];
  /** Routing hint derived from `principal`. */
  workspaceIds: string[];
  connectedAt: number;
  /**
   * Current principal snapshot used to authorize every delivered event.
   * Clients without one receive only events explicitly addressed to them.
   */
  principal?: TenancyContext;
  /** Non-null while the principal is being refreshed or replay runs; events wait here. */
  held?: WireDomainEvent[] | null;
  /**
   * `Session.id` that opened the stream (directly with a bearer JWT, or by
   * minting the SSE ticket). Revoking that session closes the stream.
   * `null` for sessionless (test/legacy) streams.
   */
  sessionId?: string | null;
  /** True while Last-Event-ID replay is being written; live events are held. */
  replaying?: boolean;
  /** Highest outbox id the replay scanned; held live events at or below it are duplicates. */
  replayCursor?: bigint | null;
}

export const clients: Map<string, SSEClient> = new Map();

const MEMBERSHIP_EVENTS = new Set([
  'team:created',
  'workspace:member-added',
  'workspace:member-removed',
  'workspace:member-updated',
  'workspace:joined',
  'workspace:left',
  'workspace:deleted',
  'team:member-added',
  'team:member-removed',
  'team:member-updated',
  'team:joined',
  'team:left',
  'team:deleted',
  'project:access-changed',
]);

/** Loads a fresh, uncached principal for a stream's user. */
export type PrincipalResolver = (userId: string) => Promise<TenancyContext>;

const defaultResolver: PrincipalResolver = (userId) =>
  resolveTenancyContext({ userId, authSource: 'jwt', scopes: [] }, { bypassCache: true });

let principalResolver: PrincipalResolver = defaultResolver;

/** Test seam: override how stream principals are re-resolved. */
export function setPrincipalResolver(resolver: PrincipalResolver | null): void {
  principalResolver = resolver ?? defaultResolver;
}

const refreshGenerations = new Map<string, number>();

function dropClient(client: SSEClient): void {
  clients.delete(client.id);
  try {
    client.res.end();
  } catch {
    // ignore
  }
}

function safeWrite(client: SSEClient, message: string): boolean {
  if (client.res.writableEnded) return false;
  try {
    client.res.write(message);
    return true;
  } catch (err) {
    logger.debug({ err, clientId: client.id }, '[SSE] write failed; dropping client');
    dropClient(client);
    return false;
  }
}

export function formatSseMessage(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Cursor frame (W02b). An unnamed (`message`) event whose SSE id is the
 * highest outbox id the server scanned for this stream. It moves the client's
 * Last-Event-ID past rows the caller may not see, so a backlog of invisible
 * events can never pin the cursor (each reconnect would otherwise rescan the
 * same filtered page). Clients ignore its payload.
 */
export function formatCursorFrame(cursor: bigint): string {
  const id = cursor.toString();
  return `id: ${id}\ndata: ${JSON.stringify({ type: 'replay:cursor', cursor: id })}\n\n`;
}

export function evictExcessConnections(userId: string): void {
  const owned = [...clients.values()]
    .filter((c) => c.userId === userId)
    .sort((a, b) => a.connectedAt - b.connectedAt);
  while (owned.length >= MAX_SSE_CONNECTIONS_PER_USER) {
    const oldest = owned.shift();
    if (!oldest) break;
    dropClient(oldest);
  }
}

export function registerClient(client: SSEClient): void {
  evictExcessConnections(client.userId);
  clients.set(client.id, client);
}

export function unregisterClient(clientId: string): void {
  clients.delete(clientId);
}

/**
 * Close every local stream opened by one of `sessionIds` (optionally only
 * those of `userId`). Returns how many were closed.
 */
export function closeStreamsForSessions(sessionIds: Iterable<string>, userId?: string): number {
  const ids = new Set(sessionIds);
  if (ids.size === 0) return 0;
  let closed = 0;
  for (const client of [...clients.values()]) {
    if (!client.sessionId || !ids.has(client.sessionId)) continue;
    if (userId && client.userId !== userId) continue;
    logger.info({ clientId: client.id, userId: client.userId }, '[SSE] session revoked; closing stream');
    dropClient(client);
    closed += 1;
  }
  return closed;
}

/** Apply a principal snapshot to a stream and derive its routing hints. */
export function applyClientPrincipal(client: SSEClient, principal: TenancyContext): void {
  client.principal = principal;
  client.teamIds = [...principal.teams];
  client.workspaceIds = [...principal.workspaces.keys()];
}

function matchesRoutingHint(client: SSEClient, event: WireDomainEvent): boolean {
  if (event.userIds.includes(client.userId)) return true;
  if (event.teamIds.some((id) => client.teamIds.includes(id))) return true;
  return event.workspaceIds.some((id) => client.workspaceIds.includes(id));
}

/** The authorization decision for one stream and one event. */
export function clientCanReceive(client: SSEClient, event: WireDomainEvent): boolean {
  if (!client.principal) {
    return event.userIds.includes(client.userId);
  }
  return canReceiveEvent(client.principal, {
    resourceType: event.resourceType ?? null,
    projectId: event.projectId ?? null,
    workspaceId: event.workspaceId,
    userIds: event.userIds,
    teamIds: event.teamIds,
    workspaceIds: event.workspaceIds,
  });
}

function deliverOrHold(client: SSEClient, event: WireDomainEvent, message: string): void {
  if (client.held) {
    client.held.push(event);
    if (client.held.length > MAX_HELD_EVENTS_PER_CLIENT) {
      logger.warn({ clientId: client.id }, '[SSE] held-event buffer overflow; closing stream');
      dropClient(client);
    }
    return;
  }
  if (clientCanReceive(client, event)) {
    safeWrite(client, message);
  }
}

/** A held live event the replay already covered (delivered or filtered). */
function coveredByReplay(client: SSEClient, event: WireDomainEvent): boolean {
  const cursor = client.replayCursor;
  if (cursor === undefined || cursor === null) return false;
  if (!/^[1-9][0-9]*$/.test(event.id)) return false;
  return BigInt(event.id) <= cursor;
}

/** Deliver a stream's held events in order under its current principal. */
function flushHeld(client: SSEClient): void {
  const held = client.held ?? [];
  client.held = null;
  for (const event of held) {
    if (!clients.has(client.id)) break;
    if (coveredByReplay(client, event)) continue;
    if (clientCanReceive(client, event)) {
      safeWrite(client, formatSseMessage(event.type, event.payload, event.id));
    }
  }
}

/**
 * Hold live events for a stream while its Last-Event-ID replay is written,
 * so replayed (older) events are never interleaved after newer live ones.
 */
export function beginReplayHold(client: SSEClient): void {
  client.replaying = true;
  client.replayCursor = null;
  if (!client.held) client.held = [];
}

/**
 * End the replay hold. Held live events the replay already covered (id at or
 * below `cursor`) are dropped as duplicates; the rest are delivered in order,
 * unless a principal refresh is in flight, which then owns the flush.
 */
export function endReplayHold(client: SSEClient, cursor: bigint | null): void {
  client.replaying = false;
  client.replayCursor = cursor;
  if (!clients.has(client.id)) return;
  if (refreshGenerations.has(client.userId)) return;
  flushHeld(client);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Users whose memberships a membership/access event may have changed. */
function affectedUserIds(event: WireDomainEvent): Set<string> {
  const users = new Set(event.userIds);
  const payload = event.payload;
  if (isRecord(payload)) {
    for (const key of ['userId', 'targetUserId']) {
      const value = payload[key];
      if (typeof value === 'string') users.add(value);
    }
    const access = payload.access;
    const rows = Array.isArray(access) ? access : [access];
    for (const row of rows) {
      if (isRecord(row) && typeof row.userId === 'string') users.add(row.userId);
    }
  }
  return users;
}

function revokedSessionIds(event: WireDomainEvent): string[] {
  const payload = event.payload;
  if (!isRecord(payload) || !Array.isArray(payload.sessionIds)) return [];
  return payload.sessionIds.filter((id): id is string => typeof id === 'string');
}

export function deliverToLocalClients(event: WireDomainEvent | PersistedDomainEvent): void {
  const wire = 'occurredAt' in event && event.occurredAt instanceof Date
    ? toWireEvent(event as PersistedDomainEvent)
    : event as WireDomainEvent;
  const message = formatSseMessage(wire.type, wire.payload, wire.id);
  for (const client of [...clients.values()]) {
    deliverOrHold(client, wire, message);
  }

  if (wire.type === SESSION_REVOKED_EVENT) {
    // Cross-replica path: the revoking replica closed its own streams already.
    // Only the addressed owner's streams can be closed by this signal.
    for (const userId of wire.userIds) {
      closeStreamsForSessions(revokedSessionIds(wire), userId);
    }
  }

  if (MEMBERSHIP_EVENTS.has(wire.type)) {
    let users = affectedUserIds(wire);
    if (users.size === 0) {
      // No explicit subject (for example `workspace:deleted`): refresh every
      // stream the event was routed to.
      users = new Set(
        [...clients.values()].filter((client) => matchesRoutingHint(client, wire)).map((client) => client.userId),
      );
    }
    // Cross-process path: the membership event itself triggers the refresh
    // (through the invalidation listener registered below).
    for (const userId of users) {
      invalidateTenancyCache(userId);
    }
  }
}

export function deliverToAllLocal(event: string, data: unknown): void {
  const message = formatSseMessage(event, data);
  for (const client of [...clients.values()]) {
    safeWrite(client, message);
  }
}

/**
 * Re-resolve the principal of every open stream owned by `userId`.
 *
 * Delivery to those streams pauses until the fresh principal is applied, so
 * an event processed after a revocation is never authorized against the
 * pre-revocation snapshot. Held events are then evaluated in order. If the
 * principal cannot be resolved, the streams are closed (fail closed).
 */
export async function refreshClientScope(userId: string): Promise<void> {
  const generation = (refreshGenerations.get(userId) ?? 0) + 1;
  refreshGenerations.set(userId, generation);
  for (const client of clients.values()) {
    if (client.userId === userId && !client.held) client.held = [];
  }

  let fresh: TenancyContext;
  try {
    fresh = await principalResolver(userId);
  } catch (err) {
    if (refreshGenerations.get(userId) !== generation) return;
    refreshGenerations.delete(userId);
    logger.warn({ err, userId }, '[SSE] failed to refresh stream principal; closing streams');
    for (const client of [...clients.values()]) {
      if (client.userId === userId) dropClient(client);
    }
    return;
  }

  // A newer refresh started meanwhile; it owns the flush.
  if (refreshGenerations.get(userId) !== generation) return;
  refreshGenerations.delete(userId);

  for (const client of [...clients.values()]) {
    if (client.userId !== userId) continue;
    applyClientPrincipal(client, fresh);
    // A stream still writing its replay keeps holding; endReplayHold flushes.
    if (client.replaying) continue;
    flushHeld(client);
  }
}

/**
 * Periodic revalidation (heartbeat): replace one stream's principal without
 * pausing delivery. Bounds staleness for membership changes that emitted no
 * event (direct database edits, other processes without a shared bus).
 */
export async function revalidateClientPrincipal(clientId: string): Promise<boolean> {
  const client = clients.get(clientId);
  if (!client) return false;
  try {
    const fresh = await principalResolver(client.userId);
    if (!clients.has(clientId) || client.held) return clients.has(clientId);
    applyClientPrincipal(client, fresh);
    return true;
  } catch (err) {
    logger.warn({ err, clientId }, '[SSE] periodic principal revalidation failed; closing stream');
    dropClient(client);
    return false;
  }
}

export function getClientCount(): number {
  return clients.size;
}

// In-process path: membership mutations call `invalidateTenancyCache` right
// after committing, so affected streams start holding events before any
// later event can be emitted, then re-authorize under the fresh principal.
onTenancyInvalidated((userId) => {
  if (![...clients.values()].some((client) => client.userId === userId)) return;
  void refreshClientScope(userId);
});
