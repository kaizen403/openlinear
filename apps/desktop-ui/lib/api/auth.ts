import { apiFetch, AuthExpiredError } from './fetch';
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
    return await apiFetch<User>('/api/auth/me', { allowUnauthenticated: true });
  } catch (err) {
    if (err instanceof AuthExpiredError) return null;
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

export async function startLogin(): Promise<void> {
  if (isTauriRuntime()) {
    const url = `${await resolveSidecarApiUrl()}/api/auth/github?client=desktop`;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
      return;
    } catch (err) {
      console.warn('[Auth] Tauri shell.open failed, falling back to window.location:', err);
    }
  }
  const url = getLoginUrl();
  window.location.href = url;
}

export function logout(): void {
  localStorage.removeItem('token');
  window.location.href = '/';
}
