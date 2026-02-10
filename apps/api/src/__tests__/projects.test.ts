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
    await prisma.projectTeam.deleteMany({});
    await prisma.task.updateMany({
      where: { projectId: { not: null } },
      data: { projectId: null },
    });
    await prisma.project.deleteMany({});
    await prisma.teamMember.deleteMany({});
    await prisma.team.deleteMany({});

    const user = await prisma.user.upsert({
      where: { githubId: 888888 },
      update: {},
      create: {
        githubId: 888888,
        username: 'projecttester',
        email: 'projecttest@example.com',
        accessToken: 'fake-token',
      },
    });
    testUserId = user.id;
    authToken = generateToken(user.id, user.username);
  }, 30000);

  afterAll(async () => {
    await prisma.projectTeam.deleteMany({});
    await prisma.task.updateMany({
      where: { projectId: { not: null } },
      data: { projectId: null },
    });
    await prisma.project.deleteMany({});
    await prisma.teamMember.deleteMany({});
    await prisma.team.deleteMany({});
  }, 30000);

  describe('GET /api/projects', () => {
    it('returns empty array when no projects exist', async () => {
      const res = await request(app).get('/api/projects');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns projects with teams array', async () => {
      const team = await prisma.team.create({
        data: { name: 'Engineering', key: 'PRJENG' },
      });

      await prisma.project.create({
        data: {
          name: 'Test Project',
          projectTeams: {
            create: [{ teamId: team.id }],
          },
        },
      });

      const res = await request(app).get('/api/projects');
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
      expect(res.body).toHaveProperty('id');
    });

    it('creates project with teamIds', async () => {
      const team = await prisma.team.create({
        data: { name: 'Design', key: 'PRJDSN' },
      });

      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Team Project', teamIds: [team.id] });

      expect(res.status).toBe(201);
      expect(res.body.teams).toHaveLength(1);
      expect(res.body.teams[0].id).toBe(team.id);
    });

    it('validates status enum', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Bad Status', status: 'invalid_status' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/projects')
        .send({ name: 'No Auth' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('returns project with teams and task count', async () => {
      const project = await prisma.project.create({
        data: { name: 'Find Me' },
      });

      const res = await request(app).get(`/api/projects/${project.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Find Me');
      expect(res.body.teams).toBeDefined();
      expect(res.body._count.tasks).toBe(0);
    });

    it('returns 404 for non-existent project', async () => {
      const res = await request(app).get('/api/projects/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/projects/:id', () => {
    it('updates project fields', async () => {
      const project = await prisma.project.create({
        data: { name: 'Old Name' },
      });

      const res = await request(app)
        .patch(`/api/projects/${project.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'New Name', status: 'in_progress' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('New Name');
      expect(res.body.status).toBe('in_progress');
    });

    it('replaces team associations when teamIds provided', async () => {
      const teamA = await prisma.team.create({ data: { name: 'Team A', key: 'PRJA' } });
      const teamB = await prisma.team.create({ data: { name: 'Team B', key: 'PRJB' } });

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

    it('returns 404 for non-existent project', async () => {
      const res = await request(app)
        .patch('/api/projects/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Nope' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('deletes project and unassigns tasks', async () => {
      const project = await prisma.project.create({
        data: { name: 'To Delete' },
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
