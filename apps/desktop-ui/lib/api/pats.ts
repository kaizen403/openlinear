import { apiFetch } from './fetch';

export interface PersonalAccessToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedPersonalAccessToken {
  id: string;
  name: string;
  token: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
}

export async function fetchPersonalAccessTokens(): Promise<PersonalAccessToken[]> {
  return apiFetch<PersonalAccessToken[]>('/api/pats');
}

export async function createPersonalAccessToken(data: {
  name: string;
  expiresAt?: string;
}): Promise<CreatedPersonalAccessToken> {
  return apiFetch<CreatedPersonalAccessToken>('/api/pats', {
    method: 'POST',
    body: JSON.stringify({
      name: data.name,
      ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
    }),
  });
}

export async function revokePersonalAccessToken(id: string): Promise<void> {
  await apiFetch<void>(`/api/pats/${id}`, { method: 'DELETE' });
}
