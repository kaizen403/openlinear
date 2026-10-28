import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { type AuthedRequest, credentialOf, requireSidecarAuth } from '../auth/principal';
import { HttpError } from '../lib/errors';
import { currentRunService } from '../run/engine-mode';

/**
 * FE-04: permission requests waiting for a person (approval mode "ask").
 *
 * - `GET /api/approvals` — every request waiting on the caller, across tasks
 *   (the approval inbox);
 * - `GET /api/tasks/:id/approvals` — the task's requests waiting on the caller;
 * - `POST /api/tasks/:id/approvals/:approvalId` `{ decision, scope?, digest }`
 *   — answer one, quoting the operation digest that was shown (`scope:
 *   'run'` allows that tool for the rest of the run).
 *
 * Only the person who started the run sees or answers its requests (the run
 * service filters by owner; the broker answers 403 to anyone else, 409
 * APPROVAL_CHANGED for another operation, 404 APPROVAL_NOT_FOUND for a
 * decided, expired or unknown request). Authentication is registered per
 * route because the router is mounted on `/api` (ahead of the task routers,
 * so these paths are answered here and authenticated once).
 */
const router: Router = Router();

const idSchema = z.string().trim().min(1).max(200).refine((id) => !id.includes('\0'), 'Ids cannot contain NUL');
const decisionBodySchema = z.object({
  decision: z.enum(['allow', 'deny']),
  /** `run`: allow this tool for the rest of the run (ignored for a deny). */
  scope: z.enum(['once', 'run']).optional(),
  digest: z.string().regex(/^[0-9a-f]{64}$/, 'digest must be the 64-character operation digest'),
}).strict();

function idOf(value: unknown, code: string, message: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, code, message);
  return parsed.data;
}

router.get('/approvals', requireSidecarAuth, (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = credentialOf(req).principal.userId;
    res.json({ approvals: currentRunService()?.approvalsWaitingOn?.(userId) ?? [] });
  } catch (error) {
    next(error);
  }
});

router.get('/tasks/:id/approvals', requireSidecarAuth, (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const taskId = idOf(req.params.id, 'INVALID_TASK_ID', 'Invalid task id');
    const userId = credentialOf(req).principal.userId;
    res.json({ approvals: currentRunService()?.pendingApprovals?.(taskId, userId) ?? [] });
  } catch (error) {
    next(error);
  }
});

router.post('/tasks/:id/approvals/:approvalId', requireSidecarAuth, (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const taskId = idOf(req.params.id, 'INVALID_TASK_ID', 'Invalid task id');
    const approvalId = idOf(req.params.approvalId, 'INVALID_APPROVAL_ID', 'Invalid approval id');
    const parsed = decisionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid approval decision', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const service = currentRunService();
    if (!service?.decideApproval) throw new HttpError(404, 'APPROVAL_NOT_FOUND', 'This approval request is no longer pending');
    const outcome = service.decideApproval({
      taskId,
      approvalId,
      decision: parsed.data.decision,
      ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
      digest: parsed.data.digest,
      userId: credentialOf(req).principal.userId,
    });
    res.json({ decision: outcome.decision, scope: outcome.scope, by: outcome.by });
  } catch (error) {
    next(error);
  }
});

export default router;
