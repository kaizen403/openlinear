import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

function generateToken(userId: string, username: string = 'workspaceuser') {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Workspaces API', () => {
  const app = createApp();
  let testUserId: string;
  let authToken: string;

  beforeAll(async () => {
    await prisma.projectAccess.deleteMany({});
    await prisma.projectTeam.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.workspaceMember.deleteMany({});
    await prisma.workspace.deleteMany({});

    const user = await prisma.user.upsert({
      where: { githubId: '777001' },
      update: {},
      create: {
        githubId: '777001',
        username: 'workspaceuser',
        email: 'workspace@example.com',
      },
    });
    testUserId = user.id;
    authToken = generateToken(user.id, user.username);
  }, 30000);

  afterAll(async () => {
    await prisma.projectAccess.deleteMany({});
    await prisma.projectTeam.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.workspaceMember.deleteMany({});
    await prisma.workspace.deleteMany({});
  }, 30000);

  it('creates and lists the caller default workspace', async () => {
    const res = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("workspaceuser's Workspace");
    expect(res.body[0].role).toBe('owner');
    expect(res.body[0]._count.members).toBe(1);
  });

  it('returns workspace details and members for a member', async () => {
    const workspace = await prisma.workspaceMember.findFirstOrThrow({
      where: { userId: testUserId },
      include: { workspace: true },
    });

    const detail = await request(app)
      .get(`/api/workspaces/${workspace.workspaceId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(workspace.workspaceId);
    expect(detail.body.currentMember.role).toBe('owner');

    const members = await request(app)
      .get(`/api/workspaces/${workspace.workspaceId}/members`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(members.status).toBe(200);
    expect(members.body).toHaveLength(1);
    expect(members.body[0].userId).toBe(testUserId);
  });

  it('hides workspaces from non-members', async () => {
    const privateWorkspace = await prisma.workspace.create({
      data: { name: 'Private Workspace', slug: 'private-workspace' },
    });

    const res = await request(app)
      .get(`/api/workspaces/${privateWorkspace.id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
  });
});
