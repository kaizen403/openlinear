/**
 * W15 metering and W18a resilience at the turn level: every model attempt
 * (rounds, retries, failures, titles) lands in `model_usage`; unknown cost
 * stays null; the usage route aggregates in SQL and respects scope; provider
 * failures are classified, retried or compacted, and the turn is time-bounded.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { Prisma, prisma } from '@openlinear/db';
import { createApp } from '../app';
import {
  OpenAICompatibleChatLLM,
  setChatLLMClientForTesting,
  type ChatLLMClient,
  type OpenAICompatibleChatLLMOptions,
  type ChatLLMEvent,
  type StreamChatCompletionInput,
} from '../lib/chat-llm';
import { runChatTurn, type ChatChunk } from '../services/chat';
import { recordModelUsage } from '../services/model-usage';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';
import {
  finishFrame,
  startFakeLLMProvider,
  textFrame,
  textStream,
  toolCallFrame,
  usageFrame,
  type FakeLLMProvider,
} from './fake-llm-provider';
import { useTestServer } from './http';

const suffix = randomUUID().slice(0, 8);

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

async function waitFor<T>(probe: () => Promise<T | null | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met in time');
}

class LegacyUsageClient implements ChatLLMClient {
  readonly model = 'legacy-double';

  async *streamChatCompletion(_input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    yield { type: 'delta', content: 'hi' };
    yield { type: 'done', finishReason: 'stop', inputTokens: 21, outputTokens: 4 };
  }
}

describe('Home Chat metering and resilience', () => {
  const app = createApp();
  const http = useTestServer(() => app);
  let provider: FakeLLMProvider;
  let userId = '';
  let otherUserId = '';
  let username = '';
  let workspaceId = '';
  let otherWorkspaceId = '';
  let reportWorkspaceId = '';
  let auth = '';

  function realClient(extra: OpenAICompatibleChatLLMOptions = {}) {
    return new OpenAICompatibleChatLLM({
      baseUrl: provider.baseUrl,
      apiKey: 'test-key',
      model: 'fake-model',
      retry: { baseDelayMs: 1, maxDelayMs: 10 },
      env: {},
      ...extra,
    });
  }

  async function newSession(title = 'Metering session'): Promise<string> {
    return (await prisma.chatSession.create({ data: { userId, workspaceId, title } })).id;
  }

  beforeAll(async () => {
    provider = await startFakeLLMProvider();
    const user = await prisma.user.create({ data: { githubId: `meter-${suffix}`, username: `meter${suffix}`, email: `meter-${suffix}@example.com` } });
    userId = user.id;
    username = user.username;
    const other = await prisma.user.create({ data: { githubId: `meter-o-${suffix}`, username: `metero${suffix}`, email: `meter-o-${suffix}@example.com` } });
    otherUserId = other.id;
    workspaceId = (await prisma.workspace.create({ data: { name: `Meter ${suffix}`, slug: `meter-${suffix}` } })).id;
    otherWorkspaceId = (await prisma.workspace.create({ data: { name: `Meter B ${suffix}`, slug: `meter-b-${suffix}` } })).id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId, role: 'owner', joinedAt: new Date() },
        { workspaceId: otherWorkspaceId, userId, role: 'member', joinedAt: new Date() },
      ],
    });
    auth = jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
  }, 30000);

  afterEach(() => {
    setChatLLMClientForTesting(null);
    provider.reset();
    delete process.env.MODEL_PRICING_JSON;
    delete process.env.CHAT_TURN_TIMEOUT_MS;
  });

  afterAll(async () => {
    await provider.close();
    await prisma.modelUsage.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.personalAccessToken.deleteMany({ where: { userId } });
    await prisma.chatSession.deleteMany({ where: { userId } });
    const workspaces = [workspaceId, otherWorkspaceId, reportWorkspaceId].filter(Boolean);
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  }, 30000);

  describe('turn metering', () => {
    it('records one row per model round with reported tokens and an explicit unknown cost', async () => {
      const sessionId = await newSession();
      provider.enqueue(
        { kind: 'sse', frames: [toolCallFrame(0, { id: 'call_ws', name: 'list_workspaces', arguments: '{}' }), finishFrame('tool_calls'), usageFrame({ prompt_tokens: 3000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } })] },
        { kind: 'sse', frames: [textFrame('You have two workspaces.'), finishFrame('stop'), usageFrame({ prompt_tokens: 3200, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 2944 } })] },
      );
      setChatLLMClientForTesting(realClient());

      const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'How many workspaces?' }));
      const done = chunks.at(-1);
      expect(done?.type).toBe('done');
      if (done?.type !== 'done') return;
      expect(done.usage).toEqual({
        modelCalls: 2,
        coverage: 'complete',
        inputTokens: 6200,
        outputTokens: 32,
        totalTokens: 6232,
        cacheReadTokens: 2944,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: null,
        costBasis: 'unknown',
      });

      const rows = await prisma.modelUsage.findMany({ where: { sessionId }, orderBy: { round: 'asc' } });
      expect(rows.map((row) => [row.surface, row.round, row.status, row.inputTokens, row.cacheReadTokens])).toEqual([
        ['chat.turn', 0, 'succeeded', 3000, 0],
        ['chat.turn', 1, 'succeeded', 3200, 2944],
      ]);
      for (const row of rows) {
        expect(row.costUsd).toBeNull();
        expect(row.costBasis).toBe('unknown');
        expect(row.provider).toBe('openai_compatible');
        expect(row.model).toBe('fake-model');
        expect(row.workspaceId).toBe(workspaceId);
        expect(row.promptHash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.toolsHash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.latencyMs).not.toBeNull();
        expect(row.rawUsage).not.toBeNull();
      }
    });

    it('estimates cost from a configured price snapshot and labels it as an estimate', async () => {
      process.env.MODEL_PRICING_JSON = JSON.stringify({ revision: 'test-2026-10', models: { 'openai_compatible:fake-model': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 } } });
      const sessionId = await newSession();
      provider.enqueue({ kind: 'sse', frames: [textFrame('ok'), finishFrame('stop'), usageFrame({ prompt_tokens: 10_000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 5000 } })] });
      setChatLLMClientForTesting(realClient());
      const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'hi' }));
      const done = chunks.at(-1);
      // 5000 × $2 + 5000 × $0.2 + 1000 × $10 per million = $0.021
      expect(done && done.type === 'done' ? done.usage?.costUsd : undefined).toBe(0.021);
      const row = await prisma.modelUsage.findFirstOrThrow({ where: { sessionId } });
      expect(row.costBasis).toBe('estimated');
      expect(row.pricingRevision).toBe('test-2026-10');
      expect(row.costUsd?.toString()).toBe('0.021');
    });

    it('meters retried attempts separately and never double counts a replayed record', async () => {
      const sessionId = await newSession();
      provider.enqueue({ kind: 'json', status: 503, body: { error: { message: 'busy' } } }, textStream('recovered', { prompt_tokens: 50, completion_tokens: 5 }));
      setChatLLMClientForTesting(realClient());
      await collect(runChatTurn({ sessionId, userId, userMessage: 'hi' }));
      const rows = await prisma.modelUsage.findMany({ where: { sessionId }, orderBy: { attempt: 'asc' } });
      expect(rows.map((row) => [row.attempt, row.status, row.errorCode, row.usageReported])).toEqual([
        [1, 'failed', 'LLM_PROVIDER_UNAVAILABLE', false],
        [2, 'succeeded', null, true],
      ]);

      const replayed = rows[1];
      if (!replayed) throw new Error('missing row');
      await recordModelUsage({ invocationId: replayed.invocationId, surface: 'chat.turn', provider: 'x', model: 'x', status: 'succeeded', usage: null, userId });
      await expect(prisma.modelUsage.count({ where: { invocationId: replayed.invocationId } })).resolves.toBe(1);
    });

    it('meters test doubles that only report legacy token fields', async () => {
      const sessionId = await newSession();
      setChatLLMClientForTesting(new LegacyUsageClient());
      await collect(runChatTurn({ sessionId, userId, userMessage: 'hi' }));
      const row = await prisma.modelUsage.findFirstOrThrow({ where: { sessionId } });
      expect([row.provider, row.inputTokens, row.outputTokens, row.costBasis]).toEqual(['unknown', 21, 4, 'unknown']);
    });

    it('meters title generation as its own surface', async () => {
      const sessionId = await newSession('New chat');
      provider.enqueue(
        textStream('Answer', { prompt_tokens: 100, completion_tokens: 3 }),
        { kind: 'json', status: 200, body: { choices: [{ message: { content: '{"title":"Workspace count"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 7 } } },
      );
      setChatLLMClientForTesting(realClient({ titleModel: 'fake-small-model' }));
      await collect(runChatTurn({ sessionId, userId, userMessage: 'How many workspaces?' }));
      const title = await waitFor(() => prisma.modelUsage.findFirst({ where: { sessionId, surface: 'chat.title' } }));
      expect([title.model, title.inputTokens, title.outputTokens, title.status]).toEqual(['fake-small-model', 60, 7, 'succeeded']);
      const titleRequest = provider.requests.find((entry) => (entry.body as { stream?: boolean }).stream !== true);
      expect((titleRequest?.body as { model?: string } | undefined)?.model).toBe('fake-small-model');
      await waitFor(async () => (await prisma.chatSession.findUnique({ where: { id: sessionId } }))?.title === 'Workspace count' || null);
    });

    it('refuses to store an unknown cost as a number at the database level', async () => {
      await expect(prisma.modelUsage.create({
        data: { invocationId: `bad-${suffix}`, surface: 'chat.turn', provider: 'p', model: 'm', status: 'succeeded', costBasis: 'unknown', costUsd: new Prisma.Decimal(0), userId },
      })).rejects.toThrow();
      await expect(prisma.modelUsage.create({
        data: { invocationId: `bad2-${suffix}`, surface: 'chat.turn', provider: 'p', model: 'm', status: 'succeeded', costBasis: 'estimated', costUsd: null, userId },
      })).rejects.toThrow();
    });
  });

  describe('resilience', () => {
    it('surfaces exhausted rate limits as LLM_RATE_LIMITED over SSE', async () => {
      const sessionId = await newSession();
      provider.setFallback({ kind: 'json', status: 429, body: { error: { message: 'Too many requests' } }, headers: { 'retry-after': '0' } });
      setChatLLMClientForTesting(realClient({ retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 } }));
      const res = await http().post(`/api/chat/sessions/${sessionId}/messages`).set('Authorization', `Bearer ${auth}`).send({ content: 'hi' });
      expect(res.status).toBe(200);
      expect(res.text).toContain('"code":"LLM_RATE_LIMITED"');
      expect(res.text).toContain('"attempts":2');
      expect(provider.requests).toHaveLength(2);
      await expect(prisma.modelUsage.count({ where: { sessionId, status: 'failed' } })).resolves.toBe(2);
    });

    it('does not retry an authentication failure', async () => {
      const sessionId = await newSession();
      provider.setFallback({ kind: 'json', status: 401, body: { error: { message: 'bad key' } } });
      setChatLLMClientForTesting(realClient());
      const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'hi' }));
      expect(chunks.at(-1)).toMatchObject({ type: 'error', code: 'LLM_AUTH_FAILED' });
      expect(provider.requests).toHaveLength(1);
    });

    it('reports a second context overflow after one trim instead of looping', async () => {
      const sessionId = await newSession();
      provider.setFallback({ kind: 'json', status: 400, body: { error: { message: 'context_length_exceeded' } } });
      setChatLLMClientForTesting(realClient());
      const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'hi' }));
      expect(chunks.at(-1)).toMatchObject({ type: 'error', code: 'LLM_CONTEXT_OVERFLOW' });
      expect(provider.requests).toHaveLength(2);
    });

    it('bounds the whole turn and reports TURN_TIMEOUT', async () => {
      process.env.CHAT_TURN_TIMEOUT_MS = '1000';
      const sessionId = await newSession();
      provider.setFallback({ kind: 'hang' });
      setChatLLMClientForTesting(realClient({ timeoutMs: 60_000 }));
      const started = Date.now();
      const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'hi' }));
      expect(chunks.at(-1)).toMatchObject({ type: 'error', code: 'TURN_TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(5000);
      const row = await prisma.modelUsage.findFirstOrThrow({ where: { sessionId } });
      expect(row.status).toBe('aborted');
    });
  });

  describe('GET /api/usage/models', () => {
    beforeAll(async () => {
      reportWorkspaceId = (await prisma.workspace.create({ data: { name: `Meter R ${suffix}`, slug: `meter-r-${suffix}` } })).id;
      await prisma.workspaceMember.create({ data: { workspaceId: reportWorkspaceId, userId, role: 'member', joinedAt: new Date() } });
      const base = { surface: 'chat.turn', provider: 'fireworks', model: 'kimi', status: 'succeeded' } as const;
      await prisma.modelUsage.createMany({
        data: [
          { ...base, invocationId: `u1-${suffix}`, userId, workspaceId: reportWorkspaceId, usageReported: true, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600, costBasis: 'unknown' },
          { ...base, invocationId: `u2-${suffix}`, userId, workspaceId: reportWorkspaceId, usageReported: true, inputTokens: 2000, outputTokens: 50, cacheReadTokens: 1400, costBasis: 'estimated', costUsd: new Prisma.Decimal('0.004') },
          { ...base, invocationId: `u3-${suffix}`, userId, workspaceId: reportWorkspaceId, status: 'failed', errorCode: 'LLM_RATE_LIMITED', costBasis: 'unknown' },
          { ...base, invocationId: `u4-${suffix}`, userId, workspaceId: otherWorkspaceId, surface: 'chat.title', usageReported: true, inputTokens: 80, outputTokens: 6, costBasis: 'unknown' },
          // Another user's call in the same workspace never appears in the caller's totals.
          { ...base, invocationId: `u5-${suffix}`, userId: otherUserId, workspaceId: reportWorkspaceId, usageReported: true, inputTokens: 999_999, outputTokens: 1, costBasis: 'unknown' },
        ],
      });
    });

    it('aggregates the caller\'s own invocations with explicit unknowns', async () => {
      const res = await http().get(`/api/usage/models?workspaceId=${reportWorkspaceId}&surface=chat.turn`).set('Authorization', `Bearer ${auth}`);
      expect(res.status).toBe(200);
      expect(res.body.totals).toMatchObject({
        calls: 3,
        callsWithUsage: 2,
        callsWithoutUsage: 1,
        inputTokens: 3000,
        outputTokens: 150,
        cacheReadTokens: 2000,
        cacheWriteTokens: null,
        cost: { knownUsd: 0.004, coverage: 'partial', byBasis: { provider_reported: 0, estimated: 1, unknown: 2 } },
      });
      expect(res.body.totals.cacheHitRate).toBeCloseTo(2000 / 3000, 5);
      expect(res.body.groups).toHaveLength(1);
    });

    it('reports a null known cost, never zero, when no cost is known', async () => {
      const res = await http().get(`/api/usage/models?workspaceId=${otherWorkspaceId}`).set('Authorization', `Bearer ${auth}`);
      expect(res.status).toBe(200);
      expect(res.body.totals.calls).toBe(1);
      expect(res.body.totals.cost).toEqual({ knownUsd: null, coverage: 'none', byBasis: { provider_reported: 0, estimated: 0, unknown: 1 } });
    });

    it('confines a workspace-bound PAT to its workspace', async () => {
      const token = generatePersonalAccessToken();
      await prisma.personalAccessToken.create({
        data: { userId, name: `meter-${suffix}`, tokenHash: hashPersonalAccessToken(token), tokenPrefix: token.slice(0, 15), scopes: ['read'], workspaceId: otherWorkspaceId },
      });
      const own = await http().get('/api/usage/models').set('Authorization', `Bearer ${token}`);
      expect(own.status).toBe(200);
      expect(own.body.workspaceId).toBe(otherWorkspaceId);
      expect(own.body.totals.calls).toBe(1);
      const foreign = await http().get(`/api/usage/models?workspaceId=${workspaceId}`).set('Authorization', `Bearer ${token}`);
      expect(foreign.status).toBe(403);
      expect(foreign.body.code).toBe('OWNERSHIP_REQUIRED');
    });

    it('adds unknown-cost coverage to the run summary without changing existing fields', async () => {
      const res = await http().get('/api/usage/summary').set('Authorization', `Bearer ${auth}`);
      expect(res.status).toBe(200);
      expect(typeof res.body.totalCostUsd).toBe('number');
      expect(res.body.costCoverage).toMatchObject({ unknownCostRuns: 0, coverage: 'none' });
      expect(res.body.daily[0]).toHaveProperty('unknownCostRuns', 0);
    });
  });
});
