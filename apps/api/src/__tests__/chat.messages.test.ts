import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

function token(userId: string, username: string) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

async function cleanup() {
  await prisma.chatToolCall.deleteMany({});
  await prisma.chatMessage.deleteMany({});
  await prisma.chatSession.deleteMany({});
  await prisma.taskLabel.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.label.deleteMany({});
  await prisma.teamMember.deleteMany({});
  await prisma.team.deleteMany({});
  await prisma.projectAccess.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.workspaceMember.deleteMany({});
  await prisma.workspace.deleteMany({});
}

describe('Chat messages pagination', () => {
  const app = createApp();
  let user: Awaited<ReturnType<typeof prisma.user.upsert>>;
  let workspaceId: string;
  let sessionId: string;
  let auth: string;
  let messageIds: string[] = [];

  beforeAll(async () => {
    await cleanup();
    user = await prisma.user.upsert({
      where: { githubId: 'chat-msgs-user' },
      update: { username: 'chatmsgsuser', email: 'chatmsgs@example.com' },
      create: { githubId: 'chat-msgs-user', username: 'chatmsgsuser', email: 'chatmsgs@example.com' },
    });
    auth = token(user.id, user.username);
    const workspace = await prisma.workspace.create({ data: { name: 'Msgs Workspace', slug: 'msgs-workspace' } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role: 'owner', joinedAt: new Date() } });

    const session = await prisma.chatSession.create({ data: { userId: user.id, workspaceId } });
    sessionId = session.id;

    // Insert 5 messages with staggered timestamps for deterministic ordering
    for (let i = 0; i < 5; i++) {
      const msg = await prisma.chatMessage.create({
        data: {
          sessionId,
          role: 'user',
          content: `Message ${i + 1}`,
          createdAt: new Date(Date.now() - (5 - i) * 1000),
        },
      });
      messageIds.push(msg.id);
    }
  }, 30000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  it('returns messages in chronological order', async () => {
    const res = await request(app)
      .get(`/api/chat/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${auth}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(5);
    expect(res.body.messages[0].content).toBe('Message 1');
    expect(res.body.messages[4].content).toBe('Message 5');
  });

  it('respects limit parameter', async () => {
    const res = await request(app)
      .get(`/api/chat/sessions/${sessionId}?limit=2`)
      .set('Authorization', `Bearer ${auth}`);
    expect(res.status).toBe(200);
    // The endpoint returns the most recent N messages (desc order, reversed)
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].content).toBe('Message 4');
    expect(res.body.messages[1].content).toBe('Message 5');
    expect(res.body.nextCursor).not.toBeNull();
  });

  it('before cursor pagination returns older messages', async () => {
    // First get the latest 2
    const first = await request(app)
      .get(`/api/chat/sessions/${sessionId}?limit=2`)
      .set('Authorization', `Bearer ${auth}`);
    const cursor = first.body.nextCursor;
    expect(cursor).toBeTruthy();

    const second = await request(app)
      .get(`/api/chat/sessions/${sessionId}?limit=2&before=${cursor}`)
      .set('Authorization', `Bearer ${auth}`);
    expect(second.status).toBe(200);
    expect(second.body.messages).toHaveLength(2);
    // These should be older messages
    expect(second.body.messages[0].content).toBe('Message 2');
    expect(second.body.messages[1].content).toBe('Message 3');
  });

  it('rejects POST with empty content (validation error)', async () => {
    const res = await request(app)
      .post(`/api/chat/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ content: '' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for POST to non-existent session', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .post(`/api/chat/sessions/${fakeId}/messages`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ content: 'hello' });
    expect(res.status).toBe(404);
  });
});
