import { Router, type Response } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { z } from 'zod';
import { HttpError } from '../errors';
import { assertTaskAccess } from '../services/ownership';
import {
  authorizeBulkCreateTasks,
  authorizeCreateTask,
  updateTaskRoute,
  bulkUpdateTaskStatus,
  bulkArchiveTasks,
  bulkDeleteTasks,
  deleteTaskRoute,
  deleteAllArchivedTasks,
  deleteArchivedTask,
  getTask,
  listTasksPaginated,
  listTasksByCursor,
  listArchivedTasksPaginated,
} from '../services/tasks';
import {
  createTaskBodySchema,
  bulkCreateTasksSchema,
  bulkStatusBodySchema,
  bulkArchiveBodySchema,
  bulkDeleteBodySchema,
  dependencyEdgesQuerySchema,
  similarTasksQuerySchema,
  taskDependencyBodySchema,
  updateTaskBodySchema,
  listTasksQuerySchema,
  CreateTaskBody,
  BulkCreateTasksBody,
  BulkStatusBody,
  BulkArchiveBody,
  BulkDeleteBody,
  DependencyEdgesQuery,
  SimilarTasksQuery,
  TaskDependencyBody,
  UpdateTaskBody,
  ListTasksQuery,
} from '../schemas/tasks';
import { paginationQuerySchema, paginated, PaginationQuery } from '../schemas/pagination';
import { respondIdempotently } from '../services/idempotency';
import { addTaskDependency, dependencyEdgesAmong, listTaskDependencies, openBlockerClosure, removeTaskDependency, similarTasks } from '../services/task-dependencies';

const router: Router = Router();

router.get('/archived', requireAuth, validateQuery(paginationQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, PaginationQuery>, res: Response) => {
    const { page, pageSize } = req.validQuery!;
    const result = await listArchivedTasksPaginated({ userId: req.userId!, page, pageSize });
    res.json(paginated(result.items, result.total, page, pageSize));
  },
);

router.delete('/archived', requireAuth, async (req: AuthRequest, res: Response) => {
  await deleteAllArchivedTasks(req.userId!);
  res.status(204).send();
});

router.delete('/archived/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  await deleteArchivedTask({ taskId: req.params.id as string, userId: req.userId! });
  res.status(204).send();
});

router.get('/', requireAuth, validateQuery(listTasksQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, ListTasksQuery>, res: Response) => {
    const query = req.validQuery!;
    const filters = {
      userId: req.userId!,
      teamId: query.teamId,
      projectId: query.projectId,
      assignee: query.assignee,
      creator: query.creator,
      status: query.status,
      labelIds: query.labelId,
      q: query.q,
      identifier: query.identifier,
      parentId: query.parentId,
    };
    const compact = query.view === 'compact';
    const cursorMode = query.cursor !== undefined || query.pagination === 'cursor';
    if (!cursorMode) {
      const { page, pageSize } = query;
      const result = await listTasksPaginated({ ...filters, page, pageSize, compact });
      res.json({ ...paginated(result.items, result.total, page, pageSize), nextCursor: result.nextCursor });
      return;
    }
    if (query.pagination === 'offset') {
      throw new HttpError(400, 'PAGINATION_CONFLICT', 'cursor cannot be combined with pagination=offset');
    }
    if (req.query.page !== undefined) {
      throw new HttpError(400, 'PAGINATION_CONFLICT', 'page cannot be combined with cursor pagination; follow nextCursor instead');
    }
    res.json(await listTasksByCursor({
      ...filters,
      cursor: query.cursor,
      pageSize: query.pageSize,
      includeTotal: query.includeTotal === 'true',
      compact,
    }));
  },
);

// Both creates honour an optional `Idempotency-Key` (W04a): the key is
// reserved, the tasks are written and the response is stored in one
// transaction; equal retries replay, different bodies get 409.
router.post('/', requireAuth, validateBody(createTaskBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateTaskBody>, res: Response) => {
    const body = req.validBody!;
    const { title, description, priority, status, labelIds, teamId, projectId, dueDate, model, agent, assigneeId, assigneeIds } = body;
    await respondIdempotently(req, res, {
      operation: 'tasks.create',
      args: { body },
      authorize: () => authorizeCreateTask({
        userId: req.userId!, title, description, priority, status, labelIds, teamId, projectId, dueDate, model, agent,
        assigneeId, assigneeIds,
      }),
    });
  },
);

router.post('/bulk', requireAuth(['tasks:write']), validateBody(bulkCreateTasksSchema),
  async (req: AuthRequest & ValidatedRequest<BulkCreateTasksBody>, res: Response) => {
    const body = req.validBody!;
    await respondIdempotently(req, res, {
      operation: 'tasks.bulk_create',
      args: { body },
      authorize: () => authorizeBulkCreateTasks({ userId: req.userId!, projectId: body.projectId, tasks: body.tasks }),
    });
  },
);

router.patch('/bulk-status', requireAuth(['tasks:write']), validateBody(bulkStatusBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkStatusBody>, res: Response) => {
    const { projectId, teamId, status, taskIds } = req.validBody!;
    const result = await bulkUpdateTaskStatus({ userId: req.userId!, projectId, teamId, status, taskIds, source: 'bulk' });
    res.json(result);
  },
);

router.post('/bulk-archive', requireAuth(['tasks:write']), validateBody(bulkArchiveBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkArchiveBody>, res: Response) => {
    const { projectId, teamId, taskIds, identifiers } = req.validBody!;
    const result = await bulkArchiveTasks({ userId: req.userId!, projectId, teamId, taskIds, identifiers, source: 'bulk' });
    res.json(result);
  },
);

router.post('/bulk-delete', requireAuth(['tasks:write']), validateBody(bulkDeleteBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkDeleteBody>, res: Response) => {
    const { projectId, teamId, taskIds, permanent } = req.validBody!;
    const result = await bulkDeleteTasks({ userId: req.userId!, projectId, teamId, taskIds, permanent });
    res.json(result);
  },
);

// FE-11: similar open issues in a project (duplicate hints); before `/:id`.
router.get('/similar', requireAuth, validateQuery(similarTasksQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, SimilarTasksQuery>, res: Response) => {
    const query = req.validQuery!;
    res.json(await similarTasks({ projectId: query.projectId, title: query.title, limit: query.limit, excludeTaskId: query.excludeTaskId, userId: req.userId! }));
  },
);

// W17a: "blocked by" relations. Edges among a set of tasks (batch ordering);
// registered before `/:id`.
router.get('/dependencies', requireAuth, validateQuery(dependencyEdgesQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, DependencyEdgesQuery>, res: Response) => {
    const edges = await dependencyEdgesAmong({ taskIds: req.validQuery!.taskIds ?? [], userId: req.userId! });
    res.json({ edges });
  },
);

// FE-10: unfinished blockers, transitively ("run with blockers").
router.get('/:id/dependencies/closure', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await openBlockerClosure({ taskId: req.params.id as string, userId: req.userId! }));
});

router.get('/:id/dependencies', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await listTaskDependencies({ taskId: req.params.id as string, userId: req.userId! }));
});

router.post('/:id/dependencies', requireAuth(['tasks:write']), validateBody(taskDependencyBodySchema),
  async (req: AuthRequest & ValidatedRequest<TaskDependencyBody>, res: Response) => {
    const result = await addTaskDependency({ taskId: req.params.id as string, dependsOnTaskId: req.validBody!.dependsOnTaskId, userId: req.userId! });
    res.status(result.created ? 201 : 200).json(result);
  },
);

router.delete('/:id/dependencies/:dependsOnTaskId', requireAuth(['tasks:write']), async (req: AuthRequest, res: Response) => {
  await removeTaskDependency({ taskId: req.params.id as string, dependsOnTaskId: req.params.dependsOnTaskId as string, userId: req.userId! });
  res.status(204).send();
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const task = await getTask({ taskId: req.params.id as string, userId: req.userId! });
  res.json(task);
});

router.patch('/:id', requireAuth, validateBody(updateTaskBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateTaskBody>, res: Response) => {
    const { labelIds, teamId, projectId, dueDate, assigneeId, assigneeIds, watcherIds, ...updateData } = req.validBody!;
    const task = await updateTaskRoute({
      userId: req.userId!, taskId: req.params.id as string,
      labelIds, teamId, projectId, dueDate, assigneeId, assigneeIds, watcherIds, ...updateData,
    });
    res.json(task);
  },
);

const executionPatchSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional(),
  sessionId: z.string().nullable().optional(),
  executionStartedAt: z.string().datetime().nullable().optional(),
  executionProgress: z.number().int().min(0).max(100).nullable().optional(),
  executionElapsedMs: z.number().int().min(0).optional(),
  executionLogs: z.unknown().optional(),
  prUrl: z.string().nullable().optional(),
  outcome: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  batchId: z.string().nullable().optional(),
});

router.patch(
  '/:id/execution',
  requireAuth(['tasks:write']),
  validateBody(executionPatchSchema),
  async (req: AuthRequest & ValidatedRequest<z.infer<typeof executionPatchSchema>>, res: Response) => {
    const taskId = req.params.id as string;
    await assertTaskAccess(taskId, req.userId!, 'full');
    const body = req.validBody!;
    const task = await prisma.task.update({
      where: { id: taskId },
      data: {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
        ...(body.executionStartedAt !== undefined
          ? { executionStartedAt: body.executionStartedAt ? new Date(body.executionStartedAt) : null }
          : {}),
        ...(body.executionProgress !== undefined ? { executionProgress: body.executionProgress } : {}),
        ...(body.executionElapsedMs !== undefined ? { executionElapsedMs: body.executionElapsedMs } : {}),
        ...(body.executionLogs !== undefined ? { executionLogs: body.executionLogs as object } : {}),
        ...(body.prUrl !== undefined ? { prUrl: body.prUrl } : {}),
        ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
        ...(body.agent !== undefined ? { agent: body.agent } : {}),
        ...(body.batchId !== undefined ? { batchId: body.batchId } : {}),
      },
    });
    res.json(task);
  },
);

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const permanent = req.query.permanent === 'true';
  await deleteTaskRoute({ userId: req.userId!, taskId: req.params.id as string, permanent });
  res.status(204).send();
});

export default router;
