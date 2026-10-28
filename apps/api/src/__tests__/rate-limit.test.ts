/**
 * W14 rate limits: authenticated requests are limited per principal
 * (session user / PAT), unauthenticated ones per IP. MCP traffic (many PATs
 * from one egress IP) must not share a bucket.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { classifyRequest, readRateLimitConfig, resetRateLimitPrincipals } from '../middleware/rate-limit';
import { createPat, createTestSession, makeUser, type TestUser } from './auth-helpers';
import { startTestServer, type TestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const LIMIT_ENV = {
  RATE_LIMIT_ENABLED: '1',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_PRINCIPAL_PER_WINDOW: '3',
  RATE_LIMIT_IP_PER_WINDOW: '2',
} as const;

const users: TestUser[] = [];
let alice: TestUser;
let bob: TestUser;

/** A fresh app (fresh in-memory buckets) built with the limit env above. */
async function limitedServer(): Promise<TestServer> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(LIMIT_ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await startTestServer(createApp());
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeAll(async () => {
  alice = await makeUser('rl-alice', RUN);
  bob = await makeUser('rl-bob', RUN);
  users.push(alice, bob);
});

afterAll(async () => {
  await prisma.personalAccessToken.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } });
  await prisma.session.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
});

describe('rate limit configuration', () => {
  it('is off under NODE_ENV=test unless enabled, and falls back to defaults for invalid numbers', () => {
    expect(readRateLimitConfig({ NODE_ENV: 'test' }).enabled).toBe(false);
    expect(readRateLimitConfig({ NODE_ENV: 'production' }).enabled).toBe(true);
    expect(readRateLimitConfig({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: '0' }).enabled).toBe(false);
    const config = readRateLimitConfig({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: '1', RATE_LIMIT_PRINCIPAL_PER_WINDOW: 'abc', RATE_LIMIT_IP_PER_WINDOW: '7' });
    expect(config).toMatchObject({ enabled: true, principalMax: 300, ipMax: 7, windowMs: 60_000 });
  });
});

describe('per-principal buckets', () => {
  it('gives each session user its own bucket on one IP', async () => {
    const server = await limitedServer();
    try {
      const aliceJwt = (await createTestSession(alice)).accessToken;
      const bobJwt = (await createTestSession(bob)).accessToken;
      const get = (token: string) => server.client().get('/api/tasks?pageSize=1').set('Authorization', `Bearer ${token}`);

      for (let i = 0; i < 3; i += 1) expect((await get(aliceJwt)).status).toBe(200);
      const limited = await get(aliceJwt);
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', details: { scope: 'principal' } });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      // Same IP, different principal: unaffected.
      for (let i = 0; i < 3; i += 1) expect((await get(bobJwt)).status).toBe(200);
      expect((await get(bobJwt)).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it('gives each PAT its own bucket (MCP users behind one egress IP no longer share one)', async () => {
    resetRateLimitPrincipals();
    const server = await limitedServer();
    try {
      const patA = await createPat(alice.id, ['read']);
      const patB = await createPat(bob.id, ['read']);
      const get = (token: string) => server.client().get('/api/tasks?pageSize=1').set('Authorization', `Bearer ${token}`);

      // A token's first request in this process is counted against the IP
      // (it is not yet known to be valid); later requests use its own bucket.
      expect((await get(patA.token)).status).toBe(200);
      for (let i = 0; i < 3; i += 1) expect((await get(patA.token)).status).toBe(200);
      const limited = await get(patA.token);
      expect(limited.status).toBe(429);
      expect(limited.body.details).toMatchObject({ scope: 'principal' });

      // Second PAT from the same IP: its own budget.
      expect((await get(patB.token)).status).toBe(200);
      for (let i = 0; i < 3; i += 1) expect((await get(patB.token)).status).toBe(200);
      expect((await get(patB.token)).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it('keeps two PATs of the same user apart', async () => {
    resetRateLimitPrincipals();
    const first = await createPat(alice.id, ['read']);
    const second = await createPat(alice.id, ['read']);
    const server = await limitedServer();
    try {
      const get = (token: string) => server.client().get('/api/tasks?pageSize=1').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '203.0.113.20');
      for (let i = 0; i < 4; i += 1) expect((await get(first.token)).status).toBe(200);
      expect((await get(first.token)).status).toBe(429);
      expect((await get(second.token)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe('per-IP buckets for unauthenticated or unverifiable requests', () => {
  it('limits anonymous requests per IP and keeps IPs apart', async () => {
    const server = await limitedServer();
    try {
      const anon = (ip: string) => server.client().get('/api/tasks').set('X-Forwarded-For', ip);
      expect((await anon('198.51.100.1')).status).toBe(401);
      expect((await anon('198.51.100.1')).status).toBe(401);
      const limited = await anon('198.51.100.1');
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', details: { scope: 'default' } });
      expect((await anon('198.51.100.2')).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('counts unknown PATs and invalid JWTs against the IP, so random tokens cannot mint buckets', async () => {
    const server = await limitedServer();
    try {
      const send = (token: string) => server.client().get('/api/tasks').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '198.51.100.9');
      const randomPat = () => `ol_pat_${randomUUID().replace(/-/g, '')}`;
      expect((await send(randomPat())).status).toBe(401);
      expect((await send('not-a-jwt')).status).toBe(401);
      expect((await send(randomPat())).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it('does not limit the probes', async () => {
    const server = await limitedServer();
    try {
      for (let i = 0; i < 4; i += 1) expect((await server.client().get('/livez')).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe('classifyRequest', () => {
  it('keys verified JWTs by user and everything else by IP', async () => {
    const jwt = (await createTestSession(alice)).accessToken;
    const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {}, ip: '192.0.2.4' }) as Parameters<typeof classifyRequest>[0];
    expect(classifyRequest(req(`Bearer ${jwt}`))).toEqual({ kind: 'user', key: `user:${alice.id}` });
    expect(classifyRequest(req('Bearer garbage')).kind).toBe('ip');
    expect(classifyRequest(req()).kind).toBe('ip');
    const pat = classifyRequest(req(`Bearer ol_pat_${'0'.repeat(32)}`));
    expect(pat.kind).toBe('ip');
  });
});
