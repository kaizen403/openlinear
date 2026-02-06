import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  getAuthorizationUrl,
  exchangeCodeForToken,
  getGitHubUser,
  createOrUpdateUser,
  getUserById,
} from '../services/github';

const router: Router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'openlinear-dev-secret-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

function generateState(): string {
  return crypto.randomUUID();
}

router.get('/github', (_req: Request, res: Response) => {
  const state = generateState();
  const authUrl = getAuthorizationUrl(state);
  res.redirect(authUrl);
});

router.get('/github/callback', async (req: Request, res: Response) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error('[Auth] GitHub OAuth error:', error, error_description);
    res.redirect(`${FRONTEND_URL}?error=${encodeURIComponent(String(error_description || error))}`);
    return;
  }

  if (!code || typeof code !== 'string') {
    res.redirect(`${FRONTEND_URL}?error=missing_code`);
    return;
  }

  try {
    const accessToken = await exchangeCodeForToken(code);
    const githubUser = await getGitHubUser(accessToken);
    const user = await createOrUpdateUser(githubUser, accessToken);

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.redirect(`${FRONTEND_URL}?token=${token}`);
  } catch (err) {
    console.error('[Auth] OAuth callback error:', err);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

router.get('/me', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await getUserById(decoded.userId);

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const { accessToken: _, ...safeUser } = user;
    res.json(safeUser);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.post('/logout', (_req: Request, res: Response) => {
  res.json({ success: true });
});

export default router;
