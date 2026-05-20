const DEFAULT_API_URL = 'http://127.0.0.1:3001';
const CLOUD_DEFAULT = 'https://openlinear.tech';
const TAURI_SIDECAR_URL_KEY = 'openlinear:tauri-sidecar-url';
const SIDECAR_READY_TIMEOUT_MS = 15_000;
const SIDECAR_READY_POLL_MS = 250;

let cachedSidecarUrl: string | null = null;
let listenerInstalled = false;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

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

async function readSidecarPort(command: 'get_api_server_port' | 'start_api_server') {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<number | null>(command).catch(() => null);
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
    const data = (await response.json().catch(() => null)) as { status?: string } | null;
    return data?.status === 'ok';
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
  if (!isTauriRuntime()) return;
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

function envApiUrl(): string | undefined {
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_API_URL) {
    return normalizeLoopbackApiUrl(process.env.NEXT_PUBLIC_API_URL);
  }
  return undefined;
}

function normalizeLoopbackApiUrl(value: string): string {
  return value
    .replace(/^http:\/\/localhost(?=[:/]|$)/, 'http://127.0.0.1')
    .replace(/^http:\/\/\[::1\](?=[:/]|$)/, 'http://127.0.0.1');
}

function envCloudUrl(): string | undefined {
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_CLOUD_API_URL) {
    return normalizeLoopbackApiUrl(process.env.NEXT_PUBLIC_CLOUD_API_URL);
  }
  return undefined;
}

export function getCloudApiUrl(): string {
  if (isTauriRuntime()) {
    return envCloudUrl() ?? CLOUD_DEFAULT;
  }
  return envApiUrl() ?? envCloudUrl() ?? DEFAULT_API_URL;
}

export function getSidecarApiUrl(): string {
  if (isTauriRuntime()) {
    return loadCachedSidecarUrl() ?? envApiUrl() ?? DEFAULT_API_URL;
  }
  return envApiUrl() ?? DEFAULT_API_URL;
}

export async function resolveKnownSidecarApiUrl(): Promise<string> {
  if (!isTauriRuntime()) return getSidecarApiUrl();

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
  if (!isTauriRuntime()) return getSidecarApiUrl();

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

export function getApiUrl(): string {
  if (isTauriRuntime()) {
    return getSidecarApiUrl();
  }
  return getCloudApiUrl();
}

function getClientHeader(): HeadersInit {
  return isTauriRuntime() ? { 'x-openlinear-client': 'desktop' } : {};
}

export function getAuthHeader(): HeadersInit {
  const token = getAuthToken();
  return {
    ...getClientHeader(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Returns the current JWT token (or null). Single point of truth for token reads.
 *
 * Use this for callsites that cannot use `apiFetch` directly — currently:
 * native EventSource (cannot set Authorization headers, must pass token via URL).
 * Do NOT use elsewhere; prefer `apiFetch` from `lib/api/fetch.ts`.
 */
export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('token');
  } catch {
    return null;
  }
}
