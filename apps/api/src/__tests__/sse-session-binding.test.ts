/**
 * W02b SSE tickets bound to the issuing session: logout / session revocation
 * invalidates outstanding tickets and closes open streams of that session
 * (locally and through the cross-replica signal); ticket consumption is
 * single-use under concurrency; "revoke other sessions" keeps the caller's.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import {
  SESSION_REVOKED_EVENT,
  clients,
  deliverToLocalClients,
  registerClient,
  unregisterClient,
  type SSEClient,
} from '../events/hub';
import { clearSessionCaches } from '../services/sessions';
import {
  closeServer,
  createTestSession,
  listen,
  makeUser,
  openStream,
  waitFor,
  type TestUser,
} from './auth-helpers';

const suffix = randomUUID().slice(0, 8);

describe('W02b SSE tickets and streams follow their session', () => {
  const app = createApp();
  let server: Server | undefined;
  let baseUrl = '';
  let user: TestUser;
  let other: TestUser;
  const previousSessionless = process.env.OPENLINEAR_ALLOW_SESSIONLESS_JWT;

  beforeAll(async () => {
    // Production behaviour: every bearer JWT must have a live Session row.
    process.env.OPENLINEAR_ALLOW_SESSIONLESS_JWT = '0';
    user = await makeUser('sse-bind', suffix);
    other = await makeUser('sse-bind-other', suffix);
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    process.env.OPENLINEAR_ALLOW_SESSIONLESS_JWT = previousSessionless;
    await closeServer(server);
    await prisma.domainEvent.deleteMany({ where: { userIds: { hasSome: [user.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
    clearSessionCaches();
  });

  async function mintTicket(accessToken: string): Promise<string> {
    const res = await request(baseUrl).post('/api/events/ticket').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(201);
    return res.body.ticket as string;
  }

  it('records the issuing session on the ticket', async () => {
    const session = await createTestSession(user);
    const ticket = await mintTicket(session.accessToken);
    const rows = await prisma.sseTicket.findMany({ where: { userId: user.id, consumedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 });
    expect(rows[0]?.sessionId).toBe(session.sessionId);
    const stream = await openStream(baseUrl, { ticket });
    expect(stream.status).toBe(200);
    await stream.close();
  });

  it('logout closes the session\'s open streams and invalidates its unused tickets', async () => {
    const doomed = await createTestSession(user);
    const survivor = await createTestSession(user);
    const doomedStream = await openStream(baseUrl, { ticket: await mintTicket(doomed.accessToken) });
    const bearerStream = await openStream(baseUrl, { bearer: doomed.accessToken });
    const survivorStream = await openStream(baseUrl, { ticket: await mintTicket(survivor.accessToken) });
    const unused = await mintTicket(doomed.accessToken);
    expect([doomedStream.status, bearerStream.status, survivorStream.status]).toEqual([200, 200, 200]);
    await waitFor(() => doomedStream.text().includes('event: connected') && bearerStream.text().includes('event: connected'));

    const logout = await request(baseUrl).post('/api/auth/logout').set('Authorization', `Bearer ${doomed.accessToken}`);
    expect(logout.status).toBe(200);

    await waitFor(() => doomedStream.ended() && bearerStream.ended());
    expect(survivorStream.ended()).toBe(false);
    expect((await prisma.sseTicket.findFirst({ where: { userId: user.id, sessionId: doomed.sessionId, consumedAt: null } }))).toBeNull();
    const late = await openStream(baseUrl, { ticket: unused });
    expect(late.status).toBe(401);
    await survivorStream.close();
  });

  it('revoking a session from the device list closes its streams', async () => {
    const target = await createTestSession(user);
    const manager = await createTestSession(user);
    const stream = await openStream(baseUrl, { ticket: await mintTicket(target.accessToken) });
    await waitFor(() => stream.text().includes('event: connected'));
    const revoked = await request(baseUrl).delete(`/api/sessions/${target.sessionId}`).set('Authorization', `Bearer ${manager.accessToken}`);
    expect(revoked.status).toBe(200);
    await waitFor(() => stream.ended());
  });

  it('refuses a ticket whose session was revoked by a path without hooks', async () => {
    const session = await createTestSession(user);
    const ticket = await mintTicket(session.accessToken);
    await prisma.session.update({ where: { id: session.sessionId }, data: { revokedAt: new Date() } });
    const res = await openStream(baseUrl, { ticket });
    expect(res.status).toBe(401);
  });

  it('lets exactly one of several concurrent connections consume a ticket', async () => {
    const session = await createTestSession(user);
    const ticket = await mintTicket(session.accessToken);
    const streams = await Promise.all(Array.from({ length: 6 }, () => openStream(baseUrl, { ticket })));
    expect(streams.map((stream) => stream.status).sort()).toEqual([200, 401, 401, 401, 401, 401]);
    await Promise.all(streams.map((stream) => stream.close()));
  });

  it('closes streams named by a cross-replica session:revoked signal, only for the addressed owner', () => {
    const fake = (userId: string, sessionId: string) => {
      let ended = false;
      const res = {
        get writableEnded() { return ended; },
        write() { return true; },
        end() { ended = true; },
      };
      const client: SSEClient = {
        id: `bind-${randomUUID()}`,
        res: res as unknown as SSEClient['res'],
        userId,
        teamIds: [],
        workspaceIds: [],
        connectedAt: Date.now(),
        sessionId,
      };
      registerClient(client);
      return { client, ended: () => ended };
    };
    const sessionId = randomUUID();
    const mine = fake(user.id, sessionId);
    const foreign = fake(other.id, sessionId);
    deliverToLocalClients({
      id: '0', type: SESSION_REVOKED_EVENT, occurredAt: new Date().toISOString(), actorId: null, workspaceId: null,
      payload: { sessionIds: [sessionId], reason: 'logout' }, userIds: [user.id], teamIds: [], workspaceIds: [],
      resourceType: 'user', projectId: null,
    });
    expect(mine.ended()).toBe(true);
    expect(clients.has(mine.client.id)).toBe(false);
    expect(foreign.ended()).toBe(false);
    unregisterClient(foreign.client.id);
  });

  it('"revoke other sessions" keeps the session that asked', async () => {
    const current = await createTestSession(user);
    const others = [await createTestSession(user), await createTestSession(user)];
    const res = await request(baseUrl).post('/api/sessions/revoke-others').set('Authorization', `Bearer ${current.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBeGreaterThanOrEqual(2);
    expect((await prisma.session.findUnique({ where: { id: current.sessionId } }))?.revokedAt).toBeNull();
    for (const session of others) {
      expect((await prisma.session.findUnique({ where: { id: session.sessionId } }))?.revokedAt).toBeInstanceOf(Date);
    }
    const stillIn = await request(baseUrl).get('/api/users/me').set('Authorization', `Bearer ${current.accessToken}`);
    expect(stillIn.status).toBe(200);
  });
});
