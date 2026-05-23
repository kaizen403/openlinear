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

describe('Chat permissions', () => {
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
      where: { githubId: 'chat-perms-user' },
      update: { username: 'chatpermsuser', email: 'chatperms@example.com' },
      create: { githubId: 'chat-perms-user', username: 'chatpermsuser', email: 'chatperms@example.com' },
    });
    other = await prisma.user.upsert({
      where: { githubId: 'chat-perms-other' },
      update: { username: 'chatpermsother', email: 'chatpermsother@example.com' },
      create: { githubId: 'chat-perms-other', username: 'chatpermsother', email: 'chatpermsother@example.com' },
    });
    auth = token(user.id, user.username);
    otherAuth = token(other.id, other.username);
    const workspace = await prisma.workspace.create({ data: { name: 'Perms Workspace', slug: 'perms-workspace' } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role: 'owner', joinedAt: new Date() } });
    const project = await prisma.project.create({ data: { workspaceId, name: 'Perms Project', key: 'PERM' } });
    projectId = project.id;
    await prisma.projectAccess.create({ data: { projectId, userId: user.id, permission: 'full' } });
  }, 30000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  it('returns 401 for unauthenticated access', async () => {
    const res = await request(app).get(`/api/chat/sessions?workspaceId=${workspaceId}`);
    expect(res.status).toBe(401);
  });

  it('denies cross-user session access (GET /sessions/:id returns 404)', async () => {
    const session = await prisma.chatSession.create({ data: { userId: user.id, workspaceId } });
    const res = await request(app)
      .get(`/api/chat/sessions/${session.id}`)
      .set('Authorization', `Bearer ${otherAuth}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
  });

  it('denies listing sessions for a workspace the user is not a member of', async () => {
    const res = await request(app)
      .get(`/api/chat/sessions?workspaceId=${workspaceId}`)
      .set('Authorization', `Bearer ${otherAuth}`);
    expect([403, 404]).toContain(res.status);
  });

  it('cannot access archived sessions', async () => {
    const session = await prisma.chatSession.create({
      data: { userId: user.id, workspaceId, archivedAt: new Date() },
    });
    const res = await request(app)
      .get(`/api/chat/sessions/${session.id}`)
      .set('Authorization', `Bearer ${auth}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
  });

  it('rejects projectId that does not belong to the workspace (PROJECT_SCOPE_MISMATCH)', async () => {
    const otherWorkspace = await prisma.workspace.create({ data: { name: 'Other WS', slug: 'other-ws-perms' } });
    await prisma.workspaceMember.create({ data: { workspaceId: otherWorkspace.id, userId: user.id, role: 'owner', joinedAt: new Date() } });
    const otherProject = await prisma.project.create({ data: { workspaceId: otherWorkspace.id, name: 'Other Project', key: 'OTHR' } });
    await prisma.projectAccess.create({ data: { projectId: otherProject.id, userId: user.id, permission: 'full' } });

    const res = await request(app)
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${auth}`)
      .send({ workspaceId, projectId: otherProject.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROJECT_SCOPE_MISMATCH');
  });
});
