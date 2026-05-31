import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClientForUser: vi.fn(),
}));

vi.mock('./opencode', () => ({
  getClientForUser: mocks.getClientForUser,
}));

const { pickAutoDetectedModel, ensureModelConfigured } = await import('./opencode-model');

function makeMockClient(overrides = {}) {
  const defaultClient = {
    provider: {
      list: vi.fn().mockResolvedValue({ data: {} }),
    },
    config: {
      get: vi.fn().mockResolvedValue({ data: {} }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const result = { ...defaultClient, ...overrides };
  // If config is partially overridden, preserve missing methods from default.
  if (overrides.config) {
    result.config = { ...defaultClient.config, ...overrides.config };
  }
  return result;
}

describe('pickAutoDetectedModel', () => {
  it('returns null when no providers are connected', () => {
    expect(pickAutoDetectedModel({ connected: [] })).toBeNull();
    expect(pickAutoDetectedModel({})).toBeNull();
  });

  it('returns null when connected is undefined', () => {
    expect(pickAutoDetectedModel({ all: [] })).toBeNull();
  });

  it('picks the highest-priority provider default model', () => {
    const result = pickAutoDetectedModel({
      connected: ['openai', 'anthropic'],
      default: { anthropic: 'claude-sonnet-4', openai: 'gpt-4' },
    });
    expect(result).toBe('anthropic/claude-sonnet-4');
  });

  it('picks openai when anthropic is not connected', () => {
    const result = pickAutoDetectedModel({
      connected: ['openai', 'google'],
      default: { openai: 'gpt-4', google: 'gemini-2.5' },
    });
    expect(result).toBe('openai/gpt-4');
  });

  it('picks a non-priority provider after exhausting priority list', () => {
    const result = pickAutoDetectedModel({
      connected: ['fireworks', 'ollama'],
      default: { fireworks: 'llama-4', ollama: 'qwen' },
    });
    expect(result).toBe('fireworks/llama-4');
  });

  it('falls back to the first model key when no defaults are set', () => {
    const result = pickAutoDetectedModel({
      connected: ['anthropic', 'openai'],
      all: [
        { id: 'openai', models: { 'gpt-4': {}, 'gpt-3.5': {} } },
        { id: 'anthropic', models: { 'claude-sonnet': {} } },
      ],
    });
    expect(result).toBe('anthropic/claude-sonnet');
  });

  it('falls back to first model key for non-priority providers', () => {
    const result = pickAutoDetectedModel({
      connected: ['fireworks'],
      all: [{ id: 'fireworks', models: { 'llama-4': {} } }],
    });
    expect(result).toBe('fireworks/llama-4');
  });

  it('returns null when no default and no models are available', () => {
    const result = pickAutoDetectedModel({
      connected: ['anthropic'],
      all: [{ id: 'anthropic', models: {} }],
    });
    expect(result).toBeNull();
  });

  it('returns null when provider in all list does not match connected id', () => {
    const result = pickAutoDetectedModel({
      connected: ['anthropic'],
      all: [{ id: 'openai', models: { 'gpt-4': {} } }],
    });
    expect(result).toBeNull();
  });
});

describe('ensureModelConfigured', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
  });

  it('returns the existing model when one is already configured', async () => {
    const client = makeMockClient({
      config: {
        get: vi.fn().mockResolvedValue({ data: { model: 'anthropic/claude-sonnet' } }),
      },
    });
    mocks.getClientForUser.mockResolvedValue(client);

    const result = await ensureModelConfigured('user-1');
    expect(result).toEqual({
      model: 'anthropic/claude-sonnet',
      autoDetected: false,
      hasProvider: false,
    });
  });

  it('auto-detects and persists when no model is configured', async () => {
    const client = makeMockClient({
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { connected: ['anthropic'], default: { anthropic: 'claude-sonnet' } },
        }),
      },
    });
    mocks.getClientForUser.mockResolvedValue(client);

    const result = await ensureModelConfigured('user-1');
    expect(result).toEqual({
      model: 'anthropic/claude-sonnet',
      autoDetected: true,
      hasProvider: true,
    });
    expect(client.config.update).toHaveBeenCalledWith({
      body: { model: 'anthropic/claude-sonnet' },
    });
  });

  it('returns null when no provider is connected', async () => {
    const client = makeMockClient({
      provider: {
        list: vi.fn().mockResolvedValue({ data: { connected: [] } }),
      },
    });
    mocks.getClientForUser.mockResolvedValue(client);

    const result = await ensureModelConfigured('user-1');
    expect(result).toEqual({
      model: null,
      autoDetected: false,
      hasProvider: false,
    });
  });

  it('returns null when provider is connected but no model is available', async () => {
    const client = makeMockClient({
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { connected: ['anthropic'], all: [{ id: 'anthropic', models: {} }] },
        }),
      },
    });
    mocks.getClientForUser.mockResolvedValue(client);

    const result = await ensureModelConfigured('user-1');
    expect(result).toEqual({
      model: null,
      autoDetected: false,
      hasProvider: true,
    });
  });

  it('uses the client override without calling getClientForUser', async () => {
    const client = makeMockClient({
      config: {
        get: vi.fn().mockResolvedValue({ data: { model: 'openai/gpt-4' } }),
      },
    });

    const result = await ensureModelConfigured('user-1', client);
    expect(result).toEqual({
      model: 'openai/gpt-4',
      autoDetected: false,
      hasProvider: false,
    });
    expect(mocks.getClientForUser).not.toHaveBeenCalled();
  });

  it('survives a config.get failure and still auto-detects', async () => {
    const client = makeMockClient({
      config: {
        get: vi.fn().mockRejectedValue(new Error('config unavailable')),
      },
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { connected: ['openai'], default: { openai: 'gpt-4' } },
        }),
      },
    });
    mocks.getClientForUser.mockResolvedValue(client);

    const result = await ensureModelConfigured('user-1');
    expect(result).toEqual({
      model: 'openai/gpt-4',
      autoDetected: true,
      hasProvider: true,
    });
  });

  it('returns detected model even when config.update fails', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeMockClient({
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { connected: ['anthropic'], default: { anthropic: 'claude-sonnet' } },
        }),
      },
      config: {
        update: vi.fn().mockRejectedValue(new Error('config write failed')),
      },
    });
    mocks.getClientForUser.mockResolvedValue(client);

    const result = await ensureModelConfigured('user-1');
    expect(result).toEqual({
      model: 'anthropic/claude-sonnet',
      autoDetected: true,
      hasProvider: true,
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Auto-detect picked'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('covers nullish coalescing when provider.data and config.data are null', async () => {
    const client = makeMockClient({
      provider: {
        list: vi.fn().mockResolvedValue({ data: null }),
      },
      config: {
        get: vi.fn().mockResolvedValue({ data: null }),
      },
    });
    mocks.getClientForUser.mockResolvedValue(client);

    const result = await ensureModelConfigured('user-1');
    expect(result).toEqual({
      model: null,
      autoDetected: false,
      hasProvider: false,
    });
  });
});
