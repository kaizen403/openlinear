import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { validateQuery, type ValidatedRequest } from '../middleware/validate';
import { insightsQuerySchema, type InsightsQuery } from '../schemas/insights';
import { projectInsights, workspaceInsights } from '../services/insights';

/**
 * W15b insights (services/insights.ts): one read-only document per project or
 * workspace and range. Mounted under `/api/projects` and `/api/workspaces`.
 */

export const projectInsightsRouter: Router = Router();

projectInsightsRouter.get('/:id/insights', requireAuth, validateQuery(insightsQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, InsightsQuery>, res: Response) => {
    res.json(await projectInsights({ projectId: req.params.id as string, userId: req.userId!, range: req.validQuery!.range }));
  },
);

export const workspaceInsightsRouter: Router = Router();

workspaceInsightsRouter.get('/:id/insights', requireAuth, validateQuery(insightsQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, InsightsQuery>, res: Response) => {
    res.json(await workspaceInsights({ workspaceId: req.params.id as string, userId: req.userId!, range: req.validQuery!.range }));
  },
);
