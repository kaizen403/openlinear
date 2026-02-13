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

router.get('/status', (_req, res: Response) => {
  res.json(getOpenCodeStatus());
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
    const result = await client.provider.oauth.authorize({
      path: { id: providerId },
      body: { method: method ?? 0 },
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
    const result = await client.provider.oauth.callback({
      path: { id: providerId },
      body: { method: method ?? 0, code },
    });

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to complete OAuth' });
  }
});

export default router;
