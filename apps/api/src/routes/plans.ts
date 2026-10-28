import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, type ValidatedRequest } from '../middleware/validate';
import {
  approvePlanBodySchema,
  createPlanBodySchema,
  getPlanQuerySchema,
  revisePlanBodySchema,
  type ApprovePlanBody,
  type CreatePlanBody,
  type GetPlanQuery,
  type RevisePlanBody,
} from '../schemas/plans';
import { respondIdempotently } from '../services/idempotency';
import { approvePlan, archivePlan, authorizeCreatePlan, getPlan, listPlans, revisePlan } from '../services/plans';

/**
 * W17b reviewable plans (services/plans.ts). Mounted twice: project-scoped
 * list/create under `/api/projects`, plan operations under `/api/plans`.
 */

export const projectPlansRouter: Router = Router();

projectPlansRouter.get('/:id/plans', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await listPlans({ projectId: req.params.id as string, userId: req.userId! }));
});

// Optional `Idempotency-Key` (W04a): equal retries replay, different bodies get 409.
projectPlansRouter.post('/:id/plans', requireAuth(['tasks:write']), validateBody(createPlanBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreatePlanBody>, res: Response) => {
    const projectId = req.params.id as string;
    const body = req.validBody!;
    await respondIdempotently(req, res, {
      operation: 'plans.create',
      args: { params: { id: projectId }, body },
      authorize: () => authorizeCreatePlan({ projectId, userId: req.userId!, title: body.title, spec: body.spec, note: body.note }),
    });
  },
);

export const plansRouter: Router = Router();

plansRouter.get('/:planId', requireAuth, validateQuery(getPlanQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, GetPlanQuery>, res: Response) => {
    res.json(await getPlan({ planId: req.params.planId as string, userId: req.userId!, revision: req.validQuery!.revision }));
  },
);

plansRouter.post('/:planId/revisions', requireAuth(['tasks:write']), validateBody(revisePlanBodySchema),
  async (req: AuthRequest & ValidatedRequest<RevisePlanBody>, res: Response) => {
    const body = req.validBody!;
    const result = await revisePlan({ planId: req.params.planId as string, userId: req.userId!, ...body });
    res.status(result.unchanged ? 200 : 201).json(result);
  },
);

plansRouter.post('/:planId/approve', requireAuth(['tasks:write']), validateBody(approvePlanBodySchema),
  async (req: AuthRequest & ValidatedRequest<ApprovePlanBody>, res: Response) => {
    res.json(await approvePlan({ planId: req.params.planId as string, userId: req.userId!, revision: req.validBody!.revision }));
  },
);

plansRouter.post('/:planId/archive', requireAuth(['tasks:write']), async (req: AuthRequest, res: Response) => {
  res.json(await archivePlan({ planId: req.params.planId as string, userId: req.userId! }));
});
