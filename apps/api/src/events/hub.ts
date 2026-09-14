import type { Response } from 'express';
import { prisma } from '@openlinear/db';
import { logger } from '../logger';
import type { PersistedDomainEvent, WireDomainEvent } from './types';
import { toWireEvent } from './types';

export const MAX_SSE_CONNECTIONS_PER_USER = 8;

export interface SSEClient {
  id: string;
  res: Response;
  userId: string;
  teamIds: string[];
  workspaceIds: string[];
  connectedAt: number;
}

export const clients: Map<string, SSEClient> = new Map();

const MEMBERSHIP_EVENTS = new Set([
  'workspace:member-added',
  'workspace:member-removed',
  'workspace:member-updated',
  'workspace:joined',
  'workspace:left',
  'team:member-added',
  'team:member-removed',
  'team:member-updated',
  'team:joined',
  'team:left',
  'project:access-changed',
]);

function safeWrite(client: SSEClient, message: string): boolean {
  if (client.res.writableEnded) return false;
  try {
    client.res.write(message);
    return true;
  } catch (err) {
    logger.debug({ err, clientId: client.id }, '[SSE] write failed; dropping client');
    clients.delete(client.id);
    try {
      client.res.end();
    } catch {
      // ignore
    }
    return false;
  }
}

export function formatSseMessage(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function evictExcessConnections(userId: string): void {
  const owned = [...clients.values()]
    .filter((c) => c.userId === userId)
    .sort((a, b) => a.connectedAt - b.connectedAt);
  while (owned.length >= MAX_SSE_CONNECTIONS_PER_USER) {
    const oldest = owned.shift();
    if (!oldest) break;
    clients.delete(oldest.id);
    try {
      oldest.res.end();
    } catch {
      // ignore
    }
  }
}

export function registerClient(client: SSEClient): void {
  evictExcessConnections(client.userId);
  clients.set(client.id, client);
}

export function unregisterClient(clientId: string): void {
  clients.delete(clientId);
}

function clientSees(client: SSEClient, event: { userIds: string[]; teamIds: string[]; workspaceIds: string[] }): boolean {
  if (event.userIds.includes(client.userId)) return true;
  if (event.teamIds.some((id) => client.teamIds.includes(id))) return true;
  if (event.workspaceIds.some((id) => client.workspaceIds.includes(id))) return true;
  return false;
}

export function deliverToLocalClients(event: WireDomainEvent | PersistedDomainEvent): void {
  const wire = 'occurredAt' in event && event.occurredAt instanceof Date
    ? toWireEvent(event as PersistedDomainEvent)
    : event as WireDomainEvent;
  const message = formatSseMessage(wire.type, wire.payload, wire.id);
  for (const client of [...clients.values()]) {
    if (clientSees(client, wire)) {
      safeWrite(client, message);
    }
  }

  if (MEMBERSHIP_EVENTS.has(wire.type)) {
    const userIds = new Set(wire.userIds);
    if (typeof (wire.payload as { userId?: unknown } | null)?.userId === 'string') {
      userIds.add((wire.payload as { userId: string }).userId);
    }
    for (const userId of userIds) {
      void refreshClientScope(userId);
    }
  }
}

export function deliverToAllLocal(event: string, data: unknown): void {
  const message = formatSseMessage(event, data);
  for (const client of [...clients.values()]) {
    safeWrite(client, message);
  }
}

export async function refreshClientScope(userId: string): Promise<void> {
  try {
    const [teams, workspaces] = await Promise.all([
      prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } }),
      prisma.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } }),
    ]);
    const teamIds = teams.map((t) => t.teamId);
    const workspaceIds = workspaces.map((w) => w.workspaceId);
    for (const client of clients.values()) {
      if (client.userId === userId) {
        client.teamIds = teamIds;
        client.workspaceIds = workspaceIds;
      }
    }
  } catch (err) {
    logger.warn({ err, userId }, '[SSE] failed to refresh client scope');
  }
}

export function getClientCount(): number {
  return clients.size;
}
