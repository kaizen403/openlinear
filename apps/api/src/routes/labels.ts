import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { broadcastToProject, broadcastToTaskById } from '../sse';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, ValidatedRequest } from '../middleware/validate';
import {
  assertProjectMember,
  assertTaskOwned,
  OwnershipError,
} from '../services/ownership';
import {
  createLabelBodySchema,
  updateLabelBodySchema,
  assignLabelBodySchema,
  listLabelsQuerySchema,
  CreateLabelBody,
  UpdateLabelBody,
  AssignLabelBody,
  ListLabelsQuery,
} from '../schemas/labels';

const router: Router = Router();

async function assertLabelAccess(labelId: string, userId: string): Promise<string> {
  const label = await prisma.label.findUnique({
    where: { id: labelId },
    select: { projectId: true },
  });
  if (!label) {
    throw new OwnershipError('label', labelId, 'not_found');
  }
  await assertProjectMember(label.projectId, userId);
  return label.projectId;
}

router.get(
  '/',
  requireAuth,
  validateQuery(listLabelsQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, ListLabelsQuery>, res: Response) => {

    const { projectId } = req.validQuery!;
    await assertProjectMember(projectId, req.userId!);

    const labels = await prisma.label.findMany({
      where: { projectId },
      orderBy: { priority: 'desc' },
    });
    res.json(labels);
    
  },
);

router.post(
  '/',
  requireAuth,
  validateBody(createLabelBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateLabelBody>, res: Response) => {

    const { projectId, ...rest } = req.validBody!;
    await assertProjectMember(projectId, req.userId!);

    const label = await prisma.label.create({
      data: { ...rest, projectId },
    });

    broadcastToProject(projectId, 'label:created', label);
    res.status(201).json(label);
    
  },
);

router.patch(
  '/:id',
  requireAuth,
  validateBody(updateLabelBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateLabelBody>, res: Response) => {

    const id = req.params.id as string;
    const projectId = await assertLabelAccess(id, req.userId!);

    const label = await prisma.label.update({
      where: { id },
      data: req.validBody!,
    });

    broadcastToProject(projectId, 'label:updated', label);
    res.json(label);
    
  },
);

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {

  const id = req.params.id as string;
  const projectId = await assertLabelAccess(id, req.userId!);

  await prisma.label.delete({ where: { id } });
  broadcastToProject(projectId, 'label:deleted', { id });
  res.status(204).send();
  
});

router.post(
  '/tasks/:id/labels',
  requireAuth,
  validateBody(assignLabelBodySchema),
  async (req: AuthRequest & ValidatedRequest<AssignLabelBody>, res: Response) => {

    const taskId = req.params.id as string;
    const { labelId } = req.validBody!;

    await assertTaskOwned(taskId, req.userId!);
    await assertLabelAccess(labelId, req.userId!);

    const taskLabel = await prisma.taskLabel.create({
      data: { taskId, labelId },
      include: { label: true },
    });

    broadcastToTaskById(taskId, 'task:label:assigned', { taskId, label: taskLabel.label });
    res.status(201).json(taskLabel);
    
  },
);

router.delete('/tasks/:id/labels/:labelId', requireAuth, async (req: AuthRequest, res: Response) => {

  const taskId = req.params.id as string;
  const labelId = req.params.labelId as string;

  await assertTaskOwned(taskId, req.userId!);

  await prisma.taskLabel.delete({
    where: { taskId_labelId: { taskId, labelId } },
  });

  broadcastToTaskById(taskId, 'task:label:removed', { taskId, labelId });
  res.status(204).send();
  
});

export default router;
