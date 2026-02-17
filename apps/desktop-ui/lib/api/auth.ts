import { API_URL, getAuthHeader } from './client';
import type { User } from './types';

export async function fetchCurrentUser(): Promise<User | null> {
  const token = localStorage.getItem('token');
  if (!token) return null;

  const res = await fetch(`${API_URL}/api/auth/me`, {
    headers: getAuthHeader(),
  });

  if (!res.ok) {
    localStorage.removeItem('token');
    return null;
  }

  return res.json();
}

export function getLoginUrl(): string {
  return `${API_URL}/api/auth/github`;
}

export async function getGitHubConnectUrl(): Promise<string> {
  const res = await fetch(`${API_URL}/api/auth/github/connect`, {
    headers: getAuthHeader(),
  });

  if (!res.ok) throw new Error('Failed to get GitHub connect URL');
  const data = await res.json();
  return data.url;
}

export function logout(): void {
  localStorage.removeItem('token');
  window.location.href = '/';
}

export async function loginUser(username: string, password: string): Promise<{ token: string; user: { id: string; username: string } }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(error.error || 'Login failed');
  }
  return res.json();
}

export async function registerUser(username: string, password: string, email?: string): Promise<{ token: string; user: { id: string; username: string } }> {
  const res = await fetch(`${API_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, email }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Registration failed' }));
    throw new Error(error.error || 'Registration failed');
  }
  return res.json();
}
