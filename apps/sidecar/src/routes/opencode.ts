import { Router, Response } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthRequest, requireAuth } from '@openlinear/api/middleware';
import { logger } from '@openlinear/api/logger';
import {
  getOpenCodeStatus,
  getClientForUser,
} from '../services/opencode';

const router: Router = Router();

type ProviderAuthEntry = { type?: string; label?: string };
type ProviderListPayload = {
  all?: Array<Record<string, any>>;
  connected?: string[];
  default?: Record<string, string>;
};
type ConfigPayload = Record<string, any> & {
  model?: string | null;
  small_model?: string | null;
  provider?: Record<string, any>;
};
type ModelRef = {
  providerId: string;
  modelId: string;
};

function resolveOauthMethodIndex(
  methods: ProviderAuthEntry[] | undefined,
  requestedMethod: unknown
): number {
  if (!methods || methods.length === 0) {
    return typeof requestedMethod === 'number' ? requestedMethod : 0;
  }

  if (
    typeof requestedMethod === 'number' &&
    requestedMethod >= 0 &&
    requestedMethod < methods.length &&
    methods[requestedMethod]?.type === 'oauth'
  ) {
    return requestedMethod;
  }

  const oauthIndex = methods.findIndex((entry) => entry?.type === 'oauth');
  if (oauthIndex >= 0) return oauthIndex;

  return typeof requestedMethod === 'number' ? requestedMethod : 0;
}

function normalizeAuthMethods(methods: ProviderAuthEntry[] | undefined): Array<{ type: string; label: string }> {
  return (methods ?? []).map((method) => ({
    type: method.type || 'api',
    label: method.label || (method.type === 'oauth' ? 'OAuth' : 'API key'),
  }));
}

function getModelId(modelKey: string, model: Record<string, any>): string {
  return typeof model.id === 'string' && model.id.length > 0 ? model.id : modelKey;
}

function normalizeModel(
  providerId: string,
  modelKey: string,
  model: Record<string, any>,
  favoriteRankByModel = new Map<string, number>(),
) {
  const id = getModelId(modelKey, model);
  const favoriteRank =
    favoriteRankByModel.get(`${providerId}/${id}`) ??
    favoriteRankByModel.get(`${providerId}/${modelKey}`) ??
    null;

  return {
    id,
    provider: model.provider || model.providerID || providerId,
    name: model.name || id,
    status: model.status || 'active',
    reasoning: Boolean(model.reasoning ?? model.capabilities?.reasoning),
    toolCall: Boolean(model.tool_call ?? model.capabilities?.toolcall),
    favorite: favoriteRank !== null,
    favoriteRank,
    limit: model.limit,
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
    },
  };
}

function getOpenCodeModelStatePaths(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    process.env.OPENCODE_STATE_DIR ? join(process.env.OPENCODE_STATE_DIR, 'model.json') : null,
    process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, 'opencode', 'model.json') : null,
    home ? join(home, '.local', 'state', 'opencode', 'model.json') : null,
    // OpenCode currently uses XDG state on macOS/Linux; these keep the reader
    // tolerant of older installs or platform-specific packagers.
    home ? join(home, '.local', 'share', 'opencode', 'model.json') : null,
    process.platform === 'darwin' && home
      ? join(home, 'Library', 'Application Support', 'opencode', 'model.json')
      : null,
  ];

  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

function normalizeModelRefs(value: unknown): ModelRef[] {
  if (!Array.isArray(value)) return [];

  const refs: ModelRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    const record = item as Record<string, unknown>;
    const providerId = record.providerID ?? record.providerId ?? record.provider;
    const modelId = record.modelID ?? record.modelId ?? record.model;
    if (typeof providerId !== 'string' || typeof modelId !== 'string') continue;
    if (!providerId || !modelId) continue;

    const key = `${providerId}/${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ providerId, modelId });
  }

  return refs;
}

async function readFavoriteModelRefs(): Promise<ModelRef[]> {
  for (const filePath of getOpenCodeModelStatePaths()) {
    try {
      const raw = await readFile(filePath, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      return normalizeModelRefs(data.favorite);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      logger.warn({ err, filePath }, `[OpenCode] Failed to read model favorites from ${filePath}`);
      return [];
    }
  }

  return [];
}

function providerModelEntries(provider: Record<string, any>): Array<[string, Record<string, any>]> {
  return Object.entries(provider.models || {}) as Array<[string, Record<string, any>]>;
}

function providerSort(currentModel: string | null) {
  return (a: Record<string, any>, b: Record<string, any>) => {
    const aCurrent = currentModel?.startsWith(`${a.id}/`) ? 1 : 0;
    const bCurrent = currentModel?.startsWith(`${b.id}/`) ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
    if (a.modelCount !== b.modelCount) return b.modelCount - a.modelCount;
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  };
}

function summarizeProviders(
  providerList: ProviderListPayload,
  authMethods: Record<string, ProviderAuthEntry[]>,
  config: ConfigPayload,
) {
  const connectedSet = new Set(providerList.connected ?? []);
  const currentModel = typeof config.model === 'string' ? config.model : null;

  return (providerList.all ?? [])
    .map((provider) => {
      const modelCount = providerModelEntries(provider).length;
      const selectedModel = currentModel?.startsWith(`${provider.id}/`)
        ? currentModel.slice(String(provider.id).length + 1)
        : null;

      return {
        id: provider.id,
        name: provider.name || provider.id,
        authenticated: connectedSet.has(provider.id),
        source: provider.source || (connectedSet.has(provider.id) ? 'auth' : 'registry'),
        env: Array.isArray(provider.env) ? provider.env : [],
        modelCount,
        defaultModel: providerList.default?.[provider.id] ?? null,
        selectedModel,
        authMethods: normalizeAuthMethods(authMethods[provider.id]),
        baseUrl: typeof provider.options?.baseURL === 'string' ? provider.options.baseURL : null,
        npm: provider.npm || provider.api?.npm || null,
      };
    })
    .sort(providerSort(currentModel));
}

router.get('/status', (_req, res: Response) => {
  res.json(getOpenCodeStatus());
});

router.get('/setup-status', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getClientForUser(req.userId!);
    const [providerList, auth, config] = await Promise.all([
      client.provider.list(),
      client.provider.auth().catch(() => ({ data: {} as Record<string, ProviderAuthEntry[]> })),
      client.config.get().catch(() => ({ data: {} as ConfigPayload })),
    ]);

    const payload = providerList.data as ProviderListPayload;
    const currentConfig = (config.data ?? {}) as ConfigPayload;
    const providers = summarizeProviders(payload, auth.data ?? {}, currentConfig);
    const ready = providers.some(p => p.authenticated);

    res.json({
      providers,
      ready,
      currentModel: currentConfig.model ?? null,
      smallModel: currentConfig.small_model ?? null,
    });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : 'Failed to get setup status' });
  }
});

router.get('/providers', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getClientForUser(req.userId!);
    const providers = await client.provider.list();
    res.json(providers.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list providers' });
  }
});

router.get('/providers/auth', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getClientForUser(req.userId!);
    const auth = await client.provider.auth();
    res.json(auth.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get provider auth methods' });
  }
});

router.post('/auth/remove', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { providerId } = req.body;
    if (!providerId || typeof providerId !== 'string') {
      res.status(400).json({ error: 'providerId is required' });
      return;
    }

    const client = await getClientForUser(req.userId!);
    await (client.auth as unknown as { remove: (opts: { path: { providerID: string } }) => Promise<void> }).remove({ path: { providerID: providerId } });

    res.json({ success: true, providerId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to remove provider' });
  }
});

router.post('/auth', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { providerId, apiKey, baseUrl, enterpriseUrl } = req.body;
    if (!providerId || !apiKey) {
      res.status(400).json({ error: 'providerId and apiKey are required' });
      return;
    }

    const client = await getClientForUser(req.userId!);
    await client.auth.set({
      path: { id: providerId },
      body: { type: 'api', key: apiKey },
    });

    const trimmedBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim() : '';
    const trimmedEnterpriseUrl = typeof enterpriseUrl === 'string' ? enterpriseUrl.trim() : '';
    if (trimmedBaseUrl || trimmedEnterpriseUrl) {
      const configResult = await client.config.get();
      const config = (configResult.data ?? {}) as ConfigPayload;
      const existingProviders = { ...(config.provider ?? {}) };
      const existingProvider = { ...(existingProviders[providerId] ?? {}) };
      const existingOptions = { ...(existingProvider.options ?? {}) };

      if (trimmedBaseUrl) {
        existingOptions.baseURL = trimmedBaseUrl;
      }
      if (trimmedEnterpriseUrl) {
        existingOptions.enterpriseUrl = trimmedEnterpriseUrl;
      }

      existingProviders[providerId] = {
        ...existingProvider,
        options: existingOptions,
      };

      const nextConfig: Record<string, any> = {
        ...config,
        provider: existingProviders,
      };
      if (nextConfig.model === null) delete nextConfig.model;
      if (nextConfig.small_model === null) delete nextConfig.small_model;

      await client.config.update({
        body: nextConfig,
      });
    }

    res.json({ success: true, providerId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to set auth' });
  }
});

router.post('/auth/oauth/authorize', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { providerId, method } = req.body;
    if (!providerId) {
      res.status(400).json({ error: 'providerId is required' });
      return;
    }

    const client = await getClientForUser(req.userId!);
    const auth = await client.provider.auth();
    const methods = auth.data?.[providerId] as ProviderAuthEntry[] | undefined;
    const resolvedMethod = resolveOauthMethodIndex(methods, method);

    const result = await client.provider.oauth.authorize({
      path: { id: providerId },
      body: { method: resolvedMethod },
    });

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start OAuth' });
  }
});

router.post('/auth/oauth/callback', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { providerId, method, code } = req.body;
    if (!providerId || !code) {
      res.status(400).json({ error: 'providerId and code are required' });
      return;
    }

    const client = await getClientForUser(req.userId!);
    const auth = await client.provider.auth();
    const methods = auth.data?.[providerId] as ProviderAuthEntry[] | undefined;
    const resolvedMethod = resolveOauthMethodIndex(methods, method);

    const result = await client.provider.oauth.callback({
      path: { id: providerId },
      body: { method: resolvedMethod, code },
    });

    res.json(result.data);
  } catch (err: any) {
    const message = err.response?.data?.error || err.message || 'Failed to complete OAuth';
    res.status(500).json({ error: message });
  }
});

router.get('/models', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getClientForUser(req.userId!);
    const [providerList, config, favoriteModels] = await Promise.all([
      client.provider.list(),
      client.config.get().catch(() => ({ data: {} as ConfigPayload })),
      readFavoriteModelRefs(),
    ]);

    const payload = providerList.data as ProviderListPayload;
    if (!payload?.all) {
      res.json({ providers: [] });
      return;
    }

    const currentConfig = (config.data ?? {}) as ConfigPayload;
    const currentModel = typeof currentConfig.model === 'string' ? currentConfig.model : null;
    const connectedSet = new Set(payload.connected ?? []);
    const favoriteProviderSet = new Set(favoriteModels.map((model) => model.providerId));
    const favoriteRankByModel = new Map(
      favoriteModels.map((model, index) => [`${model.providerId}/${model.modelId}`, index]),
    );

    const providers = (payload.all as Array<Record<string, any>>)
      .map((provider): Record<string, any> => ({
        ...provider,
        authenticated: connectedSet.has(provider.id),
        modelCount: providerModelEntries(provider).length,
      }))
      .filter((provider) => (
        provider.authenticated ||
        currentModel?.startsWith(`${provider.id}/`) ||
        favoriteProviderSet.has(provider.id) ||
        provider.source === 'config' ||
        provider.source === 'custom'
      ))
      .sort(providerSort(currentModel))
      .map((provider) => {
        const defaultModel = payload.default?.[provider.id] ?? null;
        const selectedModel = currentModel?.startsWith(`${provider.id}/`)
          ? currentModel.slice(String(provider.id).length + 1)
          : null;

        const modelsList = providerModelEntries(provider)
          .map(([modelKey, model]) => normalizeModel(provider.id, modelKey, model, favoriteRankByModel))
          .sort((a, b) => {
            const aSelected = a.id === selectedModel ? 1 : 0;
            const bSelected = b.id === selectedModel ? 1 : 0;
            if (aSelected !== bSelected) return bSelected - aSelected;
            const aFavorite = a.favorite ? 1 : 0;
            const bFavorite = b.favorite ? 1 : 0;
            if (aFavorite !== bFavorite) return bFavorite - aFavorite;
            if (a.favoriteRank !== b.favoriteRank) {
              return (a.favoriteRank ?? Number.MAX_SAFE_INTEGER) - (b.favoriteRank ?? Number.MAX_SAFE_INTEGER);
            }
            const aDefault = a.id === defaultModel ? 1 : 0;
            const bDefault = b.id === defaultModel ? 1 : 0;
            if (aDefault !== bDefault) return bDefault - aDefault;
            return a.name.localeCompare(b.name);
          });

        return {
          id: provider.id,
          name: provider.name || provider.id,
          authenticated: provider.authenticated,
          defaultModel,
          selectedModel,
          favoriteModelCount: modelsList.filter((model) => model.favorite).length,
          models: modelsList,
        };
      });

    res.json({ providers });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list models' });
  }
});

router.get('/config', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getClientForUser(req.userId!);
    const config = await client.config.get();

    res.json({
      model: config.data?.model ?? null,
      small_model: config.data?.small_model ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get config' });
  }
});

router.post('/config/model', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { model } = req.body;
    if (!model || typeof model !== 'string') {
      res.status(400).json({ error: 'model is required (format: provider/model)' });
      return;
    }

    const client = await getClientForUser(req.userId!);
    await client.config.update({
      body: { model },
    });

    res.json({ success: true, model });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to set model' });
  }
});

export default router;
