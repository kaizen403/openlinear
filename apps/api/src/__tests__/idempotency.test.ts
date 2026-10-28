/**
 * W04a — request-hash idempotency on POST /api/tasks and POST /api/tasks/bulk.
 *
 * Runs against real PostgreSQL (TEST_DATABASE_URL). Concurrency cases hold
 * real row locks / uncommitted reservations from a separate transaction and
 * observe blocked backends through pg_stat_activity, so the interleavings are
 * forced rather than timing-dependent.
 */
import { randomUUID } from 'node:crypto';
import express, { type Response } from 'express';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, type Prisma } from '@openlinear/db';
import { buildErrorHandler, createApp } from '../app';
import { HttpError } from '../errors';
import { type AuthRequest, requireAuth } from '../middleware/auth';
import { createTaskBodySchema } from '../schemas/tasks';
import {
  canonicalJson,
  computeRequestHash,
  IDEMPOTENCY_LOCK_WAIT_MS,
  pruneIdempotencyRecords,
  readIdempotencyKey,
  respondIdempotently,
} from '../services/idempotency';
import { authorizeCreateTask } from '../services/tasks';
import { testJwtSecret } from './test-env';
import type request from 'supertest';
import { startTestServer, useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const FAIL_TITLE = `W04A_FAIL_INSERT_${RUN}`;
const FAIL_FN = `w04a_fail_task_insert_${RUN}`;

function token(userId: string, username: string): string {
  return jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshKey(label: string): string {
  return `w04a-${label}-${randomUUID()}`;
}

/** Backends of this database currently blocked on a heavyweight lock. */
async function lockWaiters(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
    SELECT count(*)::int AS waiting
    FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return rows[0]?.waiting ?? 0;
}

async function waitForLockWaiters(expected: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiting = await lockWaiters();
    if (waiting >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(`expected ${expected} lock waiters, saw ${waiting}`);
    }
    await sleep(20);
  }
}

/** Starts an uncommitted transaction and keeps it open until released. */
function holdTransaction(work: (tx: Prisma.TransactionClient) => Promise<void>): {
  ready: Promise<void>;
  release: (outcome: 'commit' | 'rollback') => Promise<void>;
} {
  let markReady!: () => void;
  let finish!: (outcome: 'commit' | 'rollback') => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const finished = new Promise<'commit' | 'rollback'>((resolve) => { finish = resolve; });
  const done = prisma
    .$transaction(async (tx) => {
      await work(tx);
      markReady();
      if ((await finished) === 'rollback') {
        throw new Error('w04a test holder rollback');
      }
    }, { timeout: 30_000, maxWait: 5_000 })
    .catch((err: unknown) => {
      if (!(err instanceof Error) || err.message !== 'w04a test holder rollback') throw err;
    });
  return {
    ready,
    release: async (outcome) => {
      finish(outcome);
      await done;
    },
  };
}

describe('W04a idempotency helpers', () => {
  it('canonicalizes key order, omits undefined members and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: undefined, e: null } })).toBe('{"a":{"d":[3,1],"e":null},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });

  it('hashes method, operation, params and body into a stable SHA-256', () => {
    const base = { method: 'post', operation: 'tasks.create' as const, body: { title: 'x', labelIds: [] } };
    const hash = computeRequestHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRequestHash({ ...base, method: 'POST', body: { labelIds: [], title: 'x' } })).toBe(hash);
    expect(computeRequestHash({ ...base, operation: 'tasks.bulk_create' })).not.toBe(hash);
    expect(computeRequestHash({ ...base, body: { title: 'y', labelIds: [] } })).not.toBe(hash);
    expect(computeRequestHash({ ...base, params: { id: 'a' } })).not.toBe(hash);
  });

  it('parses the header: absent, bare, structured-field quoted and invalid forms', () => {
    const make = (value?: string) => {
      const req = express.request;
      return Object.assign(Object.create(req) as typeof req, {
        headers: value === undefined ? {} : { 'idempotency-key': value },
      });
    };
    expect(readIdempotencyKey(make())).toBeNull();
    expect(readIdempotencyKey(make('abcd-1234-efgh'))).toBe('abcd-1234-efgh');
    expect(readIdempotencyKey(make('"abcd-1234-efgh"'))).toBe('abcd-1234-efgh');
    for (const bad of ['', 'short', 'x'.repeat(129), 'has space 123', 'k1-12345, k2-12345', 'tab\tinside1']) {
      let caught: unknown;
      try {
        readIdempotencyKey(make(bad));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).statusCode).toBe(400);
      expect((caught as HttpError).code).toBe('IDEMPOTENCY_KEY_INVALID');
    }
  });
});

describe('W04a Idempotency-Key on task creation (PostgreSQL)', () => {
  const app = createApp();
  const http = useTestServer(() => app);

  let ownerId: string;
  let ownerToken: string;
  let memberId: string;
  let memberToken: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let otherProjectId: string;
  let teamId: string;
  let otherTeamId: string;
  let labelId: string;

  const projectIds = (): string[] => [projectId, otherProjectId];

  async function taskCount(where: { title?: string; projectId?: string } = {}): Promise<number> {
    return prisma.task.count({ where: { projectId: where.projectId ?? { in: projectIds() }, ...(where.title ? { title: where.title } : {}) } });
  }

  async function nextIssueNumber(id: string = teamId): Promise<number> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id }, select: { nextIssueNumber: true } });
    return team.nextIssueNumber;
  }

  async function records(key: string) {
    return prisma.idempotencyRecord.findMany({ where: { key }, orderBy: { createdAt: 'asc' } });
  }

  function createTaskRequest(auth: string, key: string | undefined, body: Record<string, unknown>) {
    const req = http().post('/api/tasks').set('Authorization', `Bearer ${auth}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  }

  function bulkRequest(auth: string, key: string | undefined, body: Record<string, unknown>) {
    const req = http().post('/api/tasks/bulk').set('Authorization', `Bearer ${auth}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  }

  async function cleanup(): Promise<void> {
    const userIds = [ownerId, memberId].filter(Boolean);
    if (userIds.length) {
      await prisma.idempotencyRecord.deleteMany({ where: { principalId: { in: userIds } } });
    }
    const projects = projectIds().filter(Boolean);
    if (projects.length) {
      await prisma.taskLabel.deleteMany({ where: { task: { projectId: { in: projects } } } });
      await prisma.taskAssignee.deleteMany({ where: { task: { projectId: { in: projects } } } });
      await prisma.activityLog.deleteMany({ where: { projectId: { in: projects } } });
      await prisma.task.deleteMany({ where: { projectId: { in: projects } } });
      await prisma.label.deleteMany({ where: { projectId: { in: projects } } });
      await prisma.projectAccess.deleteMany({ where: { projectId: { in: projects } } });
      await prisma.teamMember.deleteMany({ where: { team: { projectId: { in: projects } } } });
      await prisma.team.deleteMany({ where: { projectId: { in: projects } } });
      await prisma.project.deleteMany({ where: { id: { in: projects } } });
    }
    const workspaces = [workspaceId, otherWorkspaceId].filter(Boolean);
    if (workspaces.length) {
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    }
  }

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { githubId: `w04a-owner-${RUN}`, username: `w04a_owner_${RUN}`, email: `w04a-owner-${RUN}@example.com` },
    });
    const member = await prisma.user.create({
      data: { githubId: `w04a-member-${RUN}`, username: `w04a_member_${RUN}`, email: `w04a-member-${RUN}@example.com` },
    });
    ownerId = owner.id;
    memberId = member.id;
    ownerToken = token(owner.id, owner.username);
    memberToken = token(member.id, member.username);

    const workspace = await prisma.workspace.create({ data: { name: `W04a ${RUN}`, slug: `w04a-${RUN}` } });
    const otherWorkspace = await prisma.workspace.create({ data: { name: `W04a other ${RUN}`, slug: `w04a-other-${RUN}` } });
    workspaceId = workspace.id;
    otherWorkspaceId = otherWorkspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: ownerId, role: 'owner' },
        { workspaceId, userId: memberId, role: 'member' },
        { workspaceId: otherWorkspaceId, userId: ownerId, role: 'owner' },
      ],
    });

    const project = await prisma.project.create({ data: { name: 'W04a project', key: 'WFA', workspaceId } });
    const otherProject = await prisma.project.create({ data: { name: 'W04a other', key: 'WFB', workspaceId: otherWorkspaceId } });
    projectId = project.id;
    otherProjectId = otherProject.id;
    await prisma.projectAccess.createMany({
      data: [
        { projectId, userId: ownerId, permission: 'full' },
        { projectId, userId: memberId, permission: 'full' },
        { projectId: otherProjectId, userId: ownerId, permission: 'full' },
      ],
    });

    const team = await prisma.team.create({ data: { name: 'W04a team', key: 'WFA', projectId } });
    const otherTeam = await prisma.team.create({ data: { name: 'W04a other team', key: 'WFB', projectId: otherProjectId } });
    teamId = team.id;
    otherTeamId = otherTeam.id;
    await prisma.teamMember.createMany({
      data: [
        { teamId, userId: ownerId, role: 'owner' },
        { teamId, userId: memberId, role: 'member' },
        { teamId: otherTeamId, userId: ownerId, role: 'owner' },
      ],
    });

    const label = await prisma.label.create({ data: { name: 'w04a', color: '#123456', projectId } });
    labelId = label.id;

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION ${FAIL_FN}() RETURNS trigger AS $$
      BEGIN
        IF NEW.title = '${FAIL_TITLE}' THEN
          RAISE EXCEPTION 'w04a injected insert failure';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
  }, 30_000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${FAIL_FN} ON tasks`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FAIL_FN}()`);
    await cleanup();
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
  }, 30_000);

  beforeEach(async () => {
    await prisma.projectAccess.updateMany({ where: { projectId, userId: memberId }, data: { permission: 'full' } });
  });

  it('keeps legacy behavior without the header: identical requests create two tasks and no record', async () => {
    const title = `no-key-${RUN}`;
    const first = await createTaskRequest(ownerToken, undefined, { title, projectId });
    const second = await createTaskRequest(ownerToken, undefined, { title, projectId });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(await taskCount({ title })).toBe(2);
    expect(await prisma.idempotencyRecord.count({ where: { principalId: ownerId } })).toBe(0);
  });

  it('replays the identical response for the same key and body, writing once', async () => {
    const key = freshKey('replay');
    const title = `replay-${RUN}`;
    const before = await nextIssueNumber();

    const first = await createTaskRequest(ownerToken, key, { title, projectId, labelIds: [labelId] });
    const second = await createTaskRequest(ownerToken, key, { title, projectId, labelIds: [labelId] });

    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.text).toBe(first.text);
    expect(second.headers['content-type']).toBe(first.headers['content-type']);
    expect(first.body.labels).toEqual([expect.objectContaining({ id: labelId })]);

    expect(await taskCount({ title })).toBe(1);
    expect(await nextIssueNumber()).toBe(before + 1);
    const stored = await records(key);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      principalId: ownerId,
      workspaceId,
      operation: 'tasks.create',
      state: 'completed',
      responseStatus: 201,
      responseBody: first.text,
    });
    expect(stored[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it('treats canonically equal bodies (key order, explicit defaults, quoted key) as the same request', async () => {
    const key = freshKey('canonical');
    const title = `canonical-${RUN}`;
    const first = await createTaskRequest(ownerToken, key, { title, projectId });
    const reordered = await createTaskRequest(ownerToken, `"${key}"`, {
      priority: 'medium', projectId, status: 'todo', labelIds: [], title,
    });

    expect(first.status).toBe(201);
    expect(reordered.status).toBe(201);
    expect(reordered.headers['idempotency-replayed']).toBe('true');
    expect(reordered.text).toBe(first.text);
    expect(await taskCount({ title })).toBe(1);
  });

  it('returns 409 IDEMPOTENCY_CONFLICT for a different body under the same key and writes nothing', async () => {
    const key = freshKey('conflict');
    const title = `conflict-${RUN}`;
    const first = await createTaskRequest(ownerToken, key, { title, projectId });
    const storedBefore = await records(key);
    const before = await nextIssueNumber();

    const conflict = await createTaskRequest(ownerToken, key, { title: `${title}-changed`, projectId });

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(conflict.body.details).toMatchObject({ operation: 'tasks.create' });
    expect(await taskCount({ title: `${title}-changed` })).toBe(0);
    expect(await nextIssueNumber()).toBe(before);
    expect(await records(key)).toEqual(storedBefore);
  });

  it('rejects malformed keys with 400 before any write', async () => {
    const title = `bad-key-${RUN}`;
    for (const bad of ['', 'short', 'k'.repeat(129), 'has space 123']) {
      const res = await createTaskRequest(ownerToken, bad, { title, projectId });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    }
    expect(await taskCount({ title })).toBe(0);
    expect(await prisma.idempotencyRecord.count({ where: { principalId: ownerId, key: { startsWith: 'has' } } })).toBe(0);
  });

  it('authorizes before replaying: a principal that lost access gets 403, not the stored body', async () => {
    const key = freshKey('authz');
    const title = `authz-${RUN}`;
    const first = await createTaskRequest(memberToken, key, { title, projectId });
    expect(first.status).toBe(201);

    await prisma.projectAccess.updateMany({ where: { projectId, userId: memberId }, data: { permission: 'deny' } });
    const replay = await createTaskRequest(memberToken, key, { title, projectId });

    expect(replay.status).toBe(403);
    expect(replay.headers['idempotency-replayed']).toBeUndefined();
    expect(replay.text).not.toContain(first.body.id);
  });

  it('rolls the reservation back with a failed mutation so a retry with the same key succeeds', async () => {
    const key = freshKey('failure');
    const before = await nextIssueNumber();
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${FAIL_FN} BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION ${FAIL_FN}()`,
    );
    let failed: request.Response;
    try {
      failed = await createTaskRequest(ownerToken, key, { title: FAIL_TITLE, projectId });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${FAIL_FN} ON tasks`);
    }

    expect(failed.status).toBe(500);
    expect(await records(key)).toHaveLength(0);
    expect(await taskCount({ title: FAIL_TITLE })).toBe(0);
    expect(await nextIssueNumber()).toBe(before);

    const retry = await createTaskRequest(ownerToken, key, { title: FAIL_TITLE, projectId });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBeUndefined();
    expect(await taskCount({ title: FAIL_TITLE })).toBe(1);
    expect(await nextIssueNumber()).toBe(before + 1);
    expect(await records(key)).toEqual([expect.objectContaining({ state: 'completed', responseBody: retry.text })]);
  });

  it('forced race: duplicates that pass the fast path wait on the reservation and replay one write', async () => {
    const key = freshKey('race');
    const title = `race-${RUN}`;
    const before = await nextIssueNumber();
    const baseline = await lockWaiters();

    // Hold the team row so the owning request blocks inside its transaction
    // AFTER reserving the key but BEFORE committing.
    const holder = holdTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId} FOR UPDATE`;
    });
    await holder.ready;

    const owner = createTaskRequest(ownerToken, key, { title, projectId }).then((res) => res);
    await waitForLockWaiters(baseline + 1);

    const duplicates = Array.from({ length: 4 }, () =>
      createTaskRequest(ownerToken, key, { title, projectId }).then((res) => res));
    // Owner on the team row + four duplicates on the uncommitted reservation.
    await waitForLockWaiters(baseline + 5);
    expect(await records(key)).toHaveLength(0);

    await holder.release('commit');
    const responses = await Promise.all([owner, ...duplicates]);

    expect(responses.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    expect(responses[0].headers['idempotency-replayed']).toBeUndefined();
    for (const duplicate of responses.slice(1)) {
      expect(duplicate.headers['idempotency-replayed']).toBe('true');
      expect(duplicate.text).toBe(responses[0].text);
    }
    expect(await taskCount({ title })).toBe(1);
    expect(await nextIssueNumber()).toBe(before + 1);
    expect(await records(key)).toHaveLength(1);
  });

  it('burst: 20 concurrent identical requests produce exactly one task and one shared response', async () => {
    const key = freshKey('burst');
    const title = `burst-${RUN}`;
    const before = await nextIssueNumber();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => createTaskRequest(ownerToken, key, { title, projectId }).then((res) => res)),
    );

    expect(responses.every((res) => res.status === 201)).toBe(true);
    expect(responses.filter((res) => res.headers['idempotency-replayed'] === undefined)).toHaveLength(1);
    expect(new Set(responses.map((res) => res.text)).size).toBe(1);
    expect(await taskCount({ title })).toBe(1);
    expect(await nextIssueNumber()).toBe(before + 1);
    expect(await records(key)).toHaveLength(1);
  });

  it('a concurrent different body waits for the holder and then conflicts', async () => {
    const key = freshKey('race-conflict');
    const title = `race-conflict-${RUN}`;
    const baseline = await lockWaiters();
    const holder = holdTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId} FOR UPDATE`;
    });
    await holder.ready;

    const owner = createTaskRequest(ownerToken, key, { title, projectId }).then((res) => res);
    await waitForLockWaiters(baseline + 1);
    const other = createTaskRequest(ownerToken, key, { title: `${title}-other`, projectId }).then((res) => res);
    await waitForLockWaiters(baseline + 2);
    await holder.release('commit');

    const [ownerRes, otherRes] = await Promise.all([owner, other]);
    expect(ownerRes.status).toBe(201);
    expect(otherRes.status).toBe(409);
    expect(otherRes.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await taskCount({ title: `${title}-other` })).toBe(0);
  });

  it('takes the key over when the concurrent holder rolls back', async () => {
    const key = freshKey('takeover');
    const title = `takeover-${RUN}`;
    const baseline = await lockWaiters();
    const holder = holdTransaction(async (tx) => {
      await tx.idempotencyRecord.createMany({
        data: [{
          id: randomUUID(), principalId: ownerId, workspaceId, operation: 'tasks.create', key,
          requestHash: 'f'.repeat(64), expiresAt: new Date(Date.now() + 60_000),
        }],
      });
    });
    await holder.ready;

    const pending = createTaskRequest(ownerToken, key, { title, projectId }).then((res) => res);
    await waitForLockWaiters(baseline + 1);
    await holder.release('rollback');
    const res = await pending;

    expect(res.status).toBe(201);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
    expect(await taskCount({ title })).toBe(1);
    expect(await records(key)).toEqual([expect.objectContaining({ state: 'completed', responseBody: res.text })]);
  });

  it('bounds the wait: a holder still running after the lock wait yields 409 IN_PROGRESS with Retry-After', async () => {
    const key = freshKey('in-flight');
    const title = `in-flight-${RUN}`;
    const holder = holdTransaction(async (tx) => {
      await tx.idempotencyRecord.createMany({
        data: [{
          id: randomUUID(), principalId: ownerId, workspaceId, operation: 'tasks.create', key,
          requestHash: 'f'.repeat(64), expiresAt: new Date(Date.now() + 60_000),
        }],
      });
    });
    await holder.ready;

    const started = Date.now();
    const res = await createTaskRequest(ownerToken, key, { title, projectId });
    const waited = Date.now() - started;
    await holder.release('rollback');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(res.headers['retry-after']).toBe('1');
    expect(waited).toBeGreaterThanOrEqual(IDEMPOTENCY_LOCK_WAIT_MS - 250);
    expect(await taskCount({ title })).toBe(0);

    const retry = await createTaskRequest(ownerToken, key, { title, projectId });
    expect(retry.status).toBe(201);
    expect(await taskCount({ title })).toBe(1);
  }, 20_000);

  it('answers a committed in_progress record with 409 IN_PROGRESS (equal body) or CONFLICT (different body)', async () => {
    const key = freshKey('committed-in-progress');
    const body = { title: `committed-in-progress-${RUN}`, projectId };
    await prisma.idempotencyRecord.create({
      data: {
        principalId: ownerId, workspaceId, operation: 'tasks.create', key,
        requestHash: computeRequestHash({ method: 'POST', operation: 'tasks.create', body: createTaskBodySchema.parse(body) }),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const same = await createTaskRequest(ownerToken, key, body);
    const different = await createTaskRequest(ownerToken, key, { ...body, title: `${body.title}-x` });

    expect(same.status).toBe(409);
    expect(same.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(same.headers['retry-after']).toBe('1');
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await taskCount({ title: body.title })).toBe(0);
  });

  it('scopes keys by principal: another user with the same key and body creates its own task', async () => {
    const key = freshKey('principal');
    const title = `principal-${RUN}`;
    const mine = await createTaskRequest(ownerToken, key, { title, projectId });
    const theirs = await createTaskRequest(memberToken, key, { title, projectId });

    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.headers['idempotency-replayed']).toBeUndefined();
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(await taskCount({ title })).toBe(2);
    expect((await records(key)).map((row) => row.principalId).sort()).toEqual([ownerId, memberId].sort());
  });

  it('scopes keys by operation: the same key on single and bulk create are independent', async () => {
    const key = freshKey('operation');
    const title = `operation-${RUN}`;
    const single = await createTaskRequest(ownerToken, key, { title, projectId });
    const bulk = await bulkRequest(ownerToken, key, { projectId, tasks: [{ title }] });

    expect(single.status).toBe(201);
    expect(bulk.status).toBe(201);
    expect(bulk.headers['idempotency-replayed']).toBeUndefined();
    expect(await taskCount({ title })).toBe(2);
    expect((await records(key)).map((row) => row.operation).sort()).toEqual(['tasks.bulk_create', 'tasks.create']);
  });

  it('scopes keys by workspace: the same key in another workspace is independent, not a conflict', async () => {
    const key = freshKey('workspace');
    const title = `workspace-${RUN}`;
    const here = await createTaskRequest(ownerToken, key, { title, projectId });
    const there = await createTaskRequest(ownerToken, key, { title, projectId: otherProjectId });

    expect(here.status).toBe(201);
    expect(there.status).toBe(201);
    expect(there.headers['idempotency-replayed']).toBeUndefined();
    const stored = await records(key);
    expect(stored.map((row) => row.workspaceId).sort()).toEqual([workspaceId, otherWorkspaceId].sort());
  });

  it('forgets expired records: the key is reusable and the sweep removes only expired rows', async () => {
    const key = freshKey('expiry');
    const title = `expiry-${RUN}`;
    const first = await createTaskRequest(ownerToken, key, { title, projectId });
    expect(first.status).toBe(201);
    const [original] = await records(key);

    await prisma.idempotencyRecord.update({ where: { id: original.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const reused = await createTaskRequest(ownerToken, key, { title: `${title}-v2`, projectId });
    expect(reused.status).toBe(201);
    expect(reused.headers['idempotency-replayed']).toBeUndefined();

    const [replacement] = await records(key);
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.requestHash).not.toBe(original.requestHash);
    expect(replacement.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const replay = await createTaskRequest(ownerToken, key, { title: `${title}-v2`, projectId });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.text).toBe(reused.text);

    const expiredKey = freshKey('expired-sweep');
    await prisma.idempotencyRecord.create({
      data: {
        principalId: ownerId, workspaceId, operation: 'tasks.create', key: expiredKey,
        requestHash: 'e'.repeat(64), expiresAt: new Date(Date.now() - 1_000),
      },
    });
    expect(await pruneIdempotencyRecords()).toBeGreaterThanOrEqual(1);
    expect(await records(expiredKey)).toHaveLength(0);
    expect(await records(key)).toHaveLength(1);
  });

  it('bulk: replays the stored result, including partial failures, and allocates numbers once', async () => {
    const key = freshKey('bulk');
    const body = {
      projectId,
      tasks: [
        { title: `bulk-a-${RUN}` },
        { title: `bulk-b-${RUN}`, labelIds: [randomUUID()] },
        { title: `bulk-c-${RUN}`, labelIds: [labelId] },
      ],
    };
    const before = await nextIssueNumber();

    const first = await bulkRequest(ownerToken, key, body);
    const second = await bulkRequest(ownerToken, key, body);
    const changed = await bulkRequest(ownerToken, key, { ...body, tasks: body.tasks.slice(0, 1) });

    expect(first.status).toBe(201);
    expect(first.body.created).toHaveLength(2);
    expect(first.body.failed).toEqual([{ index: 1, error: expect.stringContaining('Invalid labelIds') }]);
    expect(second.status).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.text).toBe(first.text);
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await nextIssueNumber()).toBe(before + 2);
    expect(await prisma.task.count({ where: { projectId, title: { startsWith: 'bulk-' } } })).toBe(2);
  });

  it('bulk: concurrent identical requests create the batch once', async () => {
    const key = freshKey('bulk-burst');
    const body = { projectId, tasks: Array.from({ length: 10 }, (_, index) => ({ title: `bulk-burst-${index}-${RUN}` })) };
    const before = await nextIssueNumber();

    const responses = await Promise.all(Array.from({ length: 8 }, () => bulkRequest(ownerToken, key, body).then((res) => res)));

    expect(responses.every((res) => res.status === 201)).toBe(true);
    expect(new Set(responses.map((res) => res.text)).size).toBe(1);
    expect(await nextIssueNumber()).toBe(before + 10);
    expect(await prisma.task.count({ where: { projectId, title: { startsWith: 'bulk-burst-' } } })).toBe(10);
  });

  it('fails closed when the result exceeds the retention bound: 422 and nothing written', async () => {
    const mini = express();
    mini.use(express.json());
    mini.post('/tiny', requireAuth, async (req: AuthRequest, res: Response) => {
      const title = String((req.body as { title?: unknown }).title);
      await respondIdempotently(req, res, {
        operation: 'tasks.create',
        args: { body: { title } },
        settings: { maxResponseBytes: 64 },
        authorize: () => authorizeCreateTask({ userId: req.userId!, title, projectId }),
      });
    });
    mini.use(buildErrorHandler());

    const title = `too-large-${RUN}`;
    const key = freshKey('too-large');
    const server = await startTestServer(mini);
    try {
      const res = await server.client().post('/tiny').set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', key).send({ title });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_RESPONSE_TOO_LARGE');
      expect(await taskCount({ title })).toBe(0);
      expect(await records(key)).toHaveLength(0);

      const unkeyed = await server.client().post('/tiny').set('Authorization', `Bearer ${ownerToken}`).send({ title });
      expect(unkeyed.status).toBe(201);
      expect(await taskCount({ title })).toBe(1);
    } finally {
      await server.close();
    }
  });
});
