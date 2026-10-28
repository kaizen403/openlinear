/**
 * W02b PAT remediation and audit:
 *   - the database revokes a bound PAT whose workspace binding is lost by any
 *     path (workspace deleted outside the API route, direct UPDATE);
 *   - PAT creation and revocation are audited for account-wide tokens too;
 *   - the one-off remediation is dry-run by default, idempotent, never widens
 *     or extends, and audits every change.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { remediatePersonalAccessTokens } from '../services/pat-remediation';
import type { Server } from 'node:http';
import { closeServer, createPat, createTestSession, listen, makeUser, type TestSession, type TestUser } from './auth-helpers';

const suffix = randomUUID().slice(0, 8);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('W02b PAT remediation and audit', () => {
  const app = createApp();
  let server: Server | undefined;
  let baseUrl = '';
  let owner: TestUser;
  let bystander: TestUser;
  let session: TestSession;
  const workspaceIds: string[] = [];

  async function workspace(label: string): Promise<string> {
    const created = await prisma.workspace.create({ data: { name: `${label} ${suffix}`, slug: `${label}-${suffix}-${randomUUID().slice(0, 4)}` } });
    workspaceIds.push(created.id);
    await prisma.workspaceMember.create({ data: { workspaceId: created.id, userId: owner.id, role: 'owner' } });
    return created.id;
  }

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(app));
    owner = await makeUser('pat-remediation', suffix);
    bystander = await makeUser('pat-remediation-other', suffix);
    session = await createTestSession(owner);
  });

  afterAll(async () => {
    await closeServer(server);
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { username: { endsWith: suffix } } });
  });

  describe('database fail-safe for lost workspace bindings', () => {
    it('revokes a bound PAT when its workspace is deleted outside the API route', async () => {
      const ws = await workspace('trigger-delete');
      const bound = await createPat(owner.id, ['admin'], { workspaceId: ws });
      const unbound = await createPat(owner.id, ['workspaces:read']);
      expect((await request(baseUrl).get('/api/workspaces').set('Authorization', `Bearer ${bound.token}`)).status).toBe(200);

      await prisma.workspace.delete({ where: { id: ws } });

      const row = await prisma.personalAccessToken.findUnique({ where: { id: bound.id } });
      expect(row?.workspaceId).toBeNull();
      expect(row?.revokedAt).toBeInstanceOf(Date);
      expect((await request(baseUrl).get('/api/workspaces').set('Authorization', `Bearer ${bound.token}`)).status).toBe(401);
      expect((await prisma.personalAccessToken.findUnique({ where: { id: unbound.id } }))?.revokedAt).toBeNull();
    });

    it('revokes a bound PAT that is unbound by a direct UPDATE', async () => {
      const ws = await workspace('trigger-update');
      const bound = await createPat(owner.id, ['read'], { workspaceId: ws });
      await prisma.personalAccessToken.update({ where: { id: bound.id }, data: { workspaceId: null } });
      expect((await prisma.personalAccessToken.findUnique({ where: { id: bound.id } }))?.revokedAt).toBeInstanceOf(Date);
    });

    it('control: the workspace audit trail of a bound PAT is deleted with its workspace', async () => {
      const ws = await workspace('trigger-audit');
      const created = await request(baseUrl)
        .post('/api/pats')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ name: 'bound', scopes: ['read'], workspaceId: ws });
      expect(created.status).toBe(201);
      expect(await prisma.auditLog.count({ where: { resourceId: created.body.id as string } })).toBe(1);
      await prisma.workspace.delete({ where: { id: ws } });
      // `audit_logs` cascades: only the account audit log still knows the token was bound.
      expect(await prisma.auditLog.count({ where: { resourceId: created.body.id as string } })).toBe(0);
      const account = await prisma.accountAuditLog.findFirst({ where: { resourceId: created.body.id as string, action: 'pat.created' } });
      expect(account?.metadata).toMatchObject({ workspaceId: ws });
    });
  });

  describe('account audit for PAT lifecycle', () => {
    it('audits creation and revocation of an account-wide PAT', async () => {
      const created = await request(baseUrl)
        .post('/api/pats')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ name: 'account-wide', scopes: ['tasks:read'] });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      const createdRow = await prisma.accountAuditLog.findFirst({ where: { userId: owner.id, action: 'pat.created', resourceId: id } });
      expect(createdRow?.metadata).toMatchObject({ scopes: ['tasks:read'], workspaceId: null });
      expect(JSON.stringify(createdRow)).not.toContain(created.body.token as string);

      expect((await request(baseUrl).delete(`/api/pats/${id}`).set('Authorization', `Bearer ${session.accessToken}`)).status).toBe(204);
      expect(await prisma.accountAuditLog.count({ where: { userId: owner.id, action: 'pat.revoked', resourceId: id } })).toBe(1);
    });
  });

  describe('one-off remediation', () => {
    const ids = {
      auditEvidence: '', accountEvidence: '', wildcardOpen: '', wildcardLate: '', wildcardEarly: '', plain: '', bound: '', foreignWildcard: '',
    };
    const now = new Date('2026-10-26T12:00:00.000Z');
    const earlyExpiry = new Date(now.getTime() + 5 * DAY_MS);
    let subject: TestUser;

    beforeAll(async () => {
      subject = await makeUser('pat-remediation-subject', suffix);
      const surviving = await workspace('evidence');
      // Pre-W02a state: created bound (audited), binding since lost without revocation.
      ids.auditEvidence = (await createPat(subject.id, ['admin'])).id;
      await prisma.auditLog.create({
        data: { workspaceId: surviving, actorId: subject.id, action: 'pat.created', resourceType: 'personal_access_token', resourceId: ids.auditEvidence },
      });
      ids.accountEvidence = (await createPat(subject.id, ['read'])).id;
      await prisma.accountAuditLog.create({
        data: { userId: subject.id, actorId: subject.id, action: 'pat.created', resourceType: 'personal_access_token', resourceId: ids.accountEvidence, metadata: { workspaceId: randomUUID() } },
      });
      ids.wildcardOpen = (await createPat(subject.id, ['*'])).id;
      ids.wildcardLate = (await createPat(subject.id, ['*'], { expiresAt: new Date(now.getTime() + 365 * DAY_MS) })).id;
      ids.wildcardEarly = (await createPat(subject.id, ['*'], { expiresAt: earlyExpiry })).id;
      ids.plain = (await createPat(subject.id, ['tasks:read'])).id;
      ids.bound = (await createPat(subject.id, ['read'], { workspaceId: surviving })).id;
      ids.foreignWildcard = (await createPat(bystander.id, ['*'])).id;
    });

    async function snapshot() {
      return prisma.personalAccessToken.findMany({
        where: { userId: { in: [subject.id, bystander.id] } },
        select: { id: true, revokedAt: true, expiresAt: true, workspaceId: true },
        orderBy: { id: 'asc' },
      });
    }

    it('reports without writing in a dry run', async () => {
      const before = await snapshot();
      const auditBefore = await prisma.accountAuditLog.count({ where: { action: 'pat.remediated' } });
      const report = await remediatePersonalAccessTokens({ apply: false, now, userIds: [subject.id] });
      expect(report.dryRun).toBe(true);
      expect(report.unboundRevoked.map((row) => row.id).sort()).toEqual([ids.auditEvidence, ids.accountEvidence].sort());
      expect(report.wildcardExpiring.map((row) => row.id).sort()).toEqual([ids.wildcardOpen, ids.wildcardLate].sort());
      expect(await snapshot()).toEqual(before);
      expect(await prisma.accountAuditLog.count({ where: { action: 'pat.remediated' } })).toBe(auditBefore);
    });

    it('revokes unbound-by-deletion tokens, sunsets wildcard tokens, audits, and is idempotent', async () => {
      const report = await remediatePersonalAccessTokens({ apply: true, now, userIds: [subject.id], createdBefore: new Date(Date.now() + 60_000) });
      expect(report.unboundRevoked.map((row) => row.id).sort()).toEqual([ids.auditEvidence, ids.accountEvidence].sort());
      expect(report.wildcardExpiring.map((row) => row.id).sort()).toEqual([ids.wildcardOpen, ids.wildcardLate].sort());
      expect(report.unclassifiedAccountWide).toBe(1); // `plain`: account-wide, no evidence either way

      const rows = new Map((await snapshot()).map((row) => [row.id, row]));
      const sunset = new Date(now.getTime() + 30 * DAY_MS).getTime();
      expect(rows.get(ids.auditEvidence)?.revokedAt).toBeInstanceOf(Date);
      expect(rows.get(ids.accountEvidence)?.revokedAt).toBeInstanceOf(Date);
      expect(rows.get(ids.wildcardOpen)?.expiresAt?.getTime()).toBe(sunset);
      expect(rows.get(ids.wildcardLate)?.expiresAt?.getTime()).toBe(sunset);
      expect(rows.get(ids.wildcardEarly)?.expiresAt?.getTime()).toBe(earlyExpiry.getTime());
      expect(rows.get(ids.plain)?.revokedAt).toBeNull();
      expect(rows.get(ids.bound)?.revokedAt).toBeNull();
      expect(rows.get(ids.foreignWildcard)?.expiresAt).toBeNull(); // outside the targeted owners
      expect(await prisma.accountAuditLog.count({ where: { userId: subject.id, action: 'pat.remediated' } })).toBe(4);

      // Re-running later changes nothing and never extends an expiry.
      const again = await remediatePersonalAccessTokens({ apply: true, now: new Date(now.getTime() + 10 * DAY_MS), userIds: [subject.id] });
      expect(again.unboundRevoked).toEqual([]);
      expect(again.wildcardExpiring).toEqual([]);
      expect((await prisma.personalAccessToken.findUnique({ where: { id: ids.wildcardOpen } }))?.expiresAt?.getTime()).toBe(sunset);
      expect(await prisma.accountAuditLog.count({ where: { userId: subject.id, action: 'pat.remediated' } })).toBe(4);
    });

    it('can revoke wildcard tokens outright', async () => {
      const report = await remediatePersonalAccessTokens({ apply: true, now, userIds: [subject.id], revokeWildcard: true });
      expect(report.wildcardRevoked.map((row) => row.id).sort()).toEqual([ids.wildcardOpen, ids.wildcardLate, ids.wildcardEarly].sort());
      const live = await prisma.personalAccessToken.count({ where: { userId: subject.id, scopes: { has: '*' }, revokedAt: null } });
      expect(live).toBe(0);
    });
  });
});
