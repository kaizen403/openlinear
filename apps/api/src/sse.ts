import { prisma } from '@openlinear/db';
import { logger } from './logger';
import {
  clients,
  deliverToAllLocal,
  formatSseMessage,
  type SSEClient,
} from './events/hub';
import { persistAndDeliver } from './events/outbox';

export { clients, getClientCount, type SSEClient } from './events/hub';
export { startEventBus, stopEventBus } from './events/bus';
export { startOutboxRelay, stopOutboxRelay, startRealtime } from './events/relay';
export { emitOutbox, persistAndDeliver } from './events/outbox';

function enqueue(
  type: string,
  payload: unknown,
  audience: {
    userIds?: string[];
    teamIds?: string[];
    workspaceIds?: string[];
    all?: boolean;
  },
): void {
  if (audience.all) {
    deliverToAllLocal(type, payload);
    return;
  }
  void persistAndDeliver({ type, payload, audience }).catch((err: unknown) => {
    logger.warn({ err, type }, '[SSE] persistAndDeliver failed');
  });
}

export function broadcastToAll(event: string, data: unknown): void {
  enqueue(event, data, { all: true });
}

export const broadcast = broadcastToAll;

export function broadcastToUser(userId: string, event: string, data: unknown): void {
  enqueue(event, data, { userIds: [userId] });
}

export function broadcastToTeam(teamId: string, event: string, data: unknown): void {
  enqueue(event, data, { teamIds: [teamId] });
}

export function broadcastToWorkspace(workspaceId: string, event: string, data: unknown): void {
  enqueue(event, data, { workspaceIds: [workspaceId] });
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
  enqueue(event, data, {
    workspaceIds: project.workspaceId ? [project.workspaceId] : [],
    teamIds: project.teams.map((team) => team.id),
    userIds: project.access.map((row) => row.userId),
  });
}

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
  logger.warn(
    { event, taskId: (task as { id?: unknown }).id },
    '[SSE] task event has no teamId or creatorId; dropping',
  );
}

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
    enqueue(event, data, {
      userIds: [session.userId],
      workspaceIds: [session.workspaceId],
    });
  } catch (err) {
    logger.warn({ err, sessionId, event }, '[SSE] failed to resolve chat session for broadcast');
  }
}

export function sendToClient(clientId: string, event: string, data: unknown): boolean {
  const client = clients.get(clientId);
  if (!client) return false;
  if (client.res.writableEnded) return false;
  try {
    client.res.write(formatSseMessage(event, data));
    return true;
  } catch {
    return false;
  }
}
