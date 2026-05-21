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

describe('Chat sessions API', () => {
  const app = createApp();
  let user: Awaited<ReturnType<typeof prisma.user.upsert>>;
  let other: Awaited<ReturnType<typeof prisma.user.upsert>>;
  let workspaceId: string;
  let projectId: string;
  let auth: string;
  let otherAuth: string;

  beforeAll(async () => {
    await cleanup();
    user = await prisma.user.upsert({
      where: { githubId: 'chat-session-user' },
      update: { username: 'chatsessionuser', email: 'chatsession@example.com' },
      create: { githubId: 'chat-session-user', username: 'chatsessionuser', email: 'chatsession@example.com' },
    });
    other = await prisma.user.upsert({
      where: { githubId: 'chat-session-other' },
      update: { username: 'chatsessionother', email: 'chatsessionother@example.com' },
      create: { githubId: 'chat-session-other', username: 'chatsessionother', email: 'chatsessionother@example.com' },
    });
    auth = token(user.id, user.username);
    otherAuth = token(other.id, other.username);
    const workspace = await prisma.workspace.create({ data: { name: 'Chat Workspace', slug: 'chat-workspace' } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role: 'owner', joinedAt: new Date() } });
    const project = await prisma.project.create({ data: { workspaceId, name: 'Chat Project', key: 'CHAT' } });
    projectId = project.id;
    await prisma.projectAccess.create({ data: { projectId, userId: user.id, permission: 'full' } });
  }, 30000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  it('creates, lists, reads, patches, and archives a workspace-scoped session', async () => {
    const created = await request(app)
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${auth}`)
      .send({ workspaceId, projectId });

    expect(created.status).toBe(201);
    expect(created.body.workspaceId).toBe(workspaceId);
    expect(created.body.projectId).toBe(projectId);

    const listed = await request(app)
      .get(`/api/chat/sessions?workspaceId=${workspaceId}`)
      .set('Authorization', `Bearer ${auth}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.some((session: { id: string }) => session.id === created.body.id)).toBe(true);

    const patched = await request(app)
      .patch(`/api/chat/sessions/${created.body.id}`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ title: 'Planning chat' });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('Planning chat');

    const detail = await request(app)
      .get(`/api/chat/sessions/${created.body.id}`)
      .set('Authorization', `Bearer ${auth}`);
    expect(detail.status).toBe(200);
    expect(detail.body.session.id).toBe(created.body.id);
    expect(detail.body.messages).toEqual([]);

    const archived = await request(app)
      .delete(`/api/chat/sessions/${created.body.id}`)
      .set('Authorization', `Bearer ${auth}`);
    expect(archived.status).toBe(204);
  });

  it('denies cross-user session access', async () => {
    const session = await prisma.chatSession.create({ data: { userId: user.id, workspaceId } });
    const res = await request(app)
      .get(`/api/chat/sessions/${session.id}`)
      .set('Authorization', `Bearer ${otherAuth}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
  });
});
