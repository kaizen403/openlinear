import { Router, Request, Response } from 'express';
import { prisma } from '@openlinear/db';
import { z } from 'zod';
import { broadcast } from '../sse';
import { executeTask, cancelTask, isTaskRunning, getExecutionLogs } from '../services/execution';
import { optionalAuth, AuthRequest } from '../middleware/auth';

const PriorityEnum = z.enum(['low', 'medium', 'high']);
const StatusEnum = z.enum(['todo', 'in_progress', 'done', 'cancelled']);

const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  priority: PriorityEnum.optional().default('medium'),
  labelIds: z.array(z.string().uuid()).optional().default([]),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  priority: PriorityEnum.optional(),
  status: StatusEnum.optional(),
  labelIds: z.array(z.string().uuid()).optional(),
});

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
}

function flattenLabels(task: TaskWithLabels) {
  return {
    ...task,
    labels: task.labels.map((tl: TaskLabel) => tl.label),
  };
}

const router: Router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({
      include: {
        labels: {
          include: {
            label: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(tasks.map(flattenLabels));
  } catch (error) {
    console.error('[Tasks] Error listing tasks:', error);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { title, description, priority, labelIds } = parsed.data;

    const task = await prisma.task.create({
      data: {
        title,
        description,
        priority,
        labels: {
          create: labelIds.map((labelId) => ({ labelId })),
        },
      },
      include: {
        labels: {
          include: {
            label: true,
          },
        },
      },
    });

    const transformedTask = flattenLabels(task);
    broadcast('task:created', transformedTask);
    res.status(201).json(transformedTask);
  } catch (error) {
    console.error('[Tasks] Error creating task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        labels: {
          include: {
            label: true,
          },
        },
      },
    });

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json(flattenLabels(task));
  } catch (error) {
    console.error('[Tasks] Error getting task:', error);
    res.status(500).json({ error: 'Failed to get task' });
  }
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const parsed = UpdateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { labelIds, ...updateData } = parsed.data;

    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const task = await prisma.task.update({
      where: { id },
      data: {
        ...updateData,
        ...(labelIds !== undefined && {
          labels: {
            deleteMany: {},
            create: labelIds.map((labelId) => ({ labelId })),
          },
        }),
      },
      include: {
        labels: {
          include: {
            label: true,
          },
        },
      },
    });

    const transformedTask = flattenLabels(task);
    broadcast('task:updated', transformedTask);
    res.json(transformedTask);
  } catch (error) {
    console.error('[Tasks] Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    await prisma.task.delete({ where: { id } });

    broadcast('task:deleted', { id });
    res.status(204).send();
  } catch (error) {
    console.error('[Tasks] Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

router.post('/:id/execute', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    console.log(`[Tasks] Execute requested for task ${id.slice(0, 8)} (userId: ${req.userId || 'anonymous'})`);
    const result = await executeTask({ taskId: id, userId: req.userId });

    if (!result.success) {
      console.log(`[Tasks] Execute failed: ${result.error}`);
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ message: 'Task execution started' });
  } catch (error) {
    console.error('[Tasks] Error executing task:', error);
    res.status(500).json({ error: 'Failed to execute task' });
  }
});

router.get('/:id/running', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    res.json({ running: isTaskRunning(id) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check task status' });
  }
});

router.get('/:id/logs', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const logs = getExecutionLogs(id);
    res.json({ logs });
  } catch (error) {
    console.error('[Tasks] Error getting execution logs:', error);
    res.status(500).json({ error: 'Failed to get execution logs' });
  }
});

router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    console.log(`[Tasks] Cancel requested for task ${id.slice(0, 8)}`);

    if (!isTaskRunning(id)) {
      console.log(`[Tasks] Task ${id.slice(0, 8)} is not running, cannot cancel`);
      res.status(400).json({ error: 'Task is not running' });
      return;
    }

    const result = await cancelTask(id);

    if (!result.success) {
      console.log(`[Tasks] Cancel failed: ${result.error}`);
      res.status(400).json({ error: result.error });
      return;
    }

    console.log(`[Tasks] Task ${id.slice(0, 8)} cancelled`);
    res.json({ message: 'Task cancelled' });
  } catch (error) {
    console.error('[Tasks] Error cancelling task:', error);
    res.status(500).json({ error: 'Failed to cancel task' });
  }
});

export default router;
