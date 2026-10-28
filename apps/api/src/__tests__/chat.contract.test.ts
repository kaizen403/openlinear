/**
 * Round-7 Home Chat stream/history contract (chatui gaps):
 *  - tool events carry the tool's effect class and the announcing message id;
 *  - an interrupted write's real outcome is streamed (`tool_reconciled`),
 *    published durably (`chat:tool:reconciled`) and visible in history;
 *  - partial replies saved after an error are marked incomplete, with the
 *    error code and the turn's usage; failed turns leave an empty marker that
 *    is never replayed to the model;
 *  - stored rows carry usage, and GET /sessions/:id returns ledger totals;
 *  - Dismiss revokes a confirmation code server-side.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import {
  ChatLLMError,
  setChatLLMClientForTesting,
  type ChatLLMClient,
  type ChatLLMEvent,
  type ChatLLMUsage,
  type StreamChatCompletionInput,
} from '../lib/chat-llm';
import { runChatTurn, type ChatChunk } from '../services/chat';
import { useTestServer } from './http';
import { testJwtSecret } from './test-env';

const suffix = randomUUID().slice(0, 8);

type Script = (call: number, input: StreamChatCompletionInput) => AsyncIterable<ChatLLMEvent> | ChatLLMEvent[];

class ScriptedClient implements ChatLLMClient {
  readonly model = 'test-chat-model';
  readonly provider = 'test';
  calls = 0;
  readonly requests: StreamChatCompletionInput[] = [];

  constructor(private readonly script: Script) {}

  async *streamChatCompletion(input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    this.requests.push(input);
    const events = this.script(this.calls, input);
    this.calls += 1;
    for await (const event of events) yield event;
  }
}

function usage(input = 40, output = 10): ChatLLMUsage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, providerCostUsd: null, raw: {} };
}

const say = (text: string): ChatLLMEvent[] => [{ type: 'delta', content: text }, { type: 'done', finishReason: 'stop', usage: usage() }];

const callTool = (id: string, name: string, args: Record<string, unknown>): ChatLLMEvent[] => [
  { type: 'tool_call_delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'done', finishReason: 'tool_calls', usage: usage() },
];

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function parseSse(text: string): ChatChunk[] {
  return text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)) as ChatChunk);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not reached in time');
}

describe('Chat stream and history contract (round 7)', () => {
  const http = useTestServer(() => createApp());
  let userId = '';
  let auth = '';
  let otherAuth = '';
  let otherUserId = '';
  let workspaceId = '';
  let projectId = '';
  let teamId = '';

  async function newSession(): Promise<string> {
    return (await prisma.chatSession.create({ data: { userId, workspaceId, projectId, title: 'Contract session' } })).id;
  }

  async function seedIssues(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const number = Math.floor(Math.random() * 1_000_000_000);
      const task = await prisma.task.create({
        data: { title: `Contract issue ${i}`, identifier: `CON-${number}`, number, status: 'todo', projectId, teamId, workspaceId },
      });
      ids.push(task.id);
    }
    return ids;
  }

  const getSession = (sessionId: string, token = auth) => http().get(`/api/chat/sessions/${sessionId}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { githubId: `chat-contract-${suffix}`, username: `chatcontract${suffix}`, email: `chatcontract-${suffix}@example.com` },
    });
    userId = user.id;
    auth = jwt.sign({ userId, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
    const other = await prisma.user.create({
      data: { githubId: `chat-contract-o-${suffix}`, username: `chatcontracto${suffix}`, email: `chatcontract-o-${suffix}@example.com` },
    });
    otherUserId = other.id;
    otherAuth = jwt.sign({ userId: other.id, username: other.username }, testJwtSecret(), { expiresIn: '1h' });
    const workspace = await prisma.workspace.create({ data: { name: `Contract ${suffix}`, slug: `contract-${suffix}` } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId, role: 'owner', joinedAt: new Date() },
        { workspaceId, userId: otherUserId, role: 'member', joinedAt: new Date() },
      ],
    });
    const project = await prisma.project.create({ data: { workspaceId, name: `Contract project ${suffix}`, key: 'CON' } });
    projectId = project.id;
    const team = await prisma.team.create({ data: { name: 'Contract team', key: `CN${suffix.slice(0, 3)}`, projectId } });
    teamId = team.id;
    await prisma.teamMember.create({ data: { teamId, userId, role: 'owner' } });
    await prisma.projectAccess.create({ data: { projectId, userId, permission: 'full' } });
  });

  afterEach(async () => {
    setChatLLMClientForTesting(null);
    delete process.env.CHAT_TOOL_TIMEOUT_MS;
    await prisma.task.deleteMany({ where: { projectId } });
  });

  afterAll(async () => {
    await prisma.chatSession.deleteMany({ where: { userId } });
    await prisma.modelUsage.deleteMany({ where: { workspaceId } });
    await prisma.domainEventOutbox.deleteMany({ where: { userIds: { has: userId } } });
    await prisma.domainEvent.deleteMany({ where: { userIds: { has: userId } } });
    await prisma.task.deleteMany({ where: { projectId } });
    await prisma.teamMember.deleteMany({ where: { teamId } });
    await prisma.team.deleteMany({ where: { id: teamId } });
    await prisma.projectAccess.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it('sends the effect class and the announcing message id on tool events (null for an unknown tool)', async () => {
    const sessionId = await newSession();
    setChatLLMClientForTesting(new ScriptedClient((call) => {
      if (call === 0) {
        return [
          { type: 'tool_call_delta', index: 0, id: 'call_read', name: 'list_workspaces', argumentsDelta: '{}' },
          { type: 'tool_call_delta', index: 1, id: 'call_made_up', name: 'teleport_issue', argumentsDelta: '{}' },
          { type: 'done', finishReason: 'tool_calls', usage: usage() },
        ];
      }
      return say('Done.');
    }));
    const res = await http().post(`/api/chat/sessions/${sessionId}/messages`).set('Authorization', `Bearer ${auth}`).send({ content: 'list' });
    const chunks = parseSse(res.text);
    const starts = chunks.filter((chunk) => chunk.type === 'tool_call_start');
    const results = chunks.filter((chunk) => chunk.type === 'tool_result');
    const assistantRows = await prisma.chatMessage.findMany({ where: { sessionId, role: 'assistant' }, orderBy: { createdAt: 'asc' } });
    const announcing = assistantRows.find((row) => Array.isArray(row.toolCalls));
    if (!announcing) throw new Error('expected an assistant row with tool calls');
    expect(starts).toEqual([
      expect.objectContaining({ toolCallId: 'call_read', toolName: 'list_workspaces', effect: 'read', messageId: announcing.id }),
      expect.objectContaining({ toolCallId: 'call_made_up', toolName: 'teleport_issue', effect: null, messageId: announcing.id }),
    ]);
    expect(results.map((chunk) => (chunk.type === 'tool_result' ? [chunk.effect, chunk.messageId] : null))).toEqual([['read', announcing.id], [null, announcing.id]]);
    const userMessage = chunks.find((chunk) => chunk.type === 'user_message');
    expect(userMessage && userMessage.type === 'user_message' ? userMessage.turnId : '').toMatch(/^[0-9a-f-]{36}$/);

    // History: journal states per call, and the turn's usage on its last row.
    const history = await getSession(sessionId);
    const withCalls = history.body.messages.find((message: { id: string }) => message.id === announcing.id);
    expect(withCalls.toolCallStates).toEqual([
      expect.objectContaining({ toolCallId: 'call_read', toolName: 'list_workspaces', effect: 'read', status: 'succeeded', code: 'OK', reconciled: false }),
    ]);
    const final = history.body.messages.at(-1);
    expect(final).toMatchObject({ role: 'assistant', content: 'Done.', incomplete: false, finishReason: 'stop', errorCode: null });
    expect(final.usage).toMatchObject({ modelCalls: 2, inputTokens: 80, outputTokens: 20, totalTokens: 100, costUsd: null, costBasis: 'unknown' });
    // Session totals come from the ledger (every chat call of the session).
    expect(history.body.usage).toMatchObject({ calls: 2, inputTokens: 80, outputTokens: 20 });
    expect(history.body.activeTurn).toBeNull();
    expect(history.body.confirmations).toEqual([]);
  });

  it('marks a partial reply saved after an error as incomplete, with the code and the usage so far', async () => {
    const sessionId = await newSession();
    setChatLLMClientForTesting(new ScriptedClient(async function* (call) {
      if (call === 0) {
        yield* callTool('call_ws', 'list_workspaces', {});
        return;
      }
      yield { type: 'delta', content: 'Half an ans' };
      throw new ChatLLMError('LLM_STREAM_ERROR', 'The provider stream failed', 502, { kind: 'stream' });
    }));
    const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'explain' }));
    expect(chunks.at(-1)).toMatchObject({ type: 'error', code: 'LLM_STREAM_ERROR' });
    const history = await getSession(sessionId);
    const last = history.body.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: 'Half an ans', incomplete: true, errorCode: 'LLM_STREAM_ERROR' });
    expect(last.usage).toMatchObject({ modelCalls: 2, coverage: 'partial' });
    // Rows of one turn share its id.
    const turnIds = new Set(history.body.messages.map((message: { turnId: string }) => message.turnId));
    expect(turnIds.size).toBe(1);
  });

  it('leaves an empty incomplete marker for a turn that failed before any output, and never replays it', async () => {
    const sessionId = await newSession();
    const client = new ScriptedClient((call) => {
      if (call === 0) throw new ChatLLMError('LLM_PROVIDER_UNAVAILABLE', 'down', 503, { kind: 'unavailable' });
      return say('Back now.');
    });
    setChatLLMClientForTesting(client);
    const failed = await collect(runChatTurn({ sessionId, userId, userMessage: 'first try' }));
    expect(failed.at(-1)).toMatchObject({ type: 'error', code: 'LLM_PROVIDER_UNAVAILABLE' });
    const marker = await prisma.chatMessage.findFirstOrThrow({ where: { sessionId, role: 'assistant' } });
    expect(marker).toMatchObject({ content: null, incomplete: true, errorCode: 'LLM_PROVIDER_UNAVAILABLE' });

    await collect(runChatTurn({ sessionId, userId, userMessage: 'second try' }));
    const replayed = client.requests[1]?.messages.map((message) => message.role);
    expect(replayed).toEqual(['system', 'user', 'user']);
  });

  it('marks a reply the user stopped as incomplete with CLIENT_ABORTED', async () => {
    const sessionId = await newSession();
    const controller = new AbortController();
    setChatLLMClientForTesting(new ScriptedClient(async function* (_call, input) {
      yield { type: 'delta', content: 'Starting to' };
      await new Promise<void>((_resolve, reject) => {
        input.abortSignal?.addEventListener('abort', () => reject(new ChatLLMError('CLIENT_ABORTED', 'aborted', 499, { kind: 'aborted' })), { once: true });
        setTimeout(() => controller.abort(), 20);
      });
    }));
    const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'long one', abortSignal: controller.signal }));
    expect(chunks.at(-1)).toMatchObject({ type: 'error', code: 'CLIENT_ABORTED' });
    const last = await prisma.chatMessage.findFirstOrThrow({ where: { sessionId, role: 'assistant' } });
    expect(last).toMatchObject({ content: 'Starting to', incomplete: true, errorCode: 'CLIENT_ABORTED' });
  });

  it('streams tool_reconciled when an interrupted write settles, publishes it durably and shows it in history', async () => {
    process.env.CHAT_TOOL_TIMEOUT_MS = '300';
    const sessionId = await newSession();
    const title = `Reconciled ${suffix}`;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Hold the team row: issue numbering (and so the write) blocks past the tool timeout.
    const lock = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId} FOR UPDATE`;
      locked();
      await released;
    }, { timeout: 20_000 });
    await lockHeld;

    setChatLLMClientForTesting(new ScriptedClient(async function* (call) {
      if (call === 0) {
        yield* callTool('call_create', 'create_issue', { title });
        return;
      }
      // The write timed out (outcome unknown); let it commit, then answer.
      release();
      await lock;
      await waitFor(async () => (await prisma.chatToolCall.findFirst({ where: { sessionId, providerToolCallId: 'call_create', status: 'succeeded' } })) !== null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield* say('I tried to create it.');
    }));

    const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'create it' }));
    const result = chunks.find((chunk) => chunk.type === 'tool_result');
    expect(result).toMatchObject({ toolCallId: 'call_create', effect: 'write', result: { code: 'TOOL_OUTCOME_UNKNOWN' } });
    const reconciled = chunks.find((chunk) => chunk.type === 'tool_reconciled');
    expect(reconciled).toMatchObject({
      type: 'tool_reconciled',
      toolCallId: 'call_create',
      toolName: 'create_issue',
      effect: 'write',
      status: 'succeeded',
      reconciledAfter: 'TOOL_TIMEOUT',
      result: { ok: true, code: 'OK' },
    });
    const types = chunks.map((chunk) => chunk.type);
    expect(types.indexOf('tool_reconciled')).toBeLessThan(types.indexOf('done'));
    if (reconciled?.type === 'tool_reconciled' && result?.type === 'tool_result') expect(reconciled.messageId).toBe(result.messageId);
    await expect(prisma.task.count({ where: { projectId, title } })).resolves.toBe(1);

    // Durable, user-targeted event (outbox, or already sequenced).
    const outbox = await prisma.domainEventOutbox.count({ where: { type: 'chat:tool:reconciled', userIds: { has: userId } } });
    const sequenced = await prisma.domainEvent.count({ where: { type: 'chat:tool:reconciled', userIds: { has: userId } } });
    expect(outbox + sequenced).toBeGreaterThanOrEqual(1);

    // History: the stored tool row keeps what the model saw; the journal state says what happened.
    const history = await getSession(sessionId);
    const toolRow = history.body.messages.find((message: { role: string }) => message.role === 'tool');
    expect(JSON.parse(toolRow.content).code).toBe('TOOL_OUTCOME_UNKNOWN');
    const announcing = history.body.messages.find((message: { toolCallStates?: unknown[] }) => Array.isArray(message.toolCallStates));
    expect(announcing.toolCallStates).toEqual([
      expect.objectContaining({ toolCallId: 'call_create', effect: 'write', status: 'succeeded', reconciled: true, reconciledAfter: 'TOOL_TIMEOUT', result: expect.objectContaining({ ok: true }) }),
    ]);
  });

  describe('confirmation revoke (Dismiss)', () => {
    async function previewCode(sessionId: string): Promise<string> {
      setChatLLMClientForTesting(new ScriptedClient((call) => (call === 0
        ? callTool('call_preview', 'bulk_update_issues', { status: 'done' })
        : say('Reply with the code to confirm.'))));
      const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'close everything' }));
      const confirmation = chunks.find((chunk) => chunk.type === 'confirmation_required');
      if (confirmation?.type !== 'confirmation_required') throw new Error('expected a confirmation');
      return confirmation.code;
    }

    async function redeem(sessionId: string, code: string): Promise<ChatChunk[]> {
      setChatLLMClientForTesting(new ScriptedClient((call) => (call === 0
        ? callTool('call_redeem', 'bulk_update_issues', { status: 'done', confirmationToken: code })
        : say('Done.'))));
      return collect(runChatTurn({ sessionId, userId, userMessage: `Confirm ${code}`, confirmationTokens: [code] }));
    }

    const revoke = (sessionId: string, code: string, token = auth) =>
      http().post(`/api/chat/sessions/${sessionId}/confirmations/revoke`).set('Authorization', `Bearer ${token}`).send({ code });

    it('revokes a dismissed code so it can never be redeemed, idempotently', async () => {
      const sessionId = await newSession();
      const ids = await seedIssues(2);
      const code = await previewCode(sessionId);

      const first = await revoke(sessionId, code.toLowerCase());
      expect(first.status).toBe(200);
      expect(first.body.confirmation).toMatchObject({ state: 'revoked', toolName: 'bulk_update_issues' });
      expect((await revoke(sessionId, code)).body.confirmation.state).toBe('revoked');

      const history = await getSession(sessionId);
      expect(history.body.confirmations).toEqual([expect.objectContaining({ state: 'revoked', revokedAt: expect.any(String) })]);

      const chunks = await redeem(sessionId, code);
      const result = chunks.find((chunk) => chunk.type === 'tool_result');
      expect(result && result.type === 'tool_result' ? result.result.code : '').toBe('CONFIRMATION_REVOKED');
      const statuses = (await prisma.task.findMany({ where: { id: { in: ids } } })).map((task) => task.status);
      expect(statuses).toEqual(['todo', 'todo']);
    });

    it('refuses to revoke a code that already ran (409), an unknown code (404) and another user\'s session (404)', async () => {
      const sessionId = await newSession();
      await seedIssues(1);
      const code = await previewCode(sessionId);
      const redeemed = await redeem(sessionId, code);
      const result = redeemed.find((chunk) => chunk.type === 'tool_result');
      expect(result && result.type === 'tool_result' ? result.result.ok : false).toBe(true);

      const used = await revoke(sessionId, code);
      expect(used.status).toBe(409);
      expect(used.body.code).toBe('CONFIRMATION_USED');
      expect(used.body.details.confirmation.state).toBe('used');

      const unknown = await revoke(sessionId, 'CONFIRM-00000000');
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('CONFIRMATION_INVALID');

      expect((await revoke(sessionId, code, otherAuth)).status).toBe(404);
      expect((await revoke(sessionId, 'not-a-code')).status).toBe(400);
    });
  });
});
