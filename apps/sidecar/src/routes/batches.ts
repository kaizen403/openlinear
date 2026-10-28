import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import {
  toBatchStatusResponse,
  toBatchTaskSummaries,
  toCreateBatchResponse,
} from '@openlinear/execution-core';
import type { BatchState, BatchTask } from '@openlinear/execution-core';
import { logger } from '../lib/logger';
import { HttpError } from '../lib/errors';
import { type AuthedRequest, credentialOf, type PrincipalCredential, requireSidecarAuth } from '../auth/principal';
import { authorizeTaskAccess } from '../auth/task-access';
import { getSidecarStore, resolvePersistenceMode } from '../persistence/store';
import { loadBatchServices } from '../persistence/prisma-loader';
import { v2BatchRouter } from './batches-v2';

const CreateBatchSchema = z.object({
  taskIds: z.array(z.string().trim().min(1).max(200).refine((id) => !id.includes('\0'), 'Task IDs cannot contain NUL')).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, 'Duplicate task IDs are not allowed'),
  mode: z.enum(['parallel', 'queue', 'combined']),
});

/**
 * Batches. Prisma mode (tests, `--with-cloud-api`) uses the legacy batch
 * engine below. API-only mode uses the v2 run engine's batch coordinator
 * (W13a, `batches-v2.ts`) and never reaches Prisma; with the legacy engine
 * selected there it fails closed with BATCH_REQUIRES_API_PERSISTENCE.
 */
const router: Router = Router();

router.use(requireSidecarAuth);
router.use((req: AuthedRequest, res: Response, next: NextFunction) => {
  if (resolvePersistenceMode() === 'prisma') {
    next();
    return;
  }
  // W13a: API persistence with the v2 run engine runs batches as coordinated v2 runs.
  void import('../run/index').then(({ runEngineActive }) => {
    if (runEngineActive()) {
      v2BatchRouter(req, res, next);
      return;
    }
    next(new HttpError(501, 'BATCH_REQUIRES_API_PERSISTENCE',
      'Batch execution needs the v2 run engine in API-only mode; execute tasks individually'));
  }, next);
});

function batchTaskGuard(batch: BatchState | undefined, credential: PrincipalCredential, level: 'full' | 'write' = 'write'): Promise<void> {
  if (!batch) return Promise.resolve();
  return Promise.all(
    batch.tasks.map((t: BatchTask) => authorizeTaskAccess(credential, t.taskId, level)),
  ).then(() => undefined);
}

router.post('/', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      return;
    }

    const { taskIds, mode } = parsed.data;
    const credential = credentialOf(req);
    const userId = credential.principal.userId;

    for (const tid of taskIds) {
      await authorizeTaskAccess(credential, tid, 'write');
    }

    // The batch engine (Prisma mode) runs as the initiating user's own GitHub
    // credential, as before; the store reads it.
    const store = await getSidecarStore();
    let accessToken: string | null = null;
    try {
      accessToken = await store.getGitCredential({ taskId: taskIds[0]!, userId, attemptId: null, client: null, credential }, 'clone');
    } catch (err) {
      logger.error({ err }, '[batch] failed to decrypt access token');
      accessToken = null;
    }

    const batches = await loadBatchServices();
    const batch = await batches.createBatch({
      taskIds,
      mode,
      projectId: '',
      userId,
      accessToken,
    }, credential);

    await batches.startBatch(batch.id);

    res.status(201).json(toCreateBatchResponse(batch));
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const credential = credentialOf(req);
    const batches = await loadBatchServices();
    const visible: BatchState[] = [];
    for (const b of batches.getActiveBatches()) {
      try {
        await batchTaskGuard(b, credential, 'full');
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

router.get('/:id', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const batches = await loadBatchServices();
    const batch = batches.getBatch(id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    await batchTaskGuard(batch, credentialOf(req), 'full');

    res.json(toBatchStatusResponse(batch));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/cancel', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const batches = await loadBatchServices();
    const batch = batches.getBatch(id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    await batchTaskGuard(batch, credentialOf(req));
    await batches.cancelBatch(id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/tasks/:taskId/cancel', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const taskId = req.params.taskId as string;
    const batches = await loadBatchServices();
    const batch = batches.getBatch(id);
    if (!batch || !batch.tasks.some((task) => task.taskId === taskId)) {
      throw new HttpError(404, 'NOT_FOUND', 'Task not found in this batch');
    }
    const credential = credentialOf(req);
    if (batch.mode === 'combined') await batchTaskGuard(batch, credential);
    else await authorizeTaskAccess(credential, taskId, 'write');
    await batches.cancelTask(id, taskId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/approve', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const batches = await loadBatchServices();
    const batch = batches.getBatch(id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    await batchTaskGuard(batch, credentialOf(req));
    await batches.approveNextTask(id);
    const updated = batches.getBatch(id);
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
