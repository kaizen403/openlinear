import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  getAuthorizationUrl,
  getConfiguredGitHubRedirectUri,
  exchangeCodeForToken,
  getGitHubUser,
  createOrUpdateUser,
  getUserById,
} from '../services/github';

const router: Router = Router();

const STATE_TTL_MS = 10 * 60 * 1000;
const DESKTOP_CALLBACK_SCHEME = 'openlinear://callback';

type OAuthClient = 'web' | 'desktop';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[Auth] JWT_SECRET is required in production');
    }
    return 'openlinear-dev-secret-change-in-production';
  }
  return secret;
}

function getFrontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

function parseHttpHost(host: string | undefined): URL | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`);
  } catch {
    return null;
  }
}

function buildDesktopRedirectUri(req: Request): string | undefined {
  const requestUrl = parseHttpHost(req.get('host'));
  if (!requestUrl || !isLoopbackHostname(requestUrl.hostname) || !requestUrl.port) {
    return undefined;
  }

  try {
    const configured = new URL(getConfiguredGitHubRedirectUri());
    if (configured.protocol === 'http:' && isLoopbackHostname(configured.hostname)) {
      configured.port = requestUrl.port;
      configured.search = '';
      configured.hash = '';
      return configured.toString();
    }
  } catch {
    // Fall through to the request-derived loopback callback below.
  }

  return `http://${requestUrl.host}/api/auth/github/callback`;
}

function signState(payload: { client: OAuthClient; nonce: string; issuedAt: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getJwtSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state: string): { client: OAuthClient; nonce: string; issuedAt: number } | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = crypto
    .createHmac('sha256', getJwtSecret())
    .update(body)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof payload.issuedAt !== 'number') return null;
    if (Date.now() - payload.issuedAt > STATE_TTL_MS) return null;
    if (payload.client !== 'web' && payload.client !== 'desktop') return null;
    if (typeof payload.nonce !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

function buildSuccessRedirect(client: OAuthClient, token: string): string {
  if (client === 'desktop') {
    return `${DESKTOP_CALLBACK_SCHEME}?token=${encodeURIComponent(token)}`;
  }
  return `${getFrontendUrl()}?token=${encodeURIComponent(token)}`;
}

function buildErrorRedirect(client: OAuthClient, error: string): string {
  const encoded = encodeURIComponent(error);
  if (client === 'desktop') {
    return `${DESKTOP_CALLBACK_SCHEME}?error=${encoded}`;
  }
  return `${getFrontendUrl()}?error=${encoded}`;
}

router.get('/github', (req: Request, res: Response) => {
  const requestedClient = req.query.client === 'desktop' ? 'desktop' : 'web';
  const state = signState({
    client: requestedClient,
    nonce: crypto.randomUUID(),
    issuedAt: Date.now(),
  });
  const redirectUri =
    requestedClient === 'desktop' ? buildDesktopRedirectUri(req) : undefined;
  const authUrl = getAuthorizationUrl(state, redirectUri);
  res.redirect(authUrl);
});

router.get('/github/callback', async (req: Request, res: Response) => {
  const { code, error, error_description, state } = req.query;
  const stateStr = typeof state === 'string' ? state : '';
  const verified = verifyState(stateStr);
  const client: OAuthClient = verified?.client ?? 'web';

  if (error) {
    console.error('[Auth] GitHub OAuth error:', error, error_description);
    res.redirect(buildErrorRedirect(client, String(error_description || error)));
    return;
  }

  if (!code || typeof code !== 'string') {
    res.redirect(buildErrorRedirect(client, 'missing_code'));
    return;
  }

  if (!verified) {
    console.warn('[Auth] OAuth callback received with invalid or expired state');
    res.redirect(buildErrorRedirect(client, 'invalid_state'));
    return;
  }

  try {
    const accessToken = await exchangeCodeForToken(code);
    const githubUser = await getGitHubUser(accessToken);
    const user = await createOrUpdateUser(githubUser, accessToken);

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.redirect(buildSuccessRedirect(client, token));
  } catch (err) {
    console.error('[Auth] OAuth callback error:', err);
    const errorMsg = err instanceof Error ? err.message : 'auth_failed';
    res.redirect(buildErrorRedirect(client, errorMsg));
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
    const decoded = jwt.verify(token, getJwtSecret()) as { userId: string };
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
