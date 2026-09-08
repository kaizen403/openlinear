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
import { requireAuth, AuthRequest } from '../middleware/auth';
import { prisma } from '@openlinear/db';
import { buildErrorEnvelope } from '../lib/http';
import { hashToken, revokeSessionByTokenHash } from '../services/sessions';
import { getJwtSecret } from '../lib/secrets';
import { issueSessionToken, issueTwoFactorPendingToken } from '../lib/auth-tokens';
import { toCurrentUser } from '../lib/selects';

const router: Router = Router();

const STATE_TTL_MS = 10 * 60 * 1000;
const DESKTOP_CALLBACK_SCHEME = 'openlinear://callback';

type OAuthClient = 'web' | 'desktop' | 'dashboard';

function getFrontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

function getDashboardUrl() {
  return process.env.DASHBOARD_URL || 'http://localhost:3005';
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
    if (payload.client !== 'web' && payload.client !== 'desktop' && payload.client !== 'dashboard') return null;
    if (typeof payload.nonce !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

function buildWebSuccessRedirect(client: OAuthClient, token: string): string {
  if (client === 'dashboard') {
    // The dashboard is a separate frontend outside this repo; its callback
    // contract is unchanged.
    return `${getDashboardUrl()}?token=${encodeURIComponent(token)}`;
  }
  // Target the dedicated session-adoption route rather than the app root.
  //
  // The web client used to read `?token=` on EVERY route and silently swap the
  // session, so any link of the form `https://app/anything?token=<attacker-jwt>`
  // logged the victim into the attacker's account. That app-wide sniffing has
  // been removed; `/auth/session` is now the only route that adopts a token,
  // and it verifies the token against the API before doing so.
  return `${getFrontendUrl()}/auth/session?token=${encodeURIComponent(token)}`;
}

function buildDesktopCallbackUrl(params: { token?: string; error?: string }): string {
  const query = new URLSearchParams();
  if (params.token) query.set('token', params.token);
  if (params.error) query.set('error', params.error);
  return `${DESKTOP_CALLBACK_SCHEME}?${query.toString()}`;
}

function respondWithSuccess(client: OAuthClient, token: string, res: Response): void {
  if (client === 'desktop') {
    res
      .set('Cache-Control', 'no-store')
      .redirect(buildDesktopCallbackUrl({ token }));
    return;
  }
  res.redirect(buildWebSuccessRedirect(client, token));
}

function respondWithError(client: OAuthClient, error: string, res: Response): void {
  const encoded = encodeURIComponent(error);
  if (client === 'desktop') {
    res
      .set('Cache-Control', 'no-store')
      .redirect(buildDesktopCallbackUrl({ error }));
    return;
  }
  if (client === 'dashboard') {
    res.redirect(`${getDashboardUrl()}?error=${encoded}`);
    return;
  }
  // Same route as the success case: it renders the failure and sends the user
  // back to /login.
  res.redirect(`${getFrontendUrl()}/auth/session?error=${encoded}`);
}

router.get('/github', (req: Request, res: Response) => {
  const clientParam = req.query.client;
  const requestedClient: OAuthClient =
    clientParam === 'desktop' ? 'desktop' : clientParam === 'dashboard' ? 'dashboard' : 'web';
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
    respondWithError(client, String(error_description || error), res);
    return;
  }

  if (!code || typeof code !== 'string') {
    respondWithError(client, 'missing_code', res);
    return;
  }

  if (!verified) {
    console.warn('[Auth] OAuth callback received with invalid or expired state');
    respondWithError(client, 'invalid_state', res);
    return;
  }

  try {
    const redirectUri =
      client === 'desktop' ? buildDesktopRedirectUri(req) : undefined;
    const accessToken = await exchangeCodeForToken(code, redirectUri);
    const githubUser = await getGitHubUser(accessToken);
    const user = await createOrUpdateUser(githubUser, accessToken);

    if (user.totpEnabled) {
      const tempToken = issueTwoFactorPendingToken({
        id: user.id,
        username: user.username,
      });

      if (client === 'desktop') {
        respondWithSuccess(client, `2fa:${tempToken}`, res);
      } else {
        const baseUrl = client === 'dashboard' ? getDashboardUrl() : getFrontendUrl();
        res.redirect(`${baseUrl}?twoFactor=true&tempToken=${encodeURIComponent(tempToken)}`);
      }
      return;
    }

    // Session creation is not optional: `isSessionRevoked` fails closed, so a
    // token without a session row would be rejected on its very first use.
    const token = await issueSessionToken(
      { id: user.id, username: user.username },
      req,
    );

    respondWithSuccess(client, token, res);
  } catch (err) {
    console.error('[Auth] OAuth callback error:', err);
    const errorMsg = err instanceof Error ? err.message : 'auth_failed';
    respondWithError(client, errorMsg, res);
  }
});

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await getUserById(req.userId!);

    if (!user) {
      res.status(401).json(buildErrorEnvelope('USER_NOT_FOUND', 'User not found'));
      return;
    }

    res.json(toCurrentUser(user));
  } catch {
    res.status(500).json(buildErrorEnvelope('USER_LOOKUP_FAILED', 'Failed to load current user'));
  }
});

router.patch('/me', requireAuth, async (_req: AuthRequest, res: Response) => {
  // Self-service email changes are disabled pending a verified change flow.
  //
  // The address was writable with no proof of control, and `GET /api/invitations/pending`
  // matches invitations by email and returns the invitation token. Together those
  // let any user set their address to a colleague's, read that colleague's pending
  // invitation token, and join another tenant's workspace. Re-enable this only
  // together with an emailed confirmation link (Phase 1).
  res.status(501).json(
    buildErrorEnvelope(
      'EMAIL_CHANGE_UNAVAILABLE',
      'Changing your email address is temporarily unavailable. Contact your workspace owner.',
    ),
  );
});

router.post('/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  // Previously a no-op: the client deleted localStorage while the bearer token
  // stayed valid for its full 7-day lifetime, surviving "revoke all sessions".
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (token) {
    try {
      await revokeSessionByTokenHash(hashToken(token));
    } catch {
      res.status(500).json(buildErrorEnvelope('LOGOUT_FAILED', 'Failed to revoke session'));
      return;
    }
  }

  res.json({ success: true });
});

export default router;
