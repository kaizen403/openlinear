import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

function generateToken(userId: string, username: string = 'testuser') {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Tasks API', () => {
  const app = createApp();
  let testUserId: string;
  let authToken: string;
  let testTeamId: string;
  let testProjectId: string;

  beforeAll(async () => {
    await prisma.personalAccessToken.deleteMany({});
    await prisma.projectAccess.deleteMany({});
    await prisma.taskLabel.deleteMany({});
    await prisma.task.updateMany({ where: { teamId: { not: null } }, data: { teamId: null, projectId: null } });
    await prisma.task.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.workspaceMember.deleteMany({});
    await prisma.workspace.deleteMany({});
    await prisma.teamMember.deleteMany({});
    await prisma.team.deleteMany({});

    const user = await prisma.user.upsert({
      where: { githubId: '777777' },
      update: {},
      create: {
        githubId: '777777',
        username: 'tasktester',
        email: 'tasktest@example.com',
        accessToken: 'fake-token',
      },
    });
    testUserId = user.id;
    authToken = generateToken(user.id, user.username);

    const workspace = await prisma.workspace.create({
      data: { name: 'Task Test Workspace', slug: 'task-test-workspace' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: testUserId, role: 'owner' },
    });
    const project = await prisma.project.create({
      data: { name: 'Task Test Project', workspaceId: workspace.id, key: 'TTPR' },
    });
    testProjectId = project.id;
    await prisma.projectAccess.create({
      data: { projectId: project.id, userId: testUserId, permission: 'full' },
    });

    const team = await prisma.team.create({
      data: { name: 'Task Test Team', key: 'TTT', projectId: testProjectId },
    });
    testTeamId = team.id;

    await prisma.teamMember.create({
      data: { teamId: team.id, userId: testUserId, role: 'owner' },
    });
  }, 30000);

  afterAll(async () => {
    await prisma.personalAccessToken.deleteMany({});
    await prisma.projectAccess.deleteMany({});
    await prisma.taskLabel.deleteMany({});
    await prisma.task.updateMany({ where: { teamId: { not: null } }, data: { teamId: null, projectId: null } });
    await prisma.task.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.workspaceMember.deleteMany({});
    await prisma.workspace.deleteMany({});
    await prisma.teamMember.deleteMany({});
    await prisma.team.deleteMany({});
  }, 30000);

  describe('GET /api/tasks', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(401);
    });

    it('returns tasks scoped to caller teams', async () => {
      await prisma.task.create({
        data: {
          title: 'Test Task',
          priority: 'medium',
          teamId: testTeamId,
        },
      });

      const res = await request(app)
        .get('/api/tasks')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      expect(res.body.items.some((t: { title: string }) => t.title === 'Test Task')).toBe(true);
    });

    it('filters tasks by teamId when caller is a member', async () => {
      const team = await prisma.team.create({
            data: { name: 'Filter Team', key: 'FLT', projectId: testProjectId },
          });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'member' } });

      await prisma.task.create({ data: { title: 'Team Task', priority: 'medium', teamId: team.id } });

      const res = await request(app)
        .get(`/api/tasks?teamId=${team.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.items.some((t: { title: string }) => t.title === 'Team Task')).toBe(true);
    });

    it('rejects teamId filter when caller is not a member', async () => {
      const otherTeam = await prisma.team.create({
            data: { name: 'Other', key: 'OTH', projectId: testProjectId },
          });

      const res = await request(app)
        .get(`/api/tasks?teamId=${otherTeam.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
    });

    it('excludes tasks from projects with explicit deny access', async () => {
      const workspace = await prisma.workspace.create({
        data: { name: 'Task Deny Workspace', slug: 'task-deny-workspace' },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: testUserId, role: 'owner' },
      });
      const project = await prisma.project.create({
        data: {
          name: 'Denied Task Project',
          workspaceId: workspace.id,
          key: 'DTP',
          
        },
      });
      await prisma.projectAccess.create({
        data: { projectId: project.id, userId: testUserId, permission: 'deny' },
      });
      await prisma.task.create({
        data: {
          title: 'Hidden Denied Project Task',
          priority: 'medium',
          teamId: testTeamId,
          projectId: project.id,
        },
      });

      const list = await request(app)
        .get('/api/tasks')
        .set('Authorization', `Bearer ${authToken}`);
      expect(list.status).toBe(200);
      expect(
        list.body.items.some((task: { title: string }) => task.title === 'Hidden Denied Project Task'),
      ).toBe(false);

      const filtered = await request(app)
        .get(`/api/tasks?projectId=${project.id}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(filtered.status).toBe(403);
    });

    it('includes project-accessible tasks for workspace users who are not team members', async () => {
      const workspaceOnlyUser = await prisma.user.upsert({
        where: { githubId: '777778' },
        update: {},
        create: {
          githubId: '777778',
          username: 'workspaceonlytaskuser',
          email: 'workspaceonlytaskuser@example.com',
        },
      });
      const workspaceOnlyToken = generateToken(workspaceOnlyUser.id, workspaceOnlyUser.username);
      const workspace = await prisma.workspace.create({
        data: { name: 'Workspace Task List', slug: 'workspace-task-list' },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: workspaceOnlyUser.id, role: 'viewer' },
      });
      const project = await prisma.project.create({
        data: {
          name: 'Workspace Visible Project',
          workspaceId: workspace.id,
          key: 'WVP',
          
        },
      });
      await prisma.task.createMany({
        data: [
          {
            title: 'Workspace Visible Team Task',
            priority: 'medium',
            teamId: testTeamId,
            projectId: project.id,
          },
          {
            title: 'Workspace Visible Project Task',
            priority: 'medium',
            projectId: project.id,
          },
        ],
      });

      const res = await request(app)
        .get('/api/tasks')
        .set('Authorization', `Bearer ${workspaceOnlyToken}`);

      expect(res.status).toBe(200);
      const titles = res.body.items.map((task: { title: string }) => task.title);
      expect(titles).toContain('Workspace Visible Team Task');
      expect(titles).toContain('Workspace Visible Project Task');
    });
  });

  describe('POST /api/tasks', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/tasks').send({ title: 'unauth' });
      expect(res.status).toBe(401);
    });

    it('rejects creating a task with no team or project', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'No Team Task' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('creates a task with teamId and generates identifier', async () => {
      const team = await prisma.team.create({
            data: { name: 'Engineering', key: 'TENG', projectId: testProjectId },
          });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'owner' } });

      const res = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'Team Task', teamId: team.id });

      expect(res.status).toBe(201);
      expect(res.body.teamId).toBe(team.id);
      expect(res.body.identifier).toBe('TENG-1');
      expect(res.body.number).toBe(1);
      expect(res.body.team).toBeDefined();
      expect(res.body.team.key).toBe('TENG');
    });

    it('increments identifier for subsequent tasks in the same team', async () => {
      const team = await prisma.team.create({
            data: { name: 'Engineering', key: 'SEQ', projectId: testProjectId },
          });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'owner' } });

      const res1 = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'First', teamId: team.id });
      const res2 = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'Second', teamId: team.id });

      expect(res1.body.identifier).toBe('SEQ-1');
      expect(res2.body.identifier).toBe('SEQ-2');
    });

    it('rejects creating a task in a team the caller is not a member of', async () => {
      const otherTeam = await prisma.team.create({
            data: { name: 'Foreign', key: 'FRG', projectId: testProjectId },
          });

      const res = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'Forbidden', teamId: otherTeam.id });

      // Membership-existence is collapsed to 404 to avoid leaking which teams exist.
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
    });

    it('returns 400 for invalid data', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: '' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/tasks/bulk', () => {
    it('creates tasks with sequential gapless identifiers', async () => {
      const team = await prisma.team.create({
        data: { name: 'Bulk Team', key: 'BLK' },
      });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'owner' } });
      const project = await prisma.project.create({
        data: {
          name: 'Bulk Project',
          projectTeams: { create: [{ teamId: team.id }] },
        },
      });

      const res = await request(app)
        .post('/api/tasks/bulk')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          projectId: project.id,
          tasks: Array.from({ length: 5 }, (_, index) => ({
            title: `Bulk task ${index + 1}`,
          })),
        });

      expect(res.status).toBe(201);
      expect(res.body.failed).toEqual([]);
      expect(res.body.created.map((task: { identifier: string }) => task.identifier)).toEqual([
        'BLK-1',
        'BLK-2',
        'BLK-3',
        'BLK-4',
        'BLK-5',
      ]);

      const updatedTeam = await prisma.team.findUnique({ where: { id: team.id } });
      expect(updatedTeam?.nextIssueNumber).toBe(6);
    });

    it('enforces the 100 task cap before creating anything', async () => {
      const team = await prisma.team.create({
        data: { name: 'Bulk Cap Team', key: 'BCP' },
      });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'owner' } });
      const project = await prisma.project.create({
        data: {
          name: 'Bulk Cap Project',
          projectTeams: { create: [{ teamId: team.id }] },
        },
      });

      const before = await prisma.task.count({ where: { projectId: project.id } });
      const res = await request(app)
        .post('/api/tasks/bulk')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          projectId: project.id,
          tasks: Array.from({ length: 101 }, (_, index) => ({
            title: `Too many ${index + 1}`,
          })),
        });

      expect(res.status).toBe(400);
      await expect(prisma.task.count({ where: { projectId: project.id } })).resolves.toBe(before);
    });

    it('returns 404 for an invalid project and 403 for inaccessible projects', async () => {
      const missing = await request(app)
        .post('/api/tasks/bulk')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          projectId: '00000000-0000-0000-0000-000000000000',
          tasks: [{ title: 'No project' }],
        });
      expect(missing.status).toBe(404);

      const otherUser = await prisma.user.upsert({
        where: { githubId: '777780' },
        update: {},
        create: {
          githubId: '777780',
          username: 'bulkforbidden',
          email: 'bulkforbidden@example.com',
        },
      });
      const otherToken = generateToken(otherUser.id, otherUser.username);
      const team = await prisma.team.create({
        data: { name: 'Bulk Forbidden Team', key: 'BFD' },
      });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'owner' } });
      const project = await prisma.project.create({
        data: {
          name: 'Bulk Forbidden Project',
          projectTeams: { create: [{ teamId: team.id }] },
        },
      });

      const forbidden = await request(app)
        .post('/api/tasks/bulk')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({
          projectId: project.id,
          tasks: [{ title: 'Forbidden' }],
        });
      expect(forbidden.status).toBe(403);
    });

    it('partially succeeds when some tasks reference invalid labels', async () => {
      const team = await prisma.team.create({
        data: { name: 'Bulk Label Team', key: 'BLB' },
      });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'owner' } });
      const project = await prisma.project.create({
        data: {
          name: 'Bulk Label Project',
          projectTeams: { create: [{ teamId: team.id }] },
        },
      });
      const label = await prisma.label.create({
        data: { name: 'phase:1 - Foundation', color: '#3B82F6', teamId: team.id },
      });

      const res = await request(app)
        .post('/api/tasks/bulk')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          projectId: project.id,
          tasks: [
            { title: 'Valid labelled task', labelIds: [label.id] },
            { title: 'Invalid labelled task', labelIds: ['00000000-0000-0000-0000-000000000000'] },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.created).toHaveLength(1);
      expect(res.body.created[0].labels).toEqual([
        expect.objectContaining({ id: label.id, name: label.name }),
      ]);
      expect(res.body.failed).toEqual([
        { index: 1, error: 'Invalid labelIds: 00000000-0000-0000-0000-000000000000' },
      ]);
      await expect(prisma.task.count({ where: { projectId: project.id } })).resolves.toBe(1);
    });

    it('accepts PATs with tasks:write scope', async () => {
      const team = await prisma.team.create({
        data: { name: 'Bulk PAT Team', key: 'BPT' },
      });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: testUserId, role: 'owner' } });
      const project = await prisma.project.create({
        data: {
          name: 'Bulk PAT Project',
          projectTeams: { create: [{ teamId: team.id }] },
        },
      });
      const pat = await request(app)
        .post('/api/pats')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Bulk writer', scopes: ['tasks:write'] });

      const res = await request(app)
        .post('/api/tasks/bulk')
        .set('Authorization', `Bearer ${pat.body.token}`)
        .send({
          projectId: project.id,
          tasks: [{ title: 'PAT-created task' }],
        });

      expect(res.status).toBe(201);
      expect(res.body.created).toHaveLength(1);
      expect(res.body.created[0].title).toBe('PAT-created task');
    });
  });

  describe('GET /api/tasks/:id', () => {
    it('returns 401 without auth', async () => {
      const task = await prisma.task.create({
        data: { title: 'NoAuthGet', priority: 'medium', teamId: testTeamId },
      });
      const res = await request(app).get(`/api/tasks/${task.id}`);
      expect(res.status).toBe(401);
    });

    it('returns a task by id when caller owns it', async () => {
      const task = await prisma.task.create({
        data: { title: 'Find Me', priority: 'high', teamId: testTeamId },
      });

      const res = await request(app)
        .get(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Find Me');
      expect(res.body.priority).toBe('high');
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app)
        .get('/api/tasks/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
    });
  });

  describe('PATCH /api/tasks/:id', () => {
    it('updates a task the caller owns', async () => {
      const task = await prisma.task.create({
        data: { title: 'Update Me', priority: 'low', teamId: testTeamId },
      });

      const res = await request(app)
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'Updated Title', status: 'in_progress' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Updated Title');
      expect(res.body.status).toBe('in_progress');
    });

    it('clears execution state when moving to a terminal status', async () => {
      const task = await prisma.task.create({
        data: {
          title: 'Finish Me',
          priority: 'medium',
          status: 'in_progress',
          teamId: testTeamId,
          sessionId: 'session-123',
          executionStartedAt: new Date(),
          executionPausedAt: new Date(),
          executionElapsedMs: 42_000,
          executionProgress: 65,
        },
      });

      const res = await request(app)
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'done' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('done');
      expect(res.body.sessionId).toBeNull();
      expect(res.body.executionStartedAt).toBeNull();
      expect(res.body.executionPausedAt).toBeNull();
      expect(res.body.executionElapsedMs).toBe(0);
      expect(res.body.executionProgress).toBeNull();
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app)
        .patch('/api/tasks/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/tasks/:id', () => {
    it('archives a task the caller owns', async () => {
      const task = await prisma.task.create({
        data: { title: 'Delete Me', priority: 'medium', teamId: testTeamId },
      });

      const res = await request(app)
        .delete(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(204);

      const archived = await prisma.task.findUnique({ where: { id: task.id } });
      expect(archived).not.toBeNull();
      expect(archived!.archived).toBe(true);
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app)
        .delete('/api/tasks/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('Cross-tenant isolation', () => {
    it('prevents user B from PATCHing user A\'s task', async () => {
      const userB = await prisma.user.upsert({
        where: { githubId: '555555' },
        update: {},
        create: { githubId: '555555', username: 'userB', email: 'b@example.com' },
      });
      const tokenB = generateToken(userB.id, userB.username);

      const aTask = await prisma.task.create({
        data: { title: 'A only', priority: 'medium', teamId: testTeamId },
      });

      const res = await request(app)
        .patch(`/api/tasks/${aTask.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ title: 'hijacked' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
    });

    it('archived delete is scoped to caller teams', async () => {
      const userB = await prisma.user.upsert({
        where: { githubId: '444444' },
        update: {},
        create: { githubId: '444444', username: 'userBarchive', email: 'barch@example.com' },
      });
      const tokenB = generateToken(userB.id, userB.username);
      const teamB = await prisma.team.create({ data: { name: 'B Team', key: 'BBB', projectId: testProjectId } });
      await prisma.teamMember.create({ data: { teamId: teamB.id, userId: userB.id, role: 'owner' } });

      await prisma.task.create({
        data: { title: 'A archived', priority: 'medium', teamId: testTeamId, archived: true },
      });
      await prisma.task.create({
        data: { title: 'B archived', priority: 'medium', teamId: teamB.id, archived: true },
      });

      const before = await prisma.task.count({ where: { archived: true, teamId: teamB.id } });
      expect(before).toBeGreaterThan(0);

      const del = await request(app)
        .delete('/api/tasks/archived')
        .set('Authorization', `Bearer ${authToken}`);
      expect(del.status).toBe(204);

      const after = await prisma.task.count({ where: { archived: true, teamId: teamB.id } });
      expect(after).toBe(before);

      const aRemaining = await prisma.task.count({ where: { archived: true, teamId: testTeamId } });
      expect(aRemaining).toBe(0);
    });
  });

  describe('DELETE /api/tasks/archived', () => {
    it('does not bulk-delete archived project tasks for read-only project users', async () => {
      const viewer = await prisma.user.upsert({
        where: { githubId: '777779' },
        update: {},
        create: {
          githubId: '777779',
          username: 'archiveviewer',
          email: 'archiveviewer@example.com',
        },
      });
      const viewerToken = generateToken(viewer.id, viewer.username);
      await prisma.teamMember.create({
        data: { teamId: testTeamId, userId: viewer.id, role: 'member' },
      });
      const workspace = await prisma.workspace.create({
        data: { name: 'Archive Viewer Workspace', slug: 'archive-viewer-workspace' },
      });
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: viewer.id, role: 'viewer' },
      });
      const project = await prisma.project.create({
        data: {
          name: 'Archive Viewer Project',
          workspaceId: workspace.id,
          key: 'AVP',
          
        },
      });
      const task = await prisma.task.create({
        data: {
          title: 'Read Only Archived Project Task',
          priority: 'medium',
          archived: true,
          teamId: testTeamId,
          projectId: project.id,
        },
      });

      const res = await request(app)
        .delete('/api/tasks/archived')
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(204);
      await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toBeDefined();
    });
  });
});
