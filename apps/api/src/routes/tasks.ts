import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import {
  createTaskRoute,
  updateTaskRoute,
  bulkCreateTasksRoute,
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
  updateTaskBodySchema,
  listTasksQuerySchema,
  CreateTaskBody,
  BulkCreateTasksBody,
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

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const permanent = req.query.permanent === 'true';
  await deleteTaskRoute({ userId: req.userId!, taskId: req.params.id as string, permanent });
  res.status(204).send();
});

export default router;
