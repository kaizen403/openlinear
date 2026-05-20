import { apiFetch, ApiError, AuthExpiredError, NetworkError } from './fetch';
import {
  getApiUrl,
  getSidecarApiUrl,
  resolveKnownSidecarApiUrl,
} from './client';
import type { User } from './types';

const TOKEN_VERIFY_TIMEOUT_MS = 15_000;
const TOKEN_VERIFY_MIN_RETRY_MS = 300;
const TOKEN_VERIFY_MAX_RETRY_MS = 1_250;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function removeTokenIfCurrent(token: string): void {
  try {
    if (localStorage.getItem('token') === token) {
      localStorage.removeItem('token');
    }
  } catch {}
}

function restoreToken(previousToken: string | null): void {
  try {
    if (previousToken) {
      localStorage.setItem('token', previousToken);
    } else {
      localStorage.removeItem('token');
    }
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isRetryableTokenVerificationError(err: unknown): boolean {
  return (
    err instanceof NetworkError ||
    (err instanceof ApiError && (err.status === 408 || err.status === 429 || err.status >= 500))
  );
}

async function getAuthApiUrl(): Promise<string> {
  if (!isTauriRuntime()) return getApiUrl();
  return resolveKnownSidecarApiUrl();
}

export async function fetchCurrentUser(): Promise<User | null> {
  if (typeof window === 'undefined') return null;
  const token = localStorage.getItem('token');
  if (!token) return null;

  try {
    const apiUrl = await getAuthApiUrl();
    return await apiFetch<User>(`${apiUrl}/api/auth/me`, { allowUnauthenticated: true });
  } catch (err) {
    if (err instanceof AuthExpiredError || err instanceof NetworkError) return null;
    if (err instanceof ApiError && err.status !== 401) return null;
    removeTokenIfCurrent(token);
    return null;
  }
}

export function extractCallbackToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const normalized = trimmed.replace(/&amp;/g, '&');
  const callbackUrlMatch = /openlinear:\/\/callback\/?\?[^"'<>\s]+/i.exec(normalized);
  const maybeUrl = callbackUrlMatch?.[0] ?? normalized;

  try {
    const url = new URL(maybeUrl);
    if (url.protocol === 'openlinear:' && url.hostname === 'callback' && url.searchParams.has('error')) {
      return '';
    }
    const token = url.searchParams.get('token')?.trim();
    if (token) return token;
    if (url.protocol === 'openlinear:' && url.hostname === 'callback') {
      return '';
    }
  } catch {}

  const tokenMatch = /(?:^|[?&])token=([^&\s"'<>]+)/i.exec(normalized);
  if (tokenMatch?.[1]) {
    try {
      return decodeURIComponent(tokenMatch[1]).trim();
    } catch {
      return tokenMatch[1].trim();
    }
  }

  const jwtMatch = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.exec(normalized);
  if (jwtMatch?.[0]) return jwtMatch[0].trim();

  return normalized;
}

export async function verifyCallbackToken(token: string): Promise<User> {
  if (typeof window === 'undefined') {
    throw new NetworkError('Cannot verify callback token outside the browser');
  }

  const previousToken = localStorage.getItem('token');
  localStorage.setItem('token', token);

  const deadline = Date.now() + TOKEN_VERIFY_TIMEOUT_MS;
  let retryDelayMs = TOKEN_VERIFY_MIN_RETRY_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const apiUrl = await getAuthApiUrl();
      return await apiFetch<User>(`${apiUrl}/api/auth/me`, { allowUnauthenticated: true });
    } catch (err) {
      lastError = err;
      if (!isRetryableTokenVerificationError(err)) {
        restoreToken(previousToken);
        throw err;
      }
      await sleep(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())));
      retryDelayMs = Math.min(TOKEN_VERIFY_MAX_RETRY_MS, retryDelayMs + 150);
    }
  }

  restoreToken(previousToken);
  throw lastError instanceof Error ? lastError : new Error('Token verification failed');
}

export function getLoginUrl(): string {
  if (isTauriRuntime()) {
    return `${getSidecarApiUrl()}/api/auth/github?client=desktop`;
  }
  return `${getApiUrl()}/api/auth/github`;
}

async function waitForDesktopAuthRoute(apiUrl: string): Promise<void> {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/api/auth/github?client=desktop`, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
      });
      if (response.status === 302 || response.type === 'opaqueredirect') return;
    } catch {}
    await sleep(125);
  }
}

async function getDesktopLoginUrl(): Promise<string> {
  const apiUrl = await resolveKnownSidecarApiUrl().catch((err) => {
    console.warn('[Auth] Failed to resolve current sidecar port before GitHub login:', err);
    return getSidecarApiUrl();
  });
  await waitForDesktopAuthRoute(apiUrl);
  return `${apiUrl}/api/auth/github?client=desktop`;
}

export async function startLogin(): Promise<boolean> {
  if (isTauriRuntime()) {
    const url = await getDesktopLoginUrl();
    void import('@tauri-apps/plugin-shell')
      .then(({ open }) => open(url))
      .catch((err) => {
        console.warn('[Auth] Failed to open desktop GitHub login:', err);
        try {
          window.location.href = url;
        } catch (fallbackErr) {
          console.warn('[Auth] Failed to navigate to desktop GitHub login:', fallbackErr);
        }
      });
    return true;
  }
  const url = getLoginUrl();
  window.location.href = url;
  return true;
}

export async function updateEmail(email: string): Promise<User> {
  return apiFetch<User>('/api/auth/me', {
    method: 'PATCH',
    body: JSON.stringify({ email }),
  });
}

export function logout(): void {
  localStorage.removeItem('token');
  window.location.href = '/';
}
