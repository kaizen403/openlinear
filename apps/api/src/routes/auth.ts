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

const router: Router = Router();

const STATE_TTL_MS = 10 * 60 * 1000;
const DESKTOP_CALLBACK_SCHEME = 'openlinear://callback';

type OAuthClient = 'web' | 'desktop' | 'dashboard';

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
    return `${getDashboardUrl()}?token=${encodeURIComponent(token)}`;
  }
  return `${getFrontendUrl()}?token=${encodeURIComponent(token)}`;
}

function buildDesktopCallbackUrl(params: { token?: string; error?: string }): string {
  const query = new URLSearchParams();
  if (params.token) query.set('token', params.token);
  if (params.error) query.set('error', params.error);
  return `${DESKTOP_CALLBACK_SCHEME}?${query.toString()}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeScriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function renderDesktopCallbackHtml(params: { token?: string; error?: string }): string {
  const callbackUrl = buildDesktopCallbackUrl(params);
  const hasToken = Boolean(params.token);
  const safeError = params.error ? escapeHtml(params.error) : '';
  const safeCallbackUrl = escapeHtml(callbackUrl);
  const title = hasToken ? 'OpenLinear authenticated' : 'OpenLinear sign-in failed';
  const statusText = hasToken
    ? 'Authenticated. Return to OpenLinear to finish signing in.'
    : `GitHub returned an error${safeError ? `: ${safeError}` : '.'}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="cache-control" content="no-store">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0f0f; color: #f5f5f5; }
    main { width: min(520px, calc(100vw - 32px)); border: 1px solid #2a2a2a; background: #171717; padding: 24px; border-radius: 6px; }
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; color: #f5f5f5; font-weight: 650; letter-spacing: 0; }
    .brand svg { width: 32px; height: 32px; color: #5e6ad2; flex: none; }
    h1 { margin: 0 0 8px; font-size: 20px; line-height: 1.25; }
    p { margin: 0 0 16px; color: #b8b8b8; font-size: 14px; line-height: 1.5; }
    a, button { appearance: none; border: 1px solid #3a3a3a; background: #5e6ad2; color: white; border-radius: 4px; padding: 10px 14px; font: inherit; font-size: 14px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
    button.secondary { background: transparent; color: #f5f5f5; }
    .copy-status { min-height: 18px; margin: 10px 0 0; color: #8a8f98; font-size: 12px; }
    textarea { width: 100%; box-sizing: border-box; min-height: 104px; resize: vertical; margin: 8px 0 12px; padding: 10px; border-radius: 4px; border: 1px solid #333; background: #0f0f0f; color: #f5f5f5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .fallback { margin-top: 18px; padding-top: 18px; border-top: 1px solid #2a2a2a; }
  </style>
</head>
<body>
  <main>
    <div class="brand" aria-label="OpenLinear">
      <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <circle cx="32" cy="32" r="22" stroke="currentColor" stroke-width="8" fill="none"></circle>
        <path d="M22 42 L42 22" stroke="currentColor" stroke-width="8" stroke-linecap="square"></path>
      </svg>
      <span>OpenLinear</span>
    </div>
    <h1>${escapeHtml(title)}</h1>
    <p>${statusText}</p>
    <div class="actions">
      <a id="open-app" href="${safeCallbackUrl}">Open OpenLinear</a>
      <button class="secondary" type="button" id="copy-app-link">Copy app link</button>
    </div>
    <p id="copy-status" class="copy-status" aria-live="polite"></p>
    ${hasToken ? `<div class="fallback">
      <p>If OpenLinear does not open, copy the app link below and paste it into the sign-in screen.</p>
      <textarea id="app-link" readonly>${safeCallbackUrl}</textarea>
    </div>` : ''}
  </main>
  <script>
    const callbackUrl = ${escapeScriptString(callbackUrl)};
    const copyStatus = document.getElementById('copy-status');

    async function copyText(value, label) {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        if (copyStatus) copyStatus.textContent = label + ' copied.';
        return;
      } catch {}

      const field = document.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.left = '-9999px';
      document.body.appendChild(field);
      field.select();
      try {
        document.execCommand('copy');
        if (copyStatus) copyStatus.textContent = label + ' copied.';
      } catch {
        if (copyStatus) copyStatus.textContent = 'Copy failed. Select the token below manually.';
      } finally {
        field.remove();
      }
    }

    document.getElementById('open-app')?.addEventListener('click', () => {
      if (copyStatus) copyStatus.textContent = 'If OpenLinear did not open, copy the app link below and paste it into the sign-in screen.';
      window.setTimeout(() => {
        window.location.href = callbackUrl;
      }, 0);
    });
    document.getElementById('copy-app-link')?.addEventListener('click', () => {
      void copyText(callbackUrl, 'App link');
    });
  </script>
</body>
</html>`;
}

function respondWithSuccess(client: OAuthClient, token: string, res: Response): void {
  if (client === 'desktop') {
    res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Cache-Control', 'no-store')
      .send(renderDesktopCallbackHtml({ token }));
    return;
  }
  res.redirect(buildWebSuccessRedirect(client, token));
}

function respondWithError(client: OAuthClient, error: string, res: Response): void {
  const encoded = encodeURIComponent(error);
  if (client === 'desktop') {
    res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Cache-Control', 'no-store')
      .send(renderDesktopCallbackHtml({ error }));
    return;
  }
  if (client === 'dashboard') {
    res.redirect(`${getDashboardUrl()}?error=${encoded}`);
    return;
  }
  res.redirect(`${getFrontendUrl()}?error=${encoded}`);
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

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      getJwtSecret(),
      { expiresIn: '7d' }
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

    const { accessToken: _, ...safeUser } = user;
    res.json({
      ...safeUser,
      githubLinked: Boolean(user.accessToken),
    });
  } catch {
    res.status(500).json(buildErrorEnvelope('USER_LOOKUP_FAILED', 'Failed to load current user'));
  }
});

router.patch('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string') {
    res.status(400).json(buildErrorEnvelope('EMAIL_REQUIRED', 'Email is required'));
    return;
  }

  const trimmed = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed)) {
    res.status(400).json(buildErrorEnvelope('INVALID_EMAIL', 'Invalid email format'));
    return;
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email: trimmed } });
    if (existing && existing.id !== req.userId) {
      res.status(409).json(buildErrorEnvelope('EMAIL_IN_USE', 'Email already in use'));
      return;
    }

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { email: trimmed },
    });

    const { accessToken: _, ...safeUser } = user;
    res.json(safeUser);
  } catch {
    res.status(500).json(buildErrorEnvelope('EMAIL_UPDATE_FAILED', 'Failed to update email'));
  }
});

router.post('/logout', (_req: Request, res: Response) => {
  res.json({ success: true });
});

export default router;
