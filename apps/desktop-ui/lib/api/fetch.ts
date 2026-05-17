import { getApiUrl, getSidecarApiUrl, getAuthHeader, getAuthToken } from './client';

/**
 * Server error envelope shape — backend returns `{ error, code?, message?, details? }` on non-2xx.
 */
interface ServerErrorEnvelope {
  error?: string;
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
  /** Use the sidecar URL instead of the cloud URL. */
  sidecar?: boolean;
  /** Custom headers — merged with auth + content-type. */
  headers?: HeadersInit;
  /** Skip throwing on 401 (rare — used by initial bootstrap to silently no-op). */
  allowUnauthenticated?: boolean;
}

let authExpiredFired = false;

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
    try {
      localStorage.removeItem('token');
    } catch {
      // Ignore quota/security errors — best effort
    }
    window.dispatchEvent(new CustomEvent('auth:expired'));
    // Reset the latch on next tick so subsequent sessions can re-trigger
    window.setTimeout(() => {
      authExpiredFired = false;
    }, 1000);
  }
}

/**
 * Single seam for all HTTP calls from the desktop UI.
 *
 * - Resolves base URL lazily (cloud vs sidecar) — never at module load
 * - Auto-attaches Authorization + x-openlinear-client headers
 * - On 401: clears the same token used for the request, dispatches `auth:expired`, throws AuthExpiredError
 * - On other non-2xx: parses `{ error, code, details }` envelope, throws ApiError
 * - On network failure: throws NetworkError
 *
 * @param path - Path beginning with `/` (e.g. `/api/tasks`)
 * @param init - Standard RequestInit + `{ sidecar?: true }` to target the sidecar
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: ApiFetchInit = {},
): Promise<T> {
  const { sidecar = false, allowUnauthenticated = false, headers: customHeaders, body, ...rest } = init;

  const baseUrl = sidecar ? getSidecarApiUrl() : getApiUrl();
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`;

  const headers = buildHeaders(customHeaders, body);
  const tokenUsedForRequest = getBearerToken(headers);

  let response: Response;
  try {
    response = await fetch(url, { ...rest, headers, body });
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

  if (response.status === 401 && !allowUnauthenticated) {
    fireAuthExpired(tokenUsedForRequest);
    const envelope = await readErrorEnvelope(response);
    throw new AuthExpiredError(envelope.message || envelope.error || 'Session expired');
  }

  if (!response.ok) {
    const envelope = await readErrorEnvelope(response);
    throw new ApiError(
      response.status,
      envelope.message || envelope.error || `Request failed with status ${response.status}`,
      envelope.code,
      envelope.details,
    );
  }

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

async function readErrorEnvelope(response: Response): Promise<ServerErrorEnvelope> {
  try {
    return (await response.json()) as ServerErrorEnvelope;
  } catch {
    return {};
  }
}

/**
 * Variant that returns the raw Response — used for streaming endpoints (SSE, NDJSON)
 * where the caller wants to read the body manually. Still applies auth + 401 handling
 * and throws NetworkError on connection failure.
 */
export async function apiFetchRaw(
  path: string,
  init: ApiFetchInit = {},
): Promise<Response> {
  const { sidecar = false, allowUnauthenticated = false, headers: customHeaders, body, ...rest } = init;

  const baseUrl = sidecar ? getSidecarApiUrl() : getApiUrl();
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`;

  const headers = buildHeaders(customHeaders, body);
  const tokenUsedForRequest = getBearerToken(headers);

  let response: Response;
  try {
    response = await fetch(url, { ...rest, headers, body });
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

  if (response.status === 401 && !allowUnauthenticated) {
    fireAuthExpired(tokenUsedForRequest);
    const envelope = await readErrorEnvelope(response.clone());
    throw new AuthExpiredError(envelope.message || envelope.error || 'Session expired');
  }

  if (!response.ok) {
    const envelope = await readErrorEnvelope(response.clone());
    throw new ApiError(
      response.status,
      envelope.message || envelope.error || `Request failed with status ${response.status}`,
      envelope.code,
      envelope.details,
    );
  }

  return response;
}

function buildHeaders(customHeaders: HeadersInit | undefined, body: BodyInit | null | undefined): Headers {
  const headers = new Headers(customHeaders);
  const authHeaders = getAuthHeader();
  for (const [key, value] of Object.entries(authHeaders)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    }
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
