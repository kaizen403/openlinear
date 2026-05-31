import type { OpencodeClient } from '@opencode-ai/sdk';
import { getClientForUser } from './opencode';

/**
 * Provider preference order for auto-detection.
 * Anthropic is preferred for code tasks, then OpenAI, then Google, then OpenRouter,
 * then anything else the user has authenticated.
 */
const PROVIDER_PRIORITY = ['anthropic', 'openai', 'google', 'openrouter'];

type ProviderListPayload = {
  all?: Array<Record<string, unknown>>;
  connected?: string[];
  default?: Record<string, string>;
};

type ConfigPayload = Record<string, unknown> & {
  model?: string | null;
};

export interface EnsureModelResult {
  /** Resolved "providerId/modelId" string, or null if no model could be configured. */
  model: string | null;
  /** True when the model was just auto-selected (caller may want to log this). */
  autoDetected: boolean;
  /** True when at least one provider has credentials set up. */
  hasProvider: boolean;
}

/**
 * Pick the best available model based on authenticated providers and provider-default models.
 * Pure function so it can be unit tested without spinning up OpenCode.
 */
export function pickAutoDetectedModel(
  providers: ProviderListPayload,
): string | null {
  const connected = new Set(providers.connected ?? []);
  if (connected.size === 0) return null;

  const defaults = providers.default ?? {};

  // Walk priority list first, then fall back to any connected provider with a default.
  const ordered = [
    ...PROVIDER_PRIORITY.filter((id) => connected.has(id)),
    ...[...connected].filter((id) => !PROVIDER_PRIORITY.includes(id)),
  ];

  for (const providerId of ordered) {
    const defaultModel = defaults[providerId];
    if (defaultModel && typeof defaultModel === 'string') {
      return `${providerId}/${defaultModel}`;
    }
  }

  // Last resort: pick the first model from the first connected provider.
  for (const providerId of ordered) {
    const provider = providers.all?.find(
      (p) => (p as { id?: string }).id === providerId,
    ) as { models?: Record<string, unknown> } | undefined;
    const firstModelKey = provider?.models ? Object.keys(provider.models)[0] : undefined;
    if (firstModelKey) {
      return `${providerId}/${firstModelKey}`;
    }
  }

  return null;
}

/**
 * Ensures a model is configured for the given user. If one is already set, returns it.
 * Otherwise, auto-detects the best available model from authenticated providers and
 * persists the choice via the OpenCode config so future runs are deterministic.
 *
 * Returns `{ model: null }` only when no provider is authenticated or no model is
 * available — callers should surface a "MODEL_NOT_CONFIGURED" error in that case.
 */
export async function ensureModelConfigured(
  userId: string,
  clientOverride?: OpencodeClient,
): Promise<EnsureModelResult> {
  const client = clientOverride ?? (await getClientForUser(userId));

  const [providerListRes, configRes] = await Promise.all([
    client.provider.list(),
    client.config.get().catch(() => ({ data: {} as ConfigPayload })),
  ]);

  const providerList = (providerListRes.data ?? {}) as ProviderListPayload;
  const config = (configRes.data ?? {}) as ConfigPayload;

  const hasProvider = (providerList.connected ?? []).length > 0;
  const currentModel = typeof config.model === 'string' && config.model.length > 0
    ? config.model
    : null;

  if (currentModel) {
    return { model: currentModel, autoDetected: false, hasProvider };
  }

  const detected = pickAutoDetectedModel(providerList);
  if (!detected) {
    return { model: null, autoDetected: false, hasProvider };
  }

  try {
    await client.config.update({ body: { model: detected } });
  } catch (err) {
    // If persisting fails, we still return the detected value so the caller
    // can use it for the current run; next call will retry.
    console.warn(
      `[OpenCodeModel] Auto-detect picked "${detected}" but failed to persist:`,
      err,
    );
  }

  return { model: detected, autoDetected: true, hasProvider };
}
