import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';

describe('Tasks API', () => {
  const app = createApp();
  let createdTaskId: string;

  beforeAll(async () => {
    await prisma.taskLabel.deleteMany({});
    await prisma.task.updateMany({ where: { teamId: { not: null } }, data: { teamId: null, projectId: null } });
    await prisma.task.deleteMany({});
    await prisma.team.deleteMany({});
  }, 30000);

  afterAll(async () => {
    await prisma.taskLabel.deleteMany({});
    await prisma.task.updateMany({ where: { teamId: { not: null } }, data: { teamId: null, projectId: null } });
    await prisma.task.deleteMany({});
    await prisma.team.deleteMany({});
  }, 30000);

  describe('GET /api/tasks', () => {
    it('returns empty array when no tasks exist', async () => {
      const res = await request(app).get('/api/tasks');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns tasks when they exist', async () => {
      await prisma.task.create({
        data: {
          title: 'Test Task',
          priority: 'medium',
        },
      });

      const res = await request(app).get('/api/tasks');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe('Test Task');
    });

    it('filters tasks by teamId', async () => {
      const team = await prisma.team.create({
        data: { name: 'Filter Team', key: 'FLT' },
      });

      await prisma.task.create({ data: { title: 'Team Task', priority: 'medium', teamId: team.id } });
      await prisma.task.create({ data: { title: 'No Team Task', priority: 'medium' } });

      const res = await request(app).get(`/api/tasks?teamId=${team.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe('Team Task');
    });
  });

  describe('POST /api/tasks', () => {
    it('creates a new task', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: 'New Task' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('New Task');
      expect(res.body.priority).toBe('medium');
      expect(res.body.status).toBe('todo');
      expect(res.body).toHaveProperty('id');
      createdTaskId = res.body.id;
    });

    it('creates a new task without teamId (backward compat)', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: 'No Team Task' });

      expect(res.status).toBe(201);
      expect(res.body.teamId).toBeNull();
      expect(res.body.identifier).toBeNull();
      expect(res.body.number).toBeNull();
    });

    it('creates a task with teamId and generates identifier', async () => {
      const team = await prisma.team.create({
        data: { name: 'Engineering', key: 'TENG' },
      });

      const res = await request(app)
        .post('/api/tasks')
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

      const res1 = await request(app)
        .post('/api/tasks')
        .send({ title: 'First', teamId: team.id });
      const res2 = await request(app)
        .post('/api/tasks')
        .send({ title: 'Second', teamId: team.id });

      expect(res1.body.identifier).toBe('SEQ-1');
      expect(res2.body.identifier).toBe('SEQ-2');
    });

    it('returns 400 for invalid teamId', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: 'Bad Team', teamId: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Team not found');
    });

    it('returns 400 for invalid data', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('GET /api/tasks/:id', () => {
    it('returns a task by id', async () => {
      const task = await prisma.task.create({
        data: {
          title: 'Find Me',
          priority: 'high',
        },
      });

      const res = await request(app).get(`/api/tasks/${task.id}`);

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Find Me');
      expect(res.body.priority).toBe('high');
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).get('/api/tasks/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Task not found');
    });
  });

  describe('PATCH /api/tasks/:id', () => {
    it('updates a task', async () => {
      const task = await prisma.task.create({
        data: {
          title: 'Update Me',
          priority: 'low',
        },
      });

      const res = await request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({ title: 'Updated Title', status: 'in_progress' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Updated Title');
      expect(res.body.status).toBe('in_progress');
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app)
        .patch('/api/tasks/00000000-0000-0000-0000-000000000000')
        .send({ title: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/tasks/:id', () => {
    it('archives a task', async () => {
      const task = await prisma.task.create({
        data: {
          title: 'Delete Me',
          priority: 'medium',
        },
      });

      const res = await request(app).delete(`/api/tasks/${task.id}`);

      expect(res.status).toBe(204);

      const archived = await prisma.task.findUnique({ where: { id: task.id } });
      expect(archived).not.toBeNull();
      expect(archived!.archived).toBe(true);
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).delete('/api/tasks/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });
});
