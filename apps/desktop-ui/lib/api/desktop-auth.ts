/**
 * Client half of desktop sign-in (RFC 8252 native app + RFC 7636 PKCE).
 *
 * Before opening the browser the app creates a random `code_verifier` and a
 * random `state`, keeps both here, and sends only the S256 challenge and the
 * state to the cloud API. The API's deep link back to the app carries a
 * one-time code and the state — never a token. The code is redeemed with the
 * verifier, so a program that intercepts the deep link (custom URL schemes
 * can be claimed by any local app) cannot use it, and a deep link the app did
 * not ask for (unknown state) is dropped without any network call.
 *
 * Pending attempts live in memory and are mirrored to `sessionStorage` so a
 * webview reload during sign-in does not lose the verifier. They expire with
 * the API's OAuth state (10 minutes).
 */

export const DESKTOP_LOGIN_TTL_MS = 10 * 60 * 1000;
const STORAGE_KEY = 'openlinear:desktop-login';
const MAX_PENDING = 5;

export interface PendingDesktopLogin {
  state: string;
  verifier: string;
  createdAt: number;
}

export type DesktopCallback =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: string; state: string | null };

const CALLBACK_VALUE = /^[A-Za-z0-9_-]{16,256}$/;

let memoryPending: PendingDesktopLogin[] | null = null;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** 32 random bytes → 43 base64url characters (RFC 7636 §4.1). */
export function generateCodeVerifier(): string {
  return randomBase64Url(32);
}

/** Opaque correlation value echoed back on the deep link. */
export function generateLoginState(): string {
  return randomBase64Url(24);
}

/** RFC 7636 S256: base64url(SHA-256(ASCII(verifier))). */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function isPending(value: unknown): value is PendingDesktopLogin {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.state === 'string' &&
    typeof record.verifier === 'string' &&
    typeof record.createdAt === 'number'
  );
}

function loadPending(now: number): PendingDesktopLogin[] {
  if (!memoryPending) {
    memoryPending = [];
    if (typeof window !== 'undefined') {
      try {
        const raw = window.sessionStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) memoryPending = parsed.filter(isPending);
      } catch {
        memoryPending = [];
      }
    }
  }
  memoryPending = memoryPending.filter((entry) => now - entry.createdAt < DESKTOP_LOGIN_TTL_MS);
  return memoryPending;
}

function savePending(entries: PendingDesktopLogin[]): void {
  memoryPending = entries;
  if (typeof window === 'undefined') return;
  try {
    if (entries.length > 0) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function rememberPendingLogin(entry: PendingDesktopLogin): void {
  const entries = loadPending(entry.createdAt).filter((existing) => existing.state !== entry.state);
  entries.push(entry);
  savePending(entries.slice(-MAX_PENDING));
}

/** The pending attempt for `state`, if this app started it and it has not expired. */
export function findPendingLogin(state: string, now: number = Date.now()): PendingDesktopLogin | null {
  return loadPending(now).find((entry) => entry.state === state) ?? null;
}

export function forgetPendingLogin(state: string): void {
  savePending(loadPending(Date.now()).filter((entry) => entry.state !== state));
}

/** Test hook. */
export function resetPendingLoginsForTests(): void {
  memoryPending = null;
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
}

/**
 * Parse an `openlinear://callback?...` URL (from the deep link, or pasted by
 * the user when the browser did not hand it back). Anything else — a bare
 * token, a JWT, an https URL — is rejected.
 */
export function parseDesktopCallbackUrl(value: string): DesktopCallback | null {
  const trimmed = value.trim().replace(/&amp;/g, '&');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'openlinear:' || url.hostname !== 'callback') return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;

  const state = url.searchParams.get('state');
  const validState = state && CALLBACK_VALUE.test(state) ? state : null;
  const error = url.searchParams.get('error');
  if (error) {
    return { kind: 'error', error: error.slice(0, 200), state: validState };
  }
  const code = url.searchParams.get('code');
  if (!code || !CALLBACK_VALUE.test(code) || !validState) return null;
  return { kind: 'code', code, state: validState };
}
