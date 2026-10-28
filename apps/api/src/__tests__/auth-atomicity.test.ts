/**
 * W02b atomicity of auth primitives under parallel requests: TOTP step
 * replay, backup-code consumption, 2FA challenge consumption, refresh-token
 * rotation with family reuse detection, and email-change confirmation.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { encryptToken, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { issueTwoFactorPendingToken } from '../lib/auth-tokens';
import { generateBackupCodes, generateTOTPSecret } from '../services/totp';
import { clearSessionCaches } from '../services/sessions';
import {
  closeServer,
  createTestSession,
  listen,
  makeUser,
  openStream,
  waitFor,
  type TestUser,
} from './auth-helpers';

const suffix = randomUUID().slice(0, 8);

function totpFor(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer: 'OpenLinear', algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}

describe('W02b atomic auth primitives', () => {
  const app = createApp();
  const userIds: string[] = [];
  let server: Server | undefined;
  let baseUrl = '';
  const previousSessionless = process.env.OPENLINEAR_ALLOW_SESSIONLESS_JWT;

  beforeAll(async () => {
    process.env.OPENLINEAR_ALLOW_SESSIONLESS_JWT = '0';
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    process.env.OPENLINEAR_ALLOW_SESSIONLESS_JWT = previousSessionless;
    await closeServer(server);
    await prisma.domainEvent.deleteMany({ where: { userIds: { hasSome: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    clearSessionCaches();
  });

  async function user(label: string): Promise<TestUser> {
    const created = await makeUser(`atomic-${label}`, suffix);
    userIds.push(created.id);
    return created;
  }

  async function twoFactorUser(label: string) {
    const created = await user(label);
    const { secret } = generateTOTPSecret(created.username);
    const backup = generateBackupCodes();
    await prisma.user.update({
      where: { id: created.id },
      data: { totpEnabled: true, totpSecret: encryptToken(secret), backupCodes: backup.hashed },
    });
    return { user: created, secret, backupCodes: backup.plain };
  }

  function validate(tempToken: string, code: string) {
    return request(baseUrl).post('/api/auth/2fa/validate').send({ tempToken, code });
  }

  describe('TOTP', () => {
    it('accepts a code once, even under concurrent use, and refuses it again in its window', async () => {
      const { user: subject, secret } = await twoFactorUser('totp');
      const code = totpFor(secret).generate();
      const challenges = await Promise.all(Array.from({ length: 4 }, () => issueTwoFactorPendingToken(subject)));
      const results = await Promise.all(challenges.map((challenge) => validate(challenge, code)));
      expect(results.map((res) => res.status).sort()).toEqual([200, 401, 401, 401]);

      const replay = await validate(await issueTwoFactorPendingToken(subject), code);
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('INVALID_CODE');

      // The next time step is still accepted (one step of drift).
      const next = totpFor(secret).generate({ timestamp: Date.now() + 30_000 });
      expect((await validate(await issueTwoFactorPendingToken(subject), next)).status).toBe(200);
    });

    it('applies the same replay rule when disabling 2FA', async () => {
      const { user: subject, secret } = await twoFactorUser('totp-disable');
      const session = await createTestSession(subject);
      const code = totpFor(secret).generate();
      expect((await validate(await issueTwoFactorPendingToken(subject), code)).status).toBe(200);
      const disable = await request(baseUrl).post('/api/auth/2fa/disable').set('Authorization', `Bearer ${session.accessToken}`).send({ code });
      expect(disable.status).toBe(400);
      expect((await prisma.user.findUnique({ where: { id: subject.id } }))?.totpEnabled).toBe(true);
    });
  });

  describe('backup codes', () => {
    it('spends one backup code exactly once under concurrency', async () => {
      const { user: subject, backupCodes } = await twoFactorUser('backup-same');
      const code = backupCodes[0]!;
      const challenges = await Promise.all(Array.from({ length: 4 }, () => issueTwoFactorPendingToken(subject)));
      const results = await Promise.all(challenges.map((challenge) => validate(challenge, code)));
      expect(results.map((res) => res.status).sort()).toEqual([200, 401, 401, 401]);
      expect((await prisma.user.findUnique({ where: { id: subject.id } }))?.backupCodes).toHaveLength(7);
    });

    it('does not lose a removal when different codes are spent concurrently', async () => {
      const { user: subject, backupCodes } = await twoFactorUser('backup-different');
      const challenges = await Promise.all(Array.from({ length: 3 }, () => issueTwoFactorPendingToken(subject)));
      const results = await Promise.all(challenges.map((challenge, i) => validate(challenge, backupCodes[i]!)));
      expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
      expect((await prisma.user.findUnique({ where: { id: subject.id } }))?.backupCodes).toHaveLength(5);
      // Every spent code stays spent.
      for (const spent of backupCodes.slice(0, 3)) {
        expect((await validate(await issueTwoFactorPendingToken(subject), spent)).status).toBe(401);
      }
    });
  });

  describe('2FA challenge', () => {
    it('lets exactly one request use a challenge', async () => {
      const { user: subject, backupCodes } = await twoFactorUser('challenge');
      const challenge = await issueTwoFactorPendingToken(subject);
      const results = await Promise.all(backupCodes.slice(0, 5).map((code) => validate(challenge, code)));
      expect(results.map((res) => res.status).sort()).toEqual([200, 401, 401, 401, 401]);
      // Only the winning request spent a backup code.
      expect((await prisma.user.findUnique({ where: { id: subject.id } }))?.backupCodes).toHaveLength(7);
    });
  });

  describe('refresh-token rotation', () => {
    function refresh(refreshToken: string) {
      return request(baseUrl).post('/api/auth/refresh').send({ refreshToken });
    }

    it('rotates once under concurrency, keeps the family, and revokes it on later reuse', async () => {
      const subject = await user('refresh');
      const original = await createTestSession(subject);
      const results = await Promise.all(Array.from({ length: 5 }, () => refresh(original.refreshToken)));
      expect(results.map((res) => res.status).sort()).toEqual([200, 401, 401, 401, 401]);
      const winner = results.find((res) => res.status === 200)!;
      const successor = { accessToken: winner.body.token as string, refreshToken: winner.body.refreshToken as string };

      const family = await prisma.session.findMany({ where: { userId: subject.id, familyId: original.familyId } });
      expect(family).toHaveLength(2);
      const old = family.find((row) => row.id === original.sessionId);
      expect(old?.revokedAt).toBeInstanceOf(Date);
      expect(old?.rotatedAt).toBeInstanceOf(Date);
      // A concurrent duplicate inside the grace window does not revoke the family.
      expect(family.filter((row) => row.revokedAt === null)).toHaveLength(1);
      expect((await request(baseUrl).get('/api/users/me').set('Authorization', `Bearer ${successor.accessToken}`)).status).toBe(200);
      expect((await request(baseUrl).get('/api/users/me').set('Authorization', `Bearer ${original.accessToken}`)).status).toBe(401);

      // A stream opened by the successor session.
      const stream = await openStream(baseUrl, { bearer: successor.accessToken });
      expect(stream.status).toBe(200);
      await waitFor(() => stream.text().includes('event: connected'));

      // Later reuse of the rotated token (outside the grace window) is theft: revoke the family.
      await prisma.session.update({ where: { id: original.sessionId }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
      const reuse = await refresh(original.refreshToken);
      expect(reuse.status).toBe(401);
      expect(await prisma.session.count({ where: { userId: subject.id, familyId: original.familyId, revokedAt: null } })).toBe(0);
      expect((await request(baseUrl).get('/api/users/me').set('Authorization', `Bearer ${successor.accessToken}`)).status).toBe(401);
      expect((await refresh(successor.refreshToken)).status).toBe(401);
      await waitFor(() => stream.ended());
      const audit = await prisma.accountAuditLog.findFirst({ where: { userId: subject.id, action: 'session.refresh_reuse_detected' } });
      expect(audit?.resourceId).toBe(original.familyId);
    });

    it('keeps a rotation chain in one family, including legacy sessions without one', async () => {
      const subject = await user('refresh-chain');
      const legacy = await createTestSession(subject);
      await prisma.session.update({ where: { id: legacy.sessionId }, data: { familyId: null } });
      const first = await refresh(legacy.refreshToken);
      expect(first.status).toBe(200);
      const second = await refresh(first.body.refreshToken as string);
      expect(second.status).toBe(200);
      const rows = await prisma.session.findMany({ where: { userId: subject.id }, orderBy: { createdAt: 'asc' } });
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.familyId))).toEqual(new Set([legacy.sessionId]));
      expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
    });
  });

  describe('email change confirmation', () => {
    it('applies a confirmation token exactly once under concurrency', async () => {
      const subject = await user('email');
      const session = await createTestSession(subject);
      const requested = await request(baseUrl)
        .post('/api/users/me/email-change')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ newEmail: `changed-${suffix}@example.com` });
      expect(requested.status).toBe(202);
      const token = requested.body.token as string;
      const results = await Promise.all(Array.from({ length: 5 }, () => request(baseUrl)
        .post('/api/users/me/email-change/confirm')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ token })));
      expect(results.map((res) => res.status).sort()).toEqual([200, 400, 400, 400, 400]);
      expect((await prisma.user.findUnique({ where: { id: subject.id } }))?.email).toBe(`changed-${suffix}@example.com`);
    });
  });
});
