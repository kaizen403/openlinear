/**
 * W15 prompt caching. A loopback provider simulates automatic prefix caching
 * (cached tokens = longest common prefix with any earlier request), so the
 * suite shows that consecutive rounds and turns send a byte-identical prefix
 * and that cache reads reach the usage ledger, where hit rate is measurable.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { OpenAICompatibleChatLLM, setChatLLMClientForTesting, type ChatLLMMessage } from '../lib/chat-llm';
import { CHAT_SYSTEM_PROMPT_CORE, buildChatScopePrompt } from '../lib/chat-prompts';
import { runChatTurn, type ChatChunk } from '../services/chat';
import { getOpenAIFunctionSpecs } from '../services/chat-tools';
import { historyWindowStart, repairToolGroups, stablePrefixHash, trimMessagesForOverflow } from '../services/chat-context';
import { summarizeModelUsage } from '../services/model-usage';
import {
  finishFrame,
  startFakeLLMProvider,
  textFrame,
  toolCallFrame,
  usageFrame,
  type FakeLLMProvider,
  type RecordedRequest,
} from './fake-llm-provider';

const suffix = randomUUID().slice(0, 8);

function render(request: RecordedRequest): string {
  const body = request.body as { tools?: unknown; messages?: unknown };
  return JSON.stringify({ tools: body.tools ?? null, messages: body.messages ?? [] });
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/** Provider stand-in with automatic prefix caching, at ~4 characters per token. */
function enablePrefixCache(provider: FakeLLMProvider, reply: (request: RecordedRequest, index: number) => Array<Record<string, unknown>>): void {
  const seen: string[] = [];
  provider.setFallback((request, index) => {
    const current = render(request);
    const cachedChars = seen.reduce((best, previous) => Math.max(best, commonPrefix(previous, current)), 0);
    seen.push(current);
    return {
      kind: 'sse',
      frames: [
        ...reply(request, index),
        usageFrame({
          prompt_tokens: Math.ceil(current.length / 4),
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: Math.floor(cachedChars / 4) },
        }),
      ],
    };
  });
}

function messagesOf(request: RecordedRequest | undefined): ChatLLMMessage[] {
  return ((request?.body as { messages?: ChatLLMMessage[] } | undefined)?.messages) ?? [];
}

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe('Home Chat prompt caching', () => {
  let provider: FakeLLMProvider;
  let userId = '';
  let workspaceId = '';

  beforeAll(async () => {
    provider = await startFakeLLMProvider();
    userId = (await prisma.user.create({ data: { githubId: `cache-${suffix}`, username: `cache${suffix}`, email: `cache-${suffix}@example.com` } })).id;
    workspaceId = (await prisma.workspace.create({ data: { name: `Cache ${suffix}`, slug: `cache-${suffix}` } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner', joinedAt: new Date() } });
  }, 30000);

  afterEach(() => {
    setChatLLMClientForTesting(null);
    provider.reset();
  });

  afterAll(async () => {
    await provider.close();
    await prisma.modelUsage.deleteMany({ where: { userId } });
    await prisma.chatSession.deleteMany({ where: { userId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }, 30000);

  it('sends a byte-identical, growing prefix across consecutive rounds and turns', async () => {
    const sessionId = (await prisma.chatSession.create({ data: { userId, workspaceId, title: 'Cache session' } })).id;
    enablePrefixCache(provider, (_request, index) => (index === 0
      ? [toolCallFrame(0, { id: 'call_ws', name: 'list_workspaces', arguments: '{}' }), finishFrame('tool_calls')]
      : [textFrame(index === 1 ? 'You have one workspace.' : 'Still one.'), finishFrame('stop')]));
    setChatLLMClientForTesting(new OpenAICompatibleChatLLM({ baseUrl: provider.baseUrl, apiKey: 'k', model: 'fake-model', env: {} }));

    await collect(runChatTurn({ sessionId, userId, userMessage: 'How many workspaces do I have?' }));
    await collect(runChatTurn({ sessionId, userId, userMessage: 'And now?' }));

    const [r0, r1, r2] = provider.requests;
    expect(provider.requests).toHaveLength(3);
    // Segment 1: the tool catalogue, frozen and identical.
    const toolsOf = (entry?: RecordedRequest) => JSON.stringify((entry?.body as { tools?: unknown } | undefined)?.tools);
    const tools = toolsOf(r0);
    expect(tools.length).toBeGreaterThan(1000);
    expect(toolsOf(r1)).toBe(tools);
    expect(toolsOf(r2)).toBe(tools);
    // Segment 2: the system message starts with the static core and ends with the scope.
    const system = messagesOf(r0)[0];
    expect(typeof system?.content === 'string' && system.content.startsWith(`${CHAT_SYSTEM_PROMPT_CORE}\n\n`)).toBe(true);
    // Each request extends the previous one: round 2 replays round 1, turn 2 replays turn 1.
    expect(messagesOf(r1).slice(0, messagesOf(r0).length)).toEqual(messagesOf(r0));
    expect(messagesOf(r2).slice(0, messagesOf(r1).length)).toEqual(messagesOf(r1));
    const prefixShare = (a?: RecordedRequest, b?: RecordedRequest) => (a && b ? commonPrefix(render(a), render(b)) / render(b).length : 0);
    expect(prefixShare(r0, r1)).toBeGreaterThan(0.9);
    expect(prefixShare(r1, r2)).toBeGreaterThan(0.9);

    // Cache reads reach the ledger, so hit rate is measurable per round.
    const rows = await prisma.modelUsage.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(3);
    expect(rows[0]?.cacheReadTokens).toBe(0);
    for (const row of rows.slice(1)) {
      expect(row.cacheReadTokens ?? 0).toBeGreaterThan(0.9 * (row.inputTokens ?? 1));
    }
    const summary = await summarizeModelUsage({ userId, since: new Date(Date.now() - 60_000), workspaceId });
    expect(summary.totals.cacheHitRate).toBeGreaterThan(0.6);
    console.info('[cache-fixture]', JSON.stringify({
      toolCatalogueChars: tools.length,
      staticCoreChars: CHAT_SYSTEM_PROMPT_CORE.length,
      approxStaticPrefixTokens: Math.round((tools.length + CHAT_SYSTEM_PROMPT_CORE.length) / 4),
      perRequest: rows.map((row) => ({ input: row.inputTokens, cacheRead: row.cacheReadTokens })),
      fixtureHitRate: summary.totals.cacheHitRate,
    }));
  });

  it('keeps the history window start fixed between turns of a long session (stepped window)', async () => {
    const sessionId = (await prisma.chatSession.create({ data: { userId, workspaceId, title: 'Long session' } })).id;
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < 59; i += 1) {
      await prisma.chatMessage.create({ data: { sessionId, role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}`, createdAt: new Date(base + i * 1000) } });
    }
    enablePrefixCache(provider, () => [textFrame('ok'), finishFrame('stop')]);
    setChatLLMClientForTesting(new OpenAICompatibleChatLLM({ baseUrl: provider.baseUrl, apiKey: 'k', model: 'fake-model', env: {} }));

    for (const text of ['turn one', 'turn two', 'turn three']) {
      await collect(runChatTurn({ sessionId, userId, userMessage: text }));
    }
    const firstHistory = provider.requests.map((request) => JSON.stringify(messagesOf(request)[1]));
    // 60 → 62 messages: the window starts at the same message (position 16)...
    expect(firstHistory[1]).toBe(firstHistory[0]);
    // ...and moves forward by one 16-message step only once 64 messages exist.
    expect(firstHistory[2]).not.toBe(firstHistory[1]);

    // Compare with the previous "newest 32 rows" window on the same rows.
    const rows = await prisma.chatMessage.findMany({ where: { sessionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const toMessages = (slice: typeof rows) => slice.map((row) => ({ role: row.role, content: row.content }));
    const sliding = [60, 62].map((total) => JSON.stringify(toMessages(rows.slice(total - 32, total))));
    const stepped = [60, 62].map((total) => JSON.stringify(toMessages(rows.slice(historyWindowStart(total), total))));
    const slidingShare = commonPrefix(sliding[0] ?? '', sliding[1] ?? '') / (sliding[1] ?? '').length;
    const steppedShare = commonPrefix(stepped[0] ?? '', stepped[1] ?? '') / (stepped[1] ?? '').length;
    expect(steppedShare).toBeGreaterThan(0.9);
    expect(slidingShare).toBeLessThan(0.05);
    console.info('[window-fixture]', JSON.stringify({ slidingHistoryPrefixShare: slidingShare, steppedHistoryPrefixShare: steppedShare }));
  });

  it('keeps volatile content out of the cached prefix', () => {
    expect(CHAT_SYSTEM_PROMPT_CORE).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(CHAT_SYSTEM_PROMPT_CORE).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(buildChatScopePrompt({ userId: 'u', workspaceId: 'w', now: new Date('2026-10-25T23:59:00Z') }))
      .toBe(buildChatScopePrompt({ userId: 'u', workspaceId: 'w', now: new Date('2026-10-25T00:00:01Z') }));
    expect(stablePrefixHash(getOpenAIFunctionSpecs())).toBe(stablePrefixHash(getOpenAIFunctionSpecs()));
  });

  it('steps the window start in 16-message increments with at least 32 messages', () => {
    expect([0, 10, 32, 33, 47, 48, 63, 64, 100].map(historyWindowStart)).toEqual([0, 0, 0, 0, 0, 16, 16, 32, 64]);
    for (let total = 32; total < 200; total += 1) {
      const size = total - historyWindowStart(total);
      expect(size).toBeGreaterThanOrEqual(32);
      expect(size).toBeLessThan(48);
    }
  });
});

describe('history repair and overflow trimming', () => {
  const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'list_projects', arguments: '{}' } });

  it('drops orphan results and unanswered calls so every group is valid', () => {
    const repaired = repairToolGroups([
      { role: 'tool', tool_call_id: 'orphan', content: '{}' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
      { role: 'tool', tool_call_id: 'a', content: '{}' },
      { role: 'tool', tool_call_id: 'a', content: 'duplicate' },
      { role: 'tool', tool_call_id: 'zzz', content: '{}' },
      { role: 'assistant', content: 'thinking', tool_calls: [call('c')] },
      { role: 'user', content: 'next' },
    ]);
    expect(repaired).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [call('a')] },
      { role: 'tool', tool_call_id: 'a', content: '{}' },
      { role: 'assistant', content: 'thinking' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('keeps the system message and the whole current turn when trimming', () => {
    const history: ChatLLMMessage[] = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `h${i}` }));
    const messages: ChatLLMMessage[] = [
      { role: 'system', content: 'S' },
      ...history,
      { role: 'user', content: 'now' },
      { role: 'assistant', content: null, tool_calls: [call('x')] },
      { role: 'tool', tool_call_id: 'x', content: JSON.stringify({ ok: true, code: 'OK', message: 'm', data: 'y'.repeat(10_000) }) },
    ];
    const { messages: trimmed, droppedMessages } = trimMessagesForOverflow(messages);
    expect(droppedMessages).toBe(12);
    expect(trimmed[0]).toEqual({ role: 'system', content: 'S' });
    expect(trimmed.slice(-3).map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(String(trimmed.at(-1)?.content).length).toBeLessThanOrEqual(4001);
  });
});
