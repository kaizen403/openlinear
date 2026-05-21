import { Router, Response, NextFunction } from 'express';
import { Prisma, prisma } from '@openlinear/db';
import { broadcastToProject, broadcastToTask, broadcastToTeam, broadcastToUser } from '../sse';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { getUserTeamIds } from '../services/team-scope';
import {
  assertTaskOwned,
  assertTaskAccess,
  assertProjectAccess,
  assertProjectOwned,
  assertTeamRole,
  OwnershipError,
} from '../services/ownership';
import { buildProjectAccessWhere, buildProjectFullAccessWhere } from '../services/workspaces';
import { ValidationError } from '../errors';
import { logActivity } from '../services/activity';
import { createNotification } from './notifications';
import {
  createTaskBodySchema,
  bulkCreateTasksSchema,
  updateTaskBodySchema,
  listTasksQuerySchema,
  CreateTaskBody,
  BulkCreateTasksBody,
  UpdateTaskBody,
  ListTasksQuery,
} from '../schemas/tasks';
import { paginationQuerySchema, paginated, paginationSkipTake, PaginationQuery } from '../schemas/pagination';

interface Label {
  id: string;
  name: string;
  color: string;
  priority: number;
}

interface TaskLabel {
  taskId: string;
  labelId: string;
  label: Label;
}

interface TaskWithLabels {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  labels: TaskLabel[];
  teamId: string | null;
  projectId: string | null;
  number: number | null;
  identifier: string | null;
  team?: { id: string; name: string; key: string; color: string } | null;
  project?: { id: string; name: string; status: string; color: string } | null;
  [key: string]: unknown;
}

function flattenLabels<T extends { labels: TaskLabel[] }>(task: T): Omit<T, 'labels'> & { labels: Label[] } {
  const { labels, ...rest } = task;
  return {
    ...rest,
    labels: labels.map((tl) => tl.label),
  };
}

async function resolveProjectTeamId(projectId: string): Promise<{ teamId: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { projectTeams: { select: { teamId: true } } },
  });

  if (!project) {
    throw new OwnershipError('project', projectId, 'not_found');
  }

  if (project.projectTeams.length === 0) {
    throw new ValidationError('Project must have a team');
  }

  if (project.projectTeams.length > 1) {
    throw new ValidationError('Project must have exactly one team');
  }

  return { teamId: project.projectTeams[0].teamId };
}

const taskInclude = {
  labels: { include: { label: true } },
  team: { select: { id: true, name: true, key: true, color: true } },
  project: { select: { id: true, name: true, status: true, color: true } },
  assignee: { select: { id: true, username: true, avatarUrl: true } },
  creator: { select: { id: true, username: true, avatarUrl: true } },
};

const router: Router = Router();

function buildTaskProjectAccessWhere(userId: string, teamIds: string[]): Prisma.TaskWhereInput {
  return {
    OR: [
      { projectId: null, teamId: { in: teamIds } },
      { project: { is: buildProjectAccessWhere(userId, teamIds) } },
    ],
  };
}

function buildTaskProjectFullAccessWhere(userId: string, teamIds: string[]): Prisma.TaskWhereInput {
  return {
    OR: [
      { projectId: null, teamId: { in: teamIds } },
      { project: { is: buildProjectFullAccessWhere(userId, teamIds) } },
    ],
  };
}

router.get(
  '/archived',
  requireAuth,
  validateQuery(paginationQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, PaginationQuery>, res: Response, next: NextFunction) => {
    try {
      const { page, pageSize } = req.validQuery!;
      const teamIds = await getUserTeamIds(req.userId!);
      const where: Prisma.TaskWhereInput = {
        AND: [
          { archived: true },
          buildTaskProjectAccessWhere(req.userId!, teamIds),
        ],
      };
      const [tasks, total] = await prisma.$transaction(
        async (tx) => {
          const items = await tx.task.findMany({
            where,
            include: taskInclude,
            orderBy: { updatedAt: 'desc' },
            ...paginationSkipTake(page, pageSize),
          });
          const count = await tx.task.count({ where });
          return [items, count] as const;
        },
        { timeout: 15000, maxWait: 5000 },
      );
      res.json(paginated(tasks.map(flattenLabels), total, page, pageSize));
    } catch (error) {
      next(error);
    }
  },
);

router.delete('/archived', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const teamIds = await getUserTeamIds(req.userId!);
    const where: Prisma.TaskWhereInput = {
      AND: [
        { archived: true },
        buildTaskProjectFullAccessWhere(req.userId!, teamIds),
      ],
    };
    await prisma.task.deleteMany({
      where,
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.delete('/archived/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const owned = await assertTaskOwned(id, req.userId!);
    if (!owned.archived) {
      throw new OwnershipError('task', id, 'not_found');
    }
    await prisma.task.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get(
  '/',
  requireAuth,
  validateQuery(listTasksQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, ListTasksQuery>, res: Response, next: NextFunction) => {
    try {
      const { teamId, projectId, assignee, creator, page, pageSize } = req.validQuery!;

      const userTeamIds = await getUserTeamIds(req.userId!);
      const filters: Prisma.TaskWhereInput[] = [
        { archived: false },
        buildTaskProjectAccessWhere(req.userId!, userTeamIds),
      ];

      if (teamId) {
        if (!userTeamIds.includes(teamId)) {
          throw new OwnershipError('team', teamId, 'forbidden');
        }
        filters.push({ teamId });
      }
      if (projectId) {
        await assertProjectAccess(projectId, req.userId!, 'view');
        filters.push({ projectId });
      }

      const resolveUserFilter = async (value: string): Promise<string> => {
        if (value === 'me') return req.userId!;
        const member = await prisma.teamMember.findFirst({
          where: { userId: value, teamId: { in: userTeamIds } },
          select: { userId: true },
        });
        if (!member) {
          throw new OwnershipError('user', value, 'forbidden');
        }
        return value;
      };

      if (assignee && creator) {
        const [assigneeId, creatorId] = await Promise.all([
          resolveUserFilter(assignee),
          resolveUserFilter(creator),
        ]);
        filters.push({ OR: [{ assigneeId }, { creatorId }] });
      } else if (assignee) {
        filters.push({ assigneeId: await resolveUserFilter(assignee) });
      } else if (creator) {
        filters.push({ creatorId: await resolveUserFilter(creator) });
      }
      const where: Prisma.TaskWhereInput = { AND: filters };

      const [tasks, total] = await prisma.$transaction(
        async (tx) => {
          const items = await tx.task.findMany({
            where,
            include: taskInclude,
            orderBy: { createdAt: 'desc' },
            ...paginationSkipTake(page, pageSize),
          });
          const count = await tx.task.count({ where });
          return [items, count] as const;
        },
        { timeout: 15000, maxWait: 5000 },
      );

      res.json(paginated(tasks.map(flattenLabels), total, page, pageSize));
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/',
  requireAuth,
  validateBody(createTaskBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateTaskBody>, res: Response, next: NextFunction) => {
    try {
      const { title, description, priority, status, labelIds, teamId, projectId, dueDate, model } =
        req.validBody!;

      let resolvedTeamId = teamId;

      if (projectId) {
        await assertProjectOwned(projectId, req.userId!);
        const projectTeam = await resolveProjectTeamId(projectId);
        resolvedTeamId = projectTeam.teamId;
      }

      if (!resolvedTeamId) {
        throw new ValidationError('Task must belong to a team or a project');
      }

      await assertTeamRole(resolvedTeamId, req.userId!, ['owner', 'admin', 'member']);

      const task: TaskWithLabels = await prisma.$transaction(async (tx) => {
        const team = await tx.team.update({
          where: { id: resolvedTeamId },
          data: { nextIssueNumber: { increment: 1 } },
          select: { key: true, nextIssueNumber: true },
        });
        const number = team.nextIssueNumber - 1;
        const identifier = `${team.key}-${number}`;

        const created = await tx.task.create({
          data: {
            title,
            description,
            priority,
            status,
            teamId: resolvedTeamId,
            projectId: projectId || undefined,
            number,
            identifier,
            dueDate: dueDate ? new Date(dueDate) : undefined,
            model: model ?? undefined,
            creatorId: req.userId!,
            labels: {
              create: labelIds.map((labelId) => ({ labelId })),
            },
          },
          include: taskInclude,
        });
        return created;
      }, { timeout: 15000, maxWait: 5000 });

      const transformedTask = flattenLabels(task);
      broadcastToTask('task:created', transformedTask);

      await logActivity({
        taskId: task.id,
        projectId: task.projectId,
        teamId: task.teamId,
        userId: req.userId!,
        action: 'task_created',
        payload: {
          title: task.title,
          status: task.status,
          priority: task.priority,
          identifier: task.identifier,
        },
      });

      const taskAssigneeId = (task as { assigneeId?: string | null }).assigneeId;
      if (taskAssigneeId && taskAssigneeId !== req.userId) {
        await createNotification({
          recipientUserId: taskAssigneeId,
          actorUserId: req.userId!,
          type: 'assignment',
          taskId: task.id,
          body: `Assigned to you: ${task.title}`,
        });
      }

      res.status(201).json(transformedTask);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/bulk',
  requireAuth(['tasks:write']),
  validateBody(bulkCreateTasksSchema),
  async (req: AuthRequest & ValidatedRequest<BulkCreateTasksBody>, res: Response, next: NextFunction) => {
    try {
      const { projectId, tasks } = req.validBody!;
      await assertProjectAccess(projectId, req.userId!, 'full');

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          projectTeams: {
            take: 1,
            select: { teamId: true },
          },
        },
      });

      if (!project) {
        throw new OwnershipError('project', projectId, 'not_found');
      }
      const resolvedTeamId = project.projectTeams[0]?.teamId;
      if (!resolvedTeamId) {
        throw new ValidationError('Project must have a team');
      }
      await assertTeamRole(resolvedTeamId, req.userId!, ['owner', 'admin', 'member']);

      const labelIds = [...new Set(tasks.flatMap((task) => task.labelIds))];
      const labels = labelIds.length
        ? await prisma.label.findMany({
            where: {
              id: { in: labelIds },
              OR: [{ teamId: resolvedTeamId }, { teamId: null }],
            },
            select: { id: true },
          })
        : [];
      const validLabelIds = new Set(labels.map((label) => label.id));

      const parentIds = [...new Set(tasks.map((task) => task.parentId).filter((id): id is string => Boolean(id)))];
      const parentTasks = parentIds.length
        ? await prisma.task.findMany({
            where: {
              id: { in: parentIds },
              OR: [
                { projectId },
                { teamId: resolvedTeamId },
              ],
            },
            select: { id: true },
          })
        : [];
      const validParentIds = new Set(parentTasks.map((task) => task.id));

      const failed: Array<{ index: number; error: string }> = [];
      const validTasks = tasks
        .map((task, index) => ({ task, index }))
        .filter(({ task, index }) => {
          const invalidLabels = task.labelIds.filter((labelId) => !validLabelIds.has(labelId));
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

      const created: TaskWithLabels[] = validTasks.length
        ? await prisma.$transaction(async (tx) => {
            const team = await tx.team.update({
              where: { id: resolvedTeamId },
              data: { nextIssueNumber: { increment: validTasks.length } },
              select: { key: true, nextIssueNumber: true },
            });
            const startNumber = team.nextIssueNumber - validTasks.length;

            const createdTasks: TaskWithLabels[] = [];
            for (let i = 0; i < validTasks.length; i += 1) {
              const { task } = validTasks[i];
              const number = startNumber + i;
              const createdTask = await tx.task.create({
                data: {
                  title: task.title,
                  description: task.description,
                  priority: task.priority,
                  status: task.status,
                  teamId: resolvedTeamId,
                  projectId,
                  parentId: task.parentId,
                  number,
                  identifier: `${team.key}-${number}`,
                  dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
                  creatorId: req.userId!,
                  labels: task.labelIds.length
                    ? { create: task.labelIds.map((labelId) => ({ labelId })) }
                    : undefined,
                },
                include: taskInclude,
              });
              createdTasks.push(createdTask);
            }
            return createdTasks;
          }, { timeout: 15000, maxWait: 5000 })
        : [];

      const transformedTasks = created.map(flattenLabels);
      const taskIds = transformedTasks.map((task) => task.id);
      await broadcastToProject(projectId, 'tasks:bulk-created', {
        type: 'tasks:bulk-created',
        projectId,
        count: transformedTasks.length,
        taskIds,
      });

      await Promise.all(created.map((task) => logActivity({
        taskId: task.id,
        projectId: task.projectId,
        teamId: task.teamId,
        userId: req.userId!,
        action: 'task_created',
        payload: {
          title: task.title,
          status: task.status,
          priority: task.priority,
          identifier: task.identifier,
          source: 'bulk',
        },
      })));

      res.status(201).json({ created: transformedTasks, failed });
    } catch (error) {
      next(error);
    }
  },
);

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await assertTaskAccess(id, req.userId!, 'view');

    const task = await prisma.task.findUnique({
      where: { id },
      include: taskInclude,
    });

    if (!task) {
      throw new OwnershipError('task', id, 'not_found');
    }

    res.json(flattenLabels(task));
  } catch (error) {
    next(error);
  }
});

router.patch(
  '/:id',
  requireAuth,
  validateBody(updateTaskBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateTaskBody>, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const existing = await assertTaskOwned(id, req.userId!);
      const previousTaskMeta = await prisma.task.findUnique({
        where: { id },
        select: { assigneeId: true, creatorId: true, title: true },
      });

      const { labelIds, teamId, projectId, dueDate, assigneeId, ...updateData } = req.validBody!;

      const data: Record<string, unknown> = { ...updateData };

      if (dueDate !== undefined) {
        data.dueDate = dueDate ? new Date(dueDate) : null;
      }

      const shouldResetExecutionState =
        updateData.status !== undefined &&
        updateData.status !== existing.status &&
        ['done', 'cancelled', 'todo'].includes(updateData.status);

      if (shouldResetExecutionState) {
        data.sessionId = null;
        data.executionStartedAt = null;
        data.executionPausedAt = null;
        data.executionElapsedMs = 0;
        data.executionProgress = null;
      }

      if (projectId !== undefined) {
        if (projectId) {
          await assertProjectOwned(projectId, req.userId!);
          const projectTeam = await resolveProjectTeamId(projectId);
          data.projectId = projectId;
          data.teamId = projectTeam.teamId;
        } else {
          data.projectId = null;
          data.teamId = null;
        }
      } else if (teamId !== undefined) {
        if (teamId) {
          await assertTeamRole(teamId, req.userId!, ['owner', 'admin', 'member']);
        }
        data.teamId = teamId;
      }

      if (assigneeId !== undefined) {
        if (assigneeId === null) {
          data.assigneeId = null;
        } else {
          const effectiveTeamId =
            (data.teamId as string | null | undefined) ?? existing.teamId ?? null;
          if (!effectiveTeamId) {
            throw new ValidationError('Cannot assign user: task has no team');
          }
          const member = await prisma.teamMember.findFirst({
            where: { teamId: effectiveTeamId, userId: assigneeId },
            select: { userId: true },
          });
          if (!member) {
            throw new OwnershipError('user', assigneeId, 'forbidden');
          }
          data.assigneeId = assigneeId;
        }
      }

      if (labelIds !== undefined) {
        data.labels = {
          deleteMany: {},
          create: labelIds.map((labelId) => ({ labelId })),
        };
      }

      const task = await prisma.task.update({
        where: { id },
        data,
        include: taskInclude,
      });

      const transformedTask = flattenLabels(task);
      broadcastToTask('task:updated', transformedTask);

      const statusChanged =
        updateData.status !== undefined && updateData.status !== existing.status;
      const newAssigneeId = assigneeId;
      const previousAssigneeId = previousTaskMeta?.assigneeId ?? null;
      const assigneeChanged =
        newAssigneeId !== undefined && newAssigneeId !== previousAssigneeId;

      if (statusChanged) {
        await logActivity({
          taskId: task.id,
          projectId: task.projectId,
          teamId: task.teamId,
          userId: req.userId!,
          action: 'task_status_changed',
          payload: {
            from: existing.status,
            to: task.status,
            title: task.title,
          },
        });
        const creatorId = previousTaskMeta?.creatorId ?? null;
        if (creatorId && creatorId !== req.userId) {
          await createNotification({
            recipientUserId: creatorId,
            actorUserId: req.userId!,
            type: 'status_change',
            taskId: task.id,
            body: `Status changed: ${task.title} → ${task.status}`,
          });
        }
      } else {
        await logActivity({
          taskId: task.id,
          projectId: task.projectId,
          teamId: task.teamId,
          userId: req.userId!,
          action: 'task_updated',
          payload: { fields: Object.keys(updateData) },
        });
      }

      if (assigneeChanged && newAssigneeId && newAssigneeId !== req.userId) {
        await createNotification({
          recipientUserId: newAssigneeId,
          actorUserId: req.userId!,
          type: 'assignment',
          taskId: task.id,
          body: `Assigned to you: ${task.title}`,
        });
        await logActivity({
          taskId: task.id,
          projectId: task.projectId,
          teamId: task.teamId,
          userId: req.userId!,
          action: 'task_assigned',
          payload: { from: previousAssigneeId, to: newAssigneeId },
        });
      }

      res.json(transformedTask);
    } catch (error) {
      next(error);
    }
  },
);

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const owned = await assertTaskOwned(id, req.userId!);

    const fullTask = await prisma.task.findUnique({
      where: { id },
      select: { teamId: true, creatorId: true },
    });

    await prisma.task.update({
      where: { id },
      data: { archived: true },
    });

    const teamId = fullTask?.teamId ?? owned.teamId ?? null;
    const creatorId = fullTask?.creatorId ?? null;
    if (teamId) {
      broadcastToTeam(teamId, 'task:deleted', { id });
    } else if (creatorId) {
      broadcastToUser(creatorId, 'task:deleted', { id });
    } else {
      broadcastToUser(req.userId!, 'task:deleted', { id });
    }

    await logActivity({
      taskId: id,
      projectId: owned.projectId,
      teamId,
      userId: req.userId!,
      action: 'task_archived',
      payload: { id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
