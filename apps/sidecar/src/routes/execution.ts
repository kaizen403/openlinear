import { Router, type NextFunction, type Response } from 'express';
import { FOLLOW_UP_LIMITS } from '@openlinear/execution-core';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { errorBody, HttpError, isHttpError } from '../lib/errors';
import { type AuthedRequest, credentialOf, requireSidecarAuth } from '../auth/principal';
import { authorizeTaskAccess, type TaskAccessLevel } from '../auth/task-access';
import { getSidecarStore } from '../persistence/store';
import { executeTask, cancelTask, isTaskRunning, getExecutionLogs } from '../services/execution';
import { singleExecutionOwner } from '../services/execution/state';
import { batchOwnerOf, getBatchExecutionLogs } from '../services/batch/registry';
import { currentRunService, resolveRunEngineMode } from '../run/engine-mode';

/**
 * Sidecar single-task routes (W03a). Every route authenticates the bearer
 * through the control plane. Authorization:
 * - execute: decided by the control plane when the attempt starts;
 * - status/logs/cancel of a run the caller started: the local run owner
 *   (the principal that was authorized at start) is served directly;
 * - anyone else: the control plane decides (`full` for status/logs, `write`
 *   for cancel, mirroring the previous `assertTaskOwned` + PAT scope rules).
 *
 * Execute goes through the durable run service (W05a/W06a/W07a) by default
 * in API persistence mode; `OPENLINEAR_RUN_ENGINE=legacy` selects the
 * legacy lifecycle. Status, logs and cancel consult the run service first.
 * `POST /:id/follow-up` (W07a) continues the task's latest finished v2 run.
 */
const router: Router = Router();

const taskIdSchema = z.string().trim().min(1).max(200).refine((id) => !id.includes('\0'), 'Task IDs cannot contain NUL');

function taskIdOf(req: AuthedRequest): string {
  const parsed = taskIdSchema.safeParse(req.params.id);
  if (!parsed.success) throw new HttpError(400, 'INVALID_TASK_ID', 'Invalid task id');
  return parsed.data;
}

/** Sandbox availability failures are server-side (503), not a bad request. */
const UNAVAILABLE_CODES = new Set(['SANDBOX_UNAVAILABLE', 'SANDBOX_START_FAILED']);

function ownerOf(taskId: string): string | null {
  return singleExecutionOwner(taskId) ?? currentRunService()?.ownerOf(taskId) ?? null;
}

function runningAnywhere(taskId: string): boolean {
  return isTaskRunning(taskId) || (currentRunService()?.isRunning(taskId) ?? false);
}

async function authorizeUnlessOwner(req: AuthedRequest, taskId: string, level: TaskAccessLevel, owner: string | null): Promise<void> {
  const credential = credentialOf(req);
  if (owner && owner === credential.principal.userId) return;
  await authorizeTaskAccess(credential, taskId, level);
}

router.use(requireSidecarAuth);

// POST /:id/execute
router.post('/:id/execute', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = taskIdOf(req);
    const credential = credentialOf(req);
    // W17a: "run anyway" for a task whose blockers are open.
    const allowBlocked = (req.body as { allowBlocked?: unknown } | undefined)?.allowBlocked === true;
    logger.info(`[Tasks] Execute requested for task ${id.slice(0, 8)} (userId: ${credential.principal.userId})`);
    if (resolveRunEngineMode() === 'v2') {
      const { runEngineActive, getRunService } = await import('../run/index');
      if (runEngineActive()) {
        if (isTaskRunning(id)) throw new HttpError(409, 'TASK_ALREADY_RUNNING', 'Task is already running');
        const started = await getRunService().submit({ credential, taskId: id, allowBlocked });
        const queued = started.state === 'queued';
        res.status(queued ? 202 : 200).json({
          message: queued ? 'Task execution queued' : 'Task execution started',
          runId: started.runId,
          attemptId: started.attemptId,
          state: started.state,
        });
        return;
      }
    }
    const result = await executeTask({ taskId: id, userId: credential.principal.userId, credential, allowBlocked });

    if (!result.success) {
      logger.info(`[Tasks] Execute failed: ${result.error}`);
      const status = result.code && UNAVAILABLE_CODES.has(result.code) ? 503 : 400;
      res.status(status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
      return;
    }

    res.json({ message: 'Task execution started' });
  } catch (error) {
    next(error);
  }
});

// POST /:id/refresh-pr
router.post('/:id/refresh-pr', async (req: AuthedRequest, res: Response) => {
  try {
    const id = taskIdOf(req);
    const store = await getSidecarStore();
    res.json(await store.refreshPullRequest(credentialOf(req), id));
  } catch (error) {
    if (isHttpError(error)) {
      res.status(error.statusCode).json(errorBody(error.code, error.message, error.details));
      return;
    }
    logger.error({ err: error }, '[Tasks] Error refreshing PR');
    res.status(500).json({ error: 'Failed to refresh PR status' });
  }
});

// GET /:id/running
router.get('/:id/running', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = taskIdOf(req);
    await authorizeUnlessOwner(req, id, 'full', ownerOf(id));
    res.json({ running: runningAnywhere(id) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/logs', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = taskIdOf(req);
    const credential = credentialOf(req);
    const owner = ownerOf(id) ?? batchOwnerOf(id);
    let logs: unknown[] = getExecutionLogs(id);
    if (logs.length === 0) logs = getBatchExecutionLogs(id);
    const v2 = currentRunService();
    if (logs.length === 0 && v2?.isRunning(id)) logs = v2.logsFor(id);

    if (logs.length > 0) {
      await authorizeUnlessOwner(req, id, 'full', owner);
      res.json({ logs });
      return;
    }

    // Nothing in memory: the persisted snapshot, authorized by the store
    // (control plane in API mode).
    const store = await getSidecarStore();
    res.json({ logs: await store.readPersistedLogs(credential, id) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/cancel', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = taskIdOf(req);
    await authorizeUnlessOwner(req, id, 'write', ownerOf(id));
    logger.info(`[Tasks] Cancel requested for task ${id.slice(0, 8)}`);

    const legacyRunning = isTaskRunning(id);
    const v2 = currentRunService();
    if (!legacyRunning && v2?.isRunning(id)) {
      const cancelled = await v2.cancel(id);
      if (!cancelled.success) {
        res.status(cancelled.error === 'Cancellation is still in progress' ? 202 : 400).json({ error: cancelled.error ?? 'Cancellation failed', ...(cancelled.state ? { state: cancelled.state } : {}) });
        return;
      }
      res.json({ message: 'Task cancelled' });
      return;
    }

    if (!legacyRunning) {
      logger.info(`[Tasks] Task ${id.slice(0, 8)} is not running, cannot cancel`);
      res.status(400).json({ error: 'Task is not running' });
      return;
    }

    const result = await cancelTask(id);

    if (!result.success) {
      logger.info(`[Tasks] Cancel failed: ${result.error}`);
      res.status(400).json({ error: result.error });
      return;
    }

    logger.info(`[Tasks] Task ${id.slice(0, 8)} cancelled`);
    res.json({ message: 'Task cancelled' });
  } catch (error) {
    next(error);
  }
});

// POST /:id/follow-up — W07a follow-up turn on the task's latest finished v2
// run (contract: docs/reports/revamp-2026-10-26/v2native.md §3).
const noNul = (value: string) => !value.includes('\0');
const turnBodyShape = {
  message: z.string().max(FOLLOW_UP_LIMITS.messageMaxChars).refine((value) => value.trim().length > 0, 'message must not be empty').refine(noNul, 'message cannot contain NUL'),
  comments: z.array(z.object({
    path: z.string().min(1).max(FOLLOW_UP_LIMITS.pathMaxChars).refine(noNul, 'path cannot contain NUL'),
    line: z.number().int().positive().max(10_000_000).optional(),
    side: z.enum(['old', 'new']).optional(),
    body: z.string().max(FOLLOW_UP_LIMITS.commentBodyMaxChars).refine((value) => value.trim().length > 0, 'body must not be empty').refine(noNul, 'body cannot contain NUL'),
  }).strict()).max(FOLLOW_UP_LIMITS.commentsMax).optional(),
};
const runIdSchema = z.string().trim().min(1).max(200).refine(noNul, 'Run IDs cannot contain NUL');
/**
 * W12: `parentRunId` names the run the caller is continuing (the run on its
 * screen). When it isn't this device's latest run of the task the follow-up is
 * refused (409 FOLLOW_UP_RUN_MISMATCH) instead of resuming another session.
 * Optional: review follow-ups without it continue the latest run, as before.
 */
const followUpBodySchema = z.object({ ...turnBodyShape, parentRunId: runIdSchema.optional() }).strict();
const redirectBodySchema = z.object(turnBodyShape).strict();

router.post('/:id/follow-up', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = taskIdOf(req);
    const credential = credentialOf(req);
    const parsed = followUpBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid follow-up request', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    // The control plane decides who may continue the task (404 TASK_NOT_FOUND,
    // 403) before any local run state is revealed.
    await authorizeTaskAccess(credential, id, 'write');
    if (isTaskRunning(id)) throw new HttpError(409, 'RUN_ACTIVE', 'A turn is already in progress for this task');
    const { runEngineActive, getRunService } = await import('../run/index');
    if (!runEngineActive()) {
      throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'Follow-up turns need the v2 run engine in API persistence mode', { reason: 'run_engine_legacy' });
    }
    logger.info(`[Tasks] Follow-up requested for task ${id.slice(0, 8)} (userId: ${credential.principal.userId}, comments: ${parsed.data.comments?.length ?? 0})`);
    const started = await getRunService().followUp({
      credential,
      taskId: id,
      request: { message: parsed.data.message, comments: parsed.data.comments ?? [] },
      ...(parsed.data.parentRunId !== undefined ? { parentRunId: parsed.data.parentRunId } : {}),
    });
    res.status(202).json({ runId: started.runId, attemptId: started.attemptId, state: started.state });
  } catch (error) {
    // The control plane answers an unknown or invisible task with a generic
    // 404; the follow-up contract names it.
    if (isHttpError(error) && error.statusCode === 404) {
      next(new HttpError(404, 'TASK_NOT_FOUND', 'Task not found', error.details));
      return;
    }
    next(error);
  }
});

// POST /:id/redirect — W12: stop the running turn (work kept) and continue with this instruction.
router.post('/:id/redirect', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = taskIdOf(req);
    const credential = credentialOf(req);
    const parsed = redirectBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid redirect request', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    await authorizeTaskAccess(credential, id, 'write');
    // A legacy (v1) execution can only be stopped, not continued.
    if (isTaskRunning(id)) throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'This run cannot be redirected; stop it and run again', { reason: 'run_engine_legacy' });
    const { runEngineActive, getRunService } = await import('../run/index');
    if (!runEngineActive()) {
      throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'Redirecting needs the v2 run engine in API persistence mode', { reason: 'run_engine_legacy' });
    }
    logger.info(`[Tasks] Redirect requested for task ${id.slice(0, 8)} (userId: ${credential.principal.userId})`);
    const started = await getRunService().redirect({
      credential,
      taskId: id,
      request: { message: parsed.data.message, comments: parsed.data.comments ?? [] },
    });
    res.status(202).json({ runId: started.runId, attemptId: started.attemptId, state: started.state });
  } catch (error) {
    if (isHttpError(error) && error.statusCode === 404) {
      next(new HttpError(404, 'TASK_NOT_FOUND', 'Task not found', error.details));
      return;
    }
    next(error);
  }
});

// GET /:id/run — v2 run state (UI run-state contract; see the runengine ledger).
router.get('/:id/run', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const id = taskIdOf(req);
    await authorizeUnlessOwner(req, id, 'full', ownerOf(id));
    const run = currentRunService()?.describe(id) ?? null;
    if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'No v2 run is recorded for this task on this device');
    res.json({ run });
  } catch (error) {
    next(error);
  }
});

export default router;
