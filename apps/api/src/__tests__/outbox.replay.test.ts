/**
 * W04b replay storage: Last-Event-ID replay over more than 500 events is
 * lossless and ordered with bounded pages, survives restarts between pages,
 * never stalls on filtered pages, reports retention truncation, and (over a
 * real SSE connection) splits replay from live delivery without duplicates.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { clients } from '../events/hub';
import { getStreamConsumer } from '../events/consumer';
import { appendDomainEvent } from '../events/outbox';
import { isReplayTruncated, readReplayPage, replayEvents, replaySince, type ReplayAudience } from '../events/replay';
import { pruneStream, readStreamHead, sequencePendingEvents } from '../events/stream';
import type { DomainEventInput } from '../events/types';
import type { TenancyContext } from '../tenancy/types';
import { testJwtSecret } from './test-env';

const run = randomUUID().slice(0, 8);
const prefix = `w04b-replay.${run}.`;
const userId = `w04b-replay-user-${run}`;
const otherUser = `w04b-replay-other-${run}`;
const workspaceId = `w04b-replay-ws-${run}`;

const principal: TenancyContext = {
  userId,
  authSource: 'jwt',
  scopes: [],
  credentialId: null,
  workspaceRestriction: null,
  workspaces: new Map([[workspaceId, 'member']]),
  teams: new Set(),
  projectGrants: new Map(),
  resolvedAt: Date.now(),
};
const audience: ReplayAudience = { userId, teamIds: [], workspaceIds: [workspaceId], principal };

type Kind = 'mine' | 'sql-filtered' | 'policy-filtered';

function eventInput(kind: Kind, tag: string): DomainEventInput {
  const type = `${prefix}${kind}.${tag}`;
  if (kind === 'mine') return { type, payload: { tag }, audience: { userIds: [userId] }, resource: { type: 'user' } };
  if (kind === 'sql-filtered') return { type, payload: { tag }, audience: { userIds: [otherUser] }, resource: { type: 'user' } };
  // Routed to the principal's workspace, but bound to a team it is not in:
  // passes the SQL prefilter, fails the resource policy.
  return {
    type, payload: { tag },
    audience: { workspaceIds: [workspaceId], teamIds: [`team-x-${run}`] },
    resource: { type: 'team', projectId: null, workspaceId },
  };
}

async function append(kinds: Array<[Kind, string]>): Promise<void> {
  const data = kinds.map(([kind, tag]) => {
    const input = eventInput(kind, tag);
    return {
      type: input.type,
      payload: { tag },
      userIds: input.audience.userIds ?? [],
      teamIds: input.audience.teamIds ?? [],
      workspaceIds: input.audience.workspaceIds ?? [],
      resourceType: input.resource?.type ?? null,
      projectId: input.resource?.projectId ?? null,
      workspaceId: input.resource?.workspaceId ?? null,
      occurredAt: new Date(),
      createdAt: new Date(),
    };
  });
  for (let index = 0; index < data.length; index += 1000) {
    await prisma.domainEventOutbox.createMany({ data: data.slice(index, index + 1000) });
  }
  for (;;) {
    const moved = await sequencePendingEvents({ limit: 500 });
    if (moved.length < 500) return;
  }
}

async function mineIds(): Promise<bigint[]> {
  const rows = await prisma.domainEvent.findMany({
    where: { type: { startsWith: `${prefix}mine.` } },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

function strictlyIncreasing(ids: bigint[]): boolean {
  return ids.every((id, index) => index === 0 || id > ids[index - 1]!);
}

let cursor0 = 0n;

beforeAll(async () => {
  cursor0 = await readStreamHead();
  const kinds: Array<[Kind, string]> = [];
  for (let index = 0; index < 1800; index += 1) {
    const kind: Kind = index % 3 === 0 ? 'mine' : index % 3 === 1 ? 'sql-filtered' : 'policy-filtered';
    kinds.push([kind, String(index)]);
  }
  // A long stretch the principal may not see, then one visible event.
  for (let index = 0; index < 700; index += 1) kinds.push(['policy-filtered', `stretch-${index}`]);
  kinds.push(['mine', 'tail']);
  await append(kinds);
});

afterAll(async () => {
  await prisma.domainEvent.deleteMany({ where: { type: { startsWith: prefix } } });
  await prisma.domainEventOutbox.deleteMany({ where: { type: { startsWith: prefix } } });
});

describe('W04b replay storage', () => {
  it('replays more than 500 events losslessly and in order with tiny bounded pages', async () => {
    const expected = await mineIds();
    expect(expected.length).toBeGreaterThan(500);
    const replayed: bigint[] = [];
    for await (const event of replayEvents(cursor0, audience, { pageSize: 50, scanWindow: 120 })) {
      replayed.push(event.id);
    }
    expect(replayed).toEqual(expected);
    expect(strictlyIncreasing(replayed)).toBe(true);
  });

  it('bounds every page by result count and scanned range, and advances past fully filtered pages', async () => {
    let cursor = cursor0;
    const head = await readStreamHead();
    let pages = 0;
    let emptyPages = 0;
    for (;;) {
      const page = await readReplayPage(cursor, audience, { pageSize: 50, scanWindow: 120, upTo: head });
      pages += 1;
      expect(page.events.length).toBeLessThanOrEqual(50);
      expect(page.nextCursor > cursor || page.done).toBe(true);
      expect(page.nextCursor - cursor).toBeLessThanOrEqual(120n);
      if (page.events.length === 0) emptyPages += 1;
      if (page.done) break;
      cursor = page.nextCursor;
    }
    // The 700-event filtered stretch alone spans several empty pages.
    expect(emptyPages).toBeGreaterThanOrEqual(5);
    expect(pages).toBeGreaterThan(20);

    // The single-call compatibility wrapper no longer stalls on that stretch
    // (pre-W04b it returned [] from the first 200 filtered rows).
    const stretchStart = await prisma.domainEvent.findFirstOrThrow({
      where: { type: `${prefix}policy-filtered.stretch-0` },
      select: { id: true },
    });
    const tail = await replaySince(stretchStart.id - 1n, audience, 200);
    expect(tail.map((event) => event.type)).toEqual([`${prefix}mine.tail`]);
  });

  /**
   * A client resumes from the last id it knows: the last event it received,
   * or (`checkpointed`) the page cursor, which a server can hand out with an
   * id-only SSE frame (`id: N` + blank line updates EventSource's
   * Last-Event-ID without dispatching an event). Without checkpoints, a
   * client that dies every few pages inside a long stretch of events it may
   * not see rescans that stretch on every reconnect, so restarts here happen
   * only after a connection delivered something.
   */
  it.each([
    ['last received event', false],
    ['page checkpoint', true],
  ])('loses and duplicates nothing when the reader restarts between pages while writes continue (resume from %s)', async (_label, checkpointed) => {
    const received: bigint[] = [];
    let cursor = cursor0;
    let checkpoint = cursor0;
    let boundary = await readStreamHead();
    let pages = 0;
    let restarts = 0;
    let deliveredThisConnection = 0;
    for (;;) {
      const page = await readReplayPage(cursor, audience, { pageSize: 40, scanWindow: 150, upTo: boundary });
      received.push(...page.events.map((event) => event.id));
      deliveredThisConnection += page.events.length;
      checkpoint = page.nextCursor;
      pages += 1;
      if (page.done) break;
      if (pages % 4 === 0 && (checkpointed || deliveredThisConnection > 0)) {
        // Process restart: new events commit meanwhile, then the client
        // reconnects and the server reads a new boundary.
        restarts += 1;
        deliveredThisConnection = 0;
        await append([
          ['mine', `during-restart-${checkpointed}-${restarts}-a`],
          ['policy-filtered', `during-restart-${checkpointed}-${restarts}`],
          ['mine', `during-restart-${checkpointed}-${restarts}-b`],
        ]);
        cursor = checkpointed ? checkpoint : received.at(-1) ?? cursor0;
        boundary = await readStreamHead();
      } else {
        cursor = page.nextCursor;
      }
    }
    expect(restarts).toBeGreaterThan(3);
    expect(received).toEqual(await mineIds());
    expect(new Set(received.map(String)).size).toBe(received.length);
  });

  it('reports truncated history after retention removed events past the cursor', async () => {
    await append([['mine', 'trunc-1']]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await append([['mine', 'trunc-2']]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await append([['mine', 'trunc-3']]);
    const rows = await prisma.domainEvent.findMany({
      where: { type: { in: ['trunc-1', 'trunc-2', 'trunc-3'].map((tag) => `${prefix}mine.${tag}`) } },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(3);
    const [first, second, third] = rows;
    const deleted = await pruneStream(second!.createdAt);
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await prisma.domainEvent.count({ where: { id: { in: [first!.id, second!.id] } } })).toBe(0);
    expect(await prisma.domainEvent.count({ where: { id: third!.id } })).toBe(1);
    expect(await isReplayTruncated(first!.id)).toBe(true);
    expect(await isReplayTruncated(second!.id)).toBe(false);
    expect(await isReplayTruncated(third!.id)).toBe(false);
  });
});

describe('W04b replay over a real SSE connection', () => {
  const app = createApp();
  let server: Server | undefined;
  let baseUrl = '';
  const sseUser = { id: '', username: `w04b-sse-${run}` };

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { githubId: `w04b-sse-${run}`, username: sseUser.username, email: `w04b-sse-${run}@example.com` },
    });
    sseUser.id = user.id;
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      const closing = new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      server.closeAllConnections();
      await closing;
    }
    clients.clear();
    await prisma.domainEvent.deleteMany({ where: { userIds: { has: sseUser.id } } });
    await prisma.user.deleteMany({ where: { id: sseUser.id } });
  });

  async function appendForSse(tags: string[]): Promise<void> {
    for (const tag of tags) {
      await appendDomainEvent(prisma, {
        type: `${prefix}sse`, payload: { tag }, audience: { userIds: [sseUser.id] }, resource: { type: 'user' },
      });
    }
    for (;;) {
      const moved = await sequencePendingEvents({ limit: 500 });
      if (moved.length < 500) return;
    }
  }

  function frames(body: string): Array<{ id: string; tag: string }> {
    return body.split('\n\n').flatMap((frame) => {
      const id = /^id: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      if (!id || !data || event !== `${prefix}sse`) return [];
      return [{ id, tag: (JSON.parse(data) as { tag: string }).tag }];
    });
  }

  it('replays 700 missed events in order, then delivers later events live exactly once', async () => {
    const consumer = getStreamConsumer();
    await consumer.ensureInitialized();
    const cursor = await readStreamHead();

    // 700 events already delivered live in this process before the client
    // reconnects …
    await appendForSse(Array.from({ length: 700 }, (_, index) => `missed-${index}`));
    await consumer.catchUp();
    // … and 3 committed but not yet delivered here (sequenced elsewhere).
    await appendForSse(['late-1', 'late-2', 'late-3']);

    const token = jwt.sign({ userId: sseUser.id, username: sseUser.username }, testJwtSecret(), { expiresIn: '1h' });
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': cursor.toString() },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          body += decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        // aborted
      }
    })();
    for (let i = 0; i < 300 && frames(body).length < 700; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(frames(body).length).toBe(700);

    // The late events arrive through the consumer, not the replay.
    await consumer.catchUp();
    for (let i = 0; i < 200 && frames(body).length < 703; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await pump;

    const received = frames(body);
    expect(received.map((frame) => frame.tag)).toEqual([
      ...Array.from({ length: 700 }, (_, index) => `missed-${index}`),
      'late-1', 'late-2', 'late-3',
    ]);
    const ids = received.map((frame) => BigInt(frame.id));
    expect(strictlyIncreasing(ids)).toBe(true);
  });
});
