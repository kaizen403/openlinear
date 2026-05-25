import { prisma, type Prisma, type Priority, type Status } from '@openlinear/db';
import { ValidationError } from '../errors';
import { broadcastToProject, broadcastToTask, broadcastToTeam, broadcastToUser } from '../sse';
import { createNotification } from '../routes/notifications';
import { extractMentionedUsernames } from '../schemas/comments';
import { logActivity } from './activity';
import { getUserTeamIds } from './team-scope';
import {
  assertProjectAccess,
  assertProjectOwned,
  assertTaskAccess,
  assertTaskOwned,
  assertTeamRole,
  OwnershipError,
} from './ownership';
import { buildProjectAccessWhere, buildProjectFullAccessWhere } from './workspaces';

const labelSelect = { id: true, name: true, color: true, priority: true } as const;
const taskInclude = {
  labels: { include: { label: true } },
  team: { select: { id: true, name: true, key: true, color: true } },
  project: { select: { id: true, name: true, status: true, color: true } },
  assignee: { select: { id: true, username: true, avatarUrl: true } },
  creator: { select: { id: true, username: true, avatarUrl: true } },
} satisfies Prisma.TaskInclude;

const commentAuthorSelect = { id: true, username: true, avatarUrl: true } as const;

type TaskWithInclude = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

type TaskLabelWithLabel = TaskWithInclude['labels'][number];

export function flattenTaskLabels<T extends { labels: TaskLabelWithLabel[] }>(task: T): Omit<T, 'labels'> & { labels: Array<TaskLabelWithLabel['label']> } {
  const { labels, ...rest } = task;
  return {
    ...rest,
    labels: labels.map((taskLabel) => taskLabel.label),
  };
}

async function resolveProjectTeamId(projectId: string): Promise<string> {
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

async function buildTaskProjectAccessWhere(userId: string, teamIds: string[]): Promise<Prisma.TaskWhereInput> {
  const projects = await prisma.project.findMany({
    where: buildProjectAccessWhere(userId, teamIds),
    select: { id: true },
  });
  const projectIds = projects.map((project) => project.id);
  const visibility: Prisma.TaskWhereInput[] = [];
  if (teamIds.length > 0) visibility.push({ projectId: null, teamId: { in: teamIds } });
  if (projectIds.length > 0) visibility.push({ projectId: { in: projectIds } });
  return { OR: visibility.length > 0 ? visibility : [{ id: { in: [] } }] };
}

async function buildTaskProjectFullAccessWhere(userId: string, teamIds: string[]): Promise<Prisma.TaskWhereInput> {
  const projects = await prisma.project.findMany({
    where: buildProjectFullAccessWhere(userId, teamIds),
    select: { id: true },
  });
  const projectIds = projects.map((project) => project.id);
  const visibility: Prisma.TaskWhereInput[] = [];
  if (teamIds.length > 0) visibility.push({ projectId: null, teamId: { in: teamIds } });
  if (projectIds.length > 0) visibility.push({ projectId: { in: projectIds } });
  return { OR: visibility.length > 0 ? visibility : [{ id: { in: [] } }] };
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
    await buildTaskProjectAccessWhere(input.userId, userTeamIds),
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
        { title: { contains: input.query, mode: 'insensitive' } },
        { description: { contains: input.query, mode: 'insensitive' } },
        { identifier: { contains: input.query, mode: 'insensitive' } },
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

export async function getTask(input: { taskId: string; userId: string }) {
  await assertTaskAccess(input.taskId, input.userId, 'view');
  const task = await prisma.task.findUnique({ where: { id: input.taskId }, include: taskInclude });
  if (!task) {
    throw new OwnershipError('task', input.taskId, 'not_found');
  }
  return flattenTaskLabels(task);
}

export async function createTask(input: {
  userId: string;
  title: string;
  description?: string | null;
  priority?: Priority;
  status?: Status;
  labelIds?: string[];
  teamId?: string | null;
  projectId?: string | null;
  dueDate?: string | null;
  assigneeId?: string | null;
}) {
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

  if (input.assigneeId) {
    const assignee = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: resolvedTeamId, userId: input.assigneeId } },
      select: { id: true },
    });
    if (!assignee) throw new OwnershipError('user', input.assigneeId, 'forbidden');
  }

  const labelIds = input.labelIds ?? [];
  if (labelIds.length > 0 && projectId) {
    const labels = await prisma.label.findMany({ where: { id: { in: labelIds }, projectId }, select: { id: true } });
    if (labels.length !== new Set(labelIds).size) {
      throw new ValidationError('One or more labels are not in the selected project');
    }
  }

  const task = await prisma.$transaction(async (tx) => {
    const team = await tx.team.update({
      where: { id: resolvedTeamId },
      data: { nextIssueNumber: { increment: 1 } },
      select: { key: true, nextIssueNumber: true },
    });
    const number = team.nextIssueNumber - 1;
    return tx.task.create({
      data: {
        title: input.title,
        description: input.description ?? undefined,
        priority: input.priority ?? 'medium',
        status: input.status ?? 'todo',
        teamId: resolvedTeamId,
        projectId,
        number,
        identifier: `${team.key}-${number}`,
        dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
        assigneeId: input.assigneeId ?? undefined,
        creatorId: input.userId,
        labels: labelIds.length ? { create: labelIds.map((labelId) => ({ labelId })) } : undefined,
      },
      include: taskInclude,
    });
  }, { timeout: 15000, maxWait: 5000 });

  const transformed = flattenTaskLabels(task);
  broadcastToTask('task:created', transformed);
  await logActivity({
    taskId: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    userId: input.userId,
    action: 'task_created',
    payload: {
      title: task.title,
      status: task.status,
      priority: task.priority,
      identifier: task.identifier,
      source: 'chat',
    },
  });
  if (task.assigneeId && task.assigneeId !== input.userId) {
    await createNotification({
      recipientUserId: task.assigneeId,
      actorUserId: input.userId,
      type: 'assignment',
      taskId: task.id,
      body: `Assigned to you: ${task.title}`,
    });
  }
  return transformed;
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
    data.labels = {
      deleteMany: {},
      create: input.labelIds.map((labelId) => ({ labelId })),
    };
  }

  const task = await prisma.task.update({ where: { id: input.taskId }, data, include: taskInclude });
  const transformed = flattenTaskLabels(task);
  broadcastToTask('task:updated', transformed);

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

export async function bulkUpdateTaskStatus(input: {
  userId: string;
  projectId: string;
  status: Status;
  taskIds?: string[];
}) {
  await assertProjectAccess(input.projectId, input.userId, 'full');

  const requestedIds = [...new Set(input.taskIds ?? [])];
  const tasks = await prisma.task.findMany({
    where: {
      projectId: input.projectId,
      archived: false,
      ...(requestedIds.length ? { id: { in: requestedIds } } : {}),
    },
    select: {
      id: true,
      identifier: true,
      title: true,
      status: true,
      teamId: true,
      projectId: true,
    },
    orderBy: [{ number: 'asc' }, { createdAt: 'asc' }],
  });

  const foundIds = new Set(tasks.map((task) => task.id));
  const failed = requestedIds
    .filter((id) => !foundIds.has(id))
    .map((id) => ({ id, error: 'Issue was not found in the selected project' }));

  const teamIds = [...new Set(tasks.map((task) => task.teamId).filter((id): id is string => Boolean(id)))];
  await Promise.all(teamIds.map((teamId) => assertTeamRole(teamId, input.userId, ['owner', 'admin', 'member'])));

  const already = tasks
    .filter((task) => task.status === input.status)
    .map((task) => ({ id: task.id, identifier: task.identifier, title: task.title, status: task.status }));
  const toUpdate = tasks.filter((task) => task.status !== input.status);

  const updated = toUpdate.length
    ? await prisma.$transaction(async (tx) => {
        const resetExecution = ['done', 'cancelled', 'todo'].includes(input.status);
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
                }
              : {}),
          },
        });
        return tx.task.findMany({
          where: { id: { in: toUpdate.map((task) => task.id) } },
          include: taskInclude,
          orderBy: [{ number: 'asc' }, { createdAt: 'asc' }],
        });
      }, { timeout: 15000, maxWait: 5000 })
    : [];

  const transformed = updated.map(flattenTaskLabels);
  for (const task of transformed) {
    broadcastToTask('task:updated', task);
  }

  const previousById = new Map(toUpdate.map((task) => [task.id, task.status]));
  await Promise.all(updated.map((task) => logActivity({
    taskId: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    userId: input.userId,
    action: 'task_status_changed',
    payload: { from: previousById.get(task.id), to: task.status, title: task.title, source: 'chat_bulk' },
  })));

  return {
    updated: transformed,
    already,
    failed,
    status: input.status,
  };
}

export async function bulkArchiveTasks(input: {
  userId: string;
  projectId: string;
  taskIds?: string[];
  identifiers?: string[];
}) {
  await assertProjectAccess(input.projectId, input.userId, 'full');

  const requestedIds = [...new Set((input.taskIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const requestedIdentifiers = [...new Set((input.identifiers ?? []).map((identifier) => identifier.trim()).filter(Boolean))];
  const scopedRequests: Prisma.TaskWhereInput[] = [];
  if (requestedIds.length > 0) scopedRequests.push({ id: { in: requestedIds } });
  if (requestedIdentifiers.length > 0) scopedRequests.push({ identifier: { in: requestedIdentifiers, mode: 'insensitive' } });

  const tasks = await prisma.task.findMany({
    where: {
      projectId: input.projectId,
      archived: false,
      ...(scopedRequests.length > 0 ? { OR: scopedRequests } : {}),
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
      .map((id) => ({ id, error: 'Issue was not found in the selected project' })),
    ...requestedIdentifiers
      .filter((identifier) => !foundIdentifiers.has(identifier.toLowerCase()))
      .map((identifier) => ({ identifier, error: 'Issue was not found in the selected project' })),
  ];

  const teamIds = [...new Set(tasks.map((task) => task.teamId).filter((id): id is string => Boolean(id)))];
  await Promise.all(teamIds.map((teamId) => assertTeamRole(teamId, input.userId, ['owner', 'admin', 'member'])));

  if (tasks.length > 0) {
    await prisma.task.updateMany({
      where: { id: { in: tasks.map((task) => task.id) } },
      data: { archived: true },
    });
  }

  for (const task of tasks) {
    if (task.teamId) {
      broadcastToTeam(task.teamId, 'task:deleted', { id: task.id });
    } else if (task.creatorId) {
      broadcastToUser(task.creatorId, 'task:deleted', { id: task.id });
    } else {
      broadcastToUser(input.userId, 'task:deleted', { id: task.id });
    }
  }

  await Promise.all(tasks.map((task) => logActivity({
    taskId: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    userId: input.userId,
    action: 'task_archived',
    payload: { id: task.id, identifier: task.identifier, title: task.title, source: 'chat_bulk' },
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

export async function bulkCreateTasks(input: {
  userId: string;
  projectId: string;
  dryRun: boolean;
  tasks: Array<{
    title: string;
    description?: string | null;
    priority?: Priority;
    status?: Status;
    labelIds?: string[];
    parentId?: string;
    dueDate?: string | null;
  }>;
}) {
  if (input.tasks.length > 100) {
    throw new ValidationError('Cannot create more than 100 tasks at once');
  }
  await assertProjectAccess(input.projectId, input.userId, 'full');
  const resolvedTeamId = await resolveProjectTeamId(input.projectId);
  await assertTeamRole(resolvedTeamId, input.userId, ['owner', 'admin', 'member']);

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
      return true;
    });

  if (input.dryRun) {
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

  const created = validTasks.length
    ? await prisma.$transaction(async (tx) => {
        const team = await tx.team.update({
          where: { id: resolvedTeamId },
          data: { nextIssueNumber: { increment: validTasks.length } },
          select: { key: true, nextIssueNumber: true },
        });
        const startNumber = team.nextIssueNumber - validTasks.length;
        const createdTasks: TaskWithInclude[] = [];
        for (let index = 0; index < validTasks.length; index += 1) {
          const { task } = validTasks[index];
          const number = startNumber + index;
          createdTasks.push(await tx.task.create({
            data: {
              title: task.title,
              description: task.description ?? undefined,
              priority: task.priority ?? 'medium',
              status: task.status ?? 'todo',
              teamId: resolvedTeamId,
              projectId: input.projectId,
              parentId: task.parentId,
              number,
              identifier: `${team.key}-${number}`,
              dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
              creatorId: input.userId,
              labels: (task.labelIds ?? []).length
                ? { create: (task.labelIds ?? []).map((labelId) => ({ labelId })) }
                : undefined,
            },
            include: taskInclude,
          }));
        }
        return createdTasks;
      }, { timeout: 15000, maxWait: 5000 })
    : [];

  const transformed = created.map(flattenTaskLabels);
  await broadcastToProject(input.projectId, 'tasks:bulk-created', {
    type: 'tasks:bulk-created',
    projectId: input.projectId,
    count: transformed.length,
    taskIds: transformed.map((task) => task.id),
  });
  await Promise.all(created.map((task) => logActivity({
    taskId: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    userId: input.userId,
    action: 'task_created',
    payload: { title: task.title, status: task.status, priority: task.priority, identifier: task.identifier, source: 'chat_bulk' },
  })));

  return { created: transformed, failed, dryRun: false };
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
  const recipientIds = Array.from(new Set(mentionedUsers.map((user) => user.id).filter((id) => id !== input.userId)));

  const result = await prisma.$transaction(async (tx) => {
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
    return { comment, notifications };
  });

  if (task.teamId) {
    broadcastToTeam(task.teamId, 'comment:created', { taskId: input.taskId, comment: result.comment });
  } else {
    broadcastToUser(input.userId, 'comment:created', { taskId: input.taskId, comment: result.comment });
  }
  for (const notification of result.notifications) {
    broadcastToUser(notification.userId, 'notification:created', notification);
  }
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
  const teamIds = await getUserTeamIds(userId);
  return prisma.task.count({
    where: {
      archived: false,
      AND: [await buildTaskProjectFullAccessWhere(userId, teamIds)],
    },
  });
}

// ─── Route-facing functions ──────────────────────────────────────────────────

export async function listTasksPaginated(input: {
  userId: string;
  teamId?: string;
  projectId?: string;
  assignee?: string;
  creator?: string;
  page: number;
  pageSize: number;
}) {
  const userTeamIds = await getUserTeamIds(input.userId);
  const filters: Prisma.TaskWhereInput[] = [
    { archived: false },
    await buildTaskProjectAccessWhere(input.userId, userTeamIds),
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

  if (input.assignee && input.creator) {
    const [assigneeId, creatorId] = await Promise.all([
      resolveUserFilter(input.assignee),
      resolveUserFilter(input.creator),
    ]);
    filters.push({ OR: [{ assigneeId }, { creatorId }] });
  } else if (input.assignee) {
    filters.push({ assigneeId: await resolveUserFilter(input.assignee) });
  } else if (input.creator) {
    filters.push({ creatorId: await resolveUserFilter(input.creator) });
  }

  const where: Prisma.TaskWhereInput = { AND: filters };
  const [tasks, total] = await prisma.$transaction(
    async (tx) => {
      const items = await tx.task.findMany({
        where,
        include: taskInclude,
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      });
      const count = await tx.task.count({ where });
      return [items, count] as const;
    },
    { timeout: 15000, maxWait: 5000 },
  );

  return { items: tasks.map(flattenTaskLabels), total };
}

export async function listArchivedTasksPaginated(input: {
  userId: string;
  page: number;
  pageSize: number;
}) {
  const teamIds = await getUserTeamIds(input.userId);
  const where: Prisma.TaskWhereInput = {
    AND: [
      { archived: true },
      await buildTaskProjectAccessWhere(input.userId, teamIds),
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
    { timeout: 15000, maxWait: 5000 },
  );
  return { items: tasks.map(flattenTaskLabels), total };
}

export async function deleteAllArchivedTasks(userId: string): Promise<void> {
  const teamIds = await getUserTeamIds(userId);
  const where: Prisma.TaskWhereInput = {
    AND: [
      { archived: true },
      await buildTaskProjectFullAccessWhere(userId, teamIds),
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

export async function createTaskRoute(input: {
  userId: string;
  title: string;
  description?: string;
  priority?: Priority;
  status?: Status;
  labelIds: string[];
  teamId?: string;
  projectId?: string;
  dueDate?: string | null;
  model?: string | null;
}) {
  let resolvedTeamId = input.teamId;

  if (input.projectId) {
    await assertProjectOwned(input.projectId, input.userId);
    resolvedTeamId = await resolveProjectTeamId(input.projectId);
  }
  if (!resolvedTeamId) {
    throw new ValidationError('Task must belong to a team or a project');
  }
  await assertTeamRole(resolvedTeamId, input.userId, ['owner', 'admin', 'member']);

  const task = await prisma.$transaction(async (tx) => {
    const team = await tx.team.update({
      where: { id: resolvedTeamId },
      data: { nextIssueNumber: { increment: 1 } },
      select: { key: true, nextIssueNumber: true },
    });
    const number = team.nextIssueNumber - 1;
    const identifier = `${team.key}-${number}`;

    return tx.task.create({
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority,
        status: input.status,
        teamId: resolvedTeamId,
        projectId: input.projectId || undefined,
        number,
        identifier,
        dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
        model: input.model ?? undefined,
        creatorId: input.userId,
        labels: {
          create: input.labelIds.map((labelId) => ({ labelId })),
        },
      },
      include: taskInclude,
    });
  }, { timeout: 15000, maxWait: 5000 });

  const transformed = flattenTaskLabels(task);
  broadcastToTask('task:created', transformed);

  await logActivity({
    taskId: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    userId: input.userId,
    action: 'task_created',
    payload: { title: task.title, status: task.status, priority: task.priority, identifier: task.identifier },
  });

  const taskAssigneeId = (task as { assigneeId?: string | null }).assigneeId;
  if (taskAssigneeId && taskAssigneeId !== input.userId) {
    await createNotification({
      recipientUserId: taskAssigneeId,
      actorUserId: input.userId,
      type: 'assignment',
      taskId: task.id,
      body: `Assigned to you: ${task.title}`,
    });
  }

  return transformed;
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
    data.labels = {
      deleteMany: {},
      create: input.labelIds.map((labelId) => ({ labelId })),
    };
  }

  const hasAssigneeSync = input.assigneeIds !== undefined || input.watcherIds !== undefined;

  const task = await prisma.task.update({
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

    await prisma.$transaction([
      prisma.taskAssignee.deleteMany({ where: { taskId: input.taskId } }),
      ...(allRecords.length
        ? [prisma.taskAssignee.createMany({ data: allRecords, skipDuplicates: true })]
        : []),
    ]);
  }

  const transformed = flattenTaskLabels(task);
  broadcastToTask('task:updated', transformed);

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

export async function bulkCreateTasksRoute(input: {
  userId: string;
  projectId: string;
  tasks: Array<{
    title: string;
    description?: string;
    priority?: Priority;
    status?: Status;
    labelIds: string[];
    parentId?: string;
    dueDate?: string;
    assigneeIds?: string[];
  }>;
}) {
  await assertProjectAccess(input.projectId, input.userId, 'full');

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, teams: { take: 1, select: { id: true } } },
  });
  if (!project) throw new OwnershipError('project', input.projectId, 'not_found');
  const resolvedTeamId = project.teams[0]?.id;
  if (!resolvedTeamId) throw new ValidationError('Project must have a team');
  await assertTeamRole(resolvedTeamId, input.userId, ['owner', 'admin', 'member']);

  const labelIds = [...new Set(input.tasks.flatMap((t) => t.labelIds))];
  const labels = labelIds.length
    ? await prisma.label.findMany({ where: { id: { in: labelIds }, projectId: input.projectId }, select: { id: true } })
    : [];
  const validLabelIds = new Set(labels.map((l) => l.id));

  const parentIds = [...new Set(input.tasks.map((t) => t.parentId).filter((id): id is string => Boolean(id)))];
  const parentTasks = parentIds.length
    ? await prisma.task.findMany({
        where: { id: { in: parentIds }, OR: [{ projectId: input.projectId }, { teamId: resolvedTeamId }] },
        select: { id: true },
      })
    : [];
  const validParentIds = new Set(parentTasks.map((t) => t.id));

  const failed: Array<{ index: number; error: string }> = [];
  const validTasks = input.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task, index }) => {
      const invalidLabels = task.labelIds.filter((id) => !validLabelIds.has(id));
      if (invalidLabels.length > 0) {
        failed.push({ index, error: `Invalid labelIds: ${invalidLabels.join(', ')}` });
        return false;
      }
      if (task.parentId && !validParentIds.has(task.parentId)) {
        failed.push({ index, error: 'parentId must reference an existing accessible task' });
        return false;
      }
      return true;
    });

  const created: TaskWithInclude[] = validTasks.length
    ? await prisma.$transaction(async (tx) => {
        const team = await tx.team.update({
          where: { id: resolvedTeamId },
          data: { nextIssueNumber: { increment: validTasks.length } },
          select: { key: true, nextIssueNumber: true },
        });
        const startNumber = team.nextIssueNumber - validTasks.length;
        const createdTasks: TaskWithInclude[] = [];
        for (let i = 0; i < validTasks.length; i += 1) {
          const { task } = validTasks[i];
          const number = startNumber + i;
          createdTasks.push(await tx.task.create({
            data: {
              title: task.title,
              description: task.description,
              priority: task.priority,
              status: task.status,
              teamId: resolvedTeamId,
              projectId: input.projectId,
              parentId: task.parentId,
              number,
              identifier: `${team.key}-${number}`,
              dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
              creatorId: input.userId,
              labels: task.labelIds.length
                ? { create: task.labelIds.map((labelId) => ({ labelId })) }
                : undefined,
              taskAssignees: task.assigneeIds?.length
                ? { create: task.assigneeIds.map((userId) => ({ userId, role: 'assignee' as const })) }
                : undefined,
            },
            include: taskInclude,
          }));
        }
        return createdTasks;
      }, { timeout: 15000, maxWait: 5000 })
    : [];

  const transformed = created.map(flattenTaskLabels);
  await broadcastToProject(input.projectId, 'tasks:bulk-created', {
    type: 'tasks:bulk-created',
    projectId: input.projectId,
    count: transformed.length,
    taskIds: transformed.map((t) => t.id),
  });

  await Promise.all(created.map((task) => logActivity({
    taskId: task.id, projectId: task.projectId, teamId: task.teamId, userId: input.userId,
    action: 'task_created',
    payload: { title: task.title, status: task.status, priority: task.priority, identifier: task.identifier, source: 'bulk' },
  })));

  return { created: transformed, failed };
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
    await prisma.task.delete({ where: { id: input.taskId } });
  } else {
    await prisma.task.update({ where: { id: input.taskId }, data: { archived: true } });
  }

  const teamId = fullTask?.teamId ?? owned.teamId ?? null;
  const creatorId = fullTask?.creatorId ?? null;
  if (teamId) {
    broadcastToTeam(teamId, 'task:deleted', { id: input.taskId });
  } else if (creatorId) {
    broadcastToUser(creatorId, 'task:deleted', { id: input.taskId });
  } else {
    broadcastToUser(input.userId, 'task:deleted', { id: input.taskId });
  }

  if (!input.permanent) {
    await logActivity({
      taskId: input.taskId, projectId: owned.projectId, teamId,
      userId: input.userId, action: 'task_archived',
      payload: { id: input.taskId },
    });
  }
}
