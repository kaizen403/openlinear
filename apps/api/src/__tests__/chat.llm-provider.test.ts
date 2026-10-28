/**
 * Provider seam (W15/W18a): request shape, stream parsing, usage
 * normalisation, error classification, bounded retries, cache hints and
 * validated configuration. Every request goes to a loopback stub.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ChatLLMError,
  OpenAICompatibleChatLLM,
  type ChatLLMEvent,
  type ChatLLMMessage,
  type OpenAICompatibleChatLLMOptions,
} from '../lib/chat-llm';
import { DEFAULT_CHAT_LLM_BASE_URL, DEFAULT_CHAT_LLM_MODEL, inferProvider, loadChatLLMConfig } from '../lib/chat-llm-config';
import { backoffDelayMs, classifyHttpFailure, parseRetryAfterMs } from '../lib/llm-retry';
import { cacheHitRate, normalizeProviderUsage, resolveCost, type PricingTable } from '../lib/llm-usage';
import {
  finishFrame,
  startFakeLLMProvider,
  textFrame,
  textStream,
  toolCallFrame,
  usageFrame,
  type FakeLLMProvider,
} from './fake-llm-provider';

let provider: FakeLLMProvider;

function client(options: OpenAICompatibleChatLLMOptions = {}): OpenAICompatibleChatLLM {
  return new OpenAICompatibleChatLLM({
    baseUrl: provider.baseUrl,
    apiKey: 'test-key',
    model: 'fake-model',
    retry: { baseDelayMs: 1, maxDelayMs: 20 },
    env: {},
    ...options,
  });
}

async function drain(stream: AsyncIterable<ChatLLMEvent>): Promise<ChatLLMEvent[]> {
  const events: ChatLLMEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function drainError(stream: AsyncIterable<ChatLLMEvent>): Promise<{ events: ChatLLMEvent[]; error: ChatLLMError }> {
  const events: ChatLLMEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
  } catch (error) {
    if (error instanceof ChatLLMError) return { events, error };
    throw error;
  }
  throw new Error('expected the stream to fail');
}

const USER: ChatLLMMessage[] = [{ role: 'user', content: 'hello' }];

function body(index = -1): Record<string, unknown> {
  return provider.requests.at(index)?.body as Record<string, unknown>;
}

beforeAll(async () => {
  provider = await startFakeLLMProvider();
});

afterEach(() => {
  provider.reset();
});

afterAll(async () => {
  await provider.close();
});

describe('request shape', () => {
  it('asks for streamed usage, flattens system blocks and omits tool_choice without tools', async () => {
    provider.enqueue(textStream('ok'));
    await drain(client().streamChatCompletion({
      messages: [{ role: 'system', content: [{ type: 'text', text: 'CORE' }, { type: 'text', text: 'SCOPE' }] }, ...USER],
    }));
    const sent = body();
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent).not.toHaveProperty('tool_choice');
    expect(sent).not.toHaveProperty('tools');
    expect((sent.messages as ChatLLMMessage[])[0]).toEqual({ role: 'system', content: 'CORE\n\nSCOPE' });
    expect(provider.requests.at(-1)?.headers.authorization).toBe('Bearer test-key');
  });

  it('lets operators turn streamed usage off for providers that reject stream_options', async () => {
    provider.enqueue(textStream('ok'));
    await drain(client({ streamUsage: false }).streamChatCompletion({ messages: USER }));
    expect(body()).not.toHaveProperty('stream_options');
  });

  it('adds Anthropic-style cache breakpoints only where they are supported', async () => {
    const system: ChatLLMMessage = { role: 'system', content: [{ type: 'text', text: 'CORE' }, { type: 'text', text: 'SCOPE' }] };
    const messages: ChatLLMMessage[] = [system, { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'second' }];

    provider.enqueue(textStream('ok'), textStream('ok'), textStream('ok'));
    await drain(client({ cacheHints: 'anthropic' }).streamChatCompletion({ messages }));
    const hinted = body().messages as ChatLLMMessage[];
    const breakpoints = JSON.stringify(hinted).match(/cache_control/g) ?? [];
    expect(breakpoints).toHaveLength(2);
    expect(hinted[0]?.content).toEqual([{ type: 'text', text: 'CORE', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'SCOPE' }]);
    expect(hinted.at(-1)?.content).toEqual([{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }]);
    expect(messages[3]?.content).toBe('second');

    // auto + OpenRouter in front of an Anthropic model forwards breakpoints.
    await drain(client({ provider: 'openrouter', model: 'anthropic/claude-test' }).streamChatCompletion({ messages }));
    expect(JSON.stringify(body().messages)).toContain('cache_control');

    // auto elsewhere relies on automatic prefix caching: no hints, plain strings.
    await drain(client().streamChatCompletion({ messages }));
    expect(JSON.stringify(body().messages)).not.toContain('cache_control');
  });

  it('sends a per-conversation prompt_cache_key only to OpenAI', async () => {
    provider.enqueue(textStream('ok'), textStream('ok'));
    await drain(client({ provider: 'openai' }).streamChatCompletion({ messages: USER, cacheKey: 'session-1' }));
    expect(body().prompt_cache_key).toBe('session-1');
    await drain(client().streamChatCompletion({ messages: USER, cacheKey: 'session-1' }));
    expect(body()).not.toHaveProperty('prompt_cache_key');
  });
});

describe('stream parsing and usage', () => {
  it('reports normalised usage (cache reads, reasoning) from the trailing usage chunk', async () => {
    provider.enqueue({
      kind: 'sse',
      frames: [
        textFrame('Hel'),
        textFrame('lo'),
        finishFrame('stop'),
        usageFrame({ prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 30 } }),
      ],
      headers: { 'x-request-id': 'req-123' },
    });
    const events = await drain(client().streamChatCompletion({ messages: USER }));
    expect(events.filter((event) => event.type === 'delta').map((event) => (event.type === 'delta' ? event.content : '')).join('')).toBe('Hello');
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') return;
    expect(done.usage).toMatchObject({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1024, reasoningTokens: 30, cacheWriteTokens: null });
    expect(done.attempt).toBe(1);
    expect(done.providerRequestId).toBe('chatcmpl-fake');
    expect(done.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it('handles CRLF line endings, fragmented frames, keep-alive comments and an unterminated final frame', async () => {
    provider.enqueue({
      kind: 'sse',
      frames: [textFrame('A'), toolCallFrame(0, { id: 'call_1', name: 'list_projects', arguments: '{"wor' }), toolCallFrame(0, { arguments: 'kspaceId":"w"}' }), finishFrame('tool_calls', { prompt_tokens: 5, completion_tokens: 2 })],
      crlf: true,
      fragment: true,
      unterminatedLastFrame: true,
    });
    const events = await drain(client().streamChatCompletion({ messages: USER }));
    const args = events.filter((event) => event.type === 'tool_call_delta').map((event) => (event.type === 'tool_call_delta' ? event.argumentsDelta ?? '' : '')).join('');
    expect(args).toBe('{"workspaceId":"w"}');
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'tool_calls', inputTokens: 5, outputTokens: 2 });
  });

  it('treats a stream that ends without a finish reason as truncated, not complete', async () => {
    provider.enqueue({ kind: 'sse', frames: [textFrame('partial answer')], omitDone: true });
    const { events, error } = await drainError(client().streamChatCompletion({ messages: USER }));
    expect(events.some((event) => event.type === 'delta')).toBe(true);
    expect(error.code).toBe('LLM_STREAM_TRUNCATED');
    // Output already reached the caller, so it is not replayed.
    expect(provider.requests).toHaveLength(1);
  });

  it('rejects a malformed frame', async () => {
    provider.enqueue({ kind: 'sse', frames: [textFrame('x'), '{not json'] });
    const { error } = await drainError(client().streamChatCompletion({ messages: USER }));
    expect(error.code).toBe('LLM_STREAM_MALFORMED');
  });

  it('returns usage and retry history from non-streaming calls', async () => {
    provider.enqueue(
      { kind: 'json', status: 503, body: { error: { message: 'overloaded' } } },
      { kind: 'json', status: 200, body: { id: 'cmpl-1', choices: [{ message: { content: '{"title":"T"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 6 } } },
    );
    const completion = await client().completeChatCompletion({ messages: USER, json: true });
    expect(completion.content).toBe('{"title":"T"}');
    expect(completion.usage).toMatchObject({ inputTokens: 50, outputTokens: 6 });
    expect(completion.attempt).toBe(2);
    expect(completion.failures).toEqual([expect.objectContaining({ attempt: 1, code: 'LLM_PROVIDER_UNAVAILABLE', httpStatus: 503 })]);
    expect(body().response_format).toEqual({ type: 'json_object' });
    expect(body()).not.toHaveProperty('stream');
  });
});

describe('usage normalisation and cost', () => {
  it('maps every supported provider usage shape to inclusive token semantics', () => {
    expect(normalizeProviderUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 20 }))
      .toMatchObject({ inputTokens: 1050, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 20 });
    expect(normalizeProviderUsage({ prompt_tokens: 300, prompt_cache_hit_tokens: 256, prompt_cache_miss_tokens: 44, completion_tokens: 9 }))
      .toMatchObject({ inputTokens: 300, cacheReadTokens: 256, outputTokens: 9 });
    expect(normalizeProviderUsage({ prompt_tokens: 40, completion_tokens: 2, cached_tokens: 32 })).toMatchObject({ cacheReadTokens: 32 });
    expect(normalizeProviderUsage({ prompt_tokens: -1, completion_tokens: 1.5 })).toBeNull();
    expect(normalizeProviderUsage(null)).toBeNull();
    expect(normalizeProviderUsage({ prompt_tokens: 1, completion_tokens: 1, cost: 0.002 })?.providerCostUsd).toBeNull();
    expect(normalizeProviderUsage({ prompt_tokens: 1, completion_tokens: 1, cost: 0.002 }, { trustProviderCost: true })?.providerCostUsd).toBe(0.002);
  });

  it('never turns an unknown cost into zero', () => {
    const usage = normalizeProviderUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } });
    const pricing: PricingTable = { revision: 'test-rev', models: { 'fireworks:fake-model': { inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.25 } } };
    expect(resolveCost(usage, { provider: 'fireworks', model: 'fake-model', pricing: null })).toEqual({ costUsd: null, basis: 'unknown', pricingRevision: null });
    expect(resolveCost(null, { provider: 'fireworks', model: 'fake-model', pricing })).toEqual({ costUsd: null, basis: 'unknown', pricingRevision: null });
    // 200 uncached × $1 + 800 cached × $0.25 + 100 output × $4, per million.
    expect(resolveCost(usage, { provider: 'fireworks', model: 'fake-model', pricing })).toEqual({ costUsd: 0.0008, basis: 'estimated', pricingRevision: 'test-rev' });
    // Cached tokens but no cache price: unknown rather than a guess.
    const noCachePrice: PricingTable = { revision: 'r', models: { 'fake-model': { inputPerMTok: 1, outputPerMTok: 4 } } };
    expect(resolveCost(usage, { provider: 'fireworks', model: 'fake-model', pricing: noCachePrice }).basis).toBe('unknown');
    expect(cacheHitRate({ inputTokens: 1000, cacheReadTokens: 800 })).toBe(0.8);
    expect(cacheHitRate({ inputTokens: 1000, cacheReadTokens: null })).toBeNull();
  });
});

describe('errors and retries', () => {
  it('retries 5xx and network failures with backoff, reporting each failed attempt', async () => {
    provider.enqueue({ kind: 'json', status: 503, body: { error: { message: 'busy' } } }, { kind: 'destroy' }, textStream('third time'));
    const events = await drain(client().streamChatCompletion({ messages: USER }));
    const retries = events.filter((event) => event.type === 'retry');
    expect(retries.map((event) => (event.type === 'retry' ? event.failure.code : ''))).toEqual(['LLM_PROVIDER_UNAVAILABLE', 'LLM_NETWORK_ERROR']);
    expect(events.at(-1)).toMatchObject({ type: 'done', attempt: 3 });
  });

  it('stops after the configured number of attempts', async () => {
    provider.setFallback({ kind: 'json', status: 502, body: { error: { message: 'bad gateway' } } });
    const { error } = await drainError(client({ retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 } }).streamChatCompletion({ messages: USER }));
    expect(error.code).toBe('LLM_PROVIDER_UNAVAILABLE');
    expect(error.info.attempts).toBe(2);
    expect(error.info.failures).toHaveLength(2);
    expect(provider.requests).toHaveLength(2);
  });

  it('does not retry auth failures, bad requests, exhausted quota or context overflow', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'invalid api key', 'LLM_AUTH_FAILED'],
      [404, 'model not found', 'LLM_MODEL_NOT_FOUND'],
      [400, 'temperature must be <= 2', 'LLM_BAD_REQUEST'],
      [429, 'You exceeded your current quota, please check your plan and billing details.', 'LLM_QUOTA_EXCEEDED'],
      [400, "This model's maximum context length is 131072 tokens. However, your messages resulted in 140000 tokens.", 'LLM_CONTEXT_OVERFLOW'],
      [413, 'request entity too large', 'LLM_CONTEXT_OVERFLOW'],
    ];
    for (const [status, message, code] of cases) {
      provider.reset();
      provider.enqueue({ kind: 'json', status, body: { error: { message: `${message} Bearer sk-secretsecretsecret` } } });
      const { error } = await drainError(client().streamChatCompletion({ messages: USER }));
      expect(error.code, message).toBe(code);
      expect(provider.requests).toHaveLength(1);
      expect(error.info.providerMessage ?? '').not.toContain('secretsecret');
    }
  });

  it('honours Retry-After as a lower bound and gives up when it exceeds the policy', async () => {
    provider.enqueue({ kind: 'json', status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '120' } });
    const { error } = await drainError(client().streamChatCompletion({ messages: USER }));
    expect(error.code).toBe('LLM_RATE_LIMITED');
    expect(error.info.retryAfterMs).toBe(120_000);
    expect(provider.requests).toHaveLength(1);

    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString(), Date.now())).toBeGreaterThan(3000);
    expect(parseRetryAfterMs('soon')).toBeNull();
  });

  it('keeps jittered backoff within bounds', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    expect(backoffDelayMs(1, policy, null, () => 0)).toBe(50);
    expect(backoffDelayMs(1, policy, null, () => 1)).toBe(100);
    expect(backoffDelayMs(3, policy, null, () => 0.5)).toBe(300);
    expect(backoffDelayMs(10, policy, null, () => 1)).toBe(1000);
    expect(backoffDelayMs(1, policy, 700, () => 0)).toBe(700);
    expect(backoffDelayMs(1, policy, 5000, () => 0)).toBeNull();
    expect(classifyHttpFailure(529, 'overloaded')).toMatchObject({ code: 'LLM_PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('times out an idle provider and reports LLM_TIMEOUT', async () => {
    provider.setFallback({ kind: 'hang' });
    const { error } = await drainError(client({ timeoutMs: 150, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 } }).streamChatCompletion({ messages: USER }));
    expect(error.code).toBe('LLM_TIMEOUT');
    expect(error.info.attempts).toBe(2);
  });

  it('stops retrying as soon as the caller aborts', async () => {
    provider.setFallback({ kind: 'json', status: 503, body: { error: { message: 'busy' } } });
    const controller = new AbortController();
    const stream = client({ retry: { maxAttempts: 5, baseDelayMs: 5000, maxDelayMs: 10_000 } }).streamChatCompletion({ messages: USER, abortSignal: controller.signal });
    const pending = drainError(stream);
    setTimeout(() => controller.abort(), 100);
    const { error } = await pending;
    expect(error.code).toBe('CLIENT_ABORTED');
    expect(provider.requests).toHaveLength(1);
  });
});

describe('configuration (data processor)', () => {
  it('keeps the current default processor unless the deployment chooses another', () => {
    const loaded = loadChatLLMConfig({});
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.baseUrl).toBe(DEFAULT_CHAT_LLM_BASE_URL);
    expect(loaded.config.model).toBe(DEFAULT_CHAT_LLM_MODEL);
    expect(loaded.config.provider).toBe('fireworks');
    expect(loaded.config.titleModel).toBe(DEFAULT_CHAT_LLM_MODEL);
    expect(loaded.config.retry).toEqual({ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 });
    expect(loaded.config.pricing).toBeNull();
  });

  it('accepts a validated alternative provider', () => {
    const loaded = loadChatLLMConfig({
      CHAT_LLM_BASE_URL: 'https://openrouter.ai/api/v1/',
      CHAT_LLM_MODEL: 'anthropic/claude-test',
      CHAT_LLM_TITLE_MODEL: 'anthropic/claude-small',
      CHAT_LLM_API_KEY: 'k',
      MODEL_PRICING_JSON: JSON.stringify({ revision: 'r1', models: { 'anthropic/claude-test': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 } } }),
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config).toMatchObject({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', titleModel: 'anthropic/claude-small', apiKey: 'k' });
    expect(loaded.config.pricing?.revision).toBe('r1');
  });

  it('rejects invalid settings instead of silently falling back', () => {
    const invalid: Array<Record<string, string>> = [
      { CHAT_LLM_BASE_URL: 'http://llm.internal.example/v1' },
      { CHAT_LLM_BASE_URL: 'not a url' },
      { CHAT_LLM_BASE_URL: 'https://user:pass@api.example.com/v1' },
      { CHAT_LLM_TIMEOUT_MS: '60s' },
      { CHAT_LLM_MAX_ATTEMPTS: '0' },
      { CHAT_LLM_PROVIDER: 'mystery' },
      { CHAT_LLM_MODEL: 'has spaces' },
      { CHAT_LLM_CACHE_HINTS: 'always' },
      { MODEL_PRICING_JSON: '{"revision":"r","models":{"m":{"inputPerMTok":-1,"outputPerMTok":1}}}' },
      { MODEL_PRICING_JSON: 'not json' },
    ];
    for (const env of invalid) {
      expect(loadChatLLMConfig(env).ok, JSON.stringify(env)).toBe(false);
    }
    expect(loadChatLLMConfig({ CHAT_LLM_BASE_URL: 'http://127.0.0.1:9/v1' }).ok).toBe(true);
    expect(loadChatLLMConfig({ CHAT_LLM_BASE_URL: 'http://llm.internal.example/v1', CHAT_LLM_ALLOW_INSECURE_HTTP: '1' }).ok).toBe(true);
    expect(inferProvider('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(inferProvider('https://my-proxy.example.com/v1')).toBe('openai_compatible');
  });

  it('fails closed with LLM_MISCONFIGURED when the deployment configuration is invalid', async () => {
    const misconfigured = new OpenAICompatibleChatLLM({ env: { CHAT_LLM_BASE_URL: 'http://llm.internal.example/v1', CHAT_LLM_API_KEY: 'k' } });
    const { error } = await drainError(misconfigured.streamChatCompletion({ messages: USER }));
    expect(error.code).toBe('LLM_MISCONFIGURED');
    const keyless = new OpenAICompatibleChatLLM({ env: {} });
    const missingKey = await drainError(keyless.streamChatCompletion({ messages: USER }));
    expect(missingKey.error.code).toBe('LLM_NOT_CONFIGURED');
  });
});
