import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';
import {
  generatePersonalAccessToken,
  hashPersonalAccessToken,
} from '../services/pats';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const JWT_SECRET = testJwtSecret();

function generateJwt(userId: string, username: string) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Personal access tokens', () => {
  const app = createApp();
  const http = useTestServer(() => app);
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
    const created = await http()
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'OpenCode MCP', scopes: ['tasks:read', 'tasks:write'] });

    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^ol_pat_[a-f0-9]{32}$/);
    expect(created.body.prefix).toBe(created.body.token.slice(0, 15));
    expect(created.body.scopes).toEqual(['tasks:read', 'tasks:write']);

    const stored = await prisma.personalAccessToken.findUnique({
      where: { id: created.body.id },
      select: { tokenHash: true, tokenPrefix: true },
    });
    expect(stored?.tokenHash).toBe(hashPersonalAccessToken(created.body.token));
    expect(stored?.tokenHash).not.toBe(created.body.token);
    expect(stored?.tokenPrefix).toBe(created.body.prefix);

    const list = await http()
      .get('/api/pats')
      .set('Authorization', `Bearer ${authToken}`);

    expect(list.status).toBe(200);
    const tokenRow = list.body.find((row: { id: string }) => row.id === created.body.id);
    expect(tokenRow).toMatchObject({
      id: created.body.id,
      name: 'OpenCode MCP',
      prefix: created.body.prefix,
      scopes: ['tasks:read', 'tasks:write'],
    });
    expect(tokenRow).not.toHaveProperty('token');
  });

  it('authenticates API requests with a valid PAT and updates lastUsedAt', async () => {
    const created = await http()
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Workspace reader', scopes: ['workspaces:read'] });

    const res = await http()
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
    const created = await http()
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Revoked token', scopes: ['tasks:read'] });

    const revoked = await http()
      .delete(`/api/pats/${created.body.id}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(revoked.status).toBe(204);

    const revokedUse = await http()
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${created.body.token}`);
    expect(revokedUse.status).toBe(401);

    const revokedUseOnOptionalRoute = await http()
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
    const expiredUse = await http()
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(expiredUse.status).toBe(401);

    const underscoped = await http()
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Read only', scopes: ['projects:read'] });

    const forbidden = await http()
      .post('/api/tasks/bulk')
      .set('Authorization', `Bearer ${underscoped.body.token}`)
      .send({});
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('requires explicit scopes and rejects the wildcard scope', async () => {
    // `scopes` used to default to ['*'], so a token created for one integration
    // authorised every route in the API.
    const noScopes = await http()
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'No scopes' });
    expect(noScopes.status).toBe(400);

    const wildcard = await http()
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Wildcard', scopes: ['*'] });
    expect(wildcard.status).toBe(400);
  });

  it('refuses to manage credentials with a personal access token', async () => {
    const created = await http()
      .post('/api/pats')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Escalation attempt', scopes: ['tasks:read'] });
    expect(created.status).toBe(201);

    // A leaked PAT must not be able to mint another PAT.
    const minted = await http()
      .post('/api/pats')
      .set('Authorization', `Bearer ${created.body.token}`)
      .send({ name: 'Second token', scopes: ['tasks:read'] });
    expect(minted.status).toBe(403);
    expect(minted.body.code).toBe('SESSION_REQUIRED');
  });

});
