/**
 * Event targets for transactional appends (W04b).
 *
 * Mirrors the routing audience and W02a resource binding that the `sse.ts`
 * broadcast helpers compute, but reads through the caller's transaction
 * client, so an event about rows created in the same transaction resolves
 * correctly and no second pool connection is needed while the transaction
 * holds one. `__tests__/outbox.transactional.test.ts` asserts parity with
 * the `sse.ts` helpers; keep the two in step (or make `sse.ts` delegate
 * here).
 *
 *   user       → audience { userIds: [userId] },            binding user
 *   workspace  → audience { workspaceIds: [workspaceId] },  binding workspace
 *   team       → audience { teamIds: [teamId] },            binding team (+ its project/workspace)
 *   project    → audience workspace + teams + full/view grantees, binding project
 *   task       → project binding when it has a project, else team, else creator
 */
import type { prisma, Prisma } from '@openlinear/db';
import { appendDomainEvent } from './outbox';
import type { DomainEventAudience, DomainEventResource, PendingDomainEvent } from './types';

type Db = Prisma.TransactionClient | typeof prisma;

export interface EventTarget {
  audience: DomainEventAudience;
  resource: DomainEventResource;
}

export function userTarget(userId: string): EventTarget {
  return { audience: { userIds: [userId] }, resource: { type: 'user' } };
}

export function workspaceTarget(workspaceId: string): EventTarget {
  return { audience: { workspaceIds: [workspaceId] }, resource: { type: 'workspace', workspaceId } };
}

export async function teamTarget(db: Db, teamId: string): Promise<EventTarget> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { projectId: true, project: { select: { workspaceId: true } } },
  });
  return {
    audience: { teamIds: [teamId] },
    resource: {
      type: 'team',
      projectId: team?.projectId ?? null,
      workspaceId: team?.project.workspaceId ?? null,
    },
  };
}

/** Null when the project does not exist (nothing to deliver). */
export async function projectTarget(db: Db, projectId: string): Promise<EventTarget | null> {
  const project = await db.project.findUnique({
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
  if (!project) return null;
  return {
    audience: {
      workspaceIds: project.workspaceId ? [project.workspaceId] : [],
      teamIds: project.teams.map((team) => team.id),
      userIds: project.access.map((row) => row.userId),
    },
    resource: { type: 'project', projectId, workspaceId: project.workspaceId },
  };
}

export interface TaskTargetSubject {
  projectId?: string | null;
  teamId?: string | null;
  creatorId?: string | null;
}

/** Null when nobody can be authorized (no project, team or creator). */
export async function taskTarget(db: Db, task: TaskTargetSubject): Promise<EventTarget | null> {
  let resource: DomainEventResource | null = null;
  if (task.projectId) {
    const project = await db.project.findUnique({
      where: { id: task.projectId },
      select: { workspaceId: true },
    });
    resource = { type: 'project', projectId: task.projectId, workspaceId: project?.workspaceId ?? null };
  } else if (task.teamId) {
    const team = await db.team.findUnique({
      where: { id: task.teamId },
      select: { projectId: true, project: { select: { workspaceId: true } } },
    });
    resource = { type: 'team', projectId: team?.projectId ?? null, workspaceId: team?.project.workspaceId ?? null };
  } else if (task.creatorId) {
    resource = { type: 'user' };
  }
  if (!resource) return null;
  const audience: DomainEventAudience = task.teamId
    ? { teamIds: [task.teamId] }
    : { userIds: task.creatorId ? [task.creatorId] : [] };
  return { audience, resource };
}

/**
 * The task's team when it has one, else a single user. Matches the
 * `teamId ? broadcastToTeam : broadcastToUser` routing used for comment and
 * task deletion events.
 */
export async function teamOrUserTarget(db: Db, teamId: string | null | undefined, userId: string): Promise<EventTarget> {
  return teamId ? teamTarget(db, teamId) : userTarget(userId);
}

/** Append `type`/`payload` to a resolved target; no-op for a null target. */
export async function appendToTarget(
  db: Db,
  target: EventTarget | null,
  type: string,
  payload: unknown,
  actorId?: string | null,
): Promise<PendingDomainEvent | null> {
  if (!target) return null;
  return appendDomainEvent(db, {
    type,
    payload,
    actorId: actorId ?? null,
    audience: target.audience,
    resource: target.resource,
    workspaceId: target.resource.workspaceId ?? null,
  });
}
