import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { type AuthedRequest, credentialOf, requireSidecarAuth } from '../auth/principal';
import { authorizeTaskAccess, type TaskAccessLevel } from '../auth/task-access';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * W19a / FE-12: independent agent reviews of a task's newest finished run
 * (see run/reviewer).
 *
 * - `POST /api/tasks/:id/reviews` — start one (202 with the running review);
 *   409 REVIEW_RUNNING / REVIEW_RUN_ACTIVE / REVIEW_WORKSPACE_GONE /
 *   REVIEW_NOTHING_TO_REVIEW / REVIEW_RUNNER_UNAVAILABLE;
 * - `GET /api/tasks/:id/reviews` — the task's reviews on this device, newest
 *   first, findings re-checked against the current checkout (`stale`);
 * - `POST /api/tasks/:id/reviews/:reviewId/cancel` — stop a running one.
 *
 * Like the local diff: when the task has a run on this device only the
 * person who started it is served (403 RUN_PRINCIPAL_MISMATCH otherwise);
 * without a run the control plane decides (`write` to start or cancel,
 * `full` to read).
 * Authentication is registered per route (the router is mounted on `/api`).
 */
const router: Router = Router();

const idSchema = z.string().trim().min(1).max(200).refine((id) => !id.includes('\0'), 'Ids cannot contain NUL');

function idOf(value: unknown, code: string, message: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, code, message);
  return parsed.data;
}

async function engine() {
  const { runEngineActive, getReviewer, getRunService } = await import('../run/index');
  if (!runEngineActive()) return null;
  return { reviewer: getReviewer(), runs: getRunService() };
}

/**
 * Like the local diff (routes/task-diff.ts): a run's reviews quote its local
 * checkout, so only the principal that started the run sees or starts them;
 * without a recorded run the control plane decides.
 */
async function authorize(req: AuthedRequest, taskId: string, level: TaskAccessLevel, runOwner: string | null): Promise<string> {
  const credential = credentialOf(req);
  if (runOwner) {
    if (runOwner !== credential.principal.userId) {
      throw new HttpError(403, 'RUN_PRINCIPAL_MISMATCH', "Only the person who started this task's run can review it on this device");
    }
    return credential.principal.userId;
  }
  await authorizeTaskAccess(credential, taskId, level);
  return credential.principal.userId;
}

function ownerOf(runs: { reviewSubject(taskId: string): { ok: true; subject: { userId: string } } | { ok: false } }, taskId: string): string | null {
  const subject = runs.reviewSubject(taskId);
  return subject.ok ? subject.subject.userId : null;
}

router.post('/tasks/:id/reviews', requireSidecarAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const taskId = idOf(req.params.id, 'INVALID_TASK_ID', 'Invalid task id');
    const found = await engine();
    if (!found) throw new HttpError(409, 'REVIEW_UNSUPPORTED', 'Agent reviews need the v2 run engine in API persistence mode', { reason: 'run_engine_legacy' });
    const userId = await authorize(req, taskId, 'write', ownerOf(found.runs, taskId));
    const review = await found.reviewer.start(taskId, userId);
    logger.info(`[Reviewer] review ${review.id.slice(0, 8)} started for task ${taskId.slice(0, 8)}`);
    const { bootId: _bootId, ...view } = review;
    res.status(202).json({ review: { ...view, findings: [], headCommit: null } });
  } catch (error) {
    next(error);
  }
});

router.get('/tasks/:id/reviews', requireSidecarAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const taskId = idOf(req.params.id, 'INVALID_TASK_ID', 'Invalid task id');
    const found = await engine();
    if (!found) {
      res.json({ reviews: [], reviewing: false });
      return;
    }
    await authorize(req, taskId, 'full', ownerOf(found.runs, taskId));
    res.json({ reviews: await found.reviewer.list(taskId), reviewing: found.reviewer.isReviewing(taskId) });
  } catch (error) {
    next(error);
  }
});

router.post('/tasks/:id/reviews/:reviewId/cancel', requireSidecarAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const taskId = idOf(req.params.id, 'INVALID_TASK_ID', 'Invalid task id');
    const reviewId = idOf(req.params.reviewId, 'INVALID_REVIEW_ID', 'Invalid review id');
    const found = await engine();
    if (!found) throw new HttpError(404, 'REVIEW_NOT_RUNNING', 'This review is not running');
    await authorize(req, taskId, 'write', ownerOf(found.runs, taskId));
    if (!found.reviewer.cancel(taskId, reviewId)) throw new HttpError(404, 'REVIEW_NOT_RUNNING', 'This review is not running');
    res.status(202).json({ cancelled: true });
  } catch (error) {
    next(error);
  }
});

export default router;
