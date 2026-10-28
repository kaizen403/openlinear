import { getToken } from './token-store';
import { resolveApiTarget, type ApiTarget } from './routes';
import { isDesktopRuntime } from './runtime';

export { isDesktopRuntime };

/**
 * Base URLs for the two backends the UI talks to.
 *
 * | Runtime              | Cloud API (`getCloudApiUrl`)                         | Sidecar (`getSidecarApiUrl`)                          |
 * |----------------------|------------------------------------------------------|-------------------------------------------------------|
 * | Desktop (Tauri)      | NEXT_PUBLIC_CLOUD_API_URL, else https://openlinear.tech | port reported by Tauri (`sidecar:ready` / `get_api_server_port`), else NEXT_PUBLIC_SIDECAR_URL, else :3003 |
 * | Web (browser)        | NEXT_PUBLIC_API_URL, else NEXT_PUBLIC_CLOUD_API_URL, else http://127.0.0.1:3001 | NEXT_PUBLIC_SIDECAR_URL, else http://127.0.0.1:3003 |
 *
 * Which backend a given path belongs to is decided by `routes.ts`, never here.
 */

/** Production cloud API used by packaged desktop builds. */
export const CLOUD_DEFAULT = 'https://openlinear.tech';
/** Local cloud API in web development (`pnpm dev-live` starts it on 3001). */
export const DEFAULT_WEB_API_URL = 'http://127.0.0.1:3001';
/** Local execution sidecar outside Tauri (`pnpm dev-live` starts it on 3003). */
export const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:3003';

const TAURI_SIDECAR_URL_KEY = 'openlinear:tauri-sidecar-url';
const SIDECAR_READY_TIMEOUT_MS = 15_000;
const SIDECAR_READY_POLL_MS = 250;

let cachedSidecarUrl: string | null = null;
let listenerInstalled = false;

function loadCachedSidecarUrl(): string | null {
  if (cachedSidecarUrl) return cachedSidecarUrl;
  if (typeof window === 'undefined') return null;
  try {
    cachedSidecarUrl = window.sessionStorage.getItem(TAURI_SIDECAR_URL_KEY);
  } catch {
    cachedSidecarUrl = null;
  }
  return cachedSidecarUrl;
}

function persistSidecarUrl(url: string) {
  cachedSidecarUrl = url;
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(TAURI_SIDECAR_URL_KEY, url);
    } catch {}
  }
}

function clearCachedSidecarUrl() {
  cachedSidecarUrl = null;
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(TAURI_SIDECAR_URL_KEY);
    } catch {}
  }
}

/** Test hook: forget the Tauri-reported sidecar URL and listener state. */
export function resetSidecarUrlCacheForTests(): void {
  clearCachedSidecarUrl();
  listenerInstalled = false;
}

async function readSidecarPort(command: 'get_api_server_port' | 'start_api_server'): Promise<number | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<number | null>(command).catch(() => null);
}

/** The sidecar answers `{ ok: true, service: 'sidecar' }`; older builds `{ status: 'ok' }`. */
export function isHealthyPayload(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as { ok?: unknown; status?: unknown };
  return record.ok === true || record.status === 'ok';
}

async function isSidecarHealthy(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`${url}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    return isHealthyPayload(await response.json().catch(() => null));
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function waitForSidecarHealth(url: string): Promise<boolean> {
  const deadline = Date.now() + SIDECAR_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isSidecarHealthy(url)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, SIDECAR_READY_POLL_MS));
  }
  return false;
}

async function ensureSidecarListener() {
  if (listenerInstalled) return;
  if (!isDesktopRuntime()) return;
  listenerInstalled = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<{ port: number; api_url: string; health_url: string }>(
      'sidecar:ready',
      (event) => {
        if (event.payload?.api_url) {
          persistSidecarUrl(event.payload.api_url);
        }
      },
    );

    const port = await readSidecarPort('get_api_server_port');
    if (port) {
      persistSidecarUrl(`http://127.0.0.1:${port}`);
    }
  } catch {
    listenerInstalled = false;
  }
}

if (typeof window !== 'undefined') {
  void ensureSidecarListener();
}

function normalizeLoopbackApiUrl(value: string): string {
  return value
    .replace(/^http:\/\/localhost(?=[:/]|$)/, 'http://127.0.0.1')
    .replace(/^http:\/\/\[::1\](?=[:/]|$)/, 'http://127.0.0.1');
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed ? normalizeLoopbackApiUrl(trimmed) : undefined;
}

// Literal `process.env.NEXT_PUBLIC_*` reads: Next inlines exactly this form at
// build time (optional chaining defeats the substitution).
function envApiUrl(): string | undefined {
  return normalizeBaseUrl(process.env.NEXT_PUBLIC_API_URL);
}

function envCloudUrl(): string | undefined {
  return normalizeBaseUrl(process.env.NEXT_PUBLIC_CLOUD_API_URL);
}

function envSidecarUrl(): string | undefined {
  return normalizeBaseUrl(process.env.NEXT_PUBLIC_SIDECAR_URL);
}

/** The cloud API: identity, workspaces, projects, tasks, chat, events, ... */
export function getCloudApiUrl(): string {
  if (isDesktopRuntime()) {
    return envCloudUrl() ?? CLOUD_DEFAULT;
  }
  return envApiUrl() ?? envCloudUrl() ?? DEFAULT_WEB_API_URL;
}

/**
 * The local execution sidecar. In Tauri this is the port the shell reported
 * (the packaged sidecar binds an ephemeral port); prefer
 * `resolveApiBaseUrl('sidecar')` when a request can wait for that report.
 */
export function getSidecarApiUrl(): string {
  if (isDesktopRuntime()) {
    return loadCachedSidecarUrl() ?? envSidecarUrl() ?? DEFAULT_SIDECAR_URL;
  }
  return envSidecarUrl() ?? DEFAULT_SIDECAR_URL;
}

export async function resolveKnownSidecarApiUrl(): Promise<string> {
  if (!isDesktopRuntime()) return getSidecarApiUrl();

  await ensureSidecarListener();

  const currentPort = await readSidecarPort('get_api_server_port');
  const port = currentPort ?? (await readSidecarPort('start_api_server'));
  if (port) {
    const url = `http://127.0.0.1:${port}`;
    persistSidecarUrl(url);
    return url;
  }

  return getSidecarApiUrl();
}

export async function resolveSidecarApiUrl(): Promise<string> {
  if (!isDesktopRuntime()) return getSidecarApiUrl();

  const url = await resolveKnownSidecarApiUrl();
  if (url) {
    if (await waitForSidecarHealth(url)) return url;
    clearCachedSidecarUrl();
    throw new Error(`Sidecar API did not become ready at ${url}`);
  }

  const cached = loadCachedSidecarUrl();
  if (cached && (await waitForSidecarHealth(cached))) return cached;

  clearCachedSidecarUrl();
  throw new Error('Sidecar API is not available');
}

/** Synchronous base URL for a backend. */
export function getApiBaseUrl(target: ApiTarget): string {
  return target === 'sidecar' ? getSidecarApiUrl() : getCloudApiUrl();
}

/**
 * Base URL for a backend, waiting (in Tauri) for the shell to report the
 * sidecar's port when it is not known yet.
 */
export async function resolveApiBaseUrl(target: ApiTarget): Promise<string> {
  if (target === 'cloud') return getCloudApiUrl();
  if (!isDesktopRuntime()) return getSidecarApiUrl();
  return loadCachedSidecarUrl() ?? resolveKnownSidecarApiUrl();
}

/** Absolute URL for an API path on the backend that serves it (see routes.ts). */
export function getApiUrlForPath(path: string): string {
  return `${getApiBaseUrl(resolveApiTarget(path))}${path}`;
}

/**
 * @deprecated Ambiguous: returns the cloud API. Use `getCloudApiUrl()`, or
 * `getApiUrlForPath(path)` / `apiFetch(path)` so routes.ts picks the backend.
 */
export function getApiUrl(): string {
  return getCloudApiUrl();
}

function getClientHeader(): HeadersInit {
  return isDesktopRuntime() ? { 'x-openlinear-client': 'desktop' } : {};
}

export function getAuthHeader(): HeadersInit {
  const token = getAuthToken();
  return {
    ...getClientHeader(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Returns the current access token (or null).
 *
 * Delegates to `lib/api/token-store.ts`, the single point of truth for token
 * reads/writes. Prefer `apiFetch` from `lib/api/fetch.ts`, which attaches it,
 * refreshes it on 401 and routes the request.
 */
export function getAuthToken(): string | null {
  return getToken();
}
