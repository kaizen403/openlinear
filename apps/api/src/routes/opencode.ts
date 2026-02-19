import { Router, Response } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth';
import {
  getOpenCodeStatus,
  getClientForUser,
  getContainerStatus,
  ensureContainer,
  destroyContainer,
} from '../services/opencode';

const router: Router = Router();

type ProviderAuthEntry = { type?: string };

function resolveOauthMethodIndex(
  methods: ProviderAuthEntry[] | undefined,
  requestedMethod: unknown
): number {
  if (!methods || methods.length === 0) {
    return typeof requestedMethod === 'number' ? requestedMethod : 0;
  }

  if (
    typeof requestedMethod === 'number' &&
    requestedMethod >= 0 &&
    requestedMethod < methods.length &&
    methods[requestedMethod]?.type === 'oauth'
  ) {
    return requestedMethod;
  }

  const oauthIndex = methods.findIndex((entry) => entry?.type === 'oauth');
  if (oauthIndex >= 0) return oauthIndex;

  return typeof requestedMethod === 'number' ? requestedMethod : 0;
}

router.get('/status', (_req, res: Response) => {
  res.json(getOpenCodeStatus());
});

router.get('/setup-status', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const containerStatus = getContainerStatus(req.userId!);

    let providers: Array<{ id: string; name: string; authenticated: boolean }> = [];
    let ready = false;

    if (containerStatus?.status === 'running') {
      try {
        const client = await getClientForUser(req.userId!);
        const providerList = await client.provider.list();

        if (providerList.data?.all) {
          const connectedSet = new Set(providerList.data.connected ?? []);

          const popularProviderIds = new Set([
            'anthropic',
            'openai',
            'google',
            'github-copilot',
            'groq',
            'deepseek',
            'mistral',
            'xai',
            'openrouter',
            'amazon-bedrock',
          ]);

          providers = providerList.data.all
            .filter((provider) => popularProviderIds.has(provider.id))
            .map((provider) => ({
              id: provider.id,
              name: provider.name || provider.id,
              // Only use the `connected` set — /provider/auth returns available auth
              // methods (oauth, api), NOT whether credentials are actually configured
              authenticated: connectedSet.has(provider.id),
            }));
        }

        ready = providers.some(p => p.authenticated);
      } catch {
        // Container running but can't query providers — still return container status
      }
    }

    res.json({
      container: containerStatus ? {
        status: containerStatus.status,
        hostPort: containerStatus.hostPort,
      } : null,
      providers,
      ready,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get setup status' });
  }
});

router.get('/container', requireAuth, (req: AuthRequest, res: Response) => {
  const status = getContainerStatus(req.userId!);
  if (!status) {
    res.json({ status: 'none', message: 'No container running for this user' });
    return;
  }
  res.json({
    status: status.status,
    hostPort: status.hostPort,
    baseUrl: status.baseUrl,
    lastActivity: status.lastActivity.toISOString(),
    createdAt: status.createdAt.toISOString(),
    error: status.error,
  });
});

router.post('/container', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const container = await ensureContainer(req.userId!);
    res.json({
      status: container.status,
      hostPort: container.hostPort,
      baseUrl: container.baseUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start container' });
  }
});

router.delete('/container', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await destroyContainer(req.userId!);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to destroy container' });
  }
});

router.get('/providers', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getClientForUser(req.userId!);
    const providers = await client.provider.list();
    res.json(providers.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list providers' });
  }
});

router.get('/providers/auth', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getClientForUser(req.userId!);
    const auth = await client.provider.auth();
    res.json(auth.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get provider auth methods' });
  }
});

router.post('/auth', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { providerId, apiKey } = req.body;
    if (!providerId || !apiKey) {
      res.status(400).json({ error: 'providerId and apiKey are required' });
      return;
    }

    const client = await getClientForUser(req.userId!);
    await client.auth.set({
      path: { id: providerId },
      body: { type: 'api', key: apiKey },
    });

    res.json({ success: true, providerId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to set auth' });
  }
});

router.post('/auth/oauth/authorize', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { providerId, method } = req.body;
    if (!providerId) {
      res.status(400).json({ error: 'providerId is required' });
      return;
    }

    const client = await getClientForUser(req.userId!);
    const auth = await client.provider.auth();
    const methods = auth.data?.[providerId] as ProviderAuthEntry[] | undefined;
    const resolvedMethod = resolveOauthMethodIndex(methods, method);

    const result = await client.provider.oauth.authorize({
      path: { id: providerId },
      body: { method: resolvedMethod },
    });

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start OAuth' });
  }
});

router.post('/auth/oauth/callback', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { providerId, method, code } = req.body;
    if (!providerId || !code) {
      res.status(400).json({ error: 'providerId and code are required' });
      return;
    }

    const client = await getClientForUser(req.userId!);
    const auth = await client.provider.auth();
    const methods = auth.data?.[providerId] as ProviderAuthEntry[] | undefined;
    const resolvedMethod = resolveOauthMethodIndex(methods, method);

    const result = await client.provider.oauth.callback({
      path: { id: providerId },
      body: { method: resolvedMethod, code },
    });

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to complete OAuth' });
  }
});

router.get('/models', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getClientForUser(req.userId!);
    const providerList = await client.provider.list();

    if (!providerList.data?.all) {
      res.json({ providers: [] });
      return;
    }

    const connectedSet = new Set(providerList.data.connected ?? []);

    const providers = providerList.data.all
      .filter((provider) => connectedSet.has(provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name || provider.id,
        models: Object.values(provider.models || {}).map((model) => ({
          id: model.id,
          provider: model.provider,
          name: model.name || model.id,
          status: model.status,
          reasoning: model.reasoning ?? false,
          toolCall: model.tool_call ?? false,
          limit: model.limit,
          cost: {
            input: model.cost?.input ?? 0,
            output: model.cost?.output ?? 0,
          },
        })),
      }));

    res.json({ providers });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list models' });
  }
});

router.get('/config', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getClientForUser(req.userId!);
    const config = await client.config.get();

    res.json({
      model: config.data?.model ?? null,
      small_model: config.data?.small_model ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get config' });
  }
});

router.post('/config/model', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { model } = req.body;
    if (!model || typeof model !== 'string') {
      res.status(400).json({ error: 'model is required (format: provider/model)' });
      return;
    }

    const client = await getClientForUser(req.userId!);
    await client.config.update({
      body: { model },
    });

    res.json({ success: true, model });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to set model' });
  }
});

export default router;
