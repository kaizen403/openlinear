import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma, decryptToken } from '@openlinear/db';
import { requireAuth, AuthRequest } from '@openlinear/api/middleware';
import { logger } from '@openlinear/api/logger';
import { assertTaskOwned } from '@openlinear/api/ownership';
import {
  toBatchStatusResponse,
  toBatchTaskSummaries,
  toCreateBatchResponse,
} from '@openlinear/execution-core';
import type { BatchState, BatchTask } from '@openlinear/execution-core';
import {
  createBatch,
  startBatch,
  cancelBatch,
  cancelTask,
  getBatch,
  getActiveBatches,
  approveNextTask,
} from '../services/batch';
import { HttpError } from '@openlinear/api/errors';

const CreateBatchSchema = z.object({
  taskIds: z.array(z.string().trim().min(1).max(200).refine((id) => !id.includes('\0'), 'Task IDs cannot contain NUL')).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, 'Duplicate task IDs are not allowed'),
  mode: z.enum(['parallel', 'queue', 'combined']),
});

const router: Router = Router();

router.post('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { taskIds, mode } = parsed.data;
    const userId = req.userId!;

    for (const tid of taskIds) {
      await assertTaskOwned(tid, userId);
    }

    let accessToken: string | null = null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { accessToken: true },
    });
    try {
      accessToken = decryptToken(user?.accessToken ?? null);
    } catch (err) {
      logger.error({ err }, '[batch] failed to decrypt access token');
      accessToken = null;
    }

    const batch = await createBatch({
      taskIds,
      mode,
      projectId: '',
      userId,
      accessToken,
    });

    await startBatch(batch.id);

    res.status(201).json(toCreateBatchResponse(batch));
  } catch (error) {
    next(error);
  }
});

function batchTaskGuard(batch: BatchState | undefined, userId: string): Promise<void> {
  if (!batch) return Promise.resolve();
  return Promise.all(
    batch.tasks.map((t: BatchTask) => assertTaskOwned(t.taskId, userId)),
  ).then(() => undefined);
}

router.get('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const batches = getActiveBatches();
    const visible: BatchState[] = [];
    for (const b of batches) {
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

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const batch = getBatch(id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    await batchTaskGuard(batch, req.userId!);

    res.json(toBatchStatusResponse(batch));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/cancel', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const batch = getBatch(id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    await batchTaskGuard(batch, req.userId!);
    await cancelBatch(id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/tasks/:taskId/cancel', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const taskId = req.params.taskId as string;
    const batch = getBatch(id);
    if (!batch || !batch.tasks.some((task) => task.taskId === taskId)) {
      throw new HttpError(404, 'NOT_FOUND', 'Task not found in this batch');
    }
    if (batch.mode === 'combined') await batchTaskGuard(batch, req.userId!);
    else await assertTaskOwned(taskId, req.userId!);
    await cancelTask(id, taskId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/approve', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const batch = getBatch(id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    await batchTaskGuard(batch, req.userId!);
    await approveNextTask(id);
    const updated = getBatch(id);
    if (!updated) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    res.json({
      id: updated.id,
      status: updated.status,
      mode: updated.mode,
      tasks: toBatchTaskSummaries(updated),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
