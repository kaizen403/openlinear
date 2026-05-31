import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma, decryptToken } from '@openlinear/db';
import { optionalAuth, AuthRequest } from '@openlinear/api/middleware';
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
import { ensureModelConfigured } from '../services/opencode-model';

const CreateBatchSchema = z.object({
  taskIds: z.array(z.string()).min(1).max(20),
  mode: z.enum(['parallel', 'queue', 'combined']),
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

      const ensured = await ensureModelConfigured(userId).catch((err: unknown) => {
        console.warn('[Batch] Model pre-flight check failed:', err);
        return null;
      });
      if (ensured && !ensured.model) {
        res.status(400).json({
          error: ensured.hasProvider
            ? 'No model selected. Pick a model in Settings → AI Providers before running a batch.'
            : 'No AI provider configured. Connect a provider in Settings → AI Providers before running a batch.',
          code: 'MODEL_NOT_CONFIGURED',
          details: { hasProvider: ensured.hasProvider },
        });
        return;
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

    res.status(201).json(toCreateBatchResponse(batch));
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

    res.json(toBatchStatusResponse(batch));
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
      tasks: toBatchTaskSummaries(updated),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
