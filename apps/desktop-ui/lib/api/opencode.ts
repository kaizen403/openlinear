import { apiFetch, apiFetchRaw, ApiError, type ApiFetchInit } from './fetch';

export interface ProviderInfo {
  id: string;
  name: string;
  authenticated: boolean;
  source?: string;
  env?: string[];
  modelCount?: number;
  defaultModel?: string | null;
  selectedModel?: string | null;
  baseUrl?: string | null;
  npm?: string | null;
  authMethods?: ProviderAuthMethod[];
}

export interface SetupStatus {
  providers: ProviderInfo[];
  ready: boolean;
  hasProvider?: boolean;
  hasModel?: boolean;
  currentModel?: string | null;
  smallModel?: string | null;
}

export interface ProviderAuthMethod {
  type: 'oauth' | 'api';
  label?: string;
}

export type ProviderAuthMethods = Record<string, ProviderAuthMethod[]>;

export class OpenCodeUnavailableError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'OpenCodeUnavailableError';
  }
}

export class ModelNotConfiguredError extends Error {
  constructor(message: string, public readonly hasProvider: boolean) {
    super(message);
    this.name = 'ModelNotConfiguredError';
  }
}

export function isModelNotConfiguredError(err: unknown): err is ModelNotConfiguredError {
  return err instanceof ModelNotConfiguredError;
}

async function opencodeFetch<T>(path: string, init: ApiFetchInit, fallbackMsg: string): Promise<T> {
  try {
    return await apiFetch<T>(path, { ...init, sidecar: true });
  } catch (err) {
    if (err instanceof ApiError) {
      // 404 means the sidecar isn't running (CRUD-only API doesn't mount
      // /api/opencode/*). 5xx means sidecar is up but unhealthy. Both should
      // surface as "sidecar unavailable" so the UI can stop execution
      // gracefully instead of falling through to a confusing late failure.
      if (err.status >= 500 || err.status === 404) {
        throw new OpenCodeUnavailableError(err.status, err.message || fallbackMsg);
      }
      throw new Error(err.message || fallbackMsg);
    }
    throw err;
  }
}

export async function getSetupStatus(): Promise<SetupStatus> {
  return opencodeFetch<SetupStatus>('/api/opencode/setup-status', {}, 'Failed to get setup status');
}

export async function setProviderApiKey(
  providerId: string,
  apiKey: string,
  options?: { baseUrl?: string; enterpriseUrl?: string },
): Promise<void> {
  await opencodeFetch<void>(
    '/api/opencode/auth',
    { method: 'POST', body: JSON.stringify({ providerId, apiKey, ...options }) },
    'Failed to set API key',
  );
}

export async function getProviderAuthMethods(): Promise<ProviderAuthMethods> {
  return opencodeFetch<ProviderAuthMethods>(
    '/api/opencode/providers/auth',
    {},
    'Failed to get provider auth methods',
  );
}

export async function oauthAuthorize(
  providerId: string,
  method?: number,
): Promise<{ url: string; method?: 'auto' | 'code'; instructions?: string }> {
  return opencodeFetch<{ url: string; method?: 'auto' | 'code'; instructions?: string }>(
    '/api/opencode/auth/oauth/authorize',
    { method: 'POST', body: JSON.stringify({ providerId, method: method ?? 0 }) },
    'Failed to start OAuth',
  );
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  status: string;
  reasoning: boolean;
  toolCall: boolean;
  favorite?: boolean;
  favoriteRank?: number | null;
  limit?: { context: number; output: number };
  cost: { input: number; output: number };
}

export interface ProviderModels {
  id: string;
  name: string;
  authenticated?: boolean;
  defaultModel?: string | null;
  selectedModel?: string | null;
  favoriteModelCount?: number;
  models: ModelInfo[];
}

export interface ModelConfig {
  model: string | null;
  small_model: string | null;
}

export async function getModels(): Promise<{ providers: ProviderModels[] }> {
  return opencodeFetch<{ providers: ProviderModels[] }>(
    '/api/opencode/models',
    {},
    'Failed to get models',
  );
}

export async function getModelConfig(): Promise<ModelConfig> {
  return opencodeFetch<ModelConfig>('/api/opencode/config', {}, 'Failed to get model config');
}

export async function setModel(model: string): Promise<void> {
  await opencodeFetch<void>(
    '/api/opencode/config/model',
    { method: 'POST', body: JSON.stringify({ model }) },
    'Failed to set model',
  );
}

export async function removeProviderAuth(providerId: string): Promise<void> {
  await opencodeFetch<void>(
    '/api/opencode/auth/remove',
    { method: 'POST', body: JSON.stringify({ providerId }) },
    'Failed to remove provider',
  );
}

export async function oauthCallback(
  providerId: string,
  code: string,
  method?: number,
): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60000);

  try {
    await apiFetchRaw('/api/opencode/auth/oauth/callback', {
      method: 'POST',
      sidecar: true,
      signal: controller.signal,
      body: JSON.stringify({ providerId, code, method: method ?? 0 }),
    });
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new Error(
        'OAuth callback timed out after 60 seconds. The provider might still be processing your request — refresh the Settings page in a minute to check.',
      );
    }
    if (err instanceof ApiError) {
      throw new Error(err.message || 'Failed to complete OAuth');
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}
