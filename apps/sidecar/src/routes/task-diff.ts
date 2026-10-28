import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { type AuthedRequest, credentialOf, requireSidecarAuth } from '../auth/principal';
import { authorizeTaskAccess } from '../auth/task-access';
import { HttpError } from '../lib/errors';
import { computeTaskDiff, toDiffHttpError, validateBaseParam } from '../services/review/git-diff';
import type { ResolvedTaskWorkspace, TaskDiffResponse } from '../services/review/types';
import { getSidecarStore } from '../persistence/store';
import { branchFromLogs, resolveTaskWorkspace } from '../services/review/workspace-resolver';

/**
 * `GET /api/tasks/:id/diff?base=<ref|sha>` — the review diff of the task's
 * attempt worktree on this device (services/review/git-diff.ts).
 *
 * Authentication is registered on the route itself (not `router.use`) so
 * this router, mounted ahead of the execution router, never touches other
 * `/api/tasks` paths. Authorization: when the run's principal is known only
 * that principal may read its local diff (403 RUN_PRINCIPAL_MISMATCH);
 * otherwise (legacy checkouts found on disk, or no checkout at all) the
 * control plane decides with `full` task access, as for status and logs.
 *
 * Concurrent requests for the same task/base/worktree share one computation
 * (the desktop polls while a run is live).
 */
const router: Router = Router();

const taskIdSchema = z.string().trim().min(1).max(200).refine((id) => !id.includes('\0'), 'Task IDs cannot contain NUL');

const inFlight = new Map<string, Promise<TaskDiffResponse>>();

/** Diff computations currently shared by concurrent requests (tests/diagnostics). */
export function taskDiffComputationsInFlight(): number {
  return inFlight.size;
}

function sharedDiff(taskId: string, base: string | undefined, workspace: ResolvedTaskWorkspace): Promise<TaskDiffResponse> {
  const key = JSON.stringify([taskId, base ?? null, workspace.worktreePath, workspace.baseRef, workspace.source]);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const computation = computeTaskDiff({
    worktreePath: workspace.worktreePath,
    baseRef: workspace.baseRef,
    source: workspace.source,
    ...(base !== undefined ? { base } : {}),
  }).finally(() => {
    if (inFlight.get(key) === computation) inFlight.delete(key);
  });
  inFlight.set(key, computation);
  return computation;
}

router.get('/:id/diff', requireSidecarAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = taskIdSchema.safeParse(req.params.id);
    if (!parsed.success) throw new HttpError(400, 'INVALID_TASK_ID', 'Invalid task id');
    const taskId = parsed.data;
    const base = validateBaseParam(req.query.base);
    const credential = credentialOf(req);

    // A finished legacy run is only findable through the branch its persisted
    // log names; that read is authorized by the control plane for the caller.
    const workspace = await resolveTaskWorkspace(taskId, {
      persistedBranch: async (id) => branchFromLogs(await (await getSidecarStore()).readPersistedLogs(credential, id)),
    });
    if (workspace?.ownerUserId) {
      if (workspace.ownerUserId !== credential.principal.userId) {
        throw new HttpError(403, 'RUN_PRINCIPAL_MISMATCH', 'Only the principal that started this run can read its local diff');
      }
    } else {
      await authorizeTaskAccess(credential, taskId, 'full');
    }
    if (!workspace) {
      throw new HttpError(
        404,
        'DIFF_WORKSPACE_NOT_FOUND',
        'No attempt worktree for this task exists on this device: the task has not run here, or its worktree was already cleaned up',
      );
    }

    const diff = await sharedDiff(taskId, base, workspace);
    res.setHeader('Cache-Control', 'no-store');
    res.json(diff);
  } catch (error) {
    next(toDiffHttpError(error));
  }
});

export default router;
