import { getAuthHeader } from './client';

const SIDECAR_URL = process.env.NEXT_PUBLIC_SIDECAR_URL || 'http://localhost:3001';

export interface ProviderInfo {
  id: string;
  name: string;
  authenticated: boolean;
}

export interface SetupStatus {
  providers: ProviderInfo[];
  ready: boolean;
}

export interface ProviderAuthMethod {
  type: 'oauth' | 'api';
}

export type ProviderAuthMethods = Record<string, ProviderAuthMethod[]>;

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  status: string;
  reasoning: boolean;
  toolCall: boolean;
  limit?: { context: number; output: number };
  cost: { input: number; output: number };
  source?: 'sdk' | 'fallback';
}

export interface ProviderModels {
  id: string;
  name: string;
  models: ModelInfo[];
  source?: 'env' | 'config' | 'custom' | 'api' | 'fallback';
}

export interface ModelConfig {
  model: string | null;
  small_model: string | null;
  source?: 'opencode' | 'legacy-openlinear' | 'unset';
  effective_model?: string | null;
  override_model?: string | null;
  configured_model?: string | null;
  legacy_model?: string | null;
}

export interface ModelCatalog {
  providers: ProviderModels[];
  selection: ModelConfig | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return null;
}

function normalizeModelInfo(model: Record<string, unknown>): ModelInfo {
  const limitValue = model.limit
  const costValue = model.cost

  const limit = isRecord(limitValue)
    ? {
        context: typeof limitValue.context === 'number' ? limitValue.context : 0,
        output: typeof limitValue.output === 'number' ? limitValue.output : 0,
      }
    : undefined;

  const cost = isRecord(costValue)
    ? {
        input: typeof costValue.input === 'number' ? costValue.input : 0,
        output: typeof costValue.output === 'number' ? costValue.output : 0,
      }
    : { input: 0, output: 0 };

  return {
    id: typeof model.id === 'string' ? model.id : '',
    provider: typeof model.provider === 'string' ? model.provider : '',
    name: readString(model, ['name']) || (typeof model.id === 'string' ? model.id : ''),
    status: readString(model, ['status']) || 'available',
    reasoning: Boolean(model.reasoning),
    toolCall: Boolean(model.toolCall ?? model.tool_call),
    limit,
    cost,
    source:
      model.source === 'sdk' || model.source === 'fallback'
        ? model.source
        : undefined,
  };
}

function normalizeProviderModels(provider: Record<string, unknown>): ProviderModels {
  const modelsValue = provider.models
  const rawModels = Array.isArray(modelsValue)
    ? modelsValue
    : isRecord(modelsValue)
      ? Object.values(modelsValue)
      : [];

  return {
    id: typeof provider.id === 'string' ? provider.id : '',
    name: readString(provider, ['name']) || (typeof provider.id === 'string' ? provider.id : ''),
    models: rawModels.filter(isRecord).map(normalizeModelInfo),
    source:
      provider.source === 'env' ||
      provider.source === 'config' ||
      provider.source === 'custom' ||
      provider.source === 'api' ||
      provider.source === 'fallback'
        ? provider.source
        : undefined,
  };
}

function normalizeModelSelection(payload: unknown): ModelConfig {
  if (!isRecord(payload)) {
    return { model: null, small_model: null };
  }

  const selection = isRecord(payload.selection) ? payload.selection : null;
  const selectionSource = readString(selection, ['source']);
  const payloadSource = readString(payload, ['source']);
  const effectiveModel =
    readString(selection, ['effective_model', 'effectiveModel']) ||
    readString(selection, ['model']) ||
    readString(payload, ['effective_model', 'effectiveModel', 'model']);
  const configuredModel =
    readString(selection, ['configured_model', 'configuredModel']) ||
    readString(payload, ['configured_model', 'configuredModel']);
  const legacyModel =
    readString(selection, ['legacy_model', 'legacyModel']) ||
    readString(payload, ['legacy_model', 'legacyModel']);
  const normalizedSource =
    selectionSource === 'opencode' || selectionSource === 'legacy-openlinear' || selectionSource === 'unset'
      ? selectionSource
      : payloadSource === 'opencode' || payloadSource === 'legacy-openlinear' || payloadSource === 'unset'
        ? payloadSource
        : undefined;

  return {
    model: effectiveModel,
    small_model:
      readString(selection, ['small_model', 'smallModel']) ||
      readString(payload, ['small_model', 'smallModel']),
    source: normalizedSource as ModelConfig['source'],
    effective_model: effectiveModel,
    override_model:
      readString(selection, ['override_model', 'overrideModel']) ||
      readString(payload, ['override_model', 'overrideModel']) ||
      legacyModel,
    configured_model: configuredModel,
    legacy_model: legacyModel,
  };
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const res = await fetch(`${SIDECAR_URL}/api/opencode/setup-status`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) throw new Error('Failed to get setup status');
  return res.json();
}

export async function setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  const res = await fetch(`${SIDECAR_URL}/api/opencode/auth`, {
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
  const res = await fetch(`${SIDECAR_URL}/api/opencode/providers/auth`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) throw new Error('Failed to get provider auth methods');
  return res.json();
}

export async function oauthAuthorize(
  providerId: string,
  method?: number
): Promise<{ url: string }> {
  const res = await fetch(`${SIDECAR_URL}/api/opencode/auth/oauth/authorize`, {
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

export async function oauthCallback(
  providerId: string,
  code: string,
  method?: number
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 40000);

  let res: Response;
  try {
    res = await fetch(`${SIDECAR_URL}/api/opencode/auth/oauth/callback`, {
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
    window.clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to complete OAuth');
  }
}

export async function getModels(): Promise<ModelCatalog> {
  const res = await fetch(`${SIDECAR_URL}/api/opencode/models`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to get models');
  }

  const payload = await res.json().catch(() => ({}));
  const providersRaw = isRecord(payload)
    ? Array.isArray(payload.providers)
      ? payload.providers
      : isRecord(payload.catalog) && Array.isArray(payload.catalog.providers)
        ? payload.catalog.providers
        : []
    : [];

  return {
    providers: providersRaw.filter(isRecord).map(normalizeProviderModels),
    selection: normalizeModelSelection(payload),
  };
}

export async function getModelConfig(): Promise<ModelConfig> {
  const res = await fetch(`${SIDECAR_URL}/api/opencode/config`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to get model config');
  }

  const payload = await res.json().catch(() => ({}));
  return normalizeModelSelection(payload);
}

export async function setModel(model: string): Promise<void> {
  const res = await fetch(`${SIDECAR_URL}/api/opencode/config/model`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
    },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to set model');
  }
}
