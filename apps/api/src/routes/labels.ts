import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, type ValidatedRequest } from '../middleware/validate';
import {
  assignLabelToTask,
  createLabel,
  deleteLabel,
  listLabels,
  removeLabelFromTask,
  updateLabel,
} from '../services/labels';
import {
  createLabelBodySchema,
  updateLabelBodySchema,
  assignLabelBodySchema,
  listLabelsQuerySchema,
  type CreateLabelBody,
  type UpdateLabelBody,
  type AssignLabelBody,
  type ListLabelsQuery,
} from '../schemas/labels';

// Every write appends its SSE event in the write's transaction
// (services/labels.ts, W04b).
const router: Router = Router();

router.get(
  '/',
  requireAuth,
  validateQuery(listLabelsQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, ListLabelsQuery>, res: Response) => {
    const { projectId } = req.validQuery!;
    res.json(await listLabels({ projectId, userId: req.userId! }));
  },
);

router.post(
  '/',
  requireAuth,
  validateBody(createLabelBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateLabelBody>, res: Response) => {
    const { projectId, name, color, priority } = req.validBody!;
    const label = await createLabel({ projectId, userId: req.userId!, name, color, priority });
    res.status(201).json(label);
  },
);

router.patch(
  '/:id',
  requireAuth,
  validateBody(updateLabelBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateLabelBody>, res: Response) => {
    const label = await updateLabel({ labelId: req.params.id as string, userId: req.userId!, ...req.validBody! });
    res.json(label);
  },
);

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  await deleteLabel({ labelId: req.params.id as string, userId: req.userId! });
  res.status(204).send();
});

/** The label must belong to the task's project (400 `LABEL_NOT_IN_TASK_PROJECT`). */
router.post(
  '/tasks/:id/labels',
  requireAuth,
  validateBody(assignLabelBodySchema),
  async (req: AuthRequest & ValidatedRequest<AssignLabelBody>, res: Response) => {
    const taskLabel = await assignLabelToTask({
      taskId: req.params.id as string,
      labelId: req.validBody!.labelId,
      userId: req.userId!,
    });
    res.status(201).json(taskLabel);
  },
);

router.delete('/tasks/:id/labels/:labelId', requireAuth, async (req: AuthRequest, res: Response) => {
  await removeLabelFromTask({
    taskId: req.params.id as string,
    labelId: req.params.labelId as string,
    userId: req.userId!,
  });
  res.status(204).send();
});

export default router;
