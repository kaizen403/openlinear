import { apiFetch, ApiError, NetworkError } from './fetch';
import { getCloudApiUrl } from './client';
import { isDesktopRuntime } from './runtime';
import { clearStoredSession, getToken, setRefreshToken, setToken } from './token-store';
import {
  computeCodeChallenge,
  findPendingLogin,
  forgetPendingLogin,
  generateCodeVerifier,
  generateLoginState,
  rememberPendingLogin,
  type DesktopCallback,
} from './desktop-auth';
import type { User } from './types';

export { parseDesktopCallbackUrl } from './desktop-auth';
// Pending attempts expire after DESKTOP_LOGIN_TTL_MS (desktop-auth.ts).
export type { DesktopCallback } from './desktop-auth';

const TOKEN_VERIFY_TIMEOUT_MS = 15_000;
const TOKEN_VERIFY_MIN_RETRY_MS = 300;
const TOKEN_VERIFY_MAX_RETRY_MS = 1_250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  return (
    err instanceof NetworkError ||
    (err instanceof ApiError && (err.status === 408 || err.status === 429 || err.status >= 500))
  );
}

function removeTokenIfCurrent(token: string): void {
  if (getToken() === token) {
    setToken(null);
  }
}

/** The signed-in user, or null. Always asks the cloud API. */
export async function fetchCurrentUser(): Promise<User | null> {
  if (typeof window === 'undefined') return null;
  const token = getToken();
  if (!token) return null;

  try {
    return await apiFetch<User>('/api/auth/me', { allowUnauthenticated: true });
  } catch (err) {
    if (err instanceof NetworkError) return null;
    if (err instanceof ApiError && err.status !== 401) return null;
    removeTokenIfCurrent(token);
    return null;
  }
}

/**
 * Verify an access token against the cloud API, then adopt it.
 *
 * Used by the web `/auth/session` route, the only place a token arrives in a
 * URL. Nothing is stored until the API has accepted the token.
 */
export async function verifyCallbackToken(token: string): Promise<User> {
  if (typeof window === 'undefined') {
    throw new NetworkError('Cannot verify callback token outside the browser');
  }

  const deadline = Date.now() + TOKEN_VERIFY_TIMEOUT_MS;
  let retryDelayMs = TOKEN_VERIFY_MIN_RETRY_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const user = await apiFetch<User>('/api/auth/me', { authToken: token });
      setToken(token);
      return user;
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err)) throw err;
      await sleep(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())));
      retryDelayMs = Math.min(TOKEN_VERIFY_MAX_RETRY_MS, retryDelayMs + 150);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Token verification failed');
}

/** Browser (web) sign-in entry point on the cloud API. */
export function getLoginUrl(): string {
  return `${getCloudApiUrl()}/api/auth/github`;
}

export const GITHUB_OAUTH_UNAVAILABLE_MESSAGE =
  'GitHub sign-in is not available on this server yet.';

export interface AuthProviders {
  github: { enabled: boolean };
}

/** Which sign-in methods the cloud API accepts right now. */
export async function fetchAuthProviders(): Promise<AuthProviders> {
  try {
    const providers = await apiFetch<AuthProviders>('/api/auth/providers', { anonymous: true });
    return { github: { enabled: providers?.github?.enabled === true } };
  } catch {
    return { github: { enabled: false } };
  }
}

export type DesktopLoginFailure =
  | 'unavailable'
  | 'unsolicited'
  | 'rejected'
  | 'provider_error'
  | 'network';

export class DesktopLoginError extends Error {
  constructor(
    public readonly reason: DesktopLoginFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopLoginError';
  }
}

/**
 * Desktop step 1: create a PKCE verifier and state, ask the cloud API for the
 * GitHub authorize URL bound to them, and open it in the system browser.
 * Returns false when GitHub sign-in is disabled on the server.
 */
export async function startDesktopLogin(): Promise<boolean> {
  const verifier = generateCodeVerifier();
  const state = generateLoginState();
  const codeChallenge = await computeCodeChallenge(verifier);

  let authorizeUrl: string;
  try {
    const res = await apiFetch<{ authorizeUrl: string }>('/api/auth/desktop/authorize', {
      method: 'POST',
      anonymous: true,
      body: JSON.stringify({ codeChallenge, codeChallengeMethod: 'S256', state }),
    });
    authorizeUrl = res.authorizeUrl;
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) return false;
    throw err;
  }

  const parsed = new URL(authorizeUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new DesktopLoginError('rejected', 'The server returned an unexpected sign-in address.');
  }

  rememberPendingLogin({ state, verifier, createdAt: Date.now() });
  const { open } = await import('@tauri-apps/plugin-shell');
  await open(parsed.toString());
  return true;
}

export type DesktopLoginResult =
  | { status: 'signed_in'; user: User }
  | { status: 'two_factor_required'; tempToken: string };

const redemptions = new Map<string, Promise<DesktopLoginResult>>();

interface DesktopTokenResponse {
  token?: string;
  refreshToken?: string;
  twoFactorRequired?: boolean;
  tempToken?: string;
}

async function redeemDesktopCode(code: string, state: string, verifier: string): Promise<DesktopLoginResult> {
  let body: DesktopTokenResponse;
  try {
    body = await apiFetch<DesktopTokenResponse>('/api/auth/desktop/token', {
      method: 'POST',
      anonymous: true,
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      // Keep the verifier: the code stays redeemable for two minutes.
      throw new DesktopLoginError('network', 'Could not reach OpenLinear to finish signing in.');
    }
    forgetPendingLogin(state);
    if (err instanceof ApiError && err.status === 503) {
      throw new DesktopLoginError('unavailable', GITHUB_OAUTH_UNAVAILABLE_MESSAGE);
    }
    throw new DesktopLoginError('rejected', 'That sign-in link is no longer valid. Sign in again.');
  }

  forgetPendingLogin(state);
  if (body.twoFactorRequired && body.tempToken) {
    return { status: 'two_factor_required', tempToken: body.tempToken };
  }
  if (!body.token || !body.refreshToken) {
    throw new DesktopLoginError('rejected', 'The server did not return a session.');
  }
  return { status: 'signed_in', user: await adoptSession(body.token, body.refreshToken) };
}

/**
 * Store tokens returned in an authenticated HTTPS response body (not taken
 * from a URL), then load the user they belong to.
 */
async function adoptSession(token: string, refreshToken: string): Promise<User> {
  setToken(token);
  setRefreshToken(refreshToken);
  return apiFetch<User>('/api/auth/me');
}

/**
 * Desktop step 3: handle the `openlinear://callback` deep link (or a pasted
 * copy of it). Only a callback whose `state` matches an attempt this app
 * started is redeemed; the same code delivered twice is redeemed once.
 */
export async function completeDesktopLogin(callback: DesktopCallback): Promise<DesktopLoginResult> {
  const pending = callback.state ? findPendingLogin(callback.state) : null;

  if (callback.kind === 'error') {
    if (!pending) {
      throw new DesktopLoginError('unsolicited', 'Ignored a sign-in response this app did not ask for.');
    }
    forgetPendingLogin(pending.state);
    throw new DesktopLoginError('provider_error', `GitHub sign-in did not complete (${callback.error}).`);
  }

  if (!pending) {
    // Unknown or expired (attempts last DESKTOP_LOGIN_TTL_MS) — never redeemed.
    throw new DesktopLoginError('unsolicited', 'This sign-in link was not started here or has expired. Start sign-in again.');
  }

  const inFlight = redemptions.get(callback.code);
  if (inFlight) return inFlight;
  const redemption = redeemDesktopCode(callback.code, pending.state, pending.verifier).finally(() => {
    redemptions.delete(callback.code);
  });
  redemptions.set(callback.code, redemption);
  return redemption;
}

/** Finish a sign-in that requires a TOTP code (`POST /api/auth/2fa/validate`). */
export async function completeTwoFactorLogin(tempToken: string, code: string): Promise<User> {
  const body = await apiFetch<{ token?: string; refreshToken?: string }>('/api/auth/2fa/validate', {
    method: 'POST',
    anonymous: true,
    body: JSON.stringify({ tempToken, code }),
  });
  if (!body.token) throw new ApiError(401, 'Two-factor sign-in failed');
  setToken(body.token);
  // Web keeps the refresh token in the HttpOnly cookie; this is a no-op there.
  if (body.refreshToken) setRefreshToken(body.refreshToken);
  return apiFetch<User>('/api/auth/me');
}

/**
 * Start GitHub sign-in. Desktop: PKCE + system browser + deep link. Web: a
 * top-level navigation to the cloud API. Returns false when the server has
 * GitHub sign-in disabled.
 */
export async function startLogin(): Promise<boolean> {
  if (isDesktopRuntime()) {
    return startDesktopLogin();
  }
  const providers = await fetchAuthProviders();
  if (!providers.github.enabled) return false;
  window.location.href = getLoginUrl();
  return true;
}

export async function updateEmail(email: string): Promise<User> {
  return apiFetch<User>('/api/auth/me', {
    method: 'PATCH',
    body: JSON.stringify({ email }),
  });
}

/**
 * Sign out: revoke the session at the cloud API (best effort — it also clears
 * the web refresh cookie), forget local credentials, and go home.
 */
export function logout(): void {
  const token = getToken();
  if (token) {
    const desktop = isDesktopRuntime();
    void fetch(`${getCloudApiUrl()}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: desktop ? 'omit' : 'include',
      keepalive: true,
    }).catch(() => undefined);
  }
  clearStoredSession();
  window.location.href = '/';
}
