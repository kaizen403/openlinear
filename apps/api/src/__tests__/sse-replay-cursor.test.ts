/**
 * W02b replay cursor: Last-Event-ID replay always advances, even when whole
 * pages of routed events are invisible to the caller, and a visible event
 * behind more than one such page is delivered. Live events that arrive during
 * replay are held, de-duplicated and delivered after it.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import {
  applyClientPrincipal,
  beginReplayHold,
  deliverToLocalClients,
  endReplayHold,
  registerClient,
  unregisterClient,
  type SSEClient,
} from '../events/hub';
import { replaySince } from '../events/outbox';
import { setReplayLimits } from '../events/replay';
import { resolveTenancyContext } from '../tenancy/context';
import type { WireDomainEvent } from '../events/types';
import {
  closeServer,
  createTestSession,
  listen,
  makeUser,
  openStream,
  parseSseFrames,
  waitFor,
  type TestSession,
  type TestUser,
} from './auth-helpers';

const suffix = randomUUID().slice(0, 8);

describe('W02b Last-Event-ID replay cursor', () => {
  const app = createApp();
  let server: Server | undefined;
  let baseUrl = '';
  let viewer: TestUser;
  let stranger: TestUser;
  let session: TestSession;
  let workspaceId = '';

  beforeAll(async () => {
    viewer = await makeUser('replay-viewer', suffix);
    stranger = await makeUser('replay-stranger', suffix);
    const workspace = await prisma.workspace.create({ data: { name: `Replay ${suffix}`, slug: `replay-${suffix}` } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: viewer.id, role: 'member' },
        { workspaceId, userId: stranger.id, role: 'member' },
      ],
    });
    session = await createTestSession(viewer);
    ({ server, baseUrl } = await listen(app));
  });

  afterEach(() => {
    setReplayLimits(null);
  });

  afterAll(async () => {
    await closeServer(server);
    await prisma.domainEvent.deleteMany({
      where: { OR: [{ workspaceIds: { has: workspaceId } }, { userIds: { hasSome: [viewer.id, stranger.id] } }] },
    });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: { in: [viewer.id, stranger.id] } } });
  });

  async function head(): Promise<bigint> {
    const row = await prisma.domainEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    return row?.id ?? 0n;
  }

  /**
   * Rows routed to the viewer through the workspace audience (so the SQL
   * pre-filter returns them) but bound privately to another user: the viewer
   * may not receive them.
   */
  async function insertHidden(count: number): Promise<void> {
    await prisma.domainEvent.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        type: 'test:hidden',
        payload: { i, marker: `hidden-${suffix}` },
        userIds: [stranger.id],
        workspaceIds: [workspaceId],
        resourceType: 'user',
        publishedAt: new Date(),
      })),
    });
  }

  async function insertVisible(marker: string): Promise<bigint> {
    const row = await prisma.domainEvent.create({
      data: {
        type: 'test:visible',
        payload: { marker },
        userIds: [viewer.id],
        resourceType: 'user',
        publishedAt: new Date(),
      },
    });
    return row.id;
  }

  /**
   * Open a stream from `lastEventId` and wait until `done` holds for the
   * received text (or, without `done`, a short settle period for negative
   * checks).
   */
  async function replayOnce(lastEventId: bigint, done?: (text: string, ended: boolean) => boolean) {
    const stream = await openStream(baseUrl, { bearer: session.accessToken, lastEventId: lastEventId.toString() });
    expect(stream.status).toBe(200);
    await waitFor(() => stream.text().includes('event: connected'));
    if (done) {
      await waitFor(() => done(stream.text(), stream.ended()), 10_000);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const frames = parseSseFrames(stream.text());
    const ended = stream.ended();
    await stream.close();
    return { frames, ended };
  }

  it('the storage-level replaySince no longer stalls behind a fully invisible page (W04b paging)', async () => {
    const start = await head();
    await insertHidden(250);
    const marker = `visible-${randomUUID()}`;
    await insertVisible(marker);
    const principal = await resolveTenancyContext({ userId: viewer.id, authSource: 'jwt', scopes: [] }, { bypassCache: true });
    const rows = await replaySince(start, {
      userId: viewer.id,
      teamIds: [...principal.teams],
      workspaceIds: [...principal.workspaces.keys()],
      principal,
    });
    // Before W04b this returned [] (one 200-row page, all invisible: a stall).
    // The merged storage pages past filtered rows, so the visible event arrives.
    expect(rows.map((row) => row.type)).toEqual(['test:visible']);
    expect(JSON.stringify(rows[0]?.payload)).toContain(marker);
  });

  it('delivers a visible event behind more than one page of invisible events', async () => {
    const start = await head();
    await insertHidden(450);
    const marker = `visible-${randomUUID()}`;
    const visibleId = await insertVisible(marker);
    const { frames } = await replayOnce(start, (text) => text.includes(marker));
    const replayed = frames.filter((frame) => frame.id && frame.event !== 'connected');
    expect(replayed.some((frame) => frame.event === 'test:hidden')).toBe(false);
    const visible = replayed.find((frame) => frame.data?.includes(marker));
    expect(visible?.id).toBe(visibleId.toString());
  });

  it('advances the cursor past trailing invisible events', async () => {
    const marker = `visible-${randomUUID()}`;
    const visibleId = await insertVisible(marker);
    await insertHidden(300);
    const tail = await head();
    const { frames } = await replayOnce(visibleId, (text) => text.includes('"replay:cursor"'));
    const cursorFrame = frames.find((frame) => frame.data?.includes('"replay:cursor"'));
    expect(cursorFrame?.event).toBeUndefined(); // unnamed `message` event: browsers update lastEventId
    expect(cursorFrame?.id).toBe(tail.toString());
    // Reconnecting from the cursor finds nothing more to scan.
    const again = await replayOnce(tail);
    expect(again.frames.some((frame) => frame.data?.includes('"replay:cursor"'))).toBe(false);
  });

  it('makes progress on every connection when the scan budget runs out (no livelock)', async () => {
    setReplayLimits({ pageSize: 100, maxScannedRows: 200 });
    const start = await head();
    await insertHidden(450);
    const marker = `visible-${randomUUID()}`;
    const visibleId = await insertVisible(marker);

    let cursor = start;
    const cursors: bigint[] = [];
    let delivered = false;
    for (let attempt = 0; attempt < 5 && !delivered; attempt += 1) {
      const { frames, ended } = await replayOnce(cursor, (text, streamEnded) => text.includes(marker) || streamEnded);
      if (frames.some((frame) => frame.data?.includes(marker))) {
        delivered = true;
        break;
      }
      const cursorFrame = frames.find((frame) => frame.data?.includes('"replay:cursor"'));
      expect(cursorFrame?.id).toBeDefined();
      const next = BigInt(cursorFrame?.id ?? '0');
      expect(next > cursor).toBe(true);
      // Budget exhausted: the server hands the cursor over and ends the stream.
      expect(ended).toBe(true);
      cursors.push(next);
      cursor = next;
    }
    expect(delivered).toBe(true);
    expect(cursors.length).toBe(2);
    expect(cursor < visibleId).toBe(true);
  });

  it('holds live events during replay, drops the ones replay covered, then delivers the rest in order', async () => {
    const frames: string[] = [];
    const res = {
      writableEnded: false,
      write(chunk: string) { frames.push(chunk); return true; },
      end() { this.writableEnded = true; },
    };
    const client: SSEClient = {
      id: `replay-hold-${randomUUID()}`,
      res: res as unknown as SSEClient['res'],
      userId: viewer.id,
      teamIds: [],
      workspaceIds: [],
      connectedAt: Date.now(),
    };
    applyClientPrincipal(client, await resolveTenancyContext({ userId: viewer.id, authSource: 'jwt', scopes: [] }, { bypassCache: true }));
    beginReplayHold(client);
    registerClient(client);
    const wire = (id: string, marker: string): WireDomainEvent => ({
      id, type: 'test:live', occurredAt: new Date().toISOString(), actorId: null, workspaceId: null,
      payload: { marker }, userIds: [viewer.id], teamIds: [], workspaceIds: [], resourceType: 'user', projectId: null,
    });
    deliverToLocalClients(wire('1000', 'covered'));
    deliverToLocalClients(wire('1001', 'after-1'));
    deliverToLocalClients(wire('1002', 'after-2'));
    expect(frames).toEqual([]);
    endReplayHold(client, 1000n);
    expect(frames.some((f) => f.includes('covered'))).toBe(false);
    expect(frames.map((f) => /id: (\d+)/.exec(f)?.[1])).toEqual(['1001', '1002']);
    unregisterClient(client.id);
  });
});
