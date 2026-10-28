/**
 * W04b: the routes that used the legacy `idempotency_keys` cache now use the
 * W04a `idempotency_records` service. For each one: a burst of identical
 * keyed requests executes once (one domain effect, one event) and every
 * response is byte-identical; the same key with a different request is 409
 * IDEMPOTENCY_CONFLICT; a key held in progress is 409 IDEMPOTENCY_IN_PROGRESS.
 * Keys are scoped per credential (session vs each PAT).
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const app = createApp();
const http = useTestServer(() => app);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function token(userId: string, username: string): string {
  return jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
}

async function createPat(userId: string, scopes: string[], workspaceId: string | null = null) {
  const value = generatePersonalAccessToken();
  const row = await prisma.personalAccessToken.create({
    data: { userId, name: `w04b-${RUN}`, tokenHash: hashPersonalAccessToken(value), tokenPrefix: value.slice(0, 15), scopes, workspaceId },
  });
  return { token: value, id: row.id };
}

/**
 * Stream + pending events of `type` whose payload mentions `marker`, in ONE
 * statement: the sequencer moves rows between the tables in one transaction,
 * so two separate counts could straddle it and see neither copy.
 */
async function eventCount(type: string, marker: string): Promise<number> {
  const like = `%${marker}%`;
  const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT ((SELECT count(*) FROM domain_events WHERE type = ${type} AND payload::text LIKE ${like})
          + (SELECT count(*) FROM domain_event_outbox WHERE type = ${type} AND payload::text LIKE ${like}))::int AS n`;
  return row?.n ?? 0;
}

const created = { users: [] as string[], workspaces: [] as string[] };
const fx = { owner: { id: '', username: '', jwt: '' }, workspace: '', project: '', team: '', inviteCode: '', otherInviteCode: '' };

async function makeUser(label: string) {
  const user = await prisma.user.create({
    data: { githubId: `w04b-idem-${label}-${RUN}`, username: `w04b-idem-${label}-${RUN}`, email: `w04b-idem-${label}-${RUN}@example.com` },
  });
  created.users.push(user.id);
  return { id: user.id, username: user.username, jwt: token(user.id, user.username) };
}

beforeAll(async () => {
  fx.owner = await makeUser('owner');
  const workspace = await prisma.workspace.create({ data: { name: `W04b idem ${RUN}`, slug: `w04b-idem-${RUN}` } });
  fx.workspace = workspace.id;
  created.workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: fx.owner.id, role: 'owner' } });
  const project = await prisma.project.create({ data: { name: `W04b idem ${RUN}`, key: 'WIDM', workspaceId: workspace.id } });
  fx.project = project.id;
  await prisma.projectAccess.create({ data: { projectId: project.id, userId: fx.owner.id, permission: 'full' } });
  const team = await prisma.team.create({
    data: { name: 'W04b idem', key: 'WID', projectId: project.id, inviteCode: `WID-${RUN}`, members: { create: { userId: fx.owner.id, role: 'owner' } } },
  });
  fx.team = team.id;
  fx.inviteCode = team.inviteCode ?? '';
  const other = await prisma.team.create({ data: { name: 'W04b idem 2', key: 'WID2', projectId: project.id, inviteCode: `WID2-${RUN}` } });
  fx.otherInviteCode = other.inviteCode ?? '';
});

afterAll(async () => {
  await prisma.idempotencyRecord.deleteMany({ where: { principalId: { startsWith: fx.owner.id } } });
  for (const userId of created.users) {
    await prisma.idempotencyRecord.deleteMany({ where: { principalId: { startsWith: userId } } });
  }
  const workspaceRows = await prisma.workspaceMember.findMany({ where: { userId: { in: created.users } }, select: { workspaceId: true } });
  const workspaceIds = [...new Set([...created.workspaces, ...workspaceRows.map((row) => row.workspaceId)])];
  await prisma.task.deleteMany({ where: { project: { workspaceId: { in: workspaceIds } } } });
  await prisma.project.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: created.users } }, { workspaceIds: { hasSome: workspaceIds } }] } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
});

interface EndpointCase {
  operation: string;
  /** Sets up a fresh subject and returns the two request variants. */
  prepare: () => Promise<{
    send: (key: string | null, variant: 'a' | 'b', auth?: string) => request.Test;
    effects: () => Promise<number>;
    /** Events one execution appends (team events go to the team and the user). */
    event: { type: string; marker: string; perExecution?: number };
    expectedStatus: number;
  }>;
}

const cases: EndpointCase[] = [
  {
    operation: 'projects.create',
    prepare: async () => {
      const name = `P ${randomUUID().slice(0, 6)}`;
      const body = { a: { name, workspaceId: fx.workspace }, b: { name: `${name} other`, workspaceId: fx.workspace } };
      return {
        send: (key, variant, auth = fx.owner.jwt) => withKey(http().post('/api/projects').set('Authorization', `Bearer ${auth}`), key).send(body[variant]),
        effects: () => prisma.project.count({ where: { name } }),
        event: { type: 'project:created', marker: name },
        expectedStatus: 201,
      };
    },
  },
  {
    operation: 'projects.access.grant',
    prepare: async () => {
      const grantee = await makeUser(`grant-${randomUUID().slice(0, 4)}`);
      await prisma.workspaceMember.create({ data: { workspaceId: fx.workspace, userId: grantee.id, role: 'member' } });
      const body = { a: { userId: grantee.id, permission: 'view' }, b: { userId: grantee.id, permission: 'full' } };
      return {
        send: (key, variant, auth = fx.owner.jwt) => withKey(http().post(`/api/projects/${fx.project}/access`).set('Authorization', `Bearer ${auth}`), key).send(body[variant]),
        effects: () => eventCount('project:access-changed', grantee.id),
        event: { type: 'project:access-changed', marker: grantee.id },
        expectedStatus: 201,
      };
    },
  },
  {
    operation: 'projects.access.bulk_grant',
    prepare: async () => {
      const grantee = await makeUser(`bulkgrant-${randomUUID().slice(0, 4)}`);
      await prisma.workspaceMember.create({ data: { workspaceId: fx.workspace, userId: grantee.id, role: 'member' } });
      const body = { a: { grants: [{ userId: grantee.id, permission: 'view' }] }, b: { grants: [{ userId: grantee.id, permission: 'full' }] } };
      return {
        send: (key, variant, auth = fx.owner.jwt) => withKey(http().post(`/api/projects/${fx.project}/access/bulk`).set('Authorization', `Bearer ${auth}`), key).send(body[variant]),
        effects: () => eventCount('project:access-changed', grantee.id),
        event: { type: 'project:access-changed', marker: grantee.id },
        expectedStatus: 200,
      };
    },
  },
  {
    operation: 'teams.create',
    prepare: async () => {
      const key = `K${randomUUID().replace(/[^0-9]/g, '').slice(0, 6)}`;
      const name = `Team ${key}`;
      const body = { a: { name, key, projectId: fx.project }, b: { name: `${name} b`, key, projectId: fx.project } };
      return {
        send: (idemKey, variant, auth = fx.owner.jwt) => withKey(http().post('/api/teams').set('Authorization', `Bearer ${auth}`), idemKey).send(body[variant]),
        effects: () => prisma.team.count({ where: { projectId: fx.project, key } }),
        event: { type: 'team:created', marker: name, perExecution: 2 },
        expectedStatus: 201,
      };
    },
  },
  {
    operation: 'teams.join',
    prepare: async () => {
      const joiner = await makeUser(`join-${randomUUID().slice(0, 4)}`);
      const body = { a: { inviteCode: fx.inviteCode }, b: { inviteCode: fx.otherInviteCode } };
      return {
        send: (key, variant, auth = joiner.jwt) => withKey(http().post('/api/teams/join').set('Authorization', `Bearer ${auth}`), key).send(body[variant]),
        effects: () => prisma.teamMember.count({ where: { userId: joiner.id } }),
        event: { type: 'team:updated', marker: joiner.username, perExecution: 2 },
        expectedStatus: 200,
      };
    },
  },
  {
    operation: 'teams.members.add',
    prepare: async () => {
      const member = await makeUser(`tmember-${randomUUID().slice(0, 4)}`);
      const body = { a: { userId: member.id }, b: { userId: member.id, role: 'admin' } };
      return {
        send: (key, variant, auth = fx.owner.jwt) => withKey(http().post(`/api/teams/${fx.team}/members`).set('Authorization', `Bearer ${auth}`), key).send(body[variant]),
        effects: () => eventCount('team:member-added', member.id),
        event: { type: 'team:member-added', marker: member.id },
        expectedStatus: 201,
      };
    },
  },
  {
    operation: 'workspaces.create',
    prepare: async () => {
      const name = `WS ${randomUUID().slice(0, 6)}`;
      const body = { a: { name }, b: { name: `${name} b` } };
      return {
        send: (key, variant, auth = fx.owner.jwt) => withKey(http().post('/api/workspaces').set('Authorization', `Bearer ${auth}`), key).send(body[variant]),
        effects: () => prisma.workspace.count({ where: { name } }),
        event: { type: 'workspace:joined', marker: name },
        expectedStatus: 201,
      };
    },
  },
  {
    operation: 'workspaces.members.add',
    prepare: async () => {
      const member = await makeUser(`wmember-${randomUUID().slice(0, 4)}`);
      const body = { a: { username: member.username, role: 'member' }, b: { username: member.username, role: 'viewer' } };
      return {
        send: (key, variant, auth = fx.owner.jwt) => withKey(http().post(`/api/workspaces/${fx.workspace}/members`).set('Authorization', `Bearer ${auth}`), key).send(body[variant]),
        effects: () => prisma.workspaceMember.count({ where: { workspaceId: fx.workspace, userId: member.id } }),
        event: { type: 'workspace:member-added', marker: member.id },
        expectedStatus: 201,
      };
    },
  },
  {
    operation: 'workspaces.members.bulk_add',
    prepare: async () => {
      const member = await makeUser(`wbulk-${randomUUID().slice(0, 4)}`);
      const body = { a: { invites: [{ username: member.username, role: 'member' }] }, b: { invites: [{ username: member.username, role: 'viewer' }] } };
      return {
        send: (key, variant, auth = fx.owner.jwt) => withKey(http().post(`/api/workspaces/${fx.workspace}/members/bulk`).set('Authorization', `Bearer ${auth}`), key).send(body[variant]),
        effects: () => prisma.workspaceMember.count({ where: { workspaceId: fx.workspace, userId: member.id } }),
        event: { type: 'workspace:member-added', marker: member.id },
        expectedStatus: 201,
      };
    },
  },
];

function withKey(test: request.Test, key: string | null): request.Test {
  return key === null ? test : test.set('Idempotency-Key', key);
}

async function settledEventCount(type: string, marker: string): Promise<number> {
  // Events commit with the write; give the post-commit flush a moment so the
  // count is read from the stream, not mid-move.
  await sleep(50);
  return eventCount(type, marker);
}

describe('W04b idempotency on routes migrated off the legacy cache', () => {
  it.each(cases.map((testCase) => [testCase.operation, testCase] as const))(
    '%s: concurrent identical keyed requests execute once and replay byte-identically',
    async (_operation, testCase) => {
      const subject = await testCase.prepare();
      const key = `w04b-burst-${randomUUID()}`;
      const before = await subject.effects();
      const responses = await Promise.all(Array.from({ length: 8 }, () => subject.send(key, 'a')));
      const statuses = responses.map((res) => res.status);
      expect(statuses, JSON.stringify(responses.map((res) => res.body))).toEqual(Array(8).fill(subject.expectedStatus));
      expect(new Set(responses.map((res) => res.text)).size).toBe(1);
      expect(responses.filter((res) => res.headers['idempotency-replayed'] === 'true')).toHaveLength(7);
      const effects = await subject.effects();
      if (testCase.operation.startsWith('projects.access') || testCase.operation === 'teams.members.add') {
        expect(effects).toBe(1); // counted as events
      } else {
        expect(effects - before).toBe(1);
      }
      expect(await settledEventCount(subject.event.type, subject.event.marker)).toBe(subject.event.perExecution ?? 1);
      expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(1);
      const record = await prisma.idempotencyRecord.findFirstOrThrow({ where: { key } });
      expect(record.operation).toBe(testCase.operation);
      expect(record.state).toBe('completed');

      // A later equal retry replays too.
      const retry = await subject.send(key, 'a');
      expect(retry.status).toBe(subject.expectedStatus);
      expect(retry.headers['idempotency-replayed']).toBe('true');
      expect(retry.text).toBe(responses[0]!.text);

      // Same key, different request: conflict, nothing written.
      const conflict = await subject.send(key, 'b');
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(conflict.body.details).toMatchObject({ operation: testCase.operation });
      expect(await settledEventCount(subject.event.type, subject.event.marker)).toBe(subject.event.perExecution ?? 1);
    },
  );

  it.each(cases.map((testCase) => [testCase.operation, testCase] as const))(
    '%s: a key still in progress answers 409 IDEMPOTENCY_IN_PROGRESS with Retry-After',
    async (_operation, testCase) => {
      const subject = await testCase.prepare();
      const key = `w04b-progress-${randomUUID()}`;
      expect((await subject.send(key, 'a')).status).toBe(subject.expectedStatus);
      // An operation whose effects cannot share the transaction keeps its
      // record `in_progress` until it completes.
      await prisma.idempotencyRecord.updateMany({ where: { key }, data: { state: 'in_progress' } });
      const busy = await subject.send(key, 'a');
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(busy.headers['retry-after']).toBe('1');
    },
  );

  it('rejects malformed keys before any write', async () => {
    const subject = await cases[6]!.prepare(); // workspaces.create
    const before = await subject.effects();
    for (const bad of ['short', 'has space key', 'a'.repeat(129), 'k1-aaaaaaaa, k2-bbbbbbbb']) {
      const res = await subject.send(bad, 'a');
      expect(res.status, bad).toBe(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    }
    expect(await subject.effects()).toBe(before);
  });

  it('unkeyed requests keep their previous non-idempotent behaviour', async () => {
    const subject = await cases[6]!.prepare(); // workspaces.create
    const before = await subject.effects();
    expect((await subject.send(null, 'a')).status).toBe(201);
    expect((await subject.send(null, 'a')).status).toBe(201);
    expect(await subject.effects()).toBe(before + 2);
  });
});

describe('W04b idempotency principal: keys are scoped per credential', () => {
  it('a session and each PAT of the same user have separate key spaces; one PAT replays its own key', async () => {
    const owner = await makeUser('scope-owner');
    // W02b: creating workspaces needs `admin` (write PATs lost workspace administration).
    const patA = await createPat(owner.id, ['admin']);
    const patB = await createPat(owner.id, ['admin']);
    const name = `Scoped ${randomUUID().slice(0, 6)}`;
    const key = `w04b-scope-${randomUUID()}`;
    const send = (auth: string) => http().post('/api/workspaces').set('Authorization', `Bearer ${auth}`).set('Idempotency-Key', key).send({ name });

    const viaSession = await send(owner.jwt);
    const viaPatA = await send(patA.token);
    const viaPatAAgain = await send(patA.token);
    const viaPatB = await send(patB.token);
    expect([viaSession.status, viaPatA.status, viaPatAAgain.status, viaPatB.status]).toEqual([201, 201, 201, 201]);
    expect(viaSession.headers['idempotency-replayed']).toBeUndefined();
    expect(viaPatA.headers['idempotency-replayed']).toBeUndefined();
    expect(viaPatAAgain.headers['idempotency-replayed']).toBe('true');
    expect(viaPatAAgain.text).toBe(viaPatA.text);
    expect(viaPatB.headers['idempotency-replayed']).toBeUndefined();
    expect(new Set([viaSession.body.id, viaPatA.body.id, viaPatB.body.id]).size).toBe(3);

    const records = await prisma.idempotencyRecord.findMany({ where: { key }, select: { principalId: true } });
    expect(records.map((row) => row.principalId).sort()).toEqual(
      [owner.id, `${owner.id}:pat:${patA.id}`, `${owner.id}:pat:${patB.id}`].sort(),
    );
    // The session scope stays the bare user id (a refreshed token or a second
    // device shares it).
    const refreshed = token(owner.id, owner.username);
    const viaRefreshed = await send(refreshed);
    expect(viaRefreshed.headers['idempotency-replayed']).toBe('true');
    expect(viaRefreshed.text).toBe(viaSession.text);
  });

  it('a workspace-bound PAT records its binding workspace', async () => {
    // W02b: workspace administration and access grants need `admin` (write PATs lost them).
    const pat = await createPat(fx.owner.id, ['admin'], fx.workspace);
    const grantee = await makeUser('bound-grantee');
    await prisma.workspaceMember.create({ data: { workspaceId: fx.workspace, userId: grantee.id, role: 'member' } });
    const key = `w04b-bound-${randomUUID()}`;
    const res = await http()
      .post(`/api/projects/${fx.project}/access`)
      .set('Authorization', `Bearer ${pat.token}`)
      .set('Idempotency-Key', key)
      .send({ userId: grantee.id, permission: 'view' });
    expect(res.status).toBe(201);
    const record = await prisma.idempotencyRecord.findFirstOrThrow({ where: { key } });
    expect(record.principalId).toBe(`${fx.owner.id}:pat:${pat.id}`);
    expect(record.workspaceId).toBe(fx.workspace);
  });
});
