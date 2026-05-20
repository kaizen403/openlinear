import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

function generateToken(userId: string, username: string) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

async function cleanup() {
  await prisma.activityLog.deleteMany({});
  await prisma.projectAccess.deleteMany({});
  await prisma.projectTeam.deleteMany({});
  await prisma.task.updateMany({
    where: { projectId: { not: null } },
    data: { projectId: null },
  });
  await prisma.project.deleteMany({});
  await prisma.workspaceMember.deleteMany({});
  await prisma.workspace.deleteMany({});
  await prisma.teamMember.deleteMany({});
  await prisma.team.deleteMany({});
}

async function createUser(githubId: string, username: string) {
  return prisma.user.upsert({
    where: { githubId },
    update: { username, email: `${username}@example.com` },
    create: {
      githubId,
      username,
      email: `${username}@example.com`,
    },
  });
}

async function createWorkspace(ownerId: string, name: string) {
  const workspace = await prisma.workspace.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  await prisma.workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      userId: ownerId,
      role: 'owner',
      joinedAt: new Date(),
    },
  });
  return workspace;
}

describe('Workspace member management', () => {
  const app = createApp();
  let owner: Awaited<ReturnType<typeof createUser>>;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let member: Awaited<ReturnType<typeof createUser>>;
  let viewer: Awaited<ReturnType<typeof createUser>>;
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;

  beforeAll(async () => {
    await cleanup();
    owner = await createUser('workspace-members-owner', 'workspace_owner');
    admin = await createUser('workspace-members-admin', 'workspace_admin');
    member = await createUser('workspace-members-member', 'workspace_member');
    viewer = await createUser('workspace-members-viewer', 'workspace_viewer');
    ownerToken = generateToken(owner.id, owner.username);
    adminToken = generateToken(admin.id, admin.username);
    memberToken = generateToken(member.id, member.username);
  }, 30000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  it('invites a workspace member by username', async () => {
    const workspace = await createWorkspace(owner.id, 'Invite Happy Path');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: member.username, role: 'member' });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(member.id);
    expect(res.body.role).toBe('member');
    expect(res.body.user.username).toBe(member.username);
  });

  it('returns an existing member on duplicate invite', async () => {
    const workspace = await createWorkspace(owner.id, 'Duplicate Invite');
    const first = await request(app)
      .post(`/api/workspaces/${workspace.id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: member.username, role: 'viewer' });

    const second = await request(app)
      .post(`/api/workspaces/${workspace.id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: member.username, role: 'member' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.role).toBe('viewer');
  });

  it('updates a workspace member role', async () => {
    const workspace = await createWorkspace(owner.id, 'Role Update');
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: member.id, role: 'member' },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(member.id);
    expect(res.body.role).toBe('admin');
  });

  it('protects the last owner from demotion and removal', async () => {
    const workspace = await createWorkspace(owner.id, 'Last Owner');

    const demote = await request(app)
      .patch(`/api/workspaces/${workspace.id}/members/${owner.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'admin' });

    const remove = await request(app)
      .delete(`/api/workspaces/${workspace.id}/members/${owner.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_OWNER');
    expect(remove.status).toBe(409);
    expect(remove.body.error.code).toBe('LAST_OWNER');
  });

  it('blocks non-owners from changing roles', async () => {
    const workspace = await createWorkspace(owner.id, 'Non Owner Role Change');
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: member.id, role: 'member' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: viewer.id, role: 'viewer' },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/members/${viewer.id}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OWNERSHIP_REQUIRED');
  });

  it('allows a member to remove self and deletes project access in the workspace', async () => {
    const workspace = await createWorkspace(owner.id, 'Self Remove');
    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'Scoped Project', key: 'SCOP' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: member.id, role: 'member' },
    });
    await prisma.projectAccess.create({
      data: { projectId: project.id, userId: member.id, permission: 'view' },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(204);
    await expect(
      prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: member.id } },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.projectAccess.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: member.id } },
      }),
    ).resolves.toBeNull();
  });

  it('blocks workspace deletion while projects exist', async () => {
    const workspace = await createWorkspace(owner.id, 'Project Blocked Delete');
    await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'Still Here', key: 'STIL' },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_PROJECTS');
    expect(res.body.error.details.projectCount).toBe(1);
  });

  it('deletes an empty workspace', async () => {
    const workspace = await createWorkspace(owner.id, 'Empty Delete');

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(204);
    await expect(prisma.workspace.findUnique({ where: { id: workspace.id } })).resolves.toBeNull();
  });

  it('returns 304 for matching workspace ETag', async () => {
    const workspace = await createWorkspace(owner.id, 'ETag Workspace');

    const first = await request(app)
      .get(`/api/workspaces/${workspace.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const etag = first.headers.etag;

    const second = await request(app)
      .get(`/api/workspaces/${workspace.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('If-None-Match', etag);

    expect(first.status).toBe(200);
    expect(etag).toBeDefined();
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  it('returns only requested workspace list fields', async () => {
    await createWorkspace(owner.id, 'Selected Fields');

    const res = await request(app)
      .get('/api/workspaces?fields=id,name,role')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(Object.keys(res.body[0]).sort()).toEqual(['id', 'name', 'role'].sort());
  });

  it('paginates workspace members with a cursor', async () => {
    const workspace = await createWorkspace(owner.id, 'Paginated Members');
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: admin.id, role: 'admin' },
        { workspaceId: workspace.id, userId: member.id, role: 'member' },
        { workspaceId: workspace.id, userId: viewer.id, role: 'viewer' },
      ],
    });

    const first = await request(app)
      .get(`/api/workspaces/${workspace.id}/members?limit=2`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const second = await request(app)
      .get(`/api/workspaces/${workspace.id}/members?limit=2&cursor=${first.body.nextCursor}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(second.status).toBe(200);
    expect(second.body.data.length).toBeGreaterThan(0);
    expect(second.body.data.map((item: { id: string }) => item.id)).not.toContain(first.body.data[0].id);
  });

  it('bulk-invites members and reports skipped usernames', async () => {
    const workspace = await createWorkspace(owner.id, 'Bulk Invite');
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'admin' },
    });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/members/bulk`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        invites: [
          { username: member.username, role: 'member' },
          { username: admin.username, role: 'admin' },
          { username: 'missing-workspace-user', role: 'viewer' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.added).toHaveLength(1);
    expect(res.body.added[0].userId).toBe(member.id);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        { username: admin.username, reason: 'ALREADY_MEMBER' },
        { username: 'missing-workspace-user', reason: 'USER_NOT_FOUND' },
      ]),
    );
  });

  it('allows workspace admins to invite non-owner roles', async () => {
    const workspace = await createWorkspace(owner.id, 'Admin Invite');
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'admin' },
    });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: member.username, role: 'viewer' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('viewer');
  });
});
