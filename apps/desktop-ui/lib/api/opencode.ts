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

export interface ProviderAuthMethod {
  type: 'oauth' | 'api';
}

export type ProviderAuthMethods = Record<string, ProviderAuthMethod[]>;

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

export async function getProviderAuthMethods(): Promise<ProviderAuthMethods> {
  const res = await fetch(`${API_URL}/api/opencode/providers/auth`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) throw new Error('Failed to get provider auth methods');
  return res.json();
}

export async function oauthAuthorize(
  providerId: string,
  method?: number
): Promise<{ url: string }> {
  const res = await fetch(`${API_URL}/api/opencode/auth/oauth/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
    },
    body: JSON.stringify({ providerId, method: method ?? 0 }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to start OAuth');
  }
  return res.json();
}

// --- Configured providers localStorage cache ---
// The container's provider.list().data.connected is slow to update after auth.set().
// We persist confirmed saves here so the execute flow doesn't show a false "not configured" state.
const CONFIGURED_PROVIDERS_KEY = 'openlinear-configured-providers';

export function addConfiguredProvider(providerId: string): void {
  try {
    const existing = JSON.parse(localStorage.getItem(CONFIGURED_PROVIDERS_KEY) || '[]') as string[];
    if (!existing.includes(providerId)) {
      existing.push(providerId);
      localStorage.setItem(CONFIGURED_PROVIDERS_KEY, JSON.stringify(existing));
    }
  } catch {
    localStorage.setItem(CONFIGURED_PROVIDERS_KEY, JSON.stringify([providerId]));
  }
}

export function getConfiguredProviderIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(CONFIGURED_PROVIDERS_KEY) || '[]') as string[];
  } catch {
    return [];
  }
}

export function hasConfiguredProviders(): boolean {
  return getConfiguredProviderIds().length > 0;
}

export interface ModelInfo {
  id: string
  provider: string
  name: string
  status: string
  reasoning: boolean
  toolCall: boolean
  limit?: { context: number; output: number }
  cost: { input: number; output: number }
}

export interface ProviderModels {
  id: string
  name: string
  models: ModelInfo[]
}

export interface ModelConfig {
  model: string | null
  small_model: string | null
}

export async function getModels(): Promise<{ providers: ProviderModels[] }> {
  const res = await fetch(`${API_URL}/api/opencode/models`, {
    headers: getAuthHeader(),
  })
  if (!res.ok) throw new Error('Failed to get models')
  return res.json()
}

export async function getModelConfig(): Promise<ModelConfig> {
  const res = await fetch(`${API_URL}/api/opencode/config`, {
    headers: getAuthHeader(),
  })
  if (!res.ok) throw new Error('Failed to get model config')
  return res.json()
}

export async function setModel(model: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/opencode/config/model`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
    },
    body: JSON.stringify({ model }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Failed to set model')
  }
}

export async function oauthCallback(
  providerId: string,
  code: string,
  method?: number
): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 40000);

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/opencode/auth/oauth/callback`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify({ providerId, code, method: method ?? 0 }),
    });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new Error('OAuth callback timed out after 40 seconds. The server might still be processing your request. Please check back in a minute.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to complete OAuth');
  }
}
