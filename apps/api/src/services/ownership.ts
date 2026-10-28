import { prisma } from '@openlinear/db';
import { HttpError } from '../errors';
import { workspaceRestrictionFor } from '../tenancy/context';
import {
  type ProjectAccessSource,
  type ProjectPermissionLevel,
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

/**
 * Workspace binding of the request principal (W02a).
 *
 * A PAT created with a `workspaceId` may only reach resources inside that
 * workspace. Applies only when `userId` is the bound principal, so checks
 * about other users (mention recipients, assignees) are unaffected.
 */
export function assertPrincipalWorkspace(
  userId: string,
  workspaceId: string | null,
  resourceType: OwnershipResourceType,
  resourceId: string,
): void {
  const restriction = workspaceRestrictionFor(userId);
  if (restriction && workspaceId !== restriction) {
    throw new OwnershipError(resourceType, resourceId, 'forbidden');
  }
}

/**
 * Actions that create or join a tenant boundary (new workspace, invitation,
 * team invite code) cannot be performed by a workspace-bound PAT outside its
 * workspace. `workspaceId` is the workspace being entered, or `null` for a
 * brand-new workspace.
 */
export function assertPrincipalMayEnterWorkspace(userId: string, workspaceId: string | null): void {
  const restriction = workspaceRestrictionFor(userId);
  if (restriction && workspaceId !== restriction) {
    throw new HttpError(
      403,
      'PAT_WORKSPACE_RESTRICTED',
      'This personal access token is bound to a single workspace',
      { workspaceId: restriction },
    );
  }
}

export interface OwnedTask {
  id: string;
  teamId: string | null;
  projectId: string | null;
  creatorId: string | null;
  archived: boolean;
  status: string;
}

interface TeamMembershipAccess {
  role: TeamRole;
  projectId: string;
  workspaceId: string | null;
  denied: boolean;
}

/**
 * Membership row plus the facts needed to apply project deny and PAT
 * workspace binding to team-scoped access, in one query.
 */
async function loadTeamMembershipAccess(
  teamId: string,
  userId: string,
): Promise<TeamMembershipAccess | null> {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: {
      role: true,
      team: {
        select: {
          projectId: true,
          project: {
            select: {
              workspaceId: true,
              access: { where: { userId, permission: 'deny' }, select: { id: true }, take: 1 },
            },
          },
        },
      },
    },
  });
  if (!membership) return null;
  return {
    role: membership.role as TeamRole,
    projectId: membership.team.projectId,
    workspaceId: membership.team.project.workspaceId,
    denied: membership.team.project.access.length > 0,
  };
}

/**
 * Resolve access to a task, denying by default.
 *
 * A task with neither `projectId` nor `teamId` used to match no branch here and
 * therefore fall through to "allowed" — readable and writable by ANY
 * authenticated user, across tenants. Such rows are not hypothetical:
 * `DELETE /api/projects/:id` produces them in bulk, because `Team.project` is
 * `onDelete: Cascade` while `Task.team` is `SetNull`.
 *
 * Unscoped tasks now fall back to their creator, and anything with no creator
 * either is denied outright. Team-only tasks inherit the team project's
 * explicit deny. Workspace-bound principals never reach orphan tasks or
 * another workspace's tasks. Returns the task so callers don't refetch.
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
      creatorId: true,
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
    const membership = await loadTeamMembershipAccess(task.teamId, userId);
    if (!membership || membership.denied) {
      throw new OwnershipError('task', taskId, 'forbidden');
    }
    assertPrincipalWorkspace(userId, membership.workspaceId, 'task', taskId);
  } else {
    // Orphaned task: no project and no team. Only its creator may reach it,
    // and it belongs to no workspace a bound PAT could be restricted to.
    if (!task.creatorId || task.creatorId !== userId) {
      throw new OwnershipError('task', taskId, 'forbidden');
    }
    assertPrincipalWorkspace(userId, null, 'task', taskId);
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

  assertPrincipalWorkspace(userId, access.workspaceId, 'project', projectId);

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
 * Throws 'forbidden' when the team's project explicitly denies the user or
 * the team is outside the principal's bound workspace, and 'role_required'
 * when membership exists but role is insufficient.
 */
export async function assertTeamRole(
  teamId: string,
  userId: string,
  roles: ReadonlyArray<TeamRole>,
): Promise<{ teamId: string; userId: string; role: TeamRole }> {
  const membership = await loadTeamMembershipAccess(teamId, userId);

  if (!membership) {
    throw new OwnershipError('team', teamId, 'not_found');
  }

  if (membership.denied) {
    throw new OwnershipError('team', teamId, 'forbidden');
  }

  assertPrincipalWorkspace(userId, membership.workspaceId, 'team', teamId);

  if (!roles.includes(membership.role)) {
    throw new OwnershipError('team', teamId, 'role_required', roles);
  }

  return { teamId, userId, role: membership.role };
}

export interface OwnedComment {
  id: string;
  taskId: string;
  userId: string;
}

export type CommentAction = 'update' | 'delete';

/**
 * Comment mutation policy (W02a).
 *
 * The caller must currently hold full permission on the comment's task
 * (explicit project deny, revoked membership and PAT workspace binding all
 * apply). Then:
 *   - the author may update or delete their own comment;
 *   - a team owner/admin of the task's team may delete others' comments.
 *
 * Authorship alone no longer survives losing access to the task.
 */
export async function assertCommentAccess(
  commentId: string,
  userId: string,
  action: CommentAction,
): Promise<OwnedComment & { task: OwnedTask }> {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, taskId: true, userId: true },
  });

  if (!comment) {
    throw new OwnershipError('comment', commentId, 'not_found');
  }

  let task: OwnedTask;
  try {
    task = await assertTaskAccess(comment.taskId, userId, 'full');
  } catch (err) {
    if (isOwnershipError(err)) {
      throw new OwnershipError('comment', commentId, err.reason === 'not_found' ? 'not_found' : 'forbidden');
    }
    throw err;
  }

  const owned = { id: comment.id, taskId: comment.taskId, userId: comment.userId, task };
  if (comment.userId === userId) {
    return owned;
  }

  if (action === 'delete' && task.teamId) {
    try {
      await assertTeamRole(task.teamId, userId, ['owner', 'admin']);
      return owned;
    } catch (err) {
      if (!isOwnershipError(err)) throw err;
    }
  }

  throw new OwnershipError('comment', commentId, 'forbidden');
}

/**
 * @deprecated Use `assertCommentAccess`. Kept for import compatibility; it now
 * applies the strict delete policy (current task access + author or team
 * owner/admin) instead of "author or any team member".
 */
export async function assertCommentOwned(
  commentId: string,
  userId: string,
): Promise<OwnedComment> {
  const owned = await assertCommentAccess(commentId, userId, 'delete');
  return { id: owned.id, taskId: owned.taskId, userId: owned.userId };
}

/**
 * Users among `userIds` who can currently view `taskId`. Used to drop
 * notification recipients (for example @mentions) who would otherwise receive
 * task or comment content they are not allowed to read.
 */
export async function filterUsersWithTaskAccess(taskId: string, userIds: readonly string[]): Promise<string[]> {
  const allowed: string[] = [];
  for (const candidate of userIds) {
    try {
      await assertTaskAccess(taskId, candidate, 'view');
      allowed.push(candidate);
    } catch (err) {
      if (!isOwnershipError(err)) throw err;
    }
  }
  return allowed;
}
