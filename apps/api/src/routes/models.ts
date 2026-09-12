import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth';

const MODELS_DEV_URL = 'https://models.dev/api.json';
let cache: { fetchedAt: number; payload: unknown } | null = null;
const TTL_MS = 24 * 60 * 60 * 1000;

const router: Router = Router();

router.get('/', requireAuth, async (_req: AuthRequest, res: Response) => {
  if (!cache || Date.now() - cache.fetchedAt > TTL_MS) {
    const response = await fetch(MODELS_DEV_URL);
    if (!response.ok) {
      res.status(502).json({ error: 'MODELS_DEV_UNAVAILABLE', message: `models.dev ${response.status}` });
      return;
    }
    cache = { fetchedAt: Date.now(), payload: await response.json() };
  }
  res.json({
    source: 'models.dev',
    runners: [
      { id: 'opencode', capabilities: { streamingDeltas: true, permissionReply: true, interrupt: true, compact: true, cacheSplitUsage: true } },
      { id: 'codex', capabilities: { streamingDeltas: true, permissionReply: false, interrupt: true, compact: false, cacheSplitUsage: true } },
    ],
    models: cache.payload,
  });
});

export default router;
