import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import {
  getAuthorizationUrl,
  exchangeCodeForToken,
  getGitHubUser,
  createOrUpdateUser,
  getUserById,
} from '../services/github';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, type ValidatedRequest } from '../middleware/validate';
import { prisma } from '@openlinear/db';
import { buildErrorEnvelope } from '../lib/http';
import { hashToken, revokeSessionByTokenHash } from '../services/sessions';
import { getJwtSecret } from '../lib/secrets';
import { issueSession, issueTwoFactorPendingToken, rotateRefreshToken } from '../lib/auth-tokens';
import { issueDesktopAuthCode, redeemDesktopAuthCode } from '../services/desktop-auth';
import {
  desktopAuthorizeBodySchema,
  desktopTokenBodySchema,
  DESKTOP_STATE_PATTERN,
  PKCE_S256_CHALLENGE_PATTERN,
  type DesktopAuthorizeBody,
  type DesktopTokenBody,
} from '../schemas/auth';
import { REFRESH_TOKEN_TTL_MS } from '@openlinear/api-core';
import { toCurrentUser } from '../lib/selects';

const router: Router = Router();

const STATE_TTL_MS = 10 * 60 * 1000;
const DESKTOP_CALLBACK_URL = 'openlinear://callback';
const REFRESH_COOKIE = 'ol_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * OAuth client IDs that leaked in this repository and were revoked. They must
 * never be re-enabled, even if an environment still carries them.
 */
const REVOKED_GITHUB_CLIENT_ID_PREFIXES = ['Ov23liy8', 'Ov23limW'];

/**
 * GitHub sign-in is off until it is explicitly enabled with a replacement
 * OAuth app. It requires all of:
 *   - `OPENLINEAR_ENABLE_GITHUB_OAUTH=1` (an operator decision, in any NODE_ENV);
 *   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`;
 *   - a client ID that is not one of the revoked apps above.
 * Otherwise every GitHub/desktop sign-in endpoint answers 503
 * `GITHUB_OAUTH_DISABLED`, and GET /api/auth/providers reports it as off.
 */
export function githubOAuthEnabled(): boolean {
  if (process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH !== '1') return false;
  const clientId = process.env.GITHUB_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() ?? '';
  if (!clientId || !clientSecret) return false;
  return !REVOKED_GITHUB_CLIENT_ID_PREFIXES.some((prefix) => clientId.startsWith(prefix));
}

function requireGitHubOAuth(_req: unknown, res: Response, next: () => void): void {
  if (!githubOAuthEnabled()) {
    res.status(503).json(
      buildErrorEnvelope(
        'GITHUB_OAUTH_DISABLED',
        'GitHub sign-in is disabled. Use a personal access token, or wait for a replacement OAuth app.',
      ),
    );
    return;
  }
  next();
}

type OAuthClient = 'web' | 'desktop' | 'dashboard';

interface OAuthState {
  client: OAuthClient;
  nonce: string;
  issuedAt: number;
  /** Desktop only: PKCE S256 challenge the one-time code is bound to. */
  codeChallenge?: string;
  /** Desktop only: the app's correlation value, echoed on the deep link. */
  desktopState?: string;
}

function getFrontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

function getDashboardUrl() {
  return process.env.DASHBOARD_URL || 'http://localhost:3005';
}

function signState(payload: OAuthState): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getJwtSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state: string): OAuthState | null {
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
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Partial<OAuthState>;
    if (typeof payload.issuedAt !== 'number') return null;
    if (Date.now() - payload.issuedAt > STATE_TTL_MS) return null;
    if (payload.client !== 'web' && payload.client !== 'desktop' && payload.client !== 'dashboard') return null;
    if (typeof payload.nonce !== 'string') return null;
    if (payload.client === 'desktop') {
      // A desktop sign-in is only completable by the app that started it.
      if (
        typeof payload.codeChallenge !== 'string' ||
        !PKCE_S256_CHALLENGE_PATTERN.test(payload.codeChallenge) ||
        typeof payload.desktopState !== 'string' ||
        !DESKTOP_STATE_PATTERN.test(payload.desktopState)
      ) {
        return null;
      }
    }
    return {
      client: payload.client,
      nonce: payload.nonce,
      issuedAt: payload.issuedAt,
      ...(payload.client === 'desktop'
        ? { codeChallenge: payload.codeChallenge, desktopState: payload.desktopState }
        : {}),
    };
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

function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  });
}

/**
 * The desktop deep link carries a one-time code (or an error) and the app's
 * `state` — never an access or refresh token.
 */
function buildDesktopCallbackUrl(params: { code?: string; error?: string; state?: string }): string {
  const query = new URLSearchParams();
  if (params.code) query.set('code', params.code);
  if (params.error) query.set('error', params.error);
  if (params.state) query.set('state', params.state);
  return `${DESKTOP_CALLBACK_URL}?${query.toString()}`;
}

function redirectToDesktop(res: Response, params: { code?: string; error?: string; state?: string }): void {
  res.set('Cache-Control', 'no-store').redirect(buildDesktopCallbackUrl(params));
}

function respondWithWebSuccess(client: OAuthClient, token: string, res: Response, refreshToken?: string): void {
  if (refreshToken) setRefreshCookie(res, refreshToken);
  res.redirect(buildWebSuccessRedirect(client, token));
}

function respondWithError(state: OAuthState | null, error: string, res: Response): void {
  const client: OAuthClient = state?.client ?? 'web';
  if (client === 'desktop') {
    redirectToDesktop(res, { error, state: state?.desktopState });
    return;
  }
  const encoded = encodeURIComponent(error);
  if (client === 'dashboard') {
    res.redirect(`${getDashboardUrl()}?error=${encoded}`);
    return;
  }
  // Same route as the success case: it renders the failure and sends the user
  // back to /login.
  res.redirect(`${getFrontendUrl()}/auth/session?error=${encoded}`);
}

/** Public: which sign-in methods this deployment currently accepts. */
router.get('/providers', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store').json({ github: { enabled: githubOAuthEnabled() } });
});

router.get('/github', requireGitHubOAuth, (req: Request, res: Response) => {
  const clientParam = req.query.client;
  if (clientParam === 'desktop') {
    // The desktop app must start at POST /desktop/authorize so the sign-in is
    // bound to a PKCE verifier only the app holds. This browser entry point
    // used to finish with tokens in an openlinear:// URL.
    res.status(400).json(
      buildErrorEnvelope(
        'DESKTOP_PKCE_REQUIRED',
        'Desktop sign-in must be started from the OpenLinear app.',
      ),
    );
    return;
  }
  const requestedClient: OAuthClient = clientParam === 'dashboard' ? 'dashboard' : 'web';
  const state = signState({
    client: requestedClient,
    nonce: crypto.randomUUID(),
    issuedAt: Date.now(),
  });
  res.redirect(getAuthorizationUrl(state));
});

/**
 * Desktop step 1: bind a new GitHub sign-in to the app's PKCE challenge and
 * return the GitHub authorize URL for the app to open in the system browser.
 */
router.post(
  '/desktop/authorize',
  requireGitHubOAuth,
  validateBody(desktopAuthorizeBodySchema),
  (req: ValidatedRequest<DesktopAuthorizeBody>, res: Response) => {
    const body = req.validBody!;
    const state = signState({
      client: 'desktop',
      nonce: crypto.randomUUID(),
      issuedAt: Date.now(),
      codeChallenge: body.codeChallenge,
      desktopState: body.state,
    });
    res
      .set('Cache-Control', 'no-store')
      .json({ authorizeUrl: getAuthorizationUrl(state), expiresIn: STATE_TTL_MS / 1000 });
  },
);

router.get('/github/callback', requireGitHubOAuth, async (req: Request, res: Response) => {
  const { code, error, error_description, state } = req.query;
  const stateStr = typeof state === 'string' ? state : '';
  const verified = verifyState(stateStr);

  if (error) {
    console.error('[Auth] GitHub OAuth error:', error, error_description);
    respondWithError(verified, String(error_description || error), res);
    return;
  }

  if (!code || typeof code !== 'string') {
    respondWithError(verified, 'missing_code', res);
    return;
  }

  if (!verified) {
    console.warn('[Auth] OAuth callback received with invalid or expired state');
    respondWithError(null, 'invalid_state', res);
    return;
  }

  try {
    const accessToken = await exchangeCodeForToken(code);
    const githubUser = await getGitHubUser(accessToken);
    const user = await createOrUpdateUser(githubUser, accessToken);

    if (verified.client === 'desktop') {
      // Second factor (if any) is enforced when the code is redeemed.
      const issuedCode = await issueDesktopAuthCode({
        userId: user.id,
        codeChallenge: verified.codeChallenge!,
      });
      redirectToDesktop(res, { code: issuedCode.code, state: verified.desktopState });
      return;
    }

    if (user.totpEnabled) {
      const tempToken = await issueTwoFactorPendingToken({
        id: user.id,
        username: user.username,
      });
      const baseUrl = verified.client === 'dashboard' ? getDashboardUrl() : getFrontendUrl();
      res.redirect(`${baseUrl}?twoFactor=true#tempToken=${encodeURIComponent(tempToken)}`);
      return;
    }

    // Session creation is not optional: `isSessionRevoked` fails closed, so a
    // token without a session row would be rejected on its very first use.
    const issued = await issueSession(
      { id: user.id, username: user.username },
      req,
    );

    respondWithWebSuccess(verified.client, issued.accessToken, res, issued.refreshToken);
  } catch (err) {
    console.error('[Auth] OAuth callback error:', err);
    const errorMsg = err instanceof Error ? err.message : 'auth_failed';
    respondWithError(verified, errorMsg, res);
  }
});

/**
 * Desktop step 3: redeem the one-time code from the deep link with the PKCE
 * verifier. Tokens are returned in the body (the desktop app stores them in
 * its own store; no cookie is set). The code, the verifier binding and the
 * new session commit in one transaction.
 */
router.post(
  '/desktop/token',
  requireGitHubOAuth,
  validateBody(desktopTokenBodySchema),
  async (req: ValidatedRequest<DesktopTokenBody>, res: Response) => {
    const body = req.validBody!;
    res.set('Cache-Control', 'no-store');

    const outcome = await prisma.$transaction(async (tx) => {
      const redeemed = await redeemDesktopAuthCode(tx, {
        code: body.code,
        codeVerifier: body.codeVerifier,
      });
      if (!redeemed) return null;

      const user = await tx.user.findUnique({
        where: { id: redeemed.userId },
        select: { id: true, username: true, totpEnabled: true },
      });
      if (!user) return null;

      if (user.totpEnabled) {
        const tempToken = await issueTwoFactorPendingToken(user, tx);
        return { kind: 'two_factor' as const, tempToken };
      }

      const issued = await issueSession(user, req, tx);
      return { kind: 'session' as const, issued };
    });

    if (!outcome) {
      res.status(400).json(
        buildErrorEnvelope(
          'DESKTOP_AUTH_CODE_INVALID',
          'This sign-in link is invalid, expired or already used. Start sign-in again from the app.',
        ),
      );
      return;
    }

    if (outcome.kind === 'two_factor') {
      // Complete with POST /api/auth/2fa/validate { tempToken, code }.
      res.json({ twoFactorRequired: true, tempToken: outcome.tempToken });
      return;
    }

    res.json({
      token: outcome.issued.accessToken,
      refreshToken: outcome.issued.refreshToken,
      tokenType: 'Bearer',
    });
  },
);

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

router.post('/refresh', async (req: Request, res: Response) => {
  const bodyToken =
    typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
  const cookieHeader = req.headers.cookie ?? '';
  const cookieMatch = /(?:^|;\s*)ol_refresh=([^;]+)/.exec(cookieHeader);
  const cookieToken = cookieMatch?.[1] ? decodeURIComponent(cookieMatch[1]) : '';
  const refreshToken = bodyToken || cookieToken;
  if (!refreshToken) {
    res.status(401).json(buildErrorEnvelope('REFRESH_REQUIRED', 'Refresh token is required'));
    return;
  }

  const issued = await rotateRefreshToken(refreshToken, req);
  if (!issued) {
    if (!bodyToken) clearRefreshCookie(res);
    res.status(401).json(buildErrorEnvelope('INVALID_REFRESH', 'Refresh token is invalid or expired'));
    return;
  }

  res.set('Cache-Control', 'no-store');
  if (bodyToken) {
    // Body clients (desktop) keep the refresh token in their own store.
    res.json({ token: issued.accessToken, refreshToken: issued.refreshToken });
    return;
  }
  // Cookie clients (web) never see the refresh token: it stays HttpOnly.
  setRefreshCookie(res, issued.refreshToken);
  res.json({ token: issued.accessToken });
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

  // The web refresh token lives only in this HttpOnly cookie.
  clearRefreshCookie(res);
  res.json({ success: true });
});

export default router;
