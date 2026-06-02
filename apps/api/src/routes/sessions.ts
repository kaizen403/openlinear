import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { listActiveSessions, revokeSession, revokeAllOtherSessions, hashToken } from '../services/sessions';
import { buildErrorEnvelope } from '../lib/http';

const router: Router = Router();

function getCurrentSessionId(req: AuthRequest): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  if (token.startsWith('ol_pat_')) return null;
  return hashToken(token);
}

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const sessions = await listActiveSessions(req.userId!);
  res.json({ sessions });
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string;
  const result = await revokeSession(id, req.userId!);
  if (!result) {
    res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'Session not found'));
    return;
  }
  res.json({ success: true });
});

router.post('/revoke-others', requireAuth, async (req: AuthRequest, res: Response) => {
  const currentSessionId = getCurrentSessionId(req);
  if (!currentSessionId) {
    res.status(400).json(buildErrorEnvelope('INVALID_INPUT', 'Cannot identify current session'));
    return;
  }
  const result = await revokeAllOtherSessions(req.userId!, currentSessionId);
  res.json({ revoked: result.count });
});

export default router;
