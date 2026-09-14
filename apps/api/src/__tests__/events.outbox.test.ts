import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@openlinear/db';
import { persistAndDeliver, replaySince, parseLastEventId } from '../events/outbox';
import {
  clients,
  deliverToLocalClients,
  formatSseMessage,
  registerClient,
  unregisterClient,
  type SSEClient,
} from '../events/hub';

const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function fakeResponse() {
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return { res, chunks };
}

describe('Phase 1.3 outbox + SSE Last-Event-ID', () => {
  let userId = '';
  let workspaceId = '';

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        githubId: `evt-${suffix}`,
        username: `evt-${suffix}`,
        email: `evt-${suffix}@example.com`,
      },
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({
      data: { name: `Evt WS ${suffix}`, slug: `evt-ws-${suffix}` },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({
      data: { workspaceId, userId, role: 'owner' },
    });
  });

  afterAll(async () => {
    await prisma.domainEvent.deleteMany({
      where: { OR: [{ userIds: { has: userId } }, { workspaceIds: { has: workspaceId } }] },
    });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    clients.clear();
  });

  it('parseLastEventId accepts decimal strings and rejects junk', () => {
    expect(parseLastEventId('42')).toBe(42n);
    expect(parseLastEventId(' 7 ')).toBe(7n);
    expect(parseLastEventId('nope')).toBeNull();
    expect(parseLastEventId('')).toBeNull();
  });

  it('formatSseMessage emits id frames for replay', () => {
    const frame = formatSseMessage('task:updated', { id: 't1' }, '99');
    expect(frame).toContain('id: 99\n');
    expect(frame).toContain('event: task:updated\n');
    expect(frame).toContain('data: {"id":"t1"}');
  });

  it('persistAndDeliver writes an outbox row, fans out locally, and supports Last-Event-ID replay', async () => {
    const { res, chunks } = fakeResponse();
    const client: SSEClient = {
      id: `client-${suffix}`,
      res: res as unknown as SSEClient['res'],
      userId,
      teamIds: [],
      workspaceIds: [workspaceId],
      connectedAt: Date.now(),
    };
    registerClient(client);

    const stored = await persistAndDeliver({
      type: 'task:updated',
      payload: { title: `evt-task-${suffix}` },
      audience: { userIds: [userId], workspaceIds: [workspaceId] },
    });
    expect(stored).not.toBeNull();
    expect(stored?.publishedAt).not.toBeNull();
    expect(chunks.some((c) => c.includes('event: task:updated') && c.includes(`id: ${stored!.id}`))).toBe(true);

    const replayed = await replaySince(stored!.id - 1n, {
      userId,
      teamIds: [],
      workspaceIds: [workspaceId],
    });
    expect(replayed.some((row) => row.id === stored!.id)).toBe(true);

    const after = await replaySince(stored!.id, {
      userId,
      teamIds: [],
      workspaceIds: [workspaceId],
    });
    expect(after.some((row) => row.id === stored!.id)).toBe(false);

    unregisterClient(client.id);
  });

  it('does not deliver a user-targeted event to a different user', () => {
    const { res, chunks } = fakeResponse();
    const client: SSEClient = {
      id: `other-${suffix}`,
      res: res as unknown as SSEClient['res'],
      userId: 'someone-else',
      teamIds: [],
      workspaceIds: [],
      connectedAt: Date.now(),
    };
    registerClient(client);
    deliverToLocalClients({
      id: '1',
      type: 'notification:created',
      occurredAt: new Date().toISOString(),
      actorId: null,
      workspaceId: null,
      payload: { secret: true },
      userIds: [userId],
      teamIds: [],
      workspaceIds: [],
    });
    expect(chunks.join('')).not.toContain('secret');
    unregisterClient(client.id);
  });
});
