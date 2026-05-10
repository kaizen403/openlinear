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

  beforeAll(async () => {
    await prisma.taskLabel.deleteMany({});
    await prisma.task.updateMany({ where: { teamId: { not: null } }, data: { teamId: null, projectId: null } });
    await prisma.task.deleteMany({});
    await prisma.teamMember.deleteMany({});
    await prisma.team.deleteMany({});

    const user = await prisma.user.upsert({
      where: { githubId: 777777 },
      update: {},
      create: {
        githubId: 777777,
        username: 'tasktester',
        email: 'tasktest@example.com',
        accessToken: 'fake-token',
      },
    });
    testUserId = user.id;
    authToken = generateToken(user.id, user.username);

    const team = await prisma.team.create({
      data: { name: 'Task Test Team', key: 'TTT' },
    });
    testTeamId = team.id;

    await prisma.teamMember.create({
      data: { teamId: team.id, userId: testUserId, role: 'owner' },
    });
  }, 30000);

  afterAll(async () => {
    await prisma.taskLabel.deleteMany({});
    await prisma.task.updateMany({ where: { teamId: { not: null } }, data: { teamId: null, projectId: null } });
    await prisma.task.deleteMany({});
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
        data: { name: 'Filter Team', key: 'FLT' },
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
        data: { name: 'Other', key: 'OTH' },
      });

      const res = await request(app)
        .get(`/api/tasks?teamId=${otherTeam.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
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
      expect(res.body.error).toBe('validation_error');
    });

    it('creates a task with teamId and generates identifier', async () => {
      const team = await prisma.team.create({
        data: { name: 'Engineering', key: 'TENG' },
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
        data: { name: 'Engineering', key: 'SEQ' },
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
        data: { name: 'Foreign', key: 'FRG' },
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
      expect(res.body.error).toBe('validation_error');
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
        where: { githubId: 555555 },
        update: {},
        create: { githubId: 555555, username: 'userB', email: 'b@example.com' },
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
        where: { githubId: 444444 },
        update: {},
        create: { githubId: 444444, username: 'userBarchive', email: 'barch@example.com' },
      });
      const tokenB = generateToken(userB.id, userB.username);
      const teamB = await prisma.team.create({ data: { name: 'B Team', key: 'BBB' } });
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
});
