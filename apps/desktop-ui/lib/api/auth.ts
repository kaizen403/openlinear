import { apiFetch, AuthExpiredError, NetworkError } from './fetch';
import { getApiUrl, getSidecarApiUrl, resolveSidecarApiUrl } from './client';
import type { User } from './types';

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

export async function fetchCurrentUser(): Promise<User | null> {
  if (typeof window === 'undefined') return null;
  const token = localStorage.getItem('token');
  if (!token) return null;

  try {
    if (isTauriRuntime()) {
      const sidecarReady = await resolveSidecarApiUrl().then(() => true).catch(() => false);
      if (!sidecarReady) return null;
    }
    return await apiFetch<User>('/api/auth/me', { allowUnauthenticated: true });
  } catch (err) {
    if (err instanceof AuthExpiredError || err instanceof NetworkError) return null;
    removeTokenIfCurrent(token);
    return null;
  }
}

export function getLoginUrl(): string {
  if (isTauriRuntime()) {
    return `${getSidecarApiUrl()}/api/auth/github?client=desktop`;
  }
  return `${getApiUrl()}/api/auth/github`;
}

export async function startLogin(): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      const url = `${await resolveSidecarApiUrl()}/api/auth/github?client=desktop`;
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
      return true;
    } catch (err) {
      console.warn('[Auth] Failed to open desktop GitHub login:', err);
      return false;
    }
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
