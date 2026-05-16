const DEFAULT_API_URL = 'http://localhost:3001';
const CLOUD_DEFAULT = 'https://openlinear.tech';
const TAURI_SIDECAR_URL_KEY = 'openlinear:tauri-sidecar-url';

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

async function readSidecarPort(command: 'get_api_server_port' | 'start_api_server') {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<number | null>(command).catch(() => null);
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
    return process.env.NEXT_PUBLIC_API_URL;
  }
  return undefined;
}

function envCloudUrl(): string | undefined {
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_CLOUD_API_URL) {
    return process.env.NEXT_PUBLIC_CLOUD_API_URL;
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

export async function resolveSidecarApiUrl(): Promise<string> {
  if (!isTauriRuntime()) return getSidecarApiUrl();

  await ensureSidecarListener();

  const cached = loadCachedSidecarUrl();
  if (cached) return cached;

  const port = await readSidecarPort('start_api_server');
  if (port) {
    const url = `http://127.0.0.1:${port}`;
    persistSidecarUrl(url);
    return url;
  }

  return getSidecarApiUrl();
}

export function getApiUrl(): string {
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
