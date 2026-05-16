import { apiFetch, AuthExpiredError } from './fetch';
import { getApiUrl } from './client';
import type { User } from './types';

const CLOUD_AUTH_URL =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_CLOUD_API_URL) ||
  'https://openlinear.tech';

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
    return `${CLOUD_AUTH_URL}/api/auth/github?client=desktop`;
  }
  return `${getApiUrl()}/api/auth/github`;
}

export async function startLogin(): Promise<void> {
  const url = getLoginUrl();
  if (isTauriRuntime()) {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
      return;
    } catch (err) {
      console.warn('[Auth] Tauri shell.open failed, falling back to window.location:', err);
    }
  }
  window.location.href = url;
}

export function logout(): void {
  localStorage.removeItem('token');
  window.location.href = '/';
}
