/**
 * Regression cases for the Home Chat audit findings (W15 / W18a).
 *
 * Every case here uses only APIs that existed before the fix, so the file can
 * be run against the previous code to show each failure. Behaviour of the new
 * contracts (confirmation tokens, metering rows, cache hints) is covered in
 * the dedicated suites.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import {
  OpenAICompatibleChatLLM,
  setChatLLMClientForTesting,
  type ChatLLMClient,
  type ChatLLMEvent,
  type StreamChatCompletionInput,
} from '../lib/chat-llm';
import { runChatTurn, type ChatChunk } from '../services/chat';
import { dispatchTool } from '../services/chat-tools';
import type { ToolContext } from '../services/chat-tools/types';
import {
  finishFrame,
  startFakeLLMProvider,
  textFrame,
  textStream,
  usageFrame,
  type FakeLLMProvider,
} from './fake-llm-provider';

class ScriptedClient implements ChatLLMClient {
  readonly model = 'test-chat-model';
  private index = 0;

  constructor(private readonly scripts: ChatLLMEvent[][]) {}

  async *streamChatCompletion(_input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    const events = this.scripts[this.index] ?? [];
    this.index += 1;
    for (const event of events) yield event;
  }
}

const suffix = randomUUID().slice(0, 8);

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe('Home Chat regressions', () => {
  let userId = '';
  let workspaceId = '';
  let projectId = '';
  let teamId = '';
  let provider: FakeLLMProvider;

  async function newSession(): Promise<string> {
    // A non-default title skips auto-titling, so no extra model call consumes a script.
    const session = await prisma.chatSession.create({ data: { userId, workspaceId, projectId, title: 'Regression session' } });
    return session.id;
  }

  function ctx(sessionId: string, toolCallId: string): ToolContext {
    return { userId, workspaceId, sessionId, projectId, toolCallId };
  }

  async function seedIssues(count: number, status: 'todo' | 'in_progress' = 'todo'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const number = Math.floor(Math.random() * 1_000_000_000);
      const task = await prisma.task.create({
        data: { title: `Regression issue ${i}`, identifier: `REG-${number}`, number, status, projectId, teamId, workspaceId },
      });
      ids.push(task.id);
    }
    return ids;
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { githubId: `chat-reg-${suffix}`, username: `chatreg${suffix}`, email: `chatreg-${suffix}@example.com` },
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({ data: { name: `Regression ${suffix}`, slug: `regression-${suffix}` } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner', joinedAt: new Date() } });
    const project = await prisma.project.create({ data: { workspaceId, name: `Regression project ${suffix}`, key: 'REG' } });
    projectId = project.id;
    const team = await prisma.team.create({ data: { name: 'Regression team', key: `RG${suffix.slice(0, 3)}`, projectId } });
    teamId = team.id;
    await prisma.teamMember.create({ data: { teamId, userId, role: 'owner' } });
    await prisma.projectAccess.create({ data: { projectId, userId, permission: 'full' } });
    provider = await startFakeLLMProvider();
  }, 30000);

  afterEach(() => {
    setChatLLMClientForTesting(null);
    provider.reset();
  });

  afterAll(async () => {
    setChatLLMClientForTesting(null);
    await provider.close();
    await prisma.chatSession.deleteMany({ where: { userId } });
    await prisma.task.deleteMany({ where: { projectId } });
    await prisma.teamMember.deleteMany({ where: { teamId } });
    await prisma.team.deleteMany({ where: { id: teamId } });
    await prisma.projectAccess.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }, 30000);

  it('does not replay a previous turn\'s tool result when the provider reuses a tool-call id', async () => {
    const sessionId = await newSession();
    const titleA = `Replay A ${suffix}`;
    const titleB = `Replay B ${suffix}`;
    setChatLLMClientForTesting(new ScriptedClient([
      [
        { type: 'tool_call_delta', index: 0, id: 'functions.create_issue:0', name: 'create_issue', argumentsDelta: JSON.stringify({ title: titleA, projectId }) },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [{ type: 'delta', content: 'Created A.' }, { type: 'done', finishReason: 'stop' }],
      [
        // Same provider id in a later turn, different arguments.
        { type: 'tool_call_delta', index: 0, id: 'functions.create_issue:0', name: 'create_issue', argumentsDelta: JSON.stringify({ title: titleB, projectId }) },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [{ type: 'delta', content: 'Created B.' }, { type: 'done', finishReason: 'stop' }],
    ]));

    await collect(runChatTurn({ sessionId, userId, userMessage: 'Create issue A' }));
    const second = await collect(runChatTurn({ sessionId, userId, userMessage: 'Create issue B' }));

    await expect(prisma.task.count({ where: { projectId, title: titleA } })).resolves.toBe(1);
    // Before the fix the second call was answered from the first call's cached result.
    await expect(prisma.task.count({ where: { projectId, title: titleB } })).resolves.toBe(1);
    const result = second.find((chunk) => chunk.type === 'tool_result');
    expect(result && result.type === 'tool_result' ? JSON.stringify(result.result) : '').toContain(titleB);
  });

  it('never lets bulk_update_issues without issueIds rewrite the whole project', async () => {
    const sessionId = await newSession();
    const ids = await seedIssues(3);
    const result = await dispatchTool('bulk_update_issues', ctx(sessionId, `bulk-no-ids-${suffix}`), { projectId, status: 'done' });

    expect(result.ok).toBe(false);
    await expect(prisma.task.count({ where: { id: { in: ids }, status: 'done' } })).resolves.toBe(0);
  });

  it('never treats an empty or malformed issueIds list as "all issues"', async () => {
    const sessionId = await newSession();
    const ids = await seedIssues(2);

    const empty = await dispatchTool('bulk_update_issues', ctx(sessionId, `bulk-empty-${suffix}`), { projectId, status: 'cancelled', issueIds: [] });
    const malformed = await dispatchTool('bulk_update_issues', ctx(sessionId, `bulk-malformed-${suffix}`), { projectId, status: 'cancelled', issueIds: [42, true] });

    expect(empty.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    await expect(prisma.task.count({ where: { id: { in: ids }, status: 'cancelled' } })).resolves.toBe(0);
  });

  it('asks the provider to include usage on streams and reports usage sent after finish_reason', async () => {
    provider.enqueue({
      kind: 'sse',
      frames: [
        textFrame('Hi'),
        finishFrame('stop'),
        usageFrame({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }),
      ],
    });
    const client = new OpenAICompatibleChatLLM({ baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'fake-model' });
    const events: ChatLLMEvent[] = [];
    for await (const event of client.streamChatCompletion({ messages: [{ role: 'user', content: 'hello' }] })) events.push(event);

    const body = provider.requests.at(-1)?.body as Record<string, unknown>;
    expect(body.stream_options).toEqual({ include_usage: true });
    const done = events.filter((event) => event.type === 'done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: 'done', finishReason: 'stop', inputTokens: 12, outputTokens: 3 });
  });

  it('retries a rate-limited request instead of failing the turn', async () => {
    provider.enqueue(
      { kind: 'json', status: 429, body: { error: { message: 'rate limited' } }, headers: { 'retry-after': '0' } },
      textStream('Recovered'),
    );
    const before = provider.requests.length;
    const client = new OpenAICompatibleChatLLM({ baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'fake-model' });
    let text = '';
    for await (const event of client.streamChatCompletion({ messages: [{ role: 'user', content: 'hello' }] })) {
      if (event.type === 'delta') text += event.content;
    }
    expect(text).toBe('Recovered');
    expect(provider.requests.length - before).toBe(2);
  });

  it('trims the history and retries once when the provider reports a context overflow', async () => {
    const sessionId = await newSession();
    for (let i = 0; i < 12; i += 1) {
      await prisma.chatMessage.create({ data: { sessionId, role: i % 2 === 0 ? 'user' : 'assistant', content: `history ${i}`, createdAt: new Date(Date.now() - (60 - i) * 1000) } });
    }
    provider.enqueue(
      { kind: 'json', status: 400, body: { error: { message: 'The prompt is too long: 140000, model maximum context length: 131072' } } },
      textStream('Answer after trimming'),
    );
    setChatLLMClientForTesting(new OpenAICompatibleChatLLM({ baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'fake-model' }));

    const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'Summarise' }));

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    const final = chunks.find((chunk) => chunk.type === 'assistant_final');
    expect(final && final.type === 'assistant_final' ? final.content : '').toBe('Answer after trimming');
    const [overflowed, retried] = provider.requests.slice(-2);
    const sizeOf = (request: typeof overflowed) => (Array.isArray((request.body as { messages?: unknown[] }).messages) ? (request.body as { messages: unknown[] }).messages.length : 0);
    expect(sizeOf(retried)).toBeLessThan(sizeOf(overflowed));
  });
});
