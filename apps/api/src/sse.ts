import { prisma } from '@openlinear/db';
import { logger } from './logger';
import {
  clients,
  deliverToAllLocal,
  formatSseMessage,
} from './events/hub';
import { persistAndDeliver } from './events/outbox';
import type { DomainEventAudience, DomainEventResource } from './events/types';

export { clients, getClientCount, type SSEClient } from './events/hub';
export { startEventBus, stopEventBus } from './events/bus';
export { startOutboxRelay, stopOutboxRelay, startRealtime } from './events/relay';
export { emitOutbox, persistAndDeliver } from './events/outbox';

/**
 * Every persisted event carries a resource binding (W02a). The audience only
 * routes; delivery and Last-Event-ID replay authorize each subscriber against
 * the binding with their current principal, so an explicit project deny or a
 * removed membership is honored on live streams too.
 */
function enqueue(
  type: string,
  payload: unknown,
  audience: DomainEventAudience,
  resource?: DomainEventResource,
): void {
  if (audience.all) {
    deliverToAllLocal(type, payload);
    return;
  }
  void persistAndDeliver({
    type,
    payload,
    audience,
    resource,
    workspaceId: resource?.workspaceId ?? null,
  }).catch((err: unknown) => {
    logger.warn({ err, type }, '[SSE] persistAndDeliver failed');
  });
}

export function broadcastToAll(event: string, data: unknown): void {
  enqueue(event, data, { all: true });
}

export const broadcast = broadcastToAll;

export function broadcastToUser(userId: string, event: string, data: unknown): void {
  enqueue(event, data, { userIds: [userId] }, { type: 'user' });
}

async function emitTeamEvent(teamId: string, event: string, data: unknown): Promise<void> {
  let projectId: string | null = null;
  let workspaceId: string | null = null;
  try {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { projectId: true, project: { select: { workspaceId: true } } },
    });
    projectId = team?.projectId ?? null;
    workspaceId = team?.project.workspaceId ?? null;
  } catch (err) {
    logger.warn({ err, teamId, event }, '[SSE] failed to resolve team binding');
  }
  enqueue(event, data, { teamIds: [teamId] }, { type: 'team', projectId, workspaceId });
}

/** Current team members, minus anyone explicitly denied on the team's project. */
export function broadcastToTeam(teamId: string, event: string, data: unknown): void {
  void emitTeamEvent(teamId, event, data);
}

export function broadcastToWorkspace(workspaceId: string, event: string, data: unknown): void {
  enqueue(event, data, { workspaceIds: [workspaceId] }, { type: 'workspace', workspaceId });
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
  enqueue(
    event,
    data,
    {
      workspaceIds: project.workspaceId ? [project.workspaceId] : [],
      teamIds: project.teams.map((team) => team.id),
      userIds: project.access.map((row) => row.userId),
    },
    { type: 'project', projectId, workspaceId: project.workspaceId },
  );
}

export interface TaskEventSubject {
  projectId?: string | null;
  teamId?: string | null;
  creatorId?: string | null;
}

/**
 * Resource binding for a task-scoped event, mirroring `assertTaskAccess`:
 * project tasks bind to their project, team-only tasks to the team, orphan
 * tasks to their creator. `null` when nobody can be authorized.
 */
export async function resolveTaskEventResource(task: TaskEventSubject): Promise<DomainEventResource | null> {
  if (task.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: task.projectId },
      select: { workspaceId: true },
    });
    return { type: 'project', projectId: task.projectId, workspaceId: project?.workspaceId ?? null };
  }
  if (task.teamId) {
    const team = await prisma.team.findUnique({
      where: { id: task.teamId },
      select: { projectId: true, project: { select: { workspaceId: true } } },
    });
    return { type: 'team', projectId: team?.projectId ?? null, workspaceId: team?.project.workspaceId ?? null };
  }
  if (task.creatorId) {
    return { type: 'user' };
  }
  return null;
}

async function emitTaskEvent(
  event: string,
  task: TaskEventSubject & { id?: unknown },
  data: unknown,
): Promise<void> {
  try {
    const resource = await resolveTaskEventResource(task);
    if (!resource) {
      logger.warn({ event, taskId: task.id }, '[SSE] task event has no teamId or creatorId; dropping');
      return;
    }
    const audience: DomainEventAudience = task.teamId
      ? { teamIds: [task.teamId] }
      : { userIds: task.creatorId ? [task.creatorId] : [] };
    enqueue(event, data, audience, resource);
  } catch (err) {
    logger.warn({ err, event, taskId: task.id }, '[SSE] failed to resolve task binding');
  }
}

export function broadcastToTask(
  event: string,
  task: { teamId?: string | null; creatorId?: string | null; [k: string]: unknown },
  payload?: unknown,
): void {
  const data = payload ?? task;
  const projectId = typeof task.projectId === 'string' ? task.projectId : null;
  if (!projectId && !task.teamId && !task.creatorId) {
    logger.warn(
      { event, taskId: (task as { id?: unknown }).id },
      '[SSE] task event has no teamId or creatorId; dropping',
    );
    return;
  }
  void emitTaskEvent(event, { id: task.id, projectId, teamId: task.teamId, creatorId: task.creatorId }, data);
}

export async function broadcastToTaskById(
  taskId: string,
  event: string,
  data: unknown,
): Promise<void> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { teamId: true, creatorId: true, projectId: true },
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

/**
 * Chat sessions are private to their owner (every chat read requires
 * `session.userId === caller`), so session events go to the owner only. They
 * previously fanned out to the whole workspace.
 */
export async function broadcastToChatSession(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<void> {
  try {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!session) return;
    enqueue(event, data, { userIds: [session.userId] }, { type: 'user' });
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
