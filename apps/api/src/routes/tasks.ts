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
  teamId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  priority: PriorityEnum.optional(),
  status: StatusEnum.optional(),
  labelIds: z.array(z.string().uuid()).optional(),
  teamId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
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
  teamId: string | null;
  projectId: string | null;
  number: number | null;
  identifier: string | null;
  team?: { id: string; name: string; key: string; color: string } | null;
  project?: { id: string; name: string; status: string; color: string } | null;
  [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenLabels(task: any) {
  const { labels, ...rest } = task;
  return {
    ...rest,
    labels: (labels as TaskLabel[]).map((tl: TaskLabel) => tl.label),
  };
}

const taskInclude = {
  labels: { include: { label: true } },
  team: { select: { id: true, name: true, key: true, color: true } },
  project: { select: { id: true, name: true, status: true, color: true } },
};

const router: Router = Router();

// --- Archived endpoints (must be before /:id routes) ---

router.get('/archived', async (_req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { archived: true },
      include: taskInclude,
      orderBy: { updatedAt: 'desc' },
    });

    res.json(tasks.map(flattenLabels));
  } catch (error) {
    console.error('[Tasks] Error listing archived tasks:', error);
    res.status(500).json({ error: 'Failed to list archived tasks' });
  }
});

router.delete('/archived', async (_req: Request, res: Response) => {
  try {
    await prisma.task.deleteMany({ where: { archived: true } });
    res.status(204).send();
  } catch (error) {
    console.error('[Tasks] Error deleting all archived tasks:', error);
    res.status(500).json({ error: 'Failed to delete archived tasks' });
  }
});

router.delete('/archived/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing || !existing.archived) {
      res.status(404).json({ error: 'Archived task not found' });
      return;
    }

    await prisma.task.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    console.error('[Tasks] Error permanently deleting task:', error);
    res.status(500).json({ error: 'Failed to permanently delete task' });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const { teamId, projectId } = req.query;
    const where: Record<string, unknown> = { archived: false };
    if (teamId) where.teamId = teamId as string;
    if (projectId) where.projectId = projectId as string;

    const tasks = await prisma.task.findMany({
      where,
      include: taskInclude,
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

    const { title, description, priority, labelIds, teamId, projectId } = parsed.data;

    if (teamId) {
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!team) {
        res.status(400).json({ error: 'Team not found' });
        return;
      }
    }

    if (projectId && !teamId) {
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        res.status(400).json({ error: 'Project not found' });
        return;
      }
    }

    let task;

    if (teamId) {
      task = await prisma.$transaction(async (tx) => {
        const team = await tx.team.update({
          where: { id: teamId },
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
            teamId,
            projectId: projectId || undefined,
            number,
            identifier,
            labels: {
              create: labelIds.map((labelId) => ({ labelId })),
            },
          },
          include: taskInclude,
        });
        return created;
      });
    } else {
      task = await prisma.task.create({
        data: {
          title,
          description,
          priority,
          projectId: projectId || undefined,
          labels: {
            create: labelIds.map((labelId) => ({ labelId })),
          },
        },
        include: taskInclude,
      });
    }

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
      include: taskInclude,
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

    const { labelIds, teamId, projectId, ...updateData } = parsed.data;

    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const data: Record<string, unknown> = { ...updateData };
    if (teamId !== undefined) data.teamId = teamId;
    if (projectId !== undefined) data.projectId = projectId;
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

    await prisma.task.update({
      where: { id },
      data: { archived: true },
    });

    broadcast('task:deleted', { id });
    res.status(204).send();
  } catch (error) {
    console.error('[Tasks] Error archiving task:', error);
    res.status(500).json({ error: 'Failed to archive task' });
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
    let logs = getExecutionLogs(id);

    if (logs.length === 0) {
      const result = await prisma.$queryRaw<Array<{ executionLogs: unknown }>>`
        SELECT "executionLogs" FROM tasks WHERE id = ${id}
      `;
      if (result.length > 0 && Array.isArray(result[0].executionLogs)) {
        logs = result[0].executionLogs as unknown as typeof logs;
      }
    }

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
