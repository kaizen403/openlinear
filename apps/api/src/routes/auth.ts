import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '@openlinear/db';
import {
  getAuthorizationUrl,
  exchangeCodeForToken,
  getGitHubUser,
  createOrUpdateUser,
  getUserById,
} from '../services/github';
import { z } from 'zod';

const router: Router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'openlinear-dev-secret-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

function generateState(): string {
  return crypto.randomUUID();
}

// --- Email/Password Auth ---

const registerSchema = z.object({
  username: z.string().min(2).max(50).regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, hyphens, and underscores'),
  password: z.string().min(3).max(100),
  email: z.string().email().optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post('/register', async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const { username, password, email } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        email: email || null,
      },
    });

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (error) {
    console.error('[Auth] Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const { username, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.passwordHash) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: { id: user.id, username: user.username, email: user.email, avatarUrl: user.avatarUrl } });
  } catch (error) {
    console.error('[Auth] Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// --- GitHub OAuth ---

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
