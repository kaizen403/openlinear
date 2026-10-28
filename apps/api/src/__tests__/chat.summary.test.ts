/**
 * Summarizing compaction (optional, CHAT_HISTORY_SUMMARY=1): older turns that
 * left the stepped history window are summarised into a stored, audited
 * summary sent after the static prefix; the summary is reused until the
 * window steps, then extended incrementally. Fake model client only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import {
  ChatLLMError,
  setChatLLMClientForTesting,
  type ChatLLMClient,
  type ChatLLMCompletion,
  type ChatLLMEvent,
  type StreamChatCompletionInput,
} from '../lib/chat-llm';
import { runChatTurn, type ChatChunk } from '../services/chat';

const suffix = randomUUID().slice(0, 8);

class SummarizingClient implements ChatLLMClient {
  readonly model = 'test-chat-model';
  readonly provider = 'test';
  readonly turnRequests: StreamChatCompletionInput[] = [];
  readonly summaryRequests: StreamChatCompletionInput[] = [];
  failSummaries = false;

  async *streamChatCompletion(input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    this.turnRequests.push(input);
    yield { type: 'delta', content: `Answer ${this.turnRequests.length}` };
    yield { type: 'done', finishReason: 'stop' };
  }

  async completeChatCompletion(input: StreamChatCompletionInput & { json?: boolean }): Promise<ChatLLMCompletion> {
    this.summaryRequests.push(input);
    if (this.failSummaries) throw new ChatLLMError('LLM_PROVIDER_UNAVAILABLE', 'down', 503, { kind: 'unavailable', attempts: 1 });
    return {
      content: `SUMMARY-${this.summaryRequests.length}`,
      finishReason: 'stop',
      usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, providerCostUsd: null, raw: {} },
      attempt: 1,
      latencyMs: 5,
      failures: [],
      model: this.model,
    };
  }
}

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function userContent(input: StreamChatCompletionInput | undefined): string {
  const message = input?.messages.find((candidate) => candidate.role === 'user');
  return typeof message?.content === 'string' ? message.content : '';
}

describe('Chat summarizing compaction', () => {
  let userId = '';
  let workspaceId = '';

  async function seededSession(count: number): Promise<string> {
    const session = await prisma.chatSession.create({ data: { userId, workspaceId, title: 'Summary session' } });
    const base = Date.now() - 86_400_000;
    await prisma.chatMessage.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        sessionId: session.id,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Seed message ${index + 1}`,
        createdAt: new Date(base + index * 1000),
      })),
    });
    return session.id;
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { githubId: `chat-summary-${suffix}`, username: `chatsummary${suffix}`, email: `chatsummary-${suffix}@example.com` },
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({ data: { name: `Summary ${suffix}`, slug: `summary-${suffix}` } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner', joinedAt: new Date() } });
  });

  afterEach(() => {
    setChatLLMClientForTesting(null);
    delete process.env.CHAT_HISTORY_SUMMARY;
  });

  afterAll(async () => {
    await prisma.chatSession.deleteMany({ where: { userId } });
    await prisma.modelUsage.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it('is off by default: no summary call, one system message', async () => {
    const sessionId = await seededSession(47);
    const client = new SummarizingClient();
    setChatLLMClientForTesting(client);
    await collect(runChatTurn({ sessionId, userId, userMessage: 'hello' }));
    expect(client.summaryRequests).toHaveLength(0);
    expect(client.turnRequests[0]?.messages.filter((message) => message.role === 'system')).toHaveLength(1);
    await expect(prisma.chatSessionSummary.count({ where: { sessionId } })).resolves.toBe(0);
  });

  it('summarises the rows before the window, reuses the summary until the window steps, then extends it', async () => {
    process.env.CHAT_HISTORY_SUMMARY = '1';
    const sessionId = await seededSession(47);
    const client = new SummarizingClient();
    setChatLLMClientForTesting(client);

    // 47 seeded + this user message = 48 rows → window starts at 16.
    const first = await collect(runChatTurn({ sessionId, userId, userMessage: 'turn A' }));
    expect(first.at(-1)?.type).toBe('done');
    expect(client.summaryRequests).toHaveLength(1);
    const summaryInput = userContent(client.summaryRequests[0]);
    expect(summaryInput).toContain('Previous summary: none.');
    expect(summaryInput).toContain('messages 1–16');
    expect(summaryInput).toContain('Seed message 1\n');
    expect(summaryInput).toContain('Seed message 16');
    expect(summaryInput).not.toContain('Seed message 17');
    expect(summaryInput).toContain('<untrusted source="chat-history" kind="transcript">');

    const requestA = client.turnRequests[0];
    if (!requestA) throw new Error('expected a turn request');
    expect(requestA.messages[0]?.role).toBe('system');
    expect(requestA.messages[1]).toMatchObject({ role: 'system' });
    expect(String(requestA.messages[1]?.content)).toContain('<untrusted source="chat-summary" kind="summary">\nSUMMARY-1\n</untrusted>');
    // The window follows the summary and starts at the 17th row.
    expect(requestA.messages[2]).toMatchObject({ role: 'user', content: 'Seed message 17' });

    const stored = await prisma.chatSessionSummary.findFirstOrThrow({ where: { sessionId } });
    expect(stored).toMatchObject({ coveredMessages: 16, status: 'succeeded', content: 'SUMMARY-1', sourceMessages: 16, previousSummaryId: null, provider: 'test', model: 'test-chat-model' });
    expect(stored.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    const ledger = await prisma.modelUsage.findFirstOrThrow({ where: { invocationId: stored.invocationId ?? '' } });
    expect(ledger).toMatchObject({ surface: 'chat.summary', sessionId, status: 'succeeded', inputTokens: 500, outputTokens: 40 });

    // Next turn: 50 rows, window still starts at 16 → same summary, byte-identical prefix.
    await collect(runChatTurn({ sessionId, userId, userMessage: 'turn B' }));
    expect(client.summaryRequests).toHaveLength(1);
    const requestB = client.turnRequests[1];
    expect(JSON.stringify(requestB?.messages.slice(0, 3))).toBe(JSON.stringify(requestA.messages.slice(0, 3)));

    // Grow to 63 rows; the next user message makes 64 → window starts at 32.
    const now = Date.now();
    await prisma.chatMessage.createMany({
      data: Array.from({ length: 12 }, (_, index) => ({
        sessionId,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Later message ${index + 1}`,
        createdAt: new Date(now + index + 1),
      })),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await collect(runChatTurn({ sessionId, userId, userMessage: 'turn C' }));
    expect(client.summaryRequests).toHaveLength(2);
    const incremental = userContent(client.summaryRequests[1]);
    expect(incremental).toContain('Previous summary (messages 1–16):\nSUMMARY-1');
    expect(incremental).toContain('messages 17–32');
    expect(incremental).toContain('Seed message 17');
    expect(incremental).toContain('Seed message 32');
    expect(incremental).not.toContain('Seed message 16\n');
    expect(incremental).not.toContain('Seed message 33');
    const second = await prisma.chatSessionSummary.findFirstOrThrow({ where: { sessionId, coveredMessages: 32 } });
    expect(second).toMatchObject({ status: 'succeeded', content: 'SUMMARY-2', previousSummaryId: stored.id, sourceMessages: 16 });
    expect(String(client.turnRequests[2]?.messages[1]?.content)).toContain('SUMMARY-2');
  });

  it('records a failed summary attempt and still answers (with the previous summary, if any)', async () => {
    process.env.CHAT_HISTORY_SUMMARY = '1';
    const sessionId = await seededSession(47);
    const client = new SummarizingClient();
    client.failSummaries = true;
    setChatLLMClientForTesting(client);
    const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'turn' }));
    expect(chunks.at(-1)?.type).toBe('done');
    const failed = await prisma.chatSessionSummary.findFirstOrThrow({ where: { sessionId } });
    expect(failed).toMatchObject({ status: 'failed', content: null, errorCode: 'LLM_PROVIDER_UNAVAILABLE', coveredMessages: 16 });
    // No summary to send: just the system message and the window.
    expect(client.turnRequests[0]?.messages.filter((message) => message.role === 'system')).toHaveLength(1);
    const ledger = await prisma.modelUsage.findMany({ where: { sessionId, surface: 'chat.summary' } });
    expect(ledger.map((row) => row.status)).toEqual(['failed']);
  });
});
