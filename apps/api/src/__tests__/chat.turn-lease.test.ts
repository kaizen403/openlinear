/**
 * W18a durable single writer per chat session: a Postgres lease with expiry
 * and a fencing token. Concurrent turns on one session cannot interleave
 * (409 TURN_IN_PROGRESS for the losers); an expired lease can be taken over,
 * and the turn that lost it can no longer write its transcript.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import {
  setChatLLMClientForTesting,
  type ChatLLMClient,
  type ChatLLMEvent,
  type StreamChatCompletionInput,
} from '../lib/chat-llm';
import { runChatTurn, type ChatChunk } from '../services/chat';
import { acquireTurnLease, activeTurnLease, isTurnLeaseLostError } from '../services/chat-turn-lease';
import { useTestServer } from './http';
import { testJwtSecret } from './test-env';

const suffix = randomUUID().slice(0, 8);

/** A model double that holds its reply until the test releases it (or the turn aborts). */
class GatedClient implements ChatLLMClient {
  readonly model = 'test-chat-model';
  readonly provider = 'test';
  calls = 0;
  private release: () => void = () => undefined;
  private gate: Promise<void>;
  private enteredResolve: () => void = () => undefined;
  readonly entered: Promise<void>;

  constructor(private readonly reply = 'Done.') {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
    this.entered = new Promise((resolve) => {
      this.enteredResolve = resolve;
    });
  }

  open(): void {
    this.release();
  }

  async *streamChatCompletion(input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    this.calls += 1;
    this.enteredResolve();
    const aborted = new Promise<never>((_resolve, reject) => {
      if (input.abortSignal?.aborted) reject(new Error('aborted'));
      input.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await Promise.race([this.gate, aborted]);
    yield { type: 'delta', content: this.reply };
    yield { type: 'done', finishReason: 'stop' };
  }
}

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not reached in time');
}

describe('Chat turn lease (W18a single writer)', () => {
  const http = useTestServer(() => createApp());
  let userId = '';
  let workspaceId = '';
  let auth = '';

  async function newSession(): Promise<string> {
    return (await prisma.chatSession.create({ data: { userId, workspaceId, title: 'Lease session' } })).id;
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { githubId: `chat-lease-${suffix}`, username: `chatlease${suffix}`, email: `chatlease-${suffix}@example.com` },
    });
    userId = user.id;
    auth = jwt.sign({ userId, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
    const workspace = await prisma.workspace.create({ data: { name: `Lease ${suffix}`, slug: `lease-${suffix}` } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner', joinedAt: new Date() } });
  });

  afterEach(() => {
    setChatLLMClientForTesting(null);
    delete process.env.CHAT_TURN_LEASE_TTL_MS;
  });

  afterAll(async () => {
    await prisma.chatSession.deleteMany({ where: { userId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it('lets exactly one of several concurrent HTTP turns on a session run; the others get 409 TURN_IN_PROGRESS', async () => {
    const sessionId = await newSession();
    const client = new GatedClient('Only one of us.');
    setChatLLMClientForTesting(client);
    const send = (content: string) => http()
      .post(`/api/chat/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ content });

    const first = send('first');
    // Wait until the winner holds the lease and is inside the model call.
    const firstDone = first.then((res) => res);
    await client.entered;
    const losers = await Promise.all([send('second'), send('third'), send('fourth')]);
    for (const res of losers) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TURN_IN_PROGRESS');
      expect(res.body.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(res.headers['retry-after']).toBeDefined();
    }
    // While the winner runs, the session reports its active turn.
    const during = await http().get(`/api/chat/sessions/${sessionId}`).set('Authorization', `Bearer ${auth}`);
    expect(during.body.activeTurn).not.toBeNull();

    client.open();
    const winner = await firstDone;
    expect(winner.status).toBe(200);
    expect(winner.text).toContain('event: done');
    expect(client.calls).toBe(1);

    // Nothing from the refused requests was stored.
    const rows = await prisma.chatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => [row.role, row.content])).toEqual([['user', 'first'], ['assistant', 'Only one of us.']]);
    const turnIds = new Set(rows.map((row) => row.turnId));
    expect(turnIds.size).toBe(1);

    // Released at the end: the next turn runs.
    const nextClient = new GatedClient('Next.');
    nextClient.open();
    setChatLLMClientForTesting(nextClient);
    expect((await send('after')).status).toBe(200);
    expect(await activeTurnLease(sessionId)).toBeNull();
  });

  it('serialises concurrent direct turns on one session and lets other sessions run in parallel', async () => {
    const sessionA = await newSession();
    const sessionB = await newSession();
    const client = new GatedClient('parallel');
    setChatLLMClientForTesting(client);
    const a1 = collect(runChatTurn({ sessionId: sessionA, userId, userMessage: 'a1' }));
    await client.entered;
    const b1 = collect(runChatTurn({ sessionId: sessionB, userId, userMessage: 'b1' }));
    const a2 = await collect(runChatTurn({ sessionId: sessionA, userId, userMessage: 'a2' }));
    expect(a2).toEqual([expect.objectContaining({ type: 'error', code: 'TURN_IN_PROGRESS' })]);
    client.open();
    const [a1Chunks, b1Chunks] = await Promise.all([a1, b1]);
    expect(a1Chunks.at(-1)?.type).toBe('done');
    expect(b1Chunks.at(-1)?.type).toBe('done');
    await expect(prisma.chatMessage.count({ where: { sessionId: sessionA, role: 'user' } })).resolves.toBe(1);
  });

  it('admits exactly one of many simultaneous acquisitions (no waiting, one winner)', async () => {
    const sessionId = await newSession();
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireTurnLease(sessionId, randomUUID(), { heartbeat: false })));
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    for (const loser of results.filter((result) => !result.ok)) {
      if (!loser.ok) expect(loser.holder?.turnId).toBe(winners[0]?.ok ? winners[0].lease.turnId : undefined);
    }
    if (winners[0]?.ok) await winners[0].lease.release();
  });

  it('lets a new turn take over an expired lease (a crashed replica) and fences the old holder out', async () => {
    const sessionId = await newSession();
    const stale = await acquireTurnLease(sessionId, `stale-${suffix}`, { ttlMs: 1_000, heartbeat: false });
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.lease.fence).toBeGreaterThanOrEqual(1);

    // Not expired yet: busy.
    const early = await acquireTurnLease(sessionId, `early-${suffix}`, { heartbeat: false });
    expect(early.ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const fresh = await acquireTurnLease(sessionId, `fresh-${suffix}`, { heartbeat: false });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.lease.fence).toBe(stale.lease.fence + 1);

    // The old holder can neither renew nor write.
    await expect(stale.lease.renew()).resolves.toBe(false);
    expect(stale.lease.lost).toBe(true);
    await expect(stale.lease.fenced((tx) => tx.chatMessage.create({ data: { sessionId, role: 'assistant', content: 'stale write' } })))
      .rejects.toSatisfy(isTurnLeaseLostError);
    await expect(prisma.chatMessage.count({ where: { sessionId, content: 'stale write' } })).resolves.toBe(0);

    // Releasing the stale lease does not release the new holder's lease.
    await stale.lease.release();
    expect((await activeTurnLease(sessionId))?.turnId).toBe(`fresh-${suffix}`);
    await fresh.lease.release();
    expect(await activeTurnLease(sessionId)).toBeNull();
  });

  it('stops a running turn that lost its lease: TURN_LEASE_LOST, and nothing more is written by it', async () => {
    process.env.CHAT_TURN_LEASE_TTL_MS = '1500';
    const sessionId = await newSession();
    const client = new GatedClient('should never be stored');
    setChatLLMClientForTesting(client);
    const running = collect(runChatTurn({ sessionId, userId, userMessage: 'long question' }));
    await client.entered;
    const userRow = await prisma.chatMessage.findFirstOrThrow({ where: { sessionId, role: 'user' } });
    const staleTurnId = userRow.turnId;

    // Another replica takes the session over (as after an expiry): one
    // statement, so the running turn's heartbeat cannot interleave.
    await prisma.$executeRaw`
      UPDATE "chat_turn_leases"
      SET "turnId" = ${`takeover-${suffix}`}, "fence" = "fence" + 1,
          "renewedAt" = timezone('UTC', clock_timestamp()),
          "expiresAt" = timezone('UTC', clock_timestamp()) + interval '1 minute',
          "releasedAt" = NULL
      WHERE "sessionId" = ${sessionId}`;

    // The heartbeat (every ttl/3) notices, aborts the turn and the model call.
    const chunks = await running;
    expect(chunks.at(-1)).toMatchObject({ type: 'error', code: 'TURN_LEASE_LOST' });
    expect(chunks.some((chunk) => chunk.type === 'assistant_final')).toBe(false);
    const staleRows = await prisma.chatMessage.findMany({ where: { sessionId, turnId: staleTurnId } });
    expect(staleRows.map((row) => row.role)).toEqual(['user']);
    // The new holder still owns the session.
    expect((await activeTurnLease(sessionId))?.turnId).toBe(`takeover-${suffix}`);
    await waitFor(async () => (await prisma.chatMessage.count({ where: { sessionId, turnId: staleTurnId } })) === 1);
  });
});
