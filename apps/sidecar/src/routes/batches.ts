import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma, decryptToken } from '@openlinear/db';
import { optionalAuth, AuthRequest } from '@openlinear/api/middleware';
import { assertTaskOwned } from '@openlinear/api/ownership';
import {
  createBatch,
  startBatch,
  cancelBatch,
  cancelTask,
  getBatch,
  getActiveBatches,
  approveNextTask,
} from '../services/batch';
import type { BatchState, BatchTask, BatchStatusResponse } from '../types/batch';

const CreateBatchSchema = z.object({
  taskIds: z.array(z.string()).min(1).max(20),
  mode: z.enum(['parallel', 'queue']),
});

const router: Router = Router();

router.post('/', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { taskIds, mode } = parsed.data;
    const userId = req.userId || null;

    if (userId) {
      for (const tid of taskIds) {
        await assertTaskOwned(tid, userId);
      }
    }

    let accessToken: string | null = null;
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { accessToken: true },
      });
      try {
        accessToken = decryptToken(user?.accessToken ?? null);
      } catch (err) {
        console.error('[batch] failed to decrypt access token:', err);
        accessToken = null;
      }
    }

    const batch = await createBatch({
      taskIds,
      mode,
      projectId: '',
      userId,
      accessToken,
    });

    startBatch(batch.id);

    res.status(201).json({
      id: batch.id,
      status: batch.status,
      mode: batch.mode,
      tasks: batch.tasks.map((t: BatchTask) => ({
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        branch: t.branch,
      })),
      createdAt: batch.createdAt.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

function batchTaskGuard(batch: BatchState | undefined, userId: string | undefined): Promise<void> {
  if (!batch || !userId) return Promise.resolve();
  return Promise.all(
    batch.tasks.map((t: BatchTask) => assertTaskOwned(t.taskId, userId)),
  ).then(() => undefined);
}

router.get('/', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    const batches = getActiveBatches();
    const visible: BatchState[] = [];
    for (const b of batches) {
      if (!userId) {
        continue;
      }
      try {
        await batchTaskGuard(b, userId);
        visible.push(b);
      } catch {
        // skip batches not owned by the caller
      }
    }
    res.json(
      visible.map((b: BatchState) => ({
        id: b.id,
        status: b.status,
        mode: b.mode,
        taskCount: b.tasks.length,
        createdAt: b.createdAt.toISOString(),
      })),
    );
  } catch (error) {
    next(error);
  }
});

router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const batch = getBatch(id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    if (req.userId) {
      await batchTaskGuard(batch, req.userId);
    }

    const total = batch.tasks.length;
    const completed = batch.tasks.filter((t: BatchTask) => t.status === 'completed').length;
    const failed = batch.tasks.filter((t: BatchTask) => t.status === 'failed').length;
    const running = batch.tasks.filter((t: BatchTask) => t.status === 'running').length;
    const queued = batch.tasks.filter((t: BatchTask) => t.status === 'queued').length;
    const skipped = batch.tasks.filter((t: BatchTask) => t.status === 'skipped').length;
    const cancelled = batch.tasks.filter((t: BatchTask) => t.status === 'cancelled').length;
    const percentage = total > 0 ? Math.round(((completed + failed + skipped + cancelled) / total) * 100) : 0;

    const response: BatchStatusResponse = {
      id: batch.id,
      status: batch.status,
      mode: batch.mode,
      tasks: batch.tasks.map((t: BatchTask) => ({
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        branch: t.branch,
        error: t.error,
        startedAt: t.startedAt?.toISOString() ?? null,
        completedAt: t.completedAt?.toISOString() ?? null,
      })),
      prUrl: batch.prUrl,
      createdAt: batch.createdAt.toISOString(),
      completedAt: batch.completedAt?.toISOString() ?? null,
      progress: {
        total,
        completed,
        failed,
        running,
        queued,
        skipped,
        cancelled,
        percentage,
      },
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/cancel', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const batch = getBatch(id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    if (req.userId) {
      await batchTaskGuard(batch, req.userId);
    }
    cancelBatch(id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/tasks/:taskId/cancel', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const taskId = req.params.taskId as string;
    if (req.userId) {
      await assertTaskOwned(taskId, req.userId);
    }
    cancelTask(id, taskId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/approve', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const batch = getBatch(id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    if (req.userId) {
      await batchTaskGuard(batch, req.userId);
    }
    approveNextTask(id);
    const updated = getBatch(id);
    if (!updated) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    res.json({
      id: updated.id,
      status: updated.status,
      mode: updated.mode,
      tasks: updated.tasks.map((t: BatchTask) => ({
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        branch: t.branch,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
