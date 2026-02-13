import { API_URL, getAuthHeader } from './client';

export interface ProviderInfo {
  id: string;
  name: string;
  authenticated: boolean;
}

export interface SetupStatus {
  container: { status: string; hostPort: number } | null;
  providers: ProviderInfo[];
  ready: boolean;
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const res = await fetch(`${API_URL}/api/opencode/setup-status`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) throw new Error('Failed to get setup status');
  return res.json();
}

export async function ensureContainer(): Promise<{ status: string; hostPort: number; baseUrl: string }> {
  const res = await fetch(`${API_URL}/api/opencode/container`, {
    method: 'POST',
    headers: getAuthHeader(),
  });
  if (!res.ok) throw new Error('Failed to ensure container');
  return res.json();
}

export async function setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/opencode/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
    },
    body: JSON.stringify({ providerId, apiKey }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to set API key');
  }
}
