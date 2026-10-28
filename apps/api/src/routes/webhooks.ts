import { Router, type Response } from 'express';
import { requireAuth, requireInteractiveSession, type AuthRequest } from '../middleware/auth';
import { validateBody, validateQuery, type ValidatedRequest } from '../middleware/validate';
import {
  createWebhookBodySchema,
  listWebhookDeliveriesQuerySchema,
  updateWebhookBodySchema,
  type CreateWebhookBody,
  type ListWebhookDeliveriesQuery,
  type UpdateWebhookBody,
} from '../schemas/webhooks';
import { respondIdempotently } from '../services/idempotency';
import {
  authorizeCreateWebhook,
  deleteWebhook,
  getWebhook,
  getWebhookDelivery,
  listWebhookDeliveries,
  listWebhooks,
  pingWebhook,
  redeliverWebhookDelivery,
  revealSealedSecret,
  rotateWebhookSecret,
  updateWebhook,
  type WebhookScope,
} from '../services/webhooks';

/**
 * FE-14 outbound webhooks (services/webhooks.ts). Mounted three times:
 * project list/create under `/api/projects`, workspace list/create under
 * `/api/workspaces`, endpoint operations under `/api/webhooks`.
 *
 * Creating an endpoint, rotating its secret and changing it (the URL decides
 * where signed events go) need an interactive session: a leaked PAT must
 * not be able to mint a secret or redirect deliveries.
 */

/**
 * Keyed create (W04a): the stored response holds the secret encrypted; it
 * is decrypted only on the way out, for the first answer and for replays.
 */
async function createWebhook(req: AuthRequest & ValidatedRequest<CreateWebhookBody>, res: Response, scope: WebhookScope, params: Record<string, string>) {
  const body = req.validBody!;
  const send = res.send.bind(res);
  res.send = (payload?: unknown) => send(typeof payload === 'string' ? revealSealedSecret(payload) : payload);
  await respondIdempotently(req, res, {
    operation: 'webhooks.create',
    args: { params, body },
    authorize: () => authorizeCreateWebhook({ scope, userId: req.userId!, body }),
  });
}

/** The PAT's scopes, or `null` for a person's session (services/webhooks.ts `PatScopes`). */
function patScopesOf(req: AuthRequest): readonly string[] | null {
  return req.authSource === 'pat' ? req.patScopes ?? [] : null;
}

export const projectWebhooksRouter: Router = Router();

projectWebhooksRouter.get('/:id/webhooks', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await listWebhooks({ scope: { kind: 'project', projectId: req.params.id as string }, userId: req.userId!, patScopes: patScopesOf(req) }));
});

projectWebhooksRouter.post('/:id/webhooks', requireInteractiveSession, validateBody(createWebhookBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateWebhookBody>, res: Response) => {
    const projectId = req.params.id as string;
    res.setHeader('Cache-Control', 'no-store');
    await createWebhook(req, res, { kind: 'project', projectId }, { scope: 'project', id: projectId });
  },
);

export const workspaceWebhooksRouter: Router = Router();

workspaceWebhooksRouter.get('/:id/webhooks', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await listWebhooks({ scope: { kind: 'workspace', workspaceId: req.params.id as string }, userId: req.userId!, patScopes: patScopesOf(req) }));
});

workspaceWebhooksRouter.post('/:id/webhooks', requireInteractiveSession, validateBody(createWebhookBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateWebhookBody>, res: Response) => {
    const workspaceId = req.params.id as string;
    res.setHeader('Cache-Control', 'no-store');
    await createWebhook(req, res, { kind: 'workspace', workspaceId }, { scope: 'workspace', id: workspaceId });
  },
);

export const webhooksRouter: Router = Router();

webhooksRouter.get('/:webhookId', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await getWebhook({ webhookId: req.params.webhookId as string, userId: req.userId!, patScopes: patScopesOf(req) }));
});

webhooksRouter.patch('/:webhookId', requireInteractiveSession, validateBody(updateWebhookBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateWebhookBody>, res: Response) => {
    res.json(await updateWebhook({ webhookId: req.params.webhookId as string, userId: req.userId!, body: req.validBody! }));
  },
);

webhooksRouter.delete('/:webhookId', requireAuth, async (req: AuthRequest, res: Response) => {
  await deleteWebhook({ webhookId: req.params.webhookId as string, userId: req.userId!, patScopes: patScopesOf(req) });
  res.status(204).send();
});

webhooksRouter.post('/:webhookId/rotate-secret', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await rotateWebhookSecret({ webhookId: req.params.webhookId as string, userId: req.userId! }));
});

webhooksRouter.post('/:webhookId/ping', requireAuth, async (req: AuthRequest, res: Response) => {
  res.status(201).json(await pingWebhook({ webhookId: req.params.webhookId as string, userId: req.userId!, patScopes: patScopesOf(req) }));
});

webhooksRouter.get('/:webhookId/deliveries', requireAuth, validateQuery(listWebhookDeliveriesQuerySchema),
  async (req: AuthRequest & ValidatedRequest<unknown, ListWebhookDeliveriesQuery>, res: Response) => {
    res.json(await listWebhookDeliveries({ webhookId: req.params.webhookId as string, userId: req.userId!, patScopes: patScopesOf(req), query: req.validQuery ?? {} }));
  },
);

webhooksRouter.get('/:webhookId/deliveries/:deliveryId', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await getWebhookDelivery({ webhookId: req.params.webhookId as string, deliveryId: req.params.deliveryId as string, userId: req.userId!, patScopes: patScopesOf(req) }));
});

webhooksRouter.post('/:webhookId/deliveries/:deliveryId/redeliver', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await redeliverWebhookDelivery({ webhookId: req.params.webhookId as string, deliveryId: req.params.deliveryId as string, userId: req.userId!, patScopes: patScopesOf(req) }));
});
