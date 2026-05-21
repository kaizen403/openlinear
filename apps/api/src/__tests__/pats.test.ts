import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';
import {
  generatePersonalAccessToken,
  hashPersonalAccessToken,
} from '../services/pats';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

function generateJwt(userId: string, username: string) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Personal access tokens', () => {
  const app = createApp();
  let testUserId: string;
  let authToken: string;

  beforeAll(async () => {
    await prisma.personalAccessToken.deleteMany({});
    const user = await prisma.user.upsert({
      where: { githubId: '990001' },
      update: {},
      create: {
        githubId: '990001',
        username: 'pattester',
        email: 'pattester@example.com',
      },
    });
    testUserId = user.id;
    authToken = generateJwt(user.id, user.username);
  });

  afterAll(async () => {
    await prisma.personalAccessToken.deleteMany({ where: { userId: testUserId } });
  });

  it('creates a PAT once, stores only its hash, and lists only metadata', async () => {
    const created = await request(app)
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'OpenCode MCP' });

    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^ol_pat_[a-f0-9]{32}$/);
    expect(created.body.prefix).toBe(created.body.token.slice(0, 15));
    expect(created.body.scopes).toEqual(['*']);

    const stored = await prisma.personalAccessToken.findUnique({
      where: { id: created.body.id },
      select: { tokenHash: true, tokenPrefix: true },
    });
    expect(stored?.tokenHash).toBe(hashPersonalAccessToken(created.body.token));
    expect(stored?.tokenHash).not.toBe(created.body.token);
    expect(stored?.tokenPrefix).toBe(created.body.prefix);

    const list = await request(app)
      .get('/api/pats')
      .set('Authorization', `Bearer ${authToken}`);

    expect(list.status).toBe(200);
    const tokenRow = list.body.find((row: { id: string }) => row.id === created.body.id);
    expect(tokenRow).toMatchObject({
      id: created.body.id,
      name: 'OpenCode MCP',
      prefix: created.body.prefix,
      scopes: ['*'],
    });
    expect(tokenRow).not.toHaveProperty('token');
  });

  it('authenticates API requests with a valid PAT and updates lastUsedAt', async () => {
    const created = await request(app)
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Workspace reader', scopes: ['workspaces:read'] });

    const res = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${created.body.token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await prisma.personalAccessToken.findUnique({
      where: { id: created.body.id },
      select: { lastUsedAt: true },
    });
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('rejects revoked, expired, and underscoped PATs', async () => {
    const created = await request(app)
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Revoked token' });

    const revoked = await request(app)
      .delete(`/api/pats/${created.body.id}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(revoked.status).toBe(204);

    const revokedUse = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${created.body.token}`);
    expect(revokedUse.status).toBe(401);

    const revokedUseOnOptionalRoute = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${created.body.token}`);
    expect(revokedUseOnOptionalRoute.status).toBe(401);

    const expiredToken = generatePersonalAccessToken();
    await prisma.personalAccessToken.create({
      data: {
        userId: testUserId,
        name: 'Expired token',
        tokenHash: hashPersonalAccessToken(expiredToken),
        tokenPrefix: expiredToken.slice(0, 15),
        scopes: ['*'],
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const expiredUse = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(expiredUse.status).toBe(401);

    const underscoped = await request(app)
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Read only', scopes: ['projects:read'] });

    const forbidden = await request(app)
      .post('/api/tasks/bulk')
      .set('Authorization', `Bearer ${underscoped.body.token}`)
      .send({});
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('INSUFFICIENT_SCOPE');
  });
});
