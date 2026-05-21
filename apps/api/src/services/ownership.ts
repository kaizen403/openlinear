import { prisma } from '@openlinear/db';
import { getUserTeamIds } from './team-scope';
import {
  ProjectAccessSource,
  ProjectPermissionLevel,
  permissionAllows,
  resolveProjectAccess,
} from './workspaces';

export type OwnershipResourceType =
  | 'task'
  | 'project'
  | 'team'
  | 'comment'
  | 'label'
  | 'user'
  | 'workspace';

export type OwnershipReason =
  | 'not_found'
  | 'forbidden'
  | 'role_required';

/**
 * Single typed error raised by every ownership assertion. The global error
 * middleware in app.ts maps this to a 403 response shaped as
 * `{ error:'forbidden', code:'OWNERSHIP_REQUIRED', resourceType, resourceId }`.
 *
 * `reason` is internal-only (logged but not echoed to clients) so we don't
 * leak which resource exists vs which one a user lacks access to.
 */
export class OwnershipError extends Error {
  readonly code = 'OWNERSHIP_REQUIRED' as const;
  constructor(
    public readonly resourceType: OwnershipResourceType,
    public readonly resourceId: string,
    public readonly reason: OwnershipReason,
    public readonly requiredRoles?: ReadonlyArray<string>,
  ) {
    super(
      `OwnershipError: ${reason} on ${resourceType} ${resourceId}` +
        (requiredRoles?.length ? ` (required: ${requiredRoles.join(',')})` : ''),
    );
    this.name = 'OwnershipError';
  }
}

export function isOwnershipError(err: unknown): err is OwnershipError {
  return err instanceof OwnershipError;
}

export interface OwnedTask {
  id: string;
  teamId: string | null;
  projectId: string | null;
  archived: boolean;
  status: string;
}

/**
 * Tasks with no `teamId` are legacy/personal tasks accessible to any
 * authenticated user (backward compat). Project-scoped tasks use the new
 * project/workspace ACL when present; otherwise team membership remains the
 * fallback. Returns the task so callers don't refetch.
 */
export async function assertTaskAccess(
  taskId: string,
  userId: string,
  requiredPermission: ProjectPermissionLevel = 'view',
): Promise<OwnedTask> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      teamId: true,
      projectId: true,
      archived: true,
      status: true,
    },
  });

  if (!task) {
    throw new OwnershipError('task', taskId, 'not_found');
  }

  if (task.projectId) {
    await assertProjectAccess(task.projectId, userId, requiredPermission);
  } else if (task.teamId) {
    const teamIds = await getUserTeamIds(userId);
    if (!teamIds.includes(task.teamId)) {
      throw new OwnershipError('task', taskId, 'forbidden');
    }
  }

  return task;
}

export async function assertTaskOwned(
  taskId: string,
  userId: string,
): Promise<OwnedTask> {
  return assertTaskAccess(taskId, userId, 'full');
}

export interface OwnedProject {
  id: string;
  teamIds: string[];
  workspaceId: string | null;
  permission: ProjectPermissionLevel;
  source: ProjectAccessSource;
}

export async function assertProjectAccess(
  projectId: string,
  userId: string,
  requiredPermission: ProjectPermissionLevel = 'view',
): Promise<OwnedProject> {
  const access = await resolveProjectAccess(projectId, userId);
  if ('reason' in access) {
    throw new OwnershipError('project', projectId, access.reason);
  }

  if (!permissionAllows(access.permission, requiredPermission)) {
    throw new OwnershipError('project', projectId, 'forbidden');
  }

  return access;
}

export async function assertProjectOwned(
  projectId: string,
  userId: string,
): Promise<OwnedProject> {
  return assertProjectAccess(projectId, userId, 'full');
}

export async function assertProjectMember(
  projectId: string,
  userId: string,
): Promise<OwnedProject> {
  return assertProjectAccess(projectId, userId, 'view');
}

export type TeamRole = 'owner' | 'admin' | 'member';

/**
 * Throws OwnershipError('team', teamId, 'not_found') when the team doesn't
 * exist OR the user has no membership (collapsed to avoid existence-leaks).
 * Throws 'role_required' when membership exists but role is insufficient.
 */
export async function assertTeamRole(
  teamId: string,
  userId: string,
  roles: ReadonlyArray<TeamRole>,
): Promise<{ teamId: string; userId: string; role: TeamRole }> {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });

  if (!membership) {
    throw new OwnershipError('team', teamId, 'not_found');
  }

  if (!roles.includes(membership.role as TeamRole)) {
    throw new OwnershipError('team', teamId, 'role_required', roles);
  }

  return { teamId, userId, role: membership.role as TeamRole };
}

export interface OwnedComment {
  id: string;
  taskId: string;
  userId: string;
}

/**
 * Author OR a member of the comment's task team is allowed.
 * Consumed by T10 (comment edit/delete).
 */
export async function assertCommentOwned(
  commentId: string,
  userId: string,
): Promise<OwnedComment> {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      taskId: true,
      userId: true,
      task: { select: { teamId: true } },
    },
  });

  if (!comment) {
    throw new OwnershipError('comment', commentId, 'not_found');
  }

  if (comment.userId === userId) {
    return { id: comment.id, taskId: comment.taskId, userId: comment.userId };
  }

  if (comment.task?.teamId) {
    const teamIds = await getUserTeamIds(userId);
    if (teamIds.includes(comment.task.teamId)) {
      return { id: comment.id, taskId: comment.taskId, userId: comment.userId };
    }
  }

  throw new OwnershipError('comment', commentId, 'forbidden');
}
