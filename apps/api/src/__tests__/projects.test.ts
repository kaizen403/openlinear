import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

function generateToken(userId: string, username: string = 'testuser') {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Projects API', () => {
  const app = createApp();
  let testUserId: string;
  let authToken: string;

  beforeAll(async () => {
    await prisma.projectAccess.deleteMany({});
    await prisma.projectTeam.deleteMany({});
    await prisma.task.updateMany({
      where: { projectId: { not: null } },
      data: { projectId: null },
    });
    await prisma.project.deleteMany({});
    await prisma.workspaceMember.deleteMany({});
    await prisma.workspace.deleteMany({});
    await prisma.repository.deleteMany({ where: { githubRepoId: { in: [909001] } } });
    await prisma.teamMember.deleteMany({});
    await prisma.team.deleteMany({});

    const user = await prisma.user.upsert({
      where: { githubId: '888888' },
      update: {},
      create: {
        githubId: '888888',
        username: 'projecttester',
        email: 'projecttest@example.com',
        accessToken: 'fake-token',
      },
    });
    testUserId = user.id;
    await prisma.repository.deleteMany({ where: { userId: testUserId } });
    authToken = generateToken(user.id, user.username);
  }, 30000);

  afterAll(async () => {
    await prisma.projectAccess.deleteMany({});
    await prisma.projectTeam.deleteMany({});
    await prisma.task.updateMany({
      where: { projectId: { not: null } },
      data: { projectId: null },
    });
    await prisma.project.deleteMany({});
    await prisma.workspaceMember.deleteMany({});
    await prisma.workspace.deleteMany({});
    await prisma.repository.deleteMany({ where: { userId: testUserId } });
    await prisma.teamMember.deleteMany({});
    await prisma.team.deleteMany({});
  }, 30000);

  describe('GET /api/projects', () => {
    it('returns empty array without auth', async () => {
      const res = await request(app).get('/api/projects');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns projects with teams array', async () => {
      const team = await prisma.team.create({
        data: { name: 'Engineering', key: 'PRJENG' },
      });

      await prisma.teamMember.create({
        data: { teamId: team.id, userId: testUserId, role: 'member' },
      });

      await prisma.project.create({
        data: {
          name: 'Test Project',
          projectTeams: {
            create: [{ teamId: team.id }],
          },
        },
      });

      const res = await request(app)
        .get('/api/projects')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Test Project');
      expect(res.body[0].teams).toHaveLength(1);
      expect(res.body[0].teams[0].name).toBe('Engineering');
      expect(res.body[0]._count).toBeDefined();
    });
  });

  describe('POST /api/projects', () => {
    it('creates project with 201', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'New Project' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('New Project');
      expect(res.body.status).toBe('planned');
      expect(res.body.teams).toEqual([]);
      expect(res.body.workspaceId).toEqual(expect.any(String));
      expect(res.body.key).toBe('NEWP');
      expect(res.body).toHaveProperty('id');
    });

    it('creates project with teamIds', async () => {
      const team = await prisma.team.create({
        data: { name: 'Design', key: 'PRJDSN' },
      });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'member' } });

      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Team Project', teamIds: [team.id] });

      expect(res.status).toBe(201);
      expect(res.body.teams).toHaveLength(1);
      expect(res.body.teams[0].id).toBe(team.id);
      expect(res.body.workspace).toBeDefined();
    });

    it('creates project access for the creator', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'ACL Project' });

      expect(res.status).toBe(201);

      const access = await prisma.projectAccess.findUnique({
        where: { projectId_userId: { projectId: res.body.id, userId: testUserId } },
      });
      expect(access?.permission).toBe('full');
    });

    it('does not create projects in an implicit viewer workspace', async () => {
      const viewer = await prisma.user.upsert({
        where: { githubId: '888892' },
        update: {},
        create: {
          githubId: '888892',
          username: 'implicitviewer',
          email: 'implicitviewer@example.com',
        },
      });
      const viewerToken = generateToken(viewer.id, viewer.username);
      const workspace = await prisma.workspace.create({
        data: { name: 'Implicit Viewer Workspace', slug: 'implicit-viewer-workspace' },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: viewer.id, role: 'viewer' },
      });

      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ name: 'Viewer Created Project' });

      expect(res.status).toBe(403);
      expect(res.body.resourceType).toBe('workspace');
      expect(res.body.requiredRoles).toEqual(['owner', 'admin', 'member']);
      await expect(
        prisma.project.findFirst({
          where: { name: 'Viewer Created Project', workspaceId: workspace.id },
        }),
      ).resolves.toBeNull();
    });

    it('creates project from an imported repository and updates the selected branch', async () => {
      const repo = await prisma.repository.create({
        data: {
          githubRepoId: 909001,
          name: 'imported',
          fullName: 'projecttester/imported',
          cloneUrl: 'https://github.com/projecttester/imported.git',
          defaultBranch: 'main',
          userId: testUserId,
        },
      });

      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Imported Repo Project', repositoryId: repo.id, defaultBranch: 'develop' });

      expect(res.status).toBe(201);
      expect(res.body.repositoryId).toBe(repo.id);
      expect(res.body.repoUrl).toBe('https://github.com/projecttester/imported');
      expect(res.body.repository.defaultBranch).toBe('develop');
    });

    it('accepts SSH clone URLs without fetching public repository metadata', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'SSH Repo Project',
          repoUrl: 'git@github.com:projecttester/private-app.git',
          defaultBranch: 'develop',
        });

      expect(res.status).toBe(201);
      expect(res.body.repoUrl).toBe('git@github.com:projecttester/private-app.git');
      expect(res.body.repositoryId).toEqual(expect.any(String));
      expect(res.body.repository.defaultBranch).toBe('develop');
      expect(res.body.repository.cloneUrl).toBe('git@github.com:projecttester/private-app.git');
    });

    it('validates status enum', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Bad Status', status: 'invalid_status' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/projects')
        .send({ name: 'No Auth' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('returns project with teams and task count when caller is a member', async () => {
      const team = await prisma.team.create({ data: { name: 'GetByIdTeam', key: 'GBI' } });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'member' } });
      const project = await prisma.project.create({
        data: { name: 'Find Me', projectTeams: { create: [{ teamId: team.id }] } },
      });

      const res = await request(app)
        .get(`/api/projects/${project.id}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Find Me');
      expect(res.body.teams).toBeDefined();
      expect(res.body._count.tasks).toBe(0);
    });

    it('returns 404 for non-existent project', async () => {
      const res = await request(app)
        .get('/api/projects/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/projects/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(401);
    });
  });

  describe('Project access endpoints', () => {
    it('lists and updates project access for workspace members', async () => {
      const workspace = await prisma.workspace.create({
        data: { name: 'Access Workspace', slug: 'access-workspace' },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: testUserId, role: 'owner' },
      });
      const secondUser = await prisma.user.upsert({
        where: { githubId: '888889' },
        update: {},
        create: {
          githubId: '888889',
          username: 'projectviewer',
          email: 'projectviewer@example.com',
        },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: secondUser.id, role: 'viewer' },
      });

      const project = await prisma.project.create({
        data: { name: 'ACL Target', workspaceId: workspace.id, key: 'ACLT' },
      });
      await prisma.projectAccess.create({
        data: { projectId: project.id, userId: testUserId, permission: 'full' },
      });

      const update = await request(app)
        .post(`/api/projects/${project.id}/access`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ userId: secondUser.id, permission: 'view' });

      expect(update.status).toBe(201);
      expect(update.body.permission).toBe('view');

      const list = await request(app)
        .get(`/api/projects/${project.id}/access`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(list.status).toBe(200);
      expect(list.body.some((row: { userId: string }) => row.userId === secondUser.id)).toBe(true);
    });

    it('does not honor stale project access after workspace membership is removed', async () => {
      const workspace = await prisma.workspace.create({
        data: { name: 'Stale Grant Workspace', slug: 'stale-grant-workspace' },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: testUserId, role: 'owner' },
      });
      const removedUser = await prisma.user.upsert({
        where: { githubId: '888894' },
        update: {},
        create: {
          githubId: '888894',
          username: 'removedworkspacemember',
          email: 'removedworkspacemember@example.com',
        },
      });
      const removedUserToken = generateToken(removedUser.id, removedUser.username);
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: removedUser.id, role: 'member' },
      });
      const project = await prisma.project.create({
        data: { name: 'Stale Grant Project', workspaceId: workspace.id, key: 'SGP' },
      });
      await prisma.projectAccess.create({
        data: { projectId: project.id, userId: removedUser.id, permission: 'view' },
      });
      await prisma.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: removedUser.id } },
      });

      const res = await request(app)
        .get(`/api/projects/${project.id}`)
        .set('Authorization', `Bearer ${removedUserToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /api/projects/:id', () => {
    it('updates project fields', async () => {
      const team = await prisma.team.create({ data: { name: 'PatchTeam', key: 'PCH' } });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'member' } });
      const project = await prisma.project.create({
        data: { name: 'Old Name', projectTeams: { create: [{ teamId: team.id }] } },
      });

      const res = await request(app)
        .patch(`/api/projects/${project.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'New Name', status: 'in_progress' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('New Name');
      expect(res.body.status).toBe('in_progress');
    });

    it('preserves project key when renaming without an explicit key change', async () => {
      const workspace = await prisma.workspace.create({
        data: { name: 'Stable Key Workspace', slug: 'stable-key-workspace' },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: testUserId, role: 'owner' },
      });
      const project = await prisma.project.create({
        data: { name: 'Stable Key Project', workspaceId: workspace.id, key: 'KEEP' },
      });

      const res = await request(app)
        .patch(`/api/projects/${project.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Renamed Stable Key Project' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed Stable Key Project');
      expect(res.body.key).toBe('KEEP');
    });

    it('replaces team associations when teamIds provided', async () => {
      const teamA = await prisma.team.create({ data: { name: 'Team A', key: 'PRJA' } });
      const teamB = await prisma.team.create({ data: { name: 'Team B', key: 'PRJB' } });
      await prisma.teamMember.create({ data: { teamId: teamA.id, userId: testUserId, role: 'member' } });
      await prisma.teamMember.create({ data: { teamId: teamB.id, userId: testUserId, role: 'member' } });

      const project = await prisma.project.create({
        data: {
          name: 'Multi Team',
          projectTeams: { create: [{ teamId: teamA.id }] },
        },
      });

      const res = await request(app)
        .patch(`/api/projects/${project.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ teamIds: [teamB.id] });

      expect(res.status).toBe(200);
      expect(res.body.teams).toHaveLength(1);
      expect(res.body.teams[0].id).toBe(teamB.id);
    });

    it('clears explicit project access when moving to another workspace', async () => {
      const oldWorkspace = await prisma.workspace.create({
        data: { name: 'Move Source Workspace', slug: 'move-source-workspace' },
      });
      const newWorkspace = await prisma.workspace.create({
        data: { name: 'Move Target Workspace', slug: 'move-target-workspace' },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: oldWorkspace.id, userId: testUserId, role: 'owner' },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: newWorkspace.id, userId: testUserId, role: 'owner' },
      });

      const oldMember = await prisma.user.upsert({
        where: { githubId: '888893' },
        update: {},
        create: {
          githubId: '888893',
          username: 'oldworkspacemember',
          email: 'oldworkspacemember@example.com',
        },
      });
      const oldMemberToken = generateToken(oldMember.id, oldMember.username);
      await prisma.workspaceMember.create({
        data: { workspaceId: oldWorkspace.id, userId: oldMember.id, role: 'member' },
      });

      const project = await prisma.project.create({
        data: { name: 'Moved ACL Project', workspaceId: oldWorkspace.id, key: 'MAP' },
      });
      await prisma.projectAccess.createMany({
        data: [
          { projectId: project.id, userId: testUserId, permission: 'full' },
          { projectId: project.id, userId: oldMember.id, permission: 'view' },
        ],
      });

      const res = await request(app)
        .patch(`/api/projects/${project.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ workspaceId: newWorkspace.id });

      expect(res.status).toBe(200);
      expect(res.body.workspaceId).toBe(newWorkspace.id);
      await expect(
        prisma.projectAccess.findMany({ where: { projectId: project.id } }),
      ).resolves.toEqual([]);

      const staleAccess = await request(app)
        .get(`/api/projects/${project.id}`)
        .set('Authorization', `Bearer ${oldMemberToken}`);
      expect(staleAccess.status).toBe(403);
    });

    it('returns 404 for non-existent project', async () => {
      const res = await request(app)
        .patch('/api/projects/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Nope' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('deletes project and unassigns tasks when caller is owner', async () => {
      const team = await prisma.team.create({ data: { name: 'DelTeam', key: 'DLT' } });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'owner' } });
      const project = await prisma.project.create({
        data: { name: 'To Delete', projectTeams: { create: [{ teamId: team.id }] } },
      });

      const task = await prisma.task.create({
        data: { title: 'Project Task', priority: 'medium', projectId: project.id },
      });

      const res = await request(app)
        .delete(`/api/projects/${project.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(204);

      const deletedProject = await prisma.project.findUnique({ where: { id: project.id } });
      expect(deletedProject).toBeNull();

      const updatedTask = await prisma.task.findUnique({ where: { id: task.id } });
      expect(updatedTask?.projectId).toBeNull();
    });

    it('returns 404 for non-existent project', async () => {
      const res = await request(app)
        .delete('/api/projects/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
    });
  });
});
