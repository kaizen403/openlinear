import { Response } from 'express';
import { prisma } from '@openlinear/db';
import { logger } from './logger';

export interface SSEClient {
  id: string;
  res: Response;
  userId: string;
  teamIds: string[];
  workspaceIds: string[];
}

export const clients: Map<string, SSEClient> = new Map();

function safeWrite(client: SSEClient, message: string): boolean {
  if (client.res.writableEnded) return false;
  try {
    client.res.write(message);
    return true;
  } catch (err) {
    // Connection broken — remove client and let cleanup logic re-fire on the
    // request lifecycle hooks. We log at debug to avoid noise on routine
    // disconnects.
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

function formatMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Broadcast to every connected client (system-wide events only — e.g.
 * `opencode:status`). Avoid for any user-scoped data.
 */
export function broadcastToAll(event: string, data: unknown): void {
  const message = formatMessage(event, data);
  clients.forEach((client) => {
    safeWrite(client, message);
  });
}

export const broadcast = broadcastToAll;


/**
 * Send to every SSE connection currently held by `userId`.
 */
export function broadcastToUser(userId: string, event: string, data: unknown): void {
  const message = formatMessage(event, data);
  clients.forEach((client) => {
    if (client.userId === userId) {
      safeWrite(client, message);
    }
  });
}

/**
 * Send to every SSE connection whose owning user is a member of `teamId`.
 */
export function broadcastToTeam(teamId: string, event: string, data: unknown): void {
  const message = formatMessage(event, data);
  clients.forEach((client) => {
    if (client.teamIds.includes(teamId)) {
      safeWrite(client, message);
    }
  });
}

/**
 * Send to every SSE connection whose owning user is a member of `workspaceId`.
 */
export function broadcastToWorkspace(workspaceId: string, event: string, data: unknown): void {
  const message = formatMessage(event, data);
  clients.forEach((client) => {
    if (client.workspaceIds.includes(workspaceId)) {
      safeWrite(client, message);
    }
  });
}

export async function broadcastToProject(
  projectId: string,
  event: string,
  data: unknown,
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspaceId: true,
      teams: { select: { id: true } },
      access: {
        where: { permission: { in: ['full', 'view'] } },
        select: { userId: true },
      },
    },
  });
  if (!project) return;
  if (project.workspaceId) {
    broadcastToWorkspace(project.workspaceId, event, data);
  }
  for (const team of project.teams) {
    broadcastToTeam(team.id, event, data);
  }
  for (const access of project.access) {
    broadcastToUser(access.userId, event, data);
  }
}

/**
 * Convenience wrapper for task-scoped events: routes to the team if the task
 * has one, otherwise falls back to the creator (per T1 schema, `creatorId` is
 * always populated for new tasks; legacy rows without a creator are dropped).
 *
 * `task` may be the flattened task object as returned by the API.
 */
export function broadcastToTask(
  event: string,
  task: { teamId?: string | null; creatorId?: string | null; [k: string]: unknown },
  payload?: unknown,
): void {
  const data = payload ?? task;
  if (task.teamId) {
    broadcastToTeam(task.teamId, event, data);
    return;
  }
  if (task.creatorId) {
    broadcastToUser(task.creatorId, event, data);
    return;
  }
  // No ownership info — drop the event rather than leak it. This matches the
  // T7 ownership posture: no recipient identifiable means "do not deliver".
  logger.warn(
    { event, taskId: (task as { id?: unknown }).id },
    '[SSE] task event has no teamId or creatorId; dropping',
  );
}

/**
 * Look up a task's ownership and route a broadcast accordingly. Used by
 * sidecar code paths that only have a taskId (execution + batch progress).
 */
export async function broadcastToTaskById(
  taskId: string,
  event: string,
  data: unknown,
): Promise<void> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { teamId: true, creatorId: true },
    });
    if (!task) {
      logger.debug({ taskId, event }, '[SSE] task not found for broadcast; dropping');
      return;
    }
    broadcastToTask(event, { ...task, id: taskId }, data);
  } catch (err) {
    logger.warn({ err, taskId, event }, '[SSE] failed to resolve task for broadcast');
  }
}

export async function broadcastToChatSession(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<void> {
  try {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, workspaceId: true },
    });
    if (!session) return;

    const message = formatMessage(event, data);
    clients.forEach((client) => {
      if (client.userId === session.userId && client.workspaceIds.includes(session.workspaceId)) {
        safeWrite(client, message);
      }
    });
  } catch (err) {
    logger.warn({ err, sessionId, event }, '[SSE] failed to resolve chat session for broadcast');
  }
}

export function sendToClient(clientId: string, event: string, data: unknown): boolean {
  const client = clients.get(clientId);
  if (!client) return false;
  return safeWrite(client, formatMessage(event, data));
}

export function getClientCount(): number {
  return clients.size;
}
