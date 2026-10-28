import { prisma, type Prisma, type Priority, type Status } from '@openlinear/db';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { HttpError, ValidationError } from '../errors';
import { decodeKeysetCursor, encodeKeysetCursor, type KeysetPosition } from '../lib/keyset';
import { likeLiteral } from '../lib/like';
import { bulkArchiveBodySchema } from '../schemas/tasks';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, projectTarget, taskTarget, teamOrUserTarget, teamTarget, userTarget, type EventTarget } from '../events/targets';
import { createNotification } from '../routes/notifications';
import { extractMentionedUsernames } from '../schemas/comments';
import { logActivity } from './activity';
import { dropDependenciesOnScopeChange, isResolvedTaskStatus, notifyUnblockedDependents, readTaskDependencies } from './task-dependencies';
import { runCommand, type IdempotentCommand } from './idempotency';
import { getUserTeamIds } from './team-scope';
import {
  assertProjectAccess,
  assertProjectOwned,
  assertTaskAccess,
  assertTaskOwned,
  assertTeamRole,
  filterUsersWithTaskAccess,
  OwnershipError,
} from './ownership';
import { resolvePrincipalForUser, workspaceRestrictionFor } from '../tenancy/context';
import { scopedProjectWhere, scopedTaskWhere, scopedTeamWhere } from '../tenancy/scopes';
import type { TenancyContext } from '../tenancy/types';

const labelSelect = { id: true, name: true, color: true, priority: true } as const;
const taskBaseInclude = {
  labels: { include: { label: true } },
  team: { select: { id: true, name: true, key: true, color: true } },
  project: { select: { id: true, name: true, status: true, color: true } },
  assignee: { select: { id: true, username: true, avatarUrl: true } },
  creator: { select: { id: true, username: true, avatarUrl: true } },
} satisfies Prisma.TaskInclude;

export const taskInclude = {
  ...taskBaseInclude,
  // W17a: blockers, flattened to `blockedByIds` + `openBlockerCount`.
  blockedBy: { select: { dependsOnTaskId: true, dependsOnTask: { select: { status: true } } } },
} satisfies Prisma.TaskInclude;

const commentAuthorSelect = { id: true, username: true, avatarUrl: true } as const;

type TaskWithInclude = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

type TaskLabelWithLabel = TaskWithInclude['labels'][number];

/** A blocker row as the include loads it (status as the enum's string). */
type TaskBlockerRow = { dependsOnTaskId: string; dependsOnTask: { status: string } };

export function flattenTaskLabels<T extends { labels: TaskLabelWithLabel[]; blockedBy: TaskBlockerRow[] }>(task: T): Omit<T, 'labels' | 'blockedBy'> & {
  labels: Array<TaskLabelWithLabel['label']>;
  blockedByIds: string[];
  openBlockerCount: number;
} {
  const { labels, blockedBy, ...rest } = task;
  return {
    ...rest,
    labels: labels.map((taskLabel) => taskLabel.label),
    blockedByIds: blockedBy.map((row) => row.dependsOnTaskId),
    openBlockerCount: blockedBy.filter((row) => !isResolvedTaskStatus(row.dependsOnTask.status)).length,
  };
}

export async function resolveProjectTeamId(projectId: string): Promise<string> {
  const team = await prisma.team.findFirst({
    where: { projectId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!team) {
    throw new ValidationError('Project must have a team');
  }
  return team.id;
}

/** The request principal (PAT scopes/workspace binding) when it is `userId`. */
async function tenancyForUser(userId: string): Promise<TenancyContext> {
  return resolvePrincipalForUser(userId);
}

async function buildTaskProjectAccessWhere(userId: string): Promise<Prisma.TaskWhereInput> {
  return scopedTaskWhere(await tenancyForUser(userId));
}

async function buildTaskProjectFullAccessWhere(userId: string): Promise<Prisma.TaskWhereInput> {
  return scopedTaskWhere(await tenancyForUser(userId), {}, 'full');
}

/** Above this many visible projects (or teams) the list falls back to the correlated form. */
export const TASK_VISIBILITY_ID_LIST_LIMIT = 500;

/**
 * Task visibility for list queries, as id sets (W14).
 *
 * Same rule as `scopedTaskWhere(ctx)` (view): a task is visible when its
 * project is visible, or it has no project and is on a team the caller
 * belongs to whose project does not deny them, or it is the caller's own
 * orphan (not for workspace-bound principals). The project and team rules
 * are evaluated once over the small `linear_projects`/`teams` tables and the
 * results passed as `IN` lists, instead of correlated EXISTS per task row
 * that Postgres cannot index: with the `(archived, createdAt, id)` index a
 * list without a project filter becomes an ordered index scan with a cheap
 * filter rather than a sort of every visible task.
 *
 * Callers with more than TASK_VISIBILITY_ID_LIST_LIMIT visible projects or
 * teams keep the correlated form (bounded parameter lists; C1 F-060).
 */
async function buildTaskListVisibilityWhere(userId: string): Promise<Prisma.TaskWhereInput> {
  const ctx = await tenancyForUser(userId);
  const teamIds = [...ctx.teams];
  const [projects, teams] = await Promise.all([
    prisma.project.findMany({
      where: scopedProjectWhere(ctx, 'view'),
      select: { id: true },
      take: TASK_VISIBILITY_ID_LIST_LIMIT + 1,
    }),
    teamIds.length > 0
      ? prisma.team.findMany({
          where: { AND: [{ id: { in: teamIds } }, scopedTeamWhere(ctx)] },
          select: { id: true },
          take: TASK_VISIBILITY_ID_LIST_LIMIT + 1,
        })
      : Promise.resolve([]),
  ]);
  if (projects.length > TASK_VISIBILITY_ID_LIST_LIMIT || teams.length > TASK_VISIBILITY_ID_LIST_LIMIT) {
    return scopedTaskWhere(ctx);
  }

  const branches: Prisma.TaskWhereInput[] = [];
  if (projects.length > 0) branches.push({ projectId: { in: projects.map((project) => project.id) } });
  if (teams.length > 0) branches.push({ projectId: null, teamId: { in: teams.map((team) => team.id) } });
  const restriction = ctx.workspaceRestriction ?? workspaceRestrictionFor(ctx.userId);
  if (!restriction) branches.push({ projectId: null, teamId: null, creatorId: ctx.userId });
  return branches.length > 0 ? { OR: branches } : { id: { in: [] } };
}

export async function listTasks(input: {
  userId: string;
  workspaceId?: string;
  projectId?: string;
  teamId?: string;
  assigneeId?: string;
  status?: Status;
  query?: string;
  limit?: number;
  cursor?: string;
}) {
  const userTeamIds = await getUserTeamIds(input.userId);
  const filters: Prisma.TaskWhereInput[] = [
    { archived: false },
    await buildTaskProjectAccessWhere(input.userId),
  ];

  if (input.workspaceId) {
    filters.push({ project: { workspaceId: input.workspaceId } });
  }
  if (input.projectId) {
    await assertProjectAccess(input.projectId, input.userId, 'view');
    filters.push({ projectId: input.projectId });
  }
  if (input.teamId) {
    if (!userTeamIds.includes(input.teamId)) {
      throw new OwnershipError('team', input.teamId, 'forbidden');
    }
    filters.push({ teamId: input.teamId });
  }
  if (input.assigneeId) filters.push({ assigneeId: input.assigneeId });
  if (input.status) filters.push({ status: input.status });
  if (input.query) {
    filters.push({
      OR: [
        { title: { contains: likeLiteral(input.query), mode: 'insensitive' } },
        { description: { contains: likeLiteral(input.query), mode: 'insensitive' } },
        { identifier: { contains: likeLiteral(input.query), mode: 'insensitive' } },
      ],
    });
  }

  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const tasks = await prisma.task.findMany({
    where: { AND: filters },
    include: taskInclude,
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = tasks.slice(0, limit);
  return {
    data: page.map(flattenTaskLabels),
    nextCursor: tasks.length > limit ? page.at(-1)?.id ?? null : null,
  };
}

const taskSummarySelect = { id: true, identifier: true, title: true, status: true } as const;

export async function getTask(input: { taskId: string; userId: string }) {
  await assertTaskAccess(input.taskId, input.userId, 'view');
  // W17a: blockers come from readTaskDependencies below (one statement for
  // both directions), not from a second relation load.
  const task = await prisma.task.findUnique({ where: { id: input.taskId }, include: taskBaseInclude });
  if (!task) {
    throw new OwnershipError('task', input.taskId, 'not_found');
  }
  // Additive (W14): the parent and the non-archived sub-issues the caller can
  // see, so agents need no list scan to walk the hierarchy.
  const visibility = await buildTaskProjectAccessWhere(input.userId);
  const [parent, subtasks, dependencies, planRows] = await Promise.all([
    task.parentId
      ? prisma.task.findFirst({ where: { AND: [{ id: task.parentId }, visibility] }, select: taskSummarySelect })
      : Promise.resolve(null),
    prisma.task.findMany({
      where: { AND: [{ parentId: task.id, archived: false }, visibility] },
      select: taskSummarySelect,
      orderBy: [{ number: 'asc' }, { createdAt: 'asc' }],
      take: 100,
    }),
    // W17a: both directions (same project, so visible to whoever sees this task).
    readTaskDependencies(prisma, task.id),
    // W17b: the plan this task came from (same project as the task).
    prisma.$queryRaw<Array<{ planId: string; key: string; title: string; status: string; approvedRevision: number | null }>>`
      SELECT p.id AS "planId", pt.key, p.title, p.status, p."approvedRevision"
        FROM "plan_tasks" pt JOIN "plans" p ON p.id = pt."planId"
       WHERE pt."taskId" = ${task.id} AND p."projectId" = ${task.projectId}
       LIMIT 1`,
  ]);
  const blockerRows = dependencies.blockedBy.map((ref) => ({ dependsOnTaskId: ref.id, dependsOnTask: { status: ref.status } }));
  const planRow = planRows[0];
  return {
    ...flattenTaskLabels({ ...task, blockedBy: blockerRows }),
    parent,
    subtasks,
    blockedBy: dependencies.blockedBy,
    blocking: dependencies.blocking,
    plan: planRow ? { id: planRow.planId, key: planRow.key, title: planRow.title, status: planRow.status, approvedRevision: planRow.approvedRevision } : null,
  };
}

/**
 * Routing of `task:deleted` (unchanged from the pre-W04b broadcasts): the
 * task's team, else its creator, else the acting user.
 */
async function taskDeletedTarget(
  tx: Prisma.TransactionClient,
  task: { teamId: string | null; creatorId: string | null },
  actorUserId: string,
): Promise<EventTarget> {
  if (task.teamId) return teamTarget(tx, task.teamId);
  return userTarget(task.creatorId ?? actorUserId);
}

/** Workspace owning a team's project; the idempotency scope for task writes. */
async function resolveTeamWorkspaceId(teamId: string): Promise<string | null> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { project: { select: { workspaceId: true } } },
  });
  return team?.project.workspaceId ?? null;
}

export async function resolveProjectWorkspaceId(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  return project?.workspaceId ?? null;
}

export interface CreateTaskInput {
  userId: string;
  title: string;
  description?: string | null;
  priority?: Priority;
  status?: Status;
  labelIds?: string[];
  teamId?: string | null;
  projectId?: string | null;
  dueDate?: string | null;
  /** Primary assignee; defaults to the first of `assigneeIds`. */
  assigneeId?: string | null;
  /** All assignees (`TaskAssignee` rows, role `assignee`); members of the task's team. */
  assigneeIds?: string[];
  model?: string | null;
  agent?: string | null;
}

export type TaskDto = ReturnType<typeof flattenTaskLabels<TaskWithInclude>>;

/**
 * Authorize a single task creation and return it as a command: validation in
 * `prepare`, the issue-number allocation and insert in `mutate` (caller's
 * transaction), fan-out/activity/notification in `afterCommit`.
 */
export async function authorizeCreateTask(input: CreateTaskInput): Promise<IdempotentCommand<void, TaskDto>> {
  let resolvedTeamId = input.teamId ?? undefined;
  const projectId = input.projectId ?? undefined;

  if (projectId) {
    await assertProjectOwned(projectId, input.userId);
    resolvedTeamId = await resolveProjectTeamId(projectId);
  }
  if (!resolvedTeamId) {
    throw new ValidationError('Task must belong to a team or a project');
  }
  await assertTeamRole(resolvedTeamId, input.userId, ['owner', 'admin', 'member']);

  const teamId = resolvedTeamId;
  const labelIds = input.labelIds ?? [];
  const assigneeIds = [...new Set(input.assigneeIds ?? [])];
  // The board shows one assignee (`assigneeId`); without an explicit one the
  // first listed assignee is the primary.
  const primaryAssigneeId = input.assigneeId ?? assigneeIds[0] ?? null;

  return {
    resolveWorkspaceId: () => resolveTeamWorkspaceId(teamId),
    prepare: async () => {
      if (input.assigneeId) {
        const assignee = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId, userId: input.assigneeId } },
          select: { id: true },
        });
        if (!assignee) throw new OwnershipError('user', input.assigneeId, 'forbidden');
      }
      // Same rule as PATCH /api/tasks/:id: assignees are members of the task's team.
      await assertUsersInTeam(assigneeIds, teamId);
      // Same rule as PATCH: labels belong to the task's project (a task
      // without a project takes none). Team-only creates used to skip it.
      await assertLabelsInProject(labelIds, projectId);
    },
    mutate: async (tx) => {
      const team = await tx.team.update({
        where: { id: teamId },
        data: { nextIssueNumber: { increment: 1 } },
        select: { key: true, nextIssueNumber: true },
      });
      const number = team.nextIssueNumber - 1;
      const task = await tx.task.create({
        data: {
          title: input.title,
          description: input.description ?? undefined,
          priority: input.priority ?? 'medium',
          status: input.status ?? 'todo',
          teamId,
          projectId,
          number,
          identifier: `${team.key}-${number}`,
          dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
          assigneeId: primaryAssigneeId ?? undefined,
          creatorId: input.userId,
          model: input.model ?? undefined,
          agent: input.agent ?? undefined,
          labels: labelIds.length ? { create: [...new Set(labelIds)].map((labelId) => ({ labelId })) } : undefined,
          taskAssignees: assigneeIds.length
            ? { create: assigneeIds.map((userId) => ({ userId, role: 'assignee' as const })) }
            : undefined,
        },
        include: taskInclude,
      });
      const transformed = flattenTaskLabels(task);
      // W04b: the event commits with the task (and the idempotency record).
      await appendToTarget(tx, await taskTarget(tx, task), 'task:created', transformed, input.userId);
      return {
        status: 201,
        body: transformed,
        afterCommit: () => publishTaskCreated(task, input.userId, assigneeIds),
      };
    },
  };
}

async function publishTaskCreated(task: TaskWithInclude, userId: string, assigneeIds: readonly string[] = []): Promise<void> {
  await logActivity({
    taskId: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    userId,
    action: 'task_created',
    payload: {
      title: task.title,
      status: task.status,
      priority: task.priority,
      identifier: task.identifier,
      source: 'chat',
    },
  });
  const recipients = new Set([task.assigneeId, ...assigneeIds].filter((id): id is string => Boolean(id) && id !== userId));
  for (const recipientUserId of recipients) {
    await createNotification({
      recipientUserId,
      actorUserId: userId,
      type: 'assignment',
      taskId: task.id,
      body: `Assigned to you: ${task.title}`,
    });
  }
}

export async function createTask(input: CreateTaskInput): Promise<TaskDto> {
  return runCommand(await authorizeCreateTask(input));
}

export async function updateTask(input: {
  userId: string;
  taskId: string;
  title?: string;
  description?: string | null;
  priority?: Priority;
  status?: Status;
  labelIds?: string[];
  teamId?: string | null;
  projectId?: string | null;
  dueDate?: string | null;
  assigneeId?: string | null;
}) {
  const existing = await assertTaskOwned(input.taskId, input.userId);
  const previous = await prisma.task.findUnique({
    where: { id: input.taskId },
    select: { assigneeId: true, creatorId: true, title: true },
  });

  const data: Prisma.TaskUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.status !== undefined) {
    data.status = input.status;
    if (input.status !== existing.status && ['done', 'cancelled', 'todo'].includes(input.status)) {
      data.sessionId = null;
      data.executionStartedAt = null;
      data.executionPausedAt = null;
      data.executionElapsedMs = 0;
      data.executionProgress = null;
    }
  }
  if (input.dueDate !== undefined) data.dueDate = input.dueDate ? new Date(input.dueDate) : null;

  let effectiveTeamId = existing.teamId ?? null;
  if (input.projectId !== undefined) {
    if (input.projectId) {
      await assertProjectOwned(input.projectId, input.userId);
      effectiveTeamId = await resolveProjectTeamId(input.projectId);
      data.project = { connect: { id: input.projectId } };
      data.team = { connect: { id: effectiveTeamId } };
    } else {
      effectiveTeamId = null;
      data.project = { disconnect: true };
      data.team = { disconnect: true };
    }
  } else if (input.teamId !== undefined) {
    if (input.teamId) {
      await assertTeamRole(input.teamId, input.userId, ['owner', 'admin', 'member']);
      effectiveTeamId = input.teamId;
      data.team = { connect: { id: input.teamId } };
    } else {
      effectiveTeamId = null;
      data.team = { disconnect: true };
    }
  }

  if (input.assigneeId !== undefined) {
    if (input.assigneeId === null) {
      data.assignee = { disconnect: true };
    } else {
      if (!effectiveTeamId) throw new ValidationError('Cannot assign user: task has no team');
      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: effectiveTeamId, userId: input.assigneeId } },
        select: { id: true },
      });
      if (!member) throw new OwnershipError('user', input.assigneeId, 'forbidden');
      data.assignee = { connect: { id: input.assigneeId } };
    }
  }

  if (input.labelIds !== undefined) {
    await assertLabelsInProject(input.labelIds, input.projectId ?? existing.projectId);
    data.labels = {
      deleteMany: {},
      create: input.labelIds.map((labelId) => ({ labelId })),
    };
  }

  // W17a: a task leaving its project drops its dependency edges (as on PATCH).
  const nextScope = {
    projectId: input.projectId !== undefined ? input.projectId || null : existing.projectId,
    teamId: effectiveTeamId,
  };
  const task = await transactionWithEvents(async (tx) => {
    await dropDependenciesOnScopeChange(tx, input.taskId, existing, nextScope);
    const updated = await tx.task.update({ where: { id: input.taskId }, data, include: taskInclude });
    await appendToTarget(tx, await taskTarget(tx, updated), 'task:updated', flattenTaskLabels(updated), input.userId);
    return updated;
  });
  const transformed = flattenTaskLabels(task);

  const statusChanged = input.status !== undefined && input.status !== existing.status;
  const assigneeChanged = input.assigneeId !== undefined && input.assigneeId !== (previous?.assigneeId ?? null);

  if (statusChanged) {
    await logActivity({
      taskId: task.id,
      projectId: task.projectId,
      teamId: task.teamId,
      userId: input.userId,
      action: 'task_status_changed',
      payload: { from: existing.status, to: task.status, title: task.title },
    });
    if (task.status === 'done') await notifyUnblockedDependents({ taskIds: [task.id], actorUserId: input.userId });
  } else {
    await logActivity({
      taskId: task.id,
      projectId: task.projectId,
      teamId: task.teamId,
      userId: input.userId,
      action: 'task_updated',
      payload: { source: 'chat' },
    });
  }

  if (assigneeChanged && input.assigneeId && input.assigneeId !== input.userId) {
    await createNotification({
      recipientUserId: input.assigneeId,
      actorUserId: input.userId,
      type: 'assignment',
      taskId: task.id,
      body: `Assigned to you: ${task.title}`,
    });
    await logActivity({
      taskId: task.id,
      projectId: task.projectId,
      teamId: task.teamId,
      userId: input.userId,
      action: 'task_assigned',
      payload: { from: previous?.assigneeId ?? null, to: input.assigneeId },
    });
  }

  return transformed;
}

/**
 * Scope of a bulk call: one project (the original contract), or one team's
 * project-less ("team-only") issues, which the project-scoped endpoints
 * cannot reach.
 */
export type BulkScope = { kind: 'project'; projectId: string } | { kind: 'team'; teamId: string };

export interface BulkScopeInput {
  userId: string;
  projectId?: string | null;
  teamId?: string | null;
}

/**
 * Exactly one of `projectId`/`teamId` (400 `BULK_SCOPE_INVALID` otherwise).
 * Project scope needs full project access; team scope needs a write role on
 * the team (which also applies explicit project deny and the PAT binding).
 */
async function authorizeBulkScope(input: BulkScopeInput): Promise<BulkScope> {
  if (input.projectId && input.teamId) {
    throw new HttpError(400, 'BULK_SCOPE_INVALID', 'Pass either projectId or teamId, not both');
  }
  if (input.projectId) {
    await assertProjectAccess(input.projectId, input.userId, 'full');
    return { kind: 'project', projectId: input.projectId };
  }
  if (input.teamId) {
    await assertTeamRole(input.teamId, input.userId, ['owner', 'admin', 'member']);
    return { kind: 'team', teamId: input.teamId };
  }
  throw new HttpError(400, 'BULK_SCOPE_INVALID', 'projectId or teamId is required');
}

/** Tasks the scope can address: the project's tasks, or the team's tasks without a project. */
function bulkScopeWhere(scope: BulkScope): Prisma.TaskWhereInput {
  return scope.kind === 'project' ? { projectId: scope.projectId } : { teamId: scope.teamId, projectId: null };
}

function bulkScopeNotFound(scope: BulkScope): string {
  return scope.kind === 'project'
    ? 'Issue was not found in the selected project'
    : "Issue was not found among the team's issues without a project";
}

async function bulkScopeTarget(tx: Prisma.TransactionClient, scope: BulkScope): Promise<EventTarget | null> {
  return scope.kind === 'project' ? projectTarget(tx, scope.projectId) : teamTarget(tx, scope.teamId);
}

function bulkScopePayload(scope: BulkScope): { projectId: string | null; teamId?: string } {
  return scope.kind === 'project' ? { projectId: scope.projectId } : { projectId: null, teamId: scope.teamId };
}

/** Explicit, non-empty selection (an empty list once meant "the whole project"). */
function requireTaskIds(taskIds: readonly string[] | undefined): string[] {
  const ids = [...new Set(taskIds ?? [])];
  if (ids.length === 0) {
    throw new HttpError(
      400,
      'TASK_IDS_REQUIRED',
      'taskIds must list the issues to change (1-100 ids); an empty or missing selection no longer means every issue in the project',
    );
  }
  return ids;
}

const RESET_EXECUTION_STATUSES: ReadonlySet<Status> = new Set<Status>(['done', 'cancelled', 'todo']);

export async function bulkUpdateTaskStatus(input: BulkScopeInput & {
  status: Status;
  taskIds?: string[];
  /** Activity `source`: `chat_bulk` by default (as before); the REST route passes `bulk`. */
  source?: string;
}) {
  const requestedIds = requireTaskIds(input.taskIds);
  const scope = await authorizeBulkScope(input);

  const tasks = await prisma.task.findMany({
    where: { ...bulkScopeWhere(scope), archived: false, id: { in: requestedIds } },
    select: {
      id: true,
      identifier: true,
      title: true,
      status: true,
      teamId: true,
      projectId: true,
      creatorId: true,
    },
    orderBy: [{ number: 'asc' }, { createdAt: 'asc' }],
  });

  const foundIds = new Set(tasks.map((task) => task.id));
  const failed = requestedIds
    .filter((id) => !foundIds.has(id))
    .map((id) => ({ id, error: bulkScopeNotFound(scope) }));

  const teamIds = [...new Set(tasks.map((task) => task.teamId).filter((id): id is string => Boolean(id)))];
  await Promise.all(teamIds.map((teamId) => assertTeamRole(teamId, input.userId, ['owner', 'admin', 'member'])));

  const already = tasks
    .filter((task) => task.status === input.status)
    .map((task) => ({ id: task.id, identifier: task.identifier, title: task.title, status: task.status }));
  const toUpdate = tasks.filter((task) => task.status !== input.status);

  const updated = await transactionWithEvents(async (tx) => {
    let rows: TaskWithInclude[] = [];
    if (toUpdate.length > 0) {
      // Same reset as a single PATCH: leaving the running states clears the
      // execution fields and the batch membership.
      const resetExecution = RESET_EXECUTION_STATUSES.has(input.status);
      await tx.task.updateMany({
        where: { id: { in: toUpdate.map((task) => task.id) } },
        data: {
          status: input.status,
          ...(resetExecution
            ? {
                sessionId: null,
                executionStartedAt: null,
                executionPausedAt: null,
                executionElapsedMs: 0,
                executionProgress: null,
                batchId: null,
              }
            : {}),
        },
      });
      rows = await tx.task.findMany({
        where: { id: { in: toUpdate.map((task) => task.id) } },
        include: taskInclude,
        orderBy: [{ number: 'asc' }, { createdAt: 'asc' }],
      });
    }
    const dtos = rows.map(flattenTaskLabels);
    await appendToTarget(tx, await bulkScopeTarget(tx, scope), 'tasks:bulk-updated', {
      type: 'tasks:bulk-updated',
      ...bulkScopePayload(scope),
      count: dtos.length,
      status: input.status,
      taskIds: dtos.map((task) => task.id),
    }, input.userId);
    for (const dto of dtos) {
      await appendToTarget(tx, await taskTarget(tx, dto), 'task:updated', dto, input.userId);
    }
    return rows;
  }, PRISMA_TX_OPTIONS);

  const transformed = updated.map(flattenTaskLabels);

  const previousById = new Map(toUpdate.map((task) => [task.id, task]));
  const source = input.source ?? 'chat_bulk';
  await Promise.all(updated.map(async (task) => {
    const previous = previousById.get(task.id);
    await logActivity({
      taskId: task.id,
      projectId: task.projectId,
      teamId: task.teamId,
      userId: input.userId,
      action: 'task_status_changed',
      payload: { from: previous?.status, to: task.status, title: task.title, source },
    });
    // Same creator notification as a single PATCH status change.
    const creatorId = previous?.creatorId ?? null;
    if (creatorId && creatorId !== input.userId) {
      await createNotification({
        recipientUserId: creatorId,
        actorUserId: input.userId,
        type: 'status_change',
        taskId: task.id,
        body: `Status changed: ${task.title} → ${task.status}`,
      });
    }
  }));
  // After every status change of the batch, once (no duplicates for a task blocked by two of them).
  await notifyUnblockedDependents({ taskIds: updated.filter((task) => task.status === 'done').map((task) => task.id), actorUserId: input.userId });

  return {
    updated: transformed,
    already,
    failed,
    status: input.status,
  };
}

/**
 * Reject label ids that do not belong to the task's project.
 *
 * The single-task create path validated this; the two update paths and the
 * route-level create path did not, so a caller could attach another tenant's
 * labels to their own task by id — and those labels then render on the board
 * with the other workspace's name and colour.
 */
async function assertLabelsInProject(
  labelIds: string[],
  projectId: string | null | undefined,
): Promise<void> {
  const unique = [...new Set(labelIds)];
  if (unique.length === 0) return;

  if (!projectId) {
    throw new ValidationError('Cannot attach labels to a task with no project');
  }

  const found = await prisma.label.findMany({
    where: { id: { in: unique }, projectId },
    select: { id: true },
  });
  if (found.length !== unique.length) {
    const ok = new Set(found.map((label) => label.id));
    throw new ValidationError(
      `Invalid labelIds: ${unique.filter((id) => !ok.has(id)).join(', ')}`,
    );
  }
}

/**
 * Reject assignee/watcher ids that are not members of the task's team.
 * Without this, arbitrary user ids could be written into `TaskAssignee`,
 * disclosing membership and surfacing strangers on a board.
 */
async function assertUsersInTeam(
  userIds: string[],
  teamId: string | null | undefined,
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;

  if (!teamId) {
    throw new ValidationError('Cannot assign users to a task with no team');
  }

  const members = await prisma.teamMember.findMany({
    where: { teamId, userId: { in: unique } },
    select: { userId: true },
  });
  if (members.length !== unique.length) {
    const ok = new Set(members.map((member) => member.userId));
    throw new ValidationError(
      `Users are not members of this team: ${unique.filter((id) => !ok.has(id)).join(', ')}`,
    );
  }
}

export async function bulkArchiveTasks(input: BulkScopeInput & {
  taskIds?: string[];
  identifiers?: string[];
  /** Activity `source`: `chat_bulk` by default (as before); the REST route passes `bulk`. */
  source?: string;
}) {
  const scope = await authorizeBulkScope(input);

  const parsed = bulkArchiveBodySchema.safeParse(input);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);

  const normalizedIds = (parsed.data.taskIds ?? []).map((id) => id.trim());
  const normalizedIdentifiers = (parsed.data.identifiers ?? []).map((identifier) => identifier.trim());
  if (normalizedIds.some((id) => !id) || normalizedIdentifiers.some((identifier) => !identifier)) {
    throw new ValidationError('Archive selectors must not be blank');
  }
  const requestedIds = [...new Set(normalizedIds)];
  const requestedIdentifiers = [...new Set(normalizedIdentifiers)];
  if (requestedIds.length === 0 && requestedIdentifiers.length === 0) {
    throw new ValidationError('Specify which issues to archive via taskIds or identifiers');
  }

  const scopedRequests: Prisma.TaskWhereInput[] = [];
  if (requestedIds.length > 0) scopedRequests.push({ id: { in: requestedIds } });
  // `mode: 'insensitive'` lowercases the COLUMN but not the supplied values, so
  // `in: ['TEAM1-12']` matched nothing while `in: ['team1-12']` matched — i.e.
  // archiving by identifier silently failed for every normally-cased identifier
  // and reported success with an empty `archived` list. The values must be
  // lowercased to meet the lowercased column.
  if (requestedIdentifiers.length > 0) {
    scopedRequests.push({
      identifier: { in: requestedIdentifiers.map((identifier) => identifier.toLowerCase()), mode: 'insensitive' },
    });
  }

  const tasks = await prisma.task.findMany({
    where: {
      ...bulkScopeWhere(scope),
      archived: false,
      OR: scopedRequests,
    },
    select: {
      id: true,
      identifier: true,
      title: true,
      status: true,
      teamId: true,
      projectId: true,
      creatorId: true,
    },
    orderBy: [{ number: 'asc' }, { createdAt: 'asc' }],
  });

  const foundIds = new Set(tasks.map((task) => task.id));
  const foundIdentifiers = new Set(tasks.map((task) => task.identifier?.toLowerCase()).filter((identifier): identifier is string => Boolean(identifier)));
  const failed = [
    ...requestedIds
      .filter((id) => !foundIds.has(id))
      .map((id) => ({ id, error: bulkScopeNotFound(scope) })),
    ...requestedIdentifiers
      .filter((identifier) => !foundIdentifiers.has(identifier.toLowerCase()))
      .map((identifier) => ({ identifier, error: bulkScopeNotFound(scope) })),
  ];

  const teamIds = [...new Set(tasks.map((task) => task.teamId).filter((id): id is string => Boolean(id)))];
  await Promise.all(teamIds.map((teamId) => assertTeamRole(teamId, input.userId, ['owner', 'admin', 'member'])));

  if (tasks.length > 0) {
    await transactionWithEvents(async (tx) => {
      await tx.task.updateMany({
        where: { id: { in: tasks.map((task) => task.id) } },
        data: { archived: true },
      });
      for (const task of tasks) {
        await appendToTarget(tx, await taskDeletedTarget(tx, task, input.userId), 'task:deleted', { id: task.id }, input.userId);
      }
    });
  }

  await Promise.all(tasks.map((task) => logActivity({
    taskId: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    userId: input.userId,
    action: 'task_archived',
    payload: { id: task.id, identifier: task.identifier, title: task.title, source: input.source ?? 'chat_bulk' },
  })));

  return {
    archived: tasks.map((task) => ({
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      status: task.status,
    })),
    failed,
    count: tasks.length,
  };
}

export interface BulkCreateTaskItem {
  title: string;
  description?: string | null;
  priority?: Priority;
  status?: Status;
  labelIds?: string[];
  parentId?: string;
  dueDate?: string | null;
  assigneeIds?: string[];
}

export interface BulkCreateTasksInput {
  userId: string;
  projectId: string;
  tasks: BulkCreateTaskItem[];
}

export interface PreparedBulkCreate {
  validTasks: Array<{ task: BulkCreateTaskItem; index: number }>;
  failed: Array<{ index: number; error: string }>;
  labels: Array<Prisma.LabelGetPayload<{ select: typeof labelSelect }>>;
}

export interface BulkCreateTasksResult {
  created: TaskDto[];
  failed: Array<{ index: number; error: string }>;
}

async function authorizeBulkCreateScope(input: BulkCreateTasksInput): Promise<string> {
  if (input.tasks.length > 100) {
    throw new ValidationError('Cannot create more than 100 tasks at once');
  }
  await assertProjectAccess(input.projectId, input.userId, 'full');
  const resolvedTeamId = await resolveProjectTeamId(input.projectId);
  await assertTeamRole(resolvedTeamId, input.userId, ['owner', 'admin', 'member']);
  return resolvedTeamId;
}

/**
 * Legacy partial semantics: invalid labels/parents/assignees are reported in
 * `failed`, valid items are created. Assignees must be members of the
 * project's team (they were written unchecked before).
 */
async function prepareBulkCreate(input: BulkCreateTasksInput, teamId: string): Promise<PreparedBulkCreate> {
  const assigneeIds = [...new Set(input.tasks.flatMap((task) => task.assigneeIds ?? []))];
  const members = assigneeIds.length
    ? await prisma.teamMember.findMany({ where: { teamId, userId: { in: assigneeIds } }, select: { userId: true } })
    : [];
  const validAssigneeIds = new Set(members.map((member) => member.userId));

  const labelIds = [...new Set(input.tasks.flatMap((task) => task.labelIds ?? []))];
  const labels = labelIds.length
    ? await prisma.label.findMany({ where: { id: { in: labelIds }, projectId: input.projectId }, select: labelSelect })
    : [];
  const validLabelIds = new Set(labels.map((label) => label.id));

  const parentIds = [...new Set(input.tasks.map((task) => task.parentId).filter((id): id is string => Boolean(id)))];
  const parentTasks = parentIds.length
    ? await prisma.task.findMany({ where: { id: { in: parentIds }, projectId: input.projectId }, select: { id: true } })
    : [];
  const validParentIds = new Set(parentTasks.map((task) => task.id));

  const failed: Array<{ index: number; error: string }> = [];
  const validTasks = input.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task, index }) => {
      const invalidLabels = (task.labelIds ?? []).filter((labelId) => !validLabelIds.has(labelId));
      if (invalidLabels.length > 0) {
        failed.push({ index, error: `Invalid labelIds: ${invalidLabels.join(', ')}` });
        return false;
      }
      if (task.parentId && !validParentIds.has(task.parentId)) {
        failed.push({ index, error: 'parentId must reference an existing accessible task' });
        return false;
      }
      const invalidAssignees = (task.assigneeIds ?? []).filter((userId) => !validAssigneeIds.has(userId));
      if (invalidAssignees.length > 0) {
        failed.push({ index, error: `Users are not members of this team: ${[...new Set(invalidAssignees)].join(', ')}` });
        return false;
      }
      return true;
    });

  return { validTasks, failed, labels };
}

/**
 * Insert tasks into a project's team inside the caller's transaction, with
 * consecutive issue numbers reserved atomically (bulk create, W17b plan
 * approval). Returns the rows with `taskInclude`.
 */
export async function insertProjectTasks(
  tx: Prisma.TransactionClient,
  input: { projectId: string; teamId: string; userId: string; items: readonly BulkCreateTaskItem[] },
): Promise<TaskWithInclude[]> {
  const created: TaskWithInclude[] = [];
  if (input.items.length === 0) return created;
  const team = await tx.team.update({
    where: { id: input.teamId },
    data: { nextIssueNumber: { increment: input.items.length } },
    select: { key: true, nextIssueNumber: true },
  });
  const startNumber = team.nextIssueNumber - input.items.length;
  for (let index = 0; index < input.items.length; index += 1) {
    const task = input.items[index];
    const number = startNumber + index;
    created.push(await tx.task.create({
      data: {
        title: task.title,
        description: task.description ?? undefined,
        priority: task.priority ?? 'medium',
        status: task.status ?? 'todo',
        teamId: input.teamId,
        projectId: input.projectId,
        parentId: task.parentId,
        number,
        identifier: `${team.key}-${number}`,
        dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
        creatorId: input.userId,
        // The first assignee is the primary one the board shows (as on single create).
        assigneeId: task.assigneeIds?.[0],
        labels: (task.labelIds ?? []).length
          ? { create: [...new Set(task.labelIds)].map((labelId) => ({ labelId })) }
          : undefined,
        taskAssignees: task.assigneeIds?.length
          ? { create: [...new Set(task.assigneeIds)].map((userId) => ({ userId, role: 'assignee' as const })) }
          : undefined,
      },
      include: taskInclude,
    }));
  }
  return created;
}

function bulkCreateCommand(
  input: BulkCreateTasksInput,
  teamId: string,
): IdempotentCommand<PreparedBulkCreate, BulkCreateTasksResult> {
  return {
    resolveWorkspaceId: () => resolveProjectWorkspaceId(input.projectId),
    prepare: () => prepareBulkCreate(input, teamId),
    mutate: async (tx, { validTasks, failed }) => {
      const created = await insertProjectTasks(tx, {
        projectId: input.projectId,
        teamId,
        userId: input.userId,
        items: validTasks.map(({ task }) => task),
      });
      const transformed = created.map(flattenTaskLabels);
      await appendToTarget(tx, await projectTarget(tx, input.projectId), 'tasks:bulk-created', {
        type: 'tasks:bulk-created',
        projectId: input.projectId,
        count: transformed.length,
        taskIds: transformed.map((task) => task.id),
      }, input.userId);
      return {
        status: 201,
        body: { created: transformed, failed },
        afterCommit: () => publishTasksBulkCreated(input, created),
      };
    },
  };
}

async function publishTasksBulkCreated(
  input: BulkCreateTasksInput,
  created: TaskWithInclude[],
): Promise<void> {
  await Promise.all(created.map((task) => logActivity({
    taskId: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    userId: input.userId,
    action: 'task_created',
    payload: { title: task.title, status: task.status, priority: task.priority, identifier: task.identifier, source: 'chat_bulk' },
  })));
}

/** Authorize a bulk creation and return it as a command (see authorizeCreateTask). */
export async function authorizeBulkCreateTasks(
  input: BulkCreateTasksInput,
): Promise<IdempotentCommand<PreparedBulkCreate, BulkCreateTasksResult>> {
  return bulkCreateCommand(input, await authorizeBulkCreateScope(input));
}

export async function bulkCreateTasks(input: BulkCreateTasksInput & { dryRun: boolean }) {
  const resolvedTeamId = await authorizeBulkCreateScope(input);
  const command = bulkCreateCommand(input, resolvedTeamId);

  if (input.dryRun) {
    const { validTasks, failed, labels } = await command.prepare();
    return {
      preview: validTasks.map(({ task, index }) => ({
        index,
        title: task.title,
        description: task.description ?? null,
        priority: task.priority ?? 'medium',
        status: task.status ?? 'todo',
        projectId: input.projectId,
        teamId: resolvedTeamId,
        labelIds: task.labelIds ?? [],
        labels: labels.filter((label) => (task.labelIds ?? []).includes(label.id)),
        parentId: task.parentId ?? null,
        dueDate: task.dueDate ?? null,
      })),
      failed,
      dryRun: true,
    };
  }

  const result = await runCommand(command);
  return { created: result.created, failed: result.failed, dryRun: false };
}

export async function listComments(input: { taskId: string; userId: string; limit?: number; cursor?: string }) {
  await assertTaskAccess(input.taskId, input.userId, 'view');
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const comments = await prisma.comment.findMany({
    where: { taskId: input.taskId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { user: { select: commentAuthorSelect } },
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = comments.slice(0, limit);
  return { data: page, nextCursor: comments.length > limit ? page.at(-1)?.id ?? null : null };
}

export async function addComment(input: { taskId: string; userId: string; body: string }) {
  const task = await assertTaskOwned(input.taskId, input.userId);
  const usernames = extractMentionedUsernames(input.body);
  const mentionedUsers = usernames.length > 0
    ? await prisma.user.findMany({ where: { username: { in: usernames } }, select: { id: true, username: true } })
    : [];
  // A mention must not deliver the comment body to someone who cannot read the task.
  const recipientIds = await filterUsersWithTaskAccess(
    input.taskId,
    Array.from(new Set(mentionedUsers.map((user) => user.id).filter((id) => id !== input.userId))),
  );

  const result = await transactionWithEvents(async (tx) => {
    const comment = await tx.comment.create({
      data: { taskId: input.taskId, userId: input.userId, body: input.body, mentions: recipientIds },
      include: { user: { select: commentAuthorSelect } },
    });
    const notifications = recipientIds.length > 0
      ? await Promise.all(recipientIds.map((recipientId) => tx.notification.create({
          data: {
            userId: recipientId,
            type: 'mention',
            taskId: input.taskId,
            commentId: comment.id,
            actorUserId: input.userId,
            body: input.body,
          },
        })))
      : [];
    await appendToTarget(
      tx,
      await teamOrUserTarget(tx, task.teamId, input.userId),
      'comment:created',
      { taskId: input.taskId, comment },
      input.userId,
    );
    for (const notification of notifications) {
      await appendToTarget(tx, userTarget(notification.userId), 'notification:created', notification, input.userId);
    }
    return { comment, notifications };
  });

  await logActivity({
    taskId: input.taskId,
    teamId: task.teamId,
    userId: input.userId,
    action: 'comment_created',
    payload: { commentId: result.comment.id, mentionCount: result.notifications.length, source: 'chat' },
  });
  return result.comment;
}

export async function countWritableTasksForUser(userId: string) {
  return prisma.task.count({
    where: {
      archived: false,
      AND: [await buildTaskProjectFullAccessWhere(userId)],
    },
  });
}

// ─── Route-facing functions ──────────────────────────────────────────────────

export interface TaskListFilters {
  userId: string;
  teamId?: string;
  projectId?: string;
  /** `me`, a user id, or `none` (no primary assignee). */
  assignee?: string;
  /** `me` or a user id. With `assignee`, the two are ORed ("assigned to or created by"). */
  creator?: string;
  status?: Status[];
  /** Any of these labels. */
  labelIds?: string[];
  /** Case-insensitive substring of title, description or identifier. */
  q?: string;
  /** Exact identifier (`ENG-12`), case-insensitive. */
  identifier?: string;
  /** A parent task id, or `none` for top-level tasks. */
  parentId?: string;
}

/**
 * Stable list order shared by both pagination modes: newest first, ties
 * broken by id so equal timestamps never reorder between requests.
 */
const TASK_LIST_ORDER: Prisma.TaskOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

/**
 * `WHERE` for `GET /api/tasks`: principal visibility (scopedTaskWhere), the
 * explicit team/project checks, and the optional filters. Every filter is a
 * conjunct, except `assignee` + `creator`, which keep their original OR.
 */
async function buildTaskListWhere(input: TaskListFilters): Promise<Prisma.TaskWhereInput[]> {
  const userTeamIds = await getUserTeamIds(input.userId);
  const filters: Prisma.TaskWhereInput[] = [
    { archived: false },
    await buildTaskListVisibilityWhere(input.userId),
  ];

  if (input.teamId) {
    if (!userTeamIds.includes(input.teamId)) {
      throw new OwnershipError('team', input.teamId, 'forbidden');
    }
    filters.push({ teamId: input.teamId });
  }
  if (input.projectId) {
    await assertProjectAccess(input.projectId, input.userId, 'view');
    filters.push({ projectId: input.projectId });
  }

  const resolveUserFilter = async (value: string): Promise<string> => {
    if (value === 'me') return input.userId;
    const member = await prisma.teamMember.findFirst({
      where: { userId: value, teamId: { in: userTeamIds } },
      select: { userId: true },
    });
    if (!member) throw new OwnershipError('user', value, 'forbidden');
    return value;
  };
  const assigneeWhere = async (value: string): Promise<Prisma.TaskWhereInput> =>
    value === 'none' ? { assigneeId: null } : { assigneeId: await resolveUserFilter(value) };

  if (input.assignee && input.creator) {
    const [assigneeFilter, creatorId] = await Promise.all([
      assigneeWhere(input.assignee),
      resolveUserFilter(input.creator),
    ]);
    filters.push({ OR: [assigneeFilter, { creatorId }] });
  } else if (input.assignee) {
    filters.push(await assigneeWhere(input.assignee));
  } else if (input.creator) {
    filters.push({ creatorId: await resolveUserFilter(input.creator) });
  }

  if (input.status?.length) {
    filters.push(input.status.length === 1 ? { status: input.status[0] } : { status: { in: input.status } });
  }
  if (input.labelIds?.length) {
    filters.push({ labels: { some: { labelId: { in: input.labelIds } } } });
  }
  if (input.parentId) {
    filters.push({ parentId: input.parentId === 'none' ? null : input.parentId });
  }
  if (input.q) {
    filters.push({
      OR: [
        { title: { contains: likeLiteral(input.q), mode: 'insensitive' } },
        { description: { contains: likeLiteral(input.q), mode: 'insensitive' } },
        { identifier: { contains: likeLiteral(input.q), mode: 'insensitive' } },
      ],
    });
  }
  if (input.identifier) {
    // The schema admits no LIKE metacharacters (%, _, backslash), so this stays an
    // exact match even where Prisma renders insensitive equality as ILIKE.
    filters.push({ identifier: { equals: input.identifier, mode: 'insensitive' } });
  }
  return filters;
}

/** Rows strictly after `cursor` in TASK_LIST_ORDER. `createdAt <= c` lets the index bound the scan. */
function afterCursorWhere(cursor: KeysetPosition): Prisma.TaskWhereInput {
  return {
    createdAt: { lte: cursor.createdAt },
    OR: [{ createdAt: { lt: cursor.createdAt } }, { id: { lt: cursor.id } }],
  };
}

async function findTaskListRows(
  db: Prisma.TransactionClient | typeof prisma,
  where: Prisma.TaskWhereInput,
  page: { skip?: number; take: number },
  compact: boolean,
) {
  const rows = await db.task.findMany({
    where,
    include: taskInclude,
    ...(compact ? { omit: { executionLogs: true } } : {}),
    orderBy: TASK_LIST_ORDER,
    ...(page.skip ? { skip: page.skip } : {}),
    take: page.take,
  });
  return rows.map(flattenTaskLabels);
}

/** Offset mode (the original contract). `nextCursor` lets a caller continue with keyset pages. */
export async function listTasksPaginated(input: TaskListFilters & {
  page: number;
  pageSize: number;
  compact?: boolean;
}) {
  const where: Prisma.TaskWhereInput = { AND: await buildTaskListWhere(input) };
  const [items, total] = await prisma.$transaction(
    async (tx) => {
      const rows = await findTaskListRows(tx, where, {
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }, input.compact ?? false);
      const count = await tx.task.count({ where });
      return [rows, count] as const;
    },
    PRISMA_TX_OPTIONS,
  );
  const last = items.at(-1);
  const hasMore = input.page * input.pageSize < total;
  return { items, total, nextCursor: hasMore && last ? encodeKeysetCursor(last) : null };
}

/**
 * Keyset mode: one bounded index range per page, no OFFSET scan and no
 * count unless asked. Rows present when paging starts are each returned
 * exactly once even while other clients insert tasks (new rows sort first).
 */
export async function listTasksByCursor(input: TaskListFilters & {
  cursor?: string;
  pageSize: number;
  includeTotal?: boolean;
  compact?: boolean;
}) {
  const position = input.cursor ? decodeKeysetCursor(input.cursor) : null;
  const filters = await buildTaskListWhere(input);
  const pageWhere: Prisma.TaskWhereInput = { AND: position ? [...filters, afterCursorWhere(position)] : filters };
  const rows = await findTaskListRows(prisma, pageWhere, { take: input.pageSize + 1 }, input.compact ?? false);
  const hasMore = rows.length > input.pageSize;
  const items = hasMore ? rows.slice(0, input.pageSize) : rows;
  const last = items.at(-1);
  const total = input.includeTotal ? await prisma.task.count({ where: { AND: filters } }) : undefined;
  return {
    items,
    pageSize: input.pageSize,
    hasMore,
    nextCursor: hasMore && last ? encodeKeysetCursor(last) : null,
    ...(total !== undefined ? { total } : {}),
  };
}

export async function listArchivedTasksPaginated(input: {
  userId: string;
  page: number;
  pageSize: number;
}) {
  const where: Prisma.TaskWhereInput = {
    AND: [
      { archived: true },
      await buildTaskProjectAccessWhere(input.userId),
    ],
  };
  const [tasks, total] = await prisma.$transaction(
    async (tx) => {
      const items = await tx.task.findMany({
        where,
        include: taskInclude,
        orderBy: { updatedAt: 'desc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      });
      const count = await tx.task.count({ where });
      return [items, count] as const;
    },
    PRISMA_TX_OPTIONS,
  );
  return { items: tasks.map(flattenTaskLabels), total };
}

export async function deleteAllArchivedTasks(userId: string): Promise<void> {
  const where: Prisma.TaskWhereInput = {
    AND: [
      { archived: true },
      await buildTaskProjectFullAccessWhere(userId),
    ],
  };
  await prisma.task.deleteMany({ where });
}

export async function deleteArchivedTask(input: { taskId: string; userId: string }): Promise<void> {
  const owned = await assertTaskOwned(input.taskId, input.userId);
  if (!owned.archived) {
    throw new OwnershipError('task', input.taskId, 'not_found');
  }
  await prisma.task.delete({ where: { id: input.taskId } });
}

export async function updateTaskRoute(input: {
  userId: string;
  taskId: string;
  title?: string;
  description?: string | null;
  priority?: Priority;
  status?: Status;
  labelIds?: string[];
  teamId?: string | null;
  projectId?: string | null;
  dueDate?: string | null;
  assigneeId?: string | null;
  assigneeIds?: string[];
  watcherIds?: string[];
  model?: string | null;
  agent?: string | null;
}) {
  const existing = await assertTaskOwned(input.taskId, input.userId);
  const previousTaskMeta = await prisma.task.findUnique({
    where: { id: input.taskId },
    select: { assigneeId: true, creatorId: true, title: true },
  });

  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.model !== undefined) data.model = input.model;
  if (input.agent !== undefined) data.agent = input.agent;

  if (input.status !== undefined) {
    data.status = input.status;
    const shouldResetExecutionState =
      input.status !== existing.status &&
      ['done', 'cancelled', 'todo'].includes(input.status);
    if (shouldResetExecutionState) {
      data.sessionId = null;
      data.executionStartedAt = null;
      data.executionPausedAt = null;
      data.executionElapsedMs = 0;
      data.executionProgress = null;
      data.batchId = null;
    }
  }

  if (input.dueDate !== undefined) {
    data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
  }

  if (input.projectId !== undefined) {
    if (input.projectId) {
      await assertProjectOwned(input.projectId, input.userId);
      const projectTeamId = await resolveProjectTeamId(input.projectId);
      data.projectId = input.projectId;
      data.teamId = projectTeamId;
    } else {
      data.projectId = null;
      data.teamId = null;
    }
  } else if (input.teamId !== undefined) {
    if (input.teamId) {
      await assertTeamRole(input.teamId, input.userId, ['owner', 'admin', 'member']);
    }
    data.teamId = input.teamId;
  }

  if (input.assigneeId !== undefined) {
    if (input.assigneeId === null) {
      data.assigneeId = null;
    } else {
      const effectiveTeamId = (data.teamId as string | null | undefined) ?? existing.teamId ?? null;
      if (!effectiveTeamId) {
        throw new ValidationError('Cannot assign user: task has no team');
      }
      const member = await prisma.teamMember.findFirst({
        where: { teamId: effectiveTeamId, userId: input.assigneeId },
        select: { userId: true },
      });
      if (!member) throw new OwnershipError('user', input.assigneeId, 'forbidden');
      data.assigneeId = input.assigneeId;
    }
  }

  if (input.labelIds !== undefined) {
    await assertLabelsInProject(input.labelIds, input.projectId ?? existing.projectId);
    data.labels = {
      deleteMany: {},
      create: input.labelIds.map((labelId) => ({ labelId })),
    };
  }

  const hasAssigneeSync = input.assigneeIds !== undefined || input.watcherIds !== undefined;
  if (hasAssigneeSync) {
    const effectiveTeam =
      (data.teamId as string | null | undefined) ?? existing.teamId ?? null;
    await assertUsersInTeam(
      [...(input.assigneeIds ?? []), ...(input.watcherIds ?? [])],
      effectiveTeam,
    );
  }

  // W04b: the update, the assignee/watcher sync and `task:updated` commit
  // together (they were two separate writes and a post-commit broadcast).
  // W17a: dependencies never cross projects; moving a task drops its edges.
  const nextScope = {
    projectId: data.projectId !== undefined ? (typeof data.projectId === 'string' ? data.projectId : null) : existing.projectId,
    teamId: data.teamId !== undefined ? (typeof data.teamId === 'string' ? data.teamId : null) : existing.teamId,
  };

  const task = await transactionWithEvents(async (tx) => {
    await dropDependenciesOnScopeChange(tx, input.taskId, existing, nextScope);
    const updated = await tx.task.update({
      where: { id: input.taskId },
      data,
      include: taskInclude,
    });

    if (hasAssigneeSync) {
      const assigneeRecords = (input.assigneeIds ?? []).map((userId) => ({
        taskId: input.taskId,
        userId,
        role: 'assignee' as const,
      }));
      const watcherRecords = (input.watcherIds ?? []).map((userId) => ({
        taskId: input.taskId,
        userId,
        role: 'watcher' as const,
      }));
      const allRecords = [...assigneeRecords, ...watcherRecords];
      await tx.taskAssignee.deleteMany({ where: { taskId: input.taskId } });
      if (allRecords.length) {
        await tx.taskAssignee.createMany({ data: allRecords, skipDuplicates: true });
      }
    }

    await appendToTarget(tx, await taskTarget(tx, updated), 'task:updated', flattenTaskLabels(updated), input.userId);
    return updated;
  });

  const transformed = flattenTaskLabels(task);

  const statusChanged = input.status !== undefined && input.status !== existing.status;
  const newAssigneeId = input.assigneeId;
  const previousAssigneeId = previousTaskMeta?.assigneeId ?? null;
  const assigneeChanged = newAssigneeId !== undefined && newAssigneeId !== previousAssigneeId;

  if (statusChanged) {
    await logActivity({
      taskId: task.id, projectId: task.projectId, teamId: task.teamId, userId: input.userId,
      action: 'task_status_changed',
      payload: { from: existing.status, to: task.status, title: task.title },
    });
    const creatorId = previousTaskMeta?.creatorId ?? null;
    if (creatorId && creatorId !== input.userId) {
      await createNotification({
        recipientUserId: creatorId, actorUserId: input.userId,
        type: 'status_change', taskId: task.id,
        body: `Status changed: ${task.title} → ${task.status}`,
      });
    }
    if (task.status === 'done') await notifyUnblockedDependents({ taskIds: [task.id], actorUserId: input.userId });
  } else {
    await logActivity({
      taskId: task.id, projectId: task.projectId, teamId: task.teamId, userId: input.userId,
      action: 'task_updated',
      payload: { fields: Object.keys(input).filter((k) => k !== 'userId' && k !== 'taskId' && (input as Record<string, unknown>)[k] !== undefined) },
    });
  }

  if (assigneeChanged && newAssigneeId && newAssigneeId !== input.userId) {
    await createNotification({
      recipientUserId: newAssigneeId, actorUserId: input.userId,
      type: 'assignment', taskId: task.id,
      body: `Assigned to you: ${task.title}`,
    });
    await logActivity({
      taskId: task.id, projectId: task.projectId, teamId: task.teamId, userId: input.userId,
      action: 'task_assigned',
      payload: { from: previousAssigneeId, to: newAssigneeId },
    });
  }

  return transformed;
}

export async function bulkDeleteTasks(input: BulkScopeInput & {
  taskIds: string[];
  permanent?: boolean;
}) {
  const uniqueIds = requireTaskIds(input.taskIds);
  const scope = await authorizeBulkScope(input);
  const tasks = await prisma.task.findMany({
    where: { id: { in: uniqueIds }, ...bulkScopeWhere(scope) },
    select: { id: true, teamId: true, projectId: true, creatorId: true, identifier: true, title: true },
  });
  const found = new Set(tasks.map((task) => task.id));
  const failed = uniqueIds
    .filter((id) => !found.has(id))
    .map((id) => ({ id, error: bulkScopeNotFound(scope) }));

  // Same team-role check as bulk-archive and the single delete.
  const teamIds = [...new Set(tasks.map((task) => task.teamId).filter((id): id is string => Boolean(id)))];
  await Promise.all(teamIds.map((teamId) => assertTeamRole(teamId, input.userId, ['owner', 'admin', 'member'])));

  const permanent = Boolean(input.permanent);
  if (permanent) {
    // Written before the rows go (activity rows reference the task).
    await Promise.all(tasks.map((task) => logActivity({
      taskId: task.id, projectId: task.projectId, teamId: task.teamId, userId: input.userId,
      action: 'task_deleted',
      payload: { id: task.id, identifier: task.identifier, title: task.title, source: 'bulk' },
    })));
  }

  await transactionWithEvents(async (tx) => {
    if (permanent) {
      await tx.task.deleteMany({ where: { id: { in: [...found] } } });
    } else {
      await tx.task.updateMany({
        where: { id: { in: [...found] } },
        data: { archived: true },
      });
    }
    await appendToTarget(tx, await bulkScopeTarget(tx, scope), 'tasks:bulk-deleted', {
      type: 'tasks:bulk-deleted',
      ...bulkScopePayload(scope),
      count: found.size,
      taskIds: [...found],
      permanent,
    }, input.userId);
    // Per-task events, as bulk-archive and the single delete send, so clients
    // that do not handle `tasks:bulk-deleted` yet still drop the cards live.
    for (const task of tasks) {
      await appendToTarget(tx, await taskDeletedTarget(tx, task, input.userId), 'task:deleted', { id: task.id }, input.userId);
    }
  });

  if (!permanent) {
    await Promise.all(tasks.map((task) => logActivity({
      taskId: task.id, projectId: task.projectId, teamId: task.teamId, userId: input.userId,
      action: 'task_archived',
      payload: { id: task.id, identifier: task.identifier, title: task.title, source: 'bulk' },
    })));
  }

  return { deleted: [...found], failed, permanent };
}

export async function deleteTaskRoute(input: {
  userId: string;
  taskId: string;
  permanent: boolean;
}): Promise<void> {
  const owned = await assertTaskOwned(input.taskId, input.userId);
  const fullTask = await prisma.task.findUnique({
    where: { id: input.taskId },
    select: { teamId: true, creatorId: true },
  });

  if (input.permanent) {
    await logActivity({
      taskId: input.taskId, projectId: owned.projectId,
      teamId: fullTask?.teamId ?? owned.teamId ?? null,
      userId: input.userId, action: 'task_deleted',
      payload: { id: input.taskId },
    });
  }

  const teamId = fullTask?.teamId ?? owned.teamId ?? null;
  const creatorId = fullTask?.creatorId ?? null;
  await transactionWithEvents(async (tx) => {
    if (input.permanent) {
      await tx.task.delete({ where: { id: input.taskId } });
    } else {
      await tx.task.update({ where: { id: input.taskId }, data: { archived: true } });
    }
    await appendToTarget(tx, await taskDeletedTarget(tx, { teamId, creatorId }, input.userId), 'task:deleted', { id: input.taskId }, input.userId);
  });

  if (!input.permanent) {
    await logActivity({
      taskId: input.taskId, projectId: owned.projectId, teamId,
      userId: input.userId, action: 'task_archived',
      payload: { id: input.taskId },
    });
  }
}
