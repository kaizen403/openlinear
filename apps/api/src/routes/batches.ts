import { Router, Response } from 'express';
import { z } from 'zod';
import { optionalAuth, AuthRequest } from '../middleware/auth';
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

router.post('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = CreateBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { taskIds, mode } = parsed.data;
    const userId = req.userId || null;

    const batch = await createBatch({
      taskIds,
      mode,
      projectId: '',
      userId,
      accessToken: null,
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
    console.error('[Batches] Error creating batch:', error);
    res.status(500).json({ error: 'Failed to create batch' });
  }
});

router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const batches = getActiveBatches();
    res.json(
      batches.map((b: BatchState) => ({
        id: b.id,
        status: b.status,
        mode: b.mode,
        taskCount: b.tasks.length,
        createdAt: b.createdAt.toISOString(),
      }))
    );
  } catch (error) {
    console.error('[Batches] Error listing batches:', error);
    res.status(500).json({ error: 'Failed to list batches' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const batch = getBatch(req.params.id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
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
    console.error('[Batches] Error getting batch:', error);
    res.status(500).json({ error: 'Failed to get batch' });
  }
});

router.post('/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    cancelBatch(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('[Batches] Error cancelling batch:', error);
    res.status(500).json({ error: 'Failed to cancel batch' });
  }
});

router.post('/:id/tasks/:taskId/cancel', async (req: AuthRequest, res: Response) => {
  try {
    cancelTask(req.params.id, req.params.taskId);
    res.json({ success: true });
  } catch (error) {
    console.error('[Batches] Error cancelling task:', error);
    res.status(500).json({ error: 'Failed to cancel task' });
  }
});

router.post('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    approveNextTask(req.params.id);
    const batch = getBatch(req.params.id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    res.json({
      id: batch.id,
      status: batch.status,
      mode: batch.mode,
      tasks: batch.tasks.map((t: BatchTask) => ({
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        branch: t.branch,
      })),
    });
  } catch (error) {
    console.error('[Batches] Error approving task:', error);
    res.status(500).json({ error: 'Failed to approve task' });
  }
});

export default router;
