import { Router, Request, Response } from 'express';
import { prisma } from '@openlinear/db';
import { z } from 'zod';
import { broadcast } from '../sse';

const router: Router = Router();

const createLabelSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex color'),
  priority: z.number().int().min(0).default(0),
});

const updateLabelSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex color').optional(),
  priority: z.number().int().min(0).optional(),
});

const assignLabelSchema = z.object({
  labelId: z.string().uuid(),
});

router.get('/', async (_req: Request, res: Response) => {
  try {
    const labels = await prisma.label.findMany({
      orderBy: { priority: 'desc' },
    });
    res.json(labels);
  } catch (error) {
    console.error('[Labels] Error fetching labels:', error);
    res.status(500).json({ error: 'Failed to fetch labels' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createLabelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const label = await prisma.label.create({
      data: parsed.data,
    });

    broadcast('label:created', label);
    res.status(201).json(label);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      res.status(409).json({ error: 'Label with this name already exists' });
      return;
    }
    console.error('[Labels] Error creating label:', error);
    res.status(500).json({ error: 'Failed to create label' });
  }
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const parsed = updateLabelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const label = await prisma.label.update({
      where: { id },
      data: parsed.data,
    });

    broadcast('label:updated', label);
    res.json(label);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Record to update not found')) {
      res.status(404).json({ error: 'Label not found' });
      return;
    }
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      res.status(409).json({ error: 'Label with this name already exists' });
      return;
    }
    console.error('[Labels] Error updating label:', error);
    res.status(500).json({ error: 'Failed to update label' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    await prisma.label.delete({
      where: { id },
    });

    broadcast('label:deleted', { id });
    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Record to delete does not exist')) {
      res.status(404).json({ error: 'Label not found' });
      return;
    }
    console.error('[Labels] Error deleting label:', error);
    res.status(500).json({ error: 'Failed to delete label' });
  }
});

router.post('/tasks/:id/labels', async (req: Request, res: Response) => {
  try {
    const taskId = req.params.id as string;
    const parsed = assignLabelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const { labelId } = parsed.data;

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const label = await prisma.label.findUnique({ where: { id: labelId } });
    if (!label) {
      res.status(404).json({ error: 'Label not found' });
      return;
    }

    const taskLabel = await prisma.taskLabel.create({
      data: { taskId, labelId },
      include: { label: true },
    });

    broadcast('task:label:assigned', { taskId, label: taskLabel.label });
    res.status(201).json(taskLabel);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      res.status(409).json({ error: 'Label already assigned to this task' });
      return;
    }
    console.error('[Labels] Error assigning label:', error);
    res.status(500).json({ error: 'Failed to assign label' });
  }
});

router.delete('/tasks/:id/labels/:labelId', async (req: Request, res: Response) => {
  try {
    const taskId = req.params.id as string;
    const labelId = req.params.labelId as string;

    await prisma.taskLabel.delete({
      where: {
        taskId_labelId: { taskId, labelId },
      },
    });

    broadcast('task:label:removed', { taskId, labelId });
    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Record to delete does not exist')) {
      res.status(404).json({ error: 'Label assignment not found' });
      return;
    }
    console.error('[Labels] Error removing label:', error);
    res.status(500).json({ error: 'Failed to remove label' });
  }
});

export default router;
