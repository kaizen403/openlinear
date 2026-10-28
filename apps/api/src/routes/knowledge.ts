import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, type ValidatedRequest } from '../middleware/validate';
import {
  approveKnowledgeBodySchema,
  createKnowledgeBodySchema,
  listKnowledgeQuerySchema,
  retractKnowledgeBodySchema,
  updateKnowledgeBodySchema,
  type ApproveKnowledgeBody,
  type CreateKnowledgeBody,
  type ListKnowledgeQuery,
  type RetractKnowledgeBody,
  type UpdateKnowledgeBody,
} from '../schemas/knowledge';
import { respondIdempotently } from '../services/idempotency';
import {
  approveKnowledge,
  authorizeCreateKnowledge,
  getKnowledge,
  listKnowledge,
  retractKnowledge,
  restoreKnowledge,
  updateKnowledge,
  type KnowledgeActor,
} from '../services/knowledge';

/**
 * W19b / FE-13 project knowledge (services/knowledge.ts). Mounted twice:
 * project-scoped list/create under `/api/projects`, entry operations under
 * `/api/knowledge`. A personal access token is an agent: it can only propose.
 */

function actorOf(req: AuthRequest): KnowledgeActor {
  return { userId: req.userId!, authSource: req.authSource === 'jwt' ? 'jwt' : 'pat' };
}

export const projectKnowledgeRouter: Router = Router();

projectKnowledgeRouter.get('/:id/knowledge', requireAuth, validateQuery(listKnowledgeQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, ListKnowledgeQuery>, res: Response) => {
    res.json({ entries: await listKnowledge({ projectId: req.params.id as string, userId: req.userId!, status: req.validQuery!.status }) });
  },
);

// Optional `Idempotency-Key` (W04a): equal retries replay, different bodies get 409.
projectKnowledgeRouter.post('/:id/knowledge', requireAuth(['tasks:write']), validateBody(createKnowledgeBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateKnowledgeBody>, res: Response) => {
    const projectId = req.params.id as string;
    const body = req.validBody!;
    await respondIdempotently(req, res, {
      operation: 'knowledge.create',
      args: { params: { id: projectId }, body },
      authorize: () => authorizeCreateKnowledge({ projectId, actor: actorOf(req), body }),
    });
  },
);

export const knowledgeRouter: Router = Router();

knowledgeRouter.get('/:entryId', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await getKnowledge({ entryId: req.params.entryId as string, userId: req.userId! }));
});

knowledgeRouter.patch('/:entryId', requireAuth(['tasks:write']), validateBody(updateKnowledgeBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateKnowledgeBody>, res: Response) => {
    res.json(await updateKnowledge({ entryId: req.params.entryId as string, actor: actorOf(req), body: req.validBody! }));
  },
);

knowledgeRouter.post('/:entryId/approve', requireAuth(['tasks:write']), validateBody(approveKnowledgeBodySchema),
  async (req: AuthRequest & ValidatedRequest<ApproveKnowledgeBody>, res: Response) => {
    res.json(await approveKnowledge({ entryId: req.params.entryId as string, actor: actorOf(req), version: req.validBody!.version }));
  },
);

knowledgeRouter.post('/:entryId/retract', requireAuth(['tasks:write']), validateBody(retractKnowledgeBodySchema),
  async (req: AuthRequest & ValidatedRequest<RetractKnowledgeBody>, res: Response) => {
    res.json(await retractKnowledge({ entryId: req.params.entryId as string, actor: actorOf(req), reason: req.validBody!.reason }));
  },
);

knowledgeRouter.post('/:entryId/restore', requireAuth(['tasks:write']), async (req: AuthRequest, res: Response) => {
  res.json(await restoreKnowledge({ entryId: req.params.entryId as string, actor: actorOf(req) }));
});
