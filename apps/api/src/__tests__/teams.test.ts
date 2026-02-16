import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

function generateToken(userId: string, username: string = 'testuser') {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Teams API', () => {
  const app = createApp();
  let testUserId: string;
  let authToken: string;

  beforeAll(async () => {
    await prisma.teamMember.deleteMany({});
    await prisma.projectTeam.deleteMany({});
    await prisma.team.deleteMany({});

    const user = await prisma.user.upsert({
      where: { githubId: 999999 },
      update: {},
      create: {
        githubId: 999999,
        username: 'testuser',
        email: 'test@example.com',
        accessToken: 'fake-token',
      },
    });
    testUserId = user.id;
    authToken = generateToken(user.id, user.username);
  }, 30000);

  afterAll(async () => {
    await prisma.teamMember.deleteMany({});
    await prisma.projectTeam.deleteMany({});
    await prisma.team.deleteMany({});
  }, 30000);

  describe('GET /api/teams', () => {
    it('returns array (may be empty initially)', async () => {
      const res = await request(app).get('/api/teams');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('POST /api/teams', () => {
    it('creates team with 201', async () => {
      const res = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Engineering', key: 'ENG' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Engineering');
      expect(res.body.key).toBe('ENG');
      expect(res.body.members).toHaveLength(1);
      expect(res.body.members[0].role).toBe('owner');
      expect(res.body.members[0].userId).toBe(testUserId);
    });

    it('validates key format', async () => {
      const res = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Bad Team', key: 'bad' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'No Auth', key: 'NA' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/teams (after creation)', () => {
    it('returns teams including the created one', async () => {
      const res = await request(app)
        .get('/api/teams')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      const eng = res.body.find((t: { key: string }) => t.key === 'ENG');
      expect(eng).toBeDefined();
      expect(eng.name).toBe('Engineering');
      expect(eng._count).toBeDefined();
    });
  });

  describe('PATCH /api/teams/:id', () => {
    it('updates team via API', async () => {
      const createRes = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Patch Target', key: 'PAT' });
      expect(createRes.status).toBe(201);
      const teamId = createRes.body.id;

      const getRes = await request(app).get(`/api/teams/${teamId}`);
      expect(getRes.status).toBe(200);

      const res = await request(app)
        .patch(`/api/teams/${teamId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Name');
    });

    it('returns 404 for non-existent team', async () => {
      const res = await request(app)
        .patch('/api/teams/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Nope' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/teams/:id', () => {
    it('deletes team', async () => {
      const createRes = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'To Delete', key: 'DEL' });
      expect(createRes.status).toBe(201);
      const teamId = createRes.body.id;

      const getRes = await request(app).get(`/api/teams/${teamId}`);
      expect(getRes.status).toBe(200);

      const res = await request(app)
        .delete(`/api/teams/${teamId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(204);
    });

    it('returns 404 for non-existent team', async () => {
      const res = await request(app)
        .delete('/api/teams/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/teams/:id', () => {
    it('returns team with members and project teams', async () => {
      const createRes = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Detail Team', key: 'DTL' });
      expect(createRes.status).toBe(201);

      const res = await request(app).get(`/api/teams/${createRes.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Detail Team');
      expect(res.body.members).toHaveLength(1);
      expect(res.body.projectTeams).toBeDefined();
    });

    it('returns 404 for non-existent team', async () => {
      const res = await request(app).get('/api/teams/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/teams/:id/members', () => {
    it('adds member with valid userId', async () => {
      const createRes = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Member Team', key: 'MBR' });
      expect(createRes.status).toBe(201);

      const secondUser = await prisma.user.upsert({
        where: { githubId: 666666 },
        update: {},
        create: {
          githubId: 666666,
          username: 'seconduser',
          email: 'second@example.com',
          accessToken: 'fake-token-2',
        },
      });

      const res = await request(app)
        .post(`/api/teams/${createRes.body.id}/members`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ userId: secondUser.id, role: 'admin' });

      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(secondUser.id);
      expect(res.body.role).toBe('admin');
      expect(res.body.user).toBeDefined();
    });

    it('returns 404 with unknown email', async () => {
      const createRes = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Email Team', key: 'EML' });
      expect(createRes.status).toBe(201);

      const res = await request(app)
        .post(`/api/teams/${createRes.body.id}/members`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ email: 'nobody@example.com' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('User not found');
    });

    it('returns 400 without email or userId', async () => {
      const createRes = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Validate Team', key: 'VAL' });
      expect(createRes.status).toBe(201);

      const res = await request(app)
        .post(`/api/teams/${createRes.body.id}/members`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ role: 'member' });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/teams/:id/members/:userId', () => {
    it('removes member', async () => {
      const createRes = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Remove Member Team', key: 'RMV' });
      expect(createRes.status).toBe(201);

      const res = await request(app)
        .delete(`/api/teams/${createRes.body.id}/members/${testUserId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(204);
    });
  });
});
