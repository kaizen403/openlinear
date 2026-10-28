import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateQuery, ValidatedRequest } from '../middleware/validate';
import { chatBudgetStatus } from '../services/chat-budget';
import { summarizeModelUsage, USAGE_SURFACES } from '../services/model-usage';
import { usageByTask, usageSummary } from '../services/usage';
import { assertWorkspaceRole } from '../services/workspaces';
import { resolvePrincipalForUser } from '../tenancy/context';
import type { TenancyContext } from '../tenancy/types';

const router: Router = Router();

/**
 * Agent-run usage is scoped to runs the caller started or runs on tasks of
 * the caller's teams, AND the run's task must be readable by the principal
 * right now (W02a): historical runs on a task in an explicitly denied
 * project, a project the user was removed from, or outside a PAT's workspace
 * no longer contribute cost, counts or task titles. Aggregated in SQL; see
 * services/usage.ts.
 */
async function usagePrincipal(req: AuthRequest): Promise<TenancyContext> {
  return req.tenancy ?? resolvePrincipalForUser(req.userId!);
}

router.get(
  '/summary',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    res.json(await usageSummary(await usagePrincipal(req)));
  },
);

const byTaskQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['cost', 'runs', 'recent']).default('cost'),
});
type ByTaskQuery = z.infer<typeof byTaskQuerySchema>;

router.get(
  '/by-task',
  requireAuth,
  validateQuery(byTaskQuerySchema),
  async (
    req: ValidatedRequest<unknown, ByTaskQuery> & AuthRequest,
    res: Response,
  ) => {
    const { page, pageSize, sort } = req.validQuery!;
    const { items, total } = await usageByTask(await usagePrincipal(req), { page, pageSize, sort });
    res.json({ items, page, pageSize, total, sort });
  },
);

const modelUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  workspaceId: z.string().min(1).optional(),
  surface: z.enum(USAGE_SURFACES).optional(),
});
type ModelUsageQuery = z.infer<typeof modelUsageQuerySchema>;

/**
 * Model invocation usage (W15): Home Chat turns, titles, retries and failed
 * calls from the `model_usage` ledger, for the caller's own invocations.
 *
 * Token totals are null when no call reported them; `cost.knownUsd` sums only
 * reported/estimated costs and `cost.coverage` says whether any is unknown.
 * A workspace-bound PAT only sees its workspace.
 */
router.get(
  '/models',
  requireAuth,
  validateQuery(modelUsageQuerySchema),
  async (req: ValidatedRequest<unknown, ModelUsageQuery> & AuthRequest, res: Response) => {
    const userId = req.userId!;
    const { days, workspaceId, surface } = req.validQuery!;
    const principal = await usagePrincipal(req);
    if (workspaceId) {
      await assertWorkspaceRole(workspaceId, userId, ['owner', 'admin', 'member', 'viewer']);
    }
    const scopedWorkspace = workspaceId ?? principal.workspaceRestriction ?? undefined;

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    since.setUTCHours(0, 0, 0, 0);

    // W15: the caller's monthly chat budget status for the workspace in scope
    // (null without a workspace; budgets are per workspace and per member).
    const [summary, budget] = await Promise.all([
      summarizeModelUsage({ userId, since, workspaceId: scopedWorkspace, surface }),
      scopedWorkspace ? chatBudgetStatus(scopedWorkspace, userId) : Promise.resolve(null),
    ]);
    res.json({
      since: since.toISOString(),
      days,
      workspaceId: scopedWorkspace ?? null,
      surface: surface ?? null,
      ...summary,
      budget,
    });
  },
);

export default router;
