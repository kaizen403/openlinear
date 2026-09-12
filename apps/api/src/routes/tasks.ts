import { Router, type Response } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import { z } from 'zod';
import { HttpError } from '../errors';
import { assertTaskAccess } from '../services/ownership';
import {
  createTaskRoute,
  updateTaskRoute,
  bulkCreateTasksRoute,
  bulkUpdateTaskStatus,
  bulkArchiveTasks,
  bulkDeleteTasks,
  deleteTaskRoute,
  deleteAllArchivedTasks,
  deleteArchivedTask,
  getTask,
  listTasksPaginated,
  listArchivedTasksPaginated,
} from '../services/tasks';
import {
  createTaskBodySchema,
  bulkCreateTasksSchema,
  bulkStatusBodySchema,
  bulkArchiveBodySchema,
  bulkDeleteBodySchema,
  updateTaskBodySchema,
  listTasksQuerySchema,
  CreateTaskBody,
  BulkCreateTasksBody,
  BulkStatusBody,
  BulkArchiveBody,
  BulkDeleteBody,
  UpdateTaskBody,
  ListTasksQuery,
} from '../schemas/tasks';
import { paginationQuerySchema, paginated, PaginationQuery } from '../schemas/pagination';

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
    const { teamId, projectId, assignee, creator, page, pageSize } = req.validQuery!;
    const result = await listTasksPaginated({ userId: req.userId!, teamId, projectId, assignee, creator, page, pageSize });
    res.json(paginated(result.items, result.total, page, pageSize));
  },
);

router.post('/', requireAuth, validateBody(createTaskBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateTaskBody>, res: Response) => {
    const { title, description, priority, status, labelIds, teamId, projectId, dueDate, model } = req.validBody!;
    const task = await createTaskRoute({ userId: req.userId!, title, description, priority, status, labelIds, teamId, projectId, dueDate, model });
    res.status(201).json(task);
  },
);

router.post('/bulk', requireAuth(['tasks:write']), validateBody(bulkCreateTasksSchema),
  async (req: AuthRequest & ValidatedRequest<BulkCreateTasksBody>, res: Response) => {
    const { projectId, tasks } = req.validBody!;
    const result = await bulkCreateTasksRoute({ userId: req.userId!, projectId, tasks });
    res.status(201).json(result);
  },
);

router.patch('/bulk-status', requireAuth(['tasks:write']), validateBody(bulkStatusBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkStatusBody>, res: Response) => {
    const { projectId, status, taskIds } = req.validBody!;
    const result = await bulkUpdateTaskStatus({ userId: req.userId!, projectId, status, taskIds });
    res.json(result);
  },
);

router.post('/bulk-archive', requireAuth(['tasks:write']), validateBody(bulkArchiveBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkArchiveBody>, res: Response) => {
    const { projectId, taskIds, identifiers } = req.validBody!;
    const result = await bulkArchiveTasks({ userId: req.userId!, projectId, taskIds, identifiers });
    res.json(result);
  },
);

router.post('/bulk-delete', requireAuth(['tasks:write']), validateBody(bulkDeleteBodySchema),
  async (req: AuthRequest & ValidatedRequest<BulkDeleteBody>, res: Response) => {
    const { projectId, taskIds, permanent } = req.validBody!;
    const result = await bulkDeleteTasks({ userId: req.userId!, projectId, taskIds, permanent });
    res.json(result);
  },
);

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
