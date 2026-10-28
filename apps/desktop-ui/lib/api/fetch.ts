import { getAuthHeader, getAuthToken, getCloudApiUrl, resolveApiBaseUrl } from './client';
import { resolveApiTarget, type ApiTarget } from './routes';
import { isDesktopRuntime } from './runtime';
import {
  clearStoredSession,
  getRefreshToken,
  initTokenStore,
  setRefreshToken,
  setToken,
} from './token-store';

/**
 * Server error envelope shape — backend returns `{ error, code?, message?, details? }` on non-2xx.
 */
interface ServerErrorEnvelope {
  error?: string | { code?: string; message?: string };
  code?: string;
  message?: string;
  details?: unknown;
}

/**
 * Thrown for non-2xx HTTP responses (excluding 401).
 * Carries server-provided message + status + optional code/details.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Thrown when the server returns 401. Triggers the global auth:expired event
 * so the app can redirect to /login and clear user state.
 */
export class AuthExpiredError extends ApiError {
  constructor(message = 'Session expired') {
    super(401, message, 'auth_expired');
    this.name = 'AuthExpiredError';
  }
}

/**
 * Thrown when fetch itself fails (DNS, connection refused, offline, etc.).
 * Distinct from ApiError — UI should surface as "Could not reach server".
 */
export class NetworkError extends Error {
  public readonly retryAfterMs: number;
  constructor(message = 'Could not reach OpenLinear server', retryAfterMs = 1500) {
    super(message);
    this.name = 'NetworkError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ApiFetchInit extends Omit<RequestInit, 'headers'> {
  /**
   * @deprecated Ignored: `routes.ts` decides which backend serves a path.
   * Kept so existing call sites compile; in development a value that
   * contradicts the route table is reported once per path.
   */
  sidecar?: boolean;
  /** Custom headers — merged with auth + content-type. */
  headers?: HeadersInit;
  /** Skip throwing on 401 (rare — used by initial bootstrap to silently no-op). */
  allowUnauthenticated?: boolean;
  /**
   * Send this bearer token instead of the stored one (e.g. to verify a token
   * before adopting it). No refresh, no `auth:expired`, nothing is stored.
   */
  authToken?: string;
  /**
   * Public endpoint (sign-in, provider discovery): send no bearer token at all,
   * never refresh, never dispatch `auth:expired`.
   */
  anonymous?: boolean;
}

const REFRESH_PATH = '/api/auth/refresh';

let authExpiredFired = false;
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Trade the refresh credential for a new access token at the cloud API (the
 * only issuer — never the sidecar). Desktop sends the refresh token from its
 * store; the web relies on the HttpOnly `ol_refresh` cookie. Concurrent
 * callers share one request.
 */
export function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        await initTokenStore();
        const desktop = isDesktopRuntime();
        const refreshToken = getRefreshToken();
        if (desktop && !refreshToken) return false;
        const res = await fetch(`${getCloudApiUrl()}${REFRESH_PATH}`, {
          method: 'POST',
          credentials: desktop ? 'omit' : 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(desktop ? { refreshToken } : {}),
        });
        if (!res.ok) {
          if (res.status === 401 && desktop) setRefreshToken(null);
          return false;
        }
        const body = (await res.json()) as { token?: string; refreshToken?: string };
        if (!body.token) return false;
        setToken(body.token);
        if (desktop && body.refreshToken) setRefreshToken(body.refreshToken);
        return true;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

function getBearerToken(headers: Headers): string | null {
  const authHeader = headers.get('Authorization');
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match?.[1] ?? null;
}

function fireAuthExpired(tokenUsedForRequest: string | null) {
  if (!tokenUsedForRequest) return;
  if (authExpiredFired) return;
  if (typeof window !== 'undefined') {
    if (getAuthToken() !== tokenUsedForRequest) {
      return;
    }
    authExpiredFired = true;
    clearStoredSession();
    window.dispatchEvent(new CustomEvent('auth:expired'));
    // Reset the latch on next tick so subsequent sessions can re-trigger
    window.setTimeout(() => {
      authExpiredFired = false;
    }, 1000);
  }
}

const reportedFlagMismatches = new Set<string>();

function reportSidecarFlagMismatch(path: string, flag: boolean | undefined, target: ApiTarget) {
  if (flag === undefined || (flag ? 'sidecar' : 'cloud') === target) return;
  if (process.env.NODE_ENV === 'production') return;
  const key = `${path}:${target}`;
  if (reportedFlagMismatches.has(key)) return;
  reportedFlagMismatches.add(key);
  console.warn(
    `[apiFetch] ${path} passed sidecar: ${String(flag)}, but routes.ts sends it to the ${target}. The route table wins; fix the call site or the table.`,
  );
}

interface ResolvedRequest {
  url: string;
  target: ApiTarget;
}

async function resolveRequest(path: string, flag: boolean | undefined): Promise<ResolvedRequest> {
  if (/^https?:\/\//i.test(path)) {
    return { url: path, target: 'cloud' };
  }
  const target = resolveApiTarget(path);
  reportSidecarFlagMismatch(path, flag, target);
  return { url: `${await resolveApiBaseUrl(target)}${path}`, target };
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new NetworkError(
      err instanceof Error && err.message
        ? `Could not reach OpenLinear server: ${err.message}`
        : 'Could not reach OpenLinear server',
    );
  }
}

async function readErrorEnvelope(response: Response): Promise<{ message?: string; code?: string; details?: unknown }> {
  try {
    const envelope = (await response.json()) as ServerErrorEnvelope;
    const nested = typeof envelope.error === 'object' && envelope.error !== null ? envelope.error : undefined;
    return {
      message: envelope.message || (typeof envelope.error === 'string' ? envelope.error : nested?.message),
      code: envelope.code ?? nested?.code,
      details: envelope.details,
    };
  } catch {
    return {};
  }
}

/**
 * Routing, auth headers, refresh-and-retry on 401, and error mapping shared by
 * `apiFetch` and `apiFetchRaw`. Returns only 2xx responses.
 */
async function performRequest(path: string, init: ApiFetchInit): Promise<Response> {
  const {
    sidecar,
    allowUnauthenticated = false,
    authToken,
    anonymous = false,
    headers: customHeaders,
    body,
    ...rest
  } = init;

  const { url, target } = await resolveRequest(path, sidecar);
  const auth: AuthMode = anonymous ? { kind: 'none' } : authToken !== undefined ? { kind: 'explicit', token: authToken } : { kind: 'session' };
  // Only the stored session is refreshed or expired by this seam.
  const managedSession = auth.kind === 'session';

  let headers = buildHeaders(customHeaders, body, auth);
  let tokenUsedForRequest = getBearerToken(headers);
  let response = await send(url, { ...rest, headers, body });

  const isRefreshCall = path === REFRESH_PATH || url.endsWith(REFRESH_PATH);
  if (response.status === 401 && managedSession && tokenUsedForRequest && !isRefreshCall) {
    // Another request may have refreshed while this one was in flight.
    const latest = getAuthToken();
    const refreshed = (latest !== null && latest !== tokenUsedForRequest) || (await refreshAccessToken());
    if (refreshed) {
      headers = buildHeaders(customHeaders, body, auth);
      tokenUsedForRequest = getBearerToken(headers);
      response = await send(url, { ...rest, headers, body });
    }
  }

  if (response.status === 401 && !allowUnauthenticated && managedSession) {
    const envelope = await readErrorEnvelope(response.clone());
    if (target === 'sidecar') {
      // The cloud API owns the session. A sidecar that still refuses a token
      // the cloud just accepted (or could not refresh) is a local problem;
      // it must not sign the user out.
      throw new ApiError(401, envelope.message || 'The local execution server rejected the request', envelope.code, envelope.details);
    }
    fireAuthExpired(tokenUsedForRequest);
    throw new AuthExpiredError(envelope.message || 'Session expired');
  }

  if (!response.ok) {
    const envelope = await readErrorEnvelope(response.clone());
    throw new ApiError(
      response.status,
      envelope.message || `Request failed with status ${response.status}`,
      envelope.code,
      envelope.details,
    );
  }

  return response;
}

/**
 * Single seam for all HTTP calls from the desktop UI.
 *
 * - Routes the path to the cloud API or the local sidecar via `routes.ts`;
 *   base URLs resolve lazily, never at module load
 * - Auto-attaches Authorization + x-openlinear-client headers
 * - On 401: refreshes the access token at the cloud API once and retries;
 *   if that fails, clears the session used for the request, dispatches
 *   `auth:expired`, throws AuthExpiredError (cloud routes only)
 * - On other non-2xx: parses `{ error, code, details }` envelope, throws ApiError
 * - On network failure: throws NetworkError
 *
 * @param path - Path beginning with `/` (e.g. `/api/tasks`)
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: ApiFetchInit = {},
): Promise<T> {
  const response = await performRequest(path, init);

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return (await response.json()) as T;
  }

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Variant that returns the raw Response — used for streaming endpoints (SSE, NDJSON)
 * where the caller wants to read the body manually. Same routing, auth, refresh
 * and error handling as `apiFetch`.
 */
export async function apiFetchRaw(
  path: string,
  init: ApiFetchInit = {},
): Promise<Response> {
  return performRequest(path, init);
}

type AuthMode =
  | { kind: 'session' }
  | { kind: 'explicit'; token: string }
  | { kind: 'none' };

function buildHeaders(
  customHeaders: HeadersInit | undefined,
  body: BodyInit | null | undefined,
  auth: AuthMode,
): Headers {
  const headers = new Headers(customHeaders);
  const authHeaders = getAuthHeader();
  for (const [key, value] of Object.entries(authHeaders)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  if (auth.kind === 'explicit') {
    headers.set('Authorization', `Bearer ${auth.token}`);
  } else if (auth.kind === 'none') {
    headers.delete('Authorization');
  }
  if (body !== undefined && body !== null && !headers.has('Content-Type')) {
    const isJsonable =
      !(body instanceof FormData) &&
      !(body instanceof Blob) &&
      !(body instanceof ArrayBuffer) &&
      !(body instanceof URLSearchParams);
    if (isJsonable) {
      headers.set('Content-Type', 'application/json');
    }
  }
  return headers;
}
