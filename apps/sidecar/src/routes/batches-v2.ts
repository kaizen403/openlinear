import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { type AuthedRequest, credentialOf, type PrincipalCredential } from '../auth/principal';
import { authorizeTaskAccess } from '../auth/task-access';
import { createPrincipalClient } from '../config/cloud-api';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { MAX_BATCH_TASKS, toV2BatchStatusResponse, toV2CreateBatchResponse, type BatchCoordinatorSettings, type BatchView } from '../run/batch';

/**
 * W13a: `/api/batches` on the v2 run engine (API persistence). Same request
 * and response contracts as the legacy engine, plus per-member `prUrl` /
 * `runId` (each member publishes its own pull request). Only the batch's
 * creator can see or act on it; members are authorized one by one at start
 * (and again by the control plane when each run starts).
 */

const CreateBatchSchema = z.object({
  taskIds: z.array(z.string().trim().min(1).max(200).refine((id) => !id.includes('\0'), 'Task IDs cannot contain NUL'))
    .min(1).max(MAX_BATCH_TASKS).refine((ids) => new Set(ids).size === ids.length, 'Duplicate task IDs are not allowed'),
  mode: z.enum(['parallel', 'queue', 'combined']),
});

const DEFAULT_SETTINGS: BatchCoordinatorSettings & { maxBatchSize: number } = { autoApprove: false, stopOnFailure: false, maxBatchSize: MAX_BATCH_TASKS };

/** The user's queue settings; defaults when the token can't read them (e.g. a tasks-only PAT). */
async function loadSettings(credential: PrincipalCredential): Promise<BatchCoordinatorSettings & { maxBatchSize: number }> {
  try {
    const raw = await createPrincipalClient(credential.token).getSettings() as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
    const size = typeof raw.maxBatchSize === 'number' && Number.isInteger(raw.maxBatchSize) && raw.maxBatchSize >= 1 ? Math.min(raw.maxBatchSize, MAX_BATCH_TASKS) : MAX_BATCH_TASKS;
    return {
      autoApprove: raw.queueAutoApprove === true,
      stopOnFailure: raw.stopOnFailure === true,
      maxBatchSize: size,
    };
  } catch (error) {
    logger.debug({ err: error }, '[Batch] execution settings unavailable; using defaults');
    return DEFAULT_SETTINGS;
  }
}

async function coordinator() {
  const { getBatchCoordinator } = await import('../run/index');
  return getBatchCoordinator();
}

/** The batch, if the caller created it (others get the same 404 as a missing batch). */
async function ownedBatch(req: AuthedRequest): Promise<{ view: BatchView; credential: PrincipalCredential }> {
  const credential = credentialOf(req);
  const view = (await coordinator()).view(req.params.id as string);
  if (!view || view.batch.userId !== credential.principal.userId) throw new HttpError(404, 'NOT_FOUND', 'Batch not found');
  return { view, credential };
}

export const v2BatchRouter: Router = Router();

v2BatchRouter.post('/', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateBatchSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Validation failed', parsed.error.flatten());
    const { taskIds, mode } = parsed.data;
    const credential = credentialOf(req);
    const settings = await loadSettings(credential);
    if (taskIds.length > settings.maxBatchSize) {
      throw new HttpError(400, 'INVALID_BATCH', `Your maximum batch size is ${settings.maxBatchSize}; select fewer tasks or raise it in Settings → Execution`, { maxBatchSize: settings.maxBatchSize });
    }
    // Refuse up front rather than starting some members of a selection the caller can't run.
    for (const taskId of taskIds) await authorizeTaskAccess(credential, taskId, 'write');
    const view = await (await coordinator()).create({
      credential,
      taskIds,
      mode,
      settings: { autoApprove: settings.autoApprove, stopOnFailure: settings.stopOnFailure },
    });
    res.status(201).json(toV2CreateBatchResponse(view));
  } catch (error) {
    next(error);
  }
});

v2BatchRouter.get('/', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const views = (await coordinator()).active(credentialOf(req).principal.userId);
    res.json(views.map((view) => ({
      id: view.batch.batchId,
      status: view.batch.status,
      mode: view.batch.mode,
      taskCount: view.members.length,
      createdAt: new Date(view.batch.createdAt).toISOString(),
    })));
  } catch (error) {
    next(error);
  }
});

v2BatchRouter.get('/:id', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { view } = await ownedBatch(req);
    res.json(toV2BatchStatusResponse(view));
  } catch (error) {
    next(error);
  }
});

v2BatchRouter.post('/:id/cancel', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { view } = await ownedBatch(req);
    await (await coordinator()).cancel(view.batch.batchId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

v2BatchRouter.post('/:id/tasks/:taskId/cancel', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { view } = await ownedBatch(req);
    await (await coordinator()).cancelTask(view.batch.batchId, req.params.taskId as string);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

v2BatchRouter.post('/:id/approve', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { view, credential } = await ownedBatch(req);
    const updated = await (await coordinator()).approveNext(view.batch.batchId, credential);
    const response = toV2BatchStatusResponse(updated);
    res.json({ id: response.id, status: response.status, mode: response.mode, tasks: response.tasks });
  } catch (error) {
    next(error);
  }
});

// Nothing below this router may reach the legacy (Prisma) batch engine in API mode.
v2BatchRouter.use((_req: AuthedRequest, _res: Response, next: NextFunction) => {
  next(new HttpError(404, 'NOT_FOUND', 'Not found'));
});
