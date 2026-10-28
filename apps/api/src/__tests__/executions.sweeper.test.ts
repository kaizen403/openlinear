/**
 * W05a control plane: the attempt lease sweeper (dead sidecar → task
 * released, attempt fenced) and capability renewal for long runs.
 *
 * Real PostgreSQL (TEST_DATABASE_URL); the API is served on an ephemeral
 * loopback port. Fixtures delete only the rows they create.
 */
import { randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptToken, Prisma, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { LOST_SIDECAR_OUTCOME, sweepLostExecutionAttempts } from '../services/execution-sweeper';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const ids = { users: [] as string[], workspaces: [] as string[], repositories: [] as string[] };
let server: Server | undefined;
let baseUrl = '';
let ownerId = '';
let ownerJwt = '';
let projectId = '';
let teamId = '';
let workspaceId = '';
let writePat = '';
let writePatId = '';

interface Started {
  attemptId: string;
  token: string;
}

async function api(method: string, path: string, bearer: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function makeTask(title = `sweeper task ${randomUUID().slice(0, 6)}`) {
  return prisma.task.create({
    data: { title, description: 'W05a fixture', model: 'stub/model', projectId, teamId, workspaceId, creatorId: ownerId },
  });
}

async function start(taskId: string, bearer = ownerJwt): Promise<Started> {
  const res = await api('POST', '/api/executions/attempts', bearer, { taskId });
  expect(res.status).toBe(201);
  const attempt = res.body.attempt as { id: string };
  const capability = res.body.capability as { token: string };
  return { attemptId: attempt.id, token: capability.token };
}

function callback(started: Started, action: string, body: unknown = {}, token = started.token) {
  return api('POST', `/api/executions/attempts/${started.attemptId}/${action}`, token, body);
}

async function claim(started: Started, sessionId = `ses_${randomUUID().slice(0, 8)}`) {
  const res = await callback(started, 'claim', { sessionId, runner: 'opencode', model: 'stub/model' });
  expect(res.status).toBe(200);
  return sessionId;
}

/** Age an attempt's lease by `ms`. */
async function age(attemptId: string, ms: number) {
  await prisma.executionAttempt.update({ where: { id: attemptId }, data: { heartbeatAt: new Date(Date.now() - ms) } });
}

async function eventsFor(taskId: string, type: string): Promise<number> {
  // One snapshot for both tables: the outbox sequencer moves rows from
  // `domain_event_outbox` to `domain_events` right after commit, so two
  // independent reads could count the same event in both tables.
  const [sequenced, pending] = await prisma.$transaction(
    async (tx) => [
      await tx.domainEvent.findMany({ where: { type, actorId: ownerId } }),
      await tx.domainEventOutbox.findMany({ where: { type, actorId: ownerId } }),
    ] as const,
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return [...sequenced, ...pending].filter((row) => (row.payload as { taskId?: string; id?: string }).taskId === taskId
    || (row.payload as { id?: string }).id === taskId).length;
}

const LEASE = 60_000;

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { username: `w05a-owner-${RUN}`, email: `w05a-owner-${RUN}@example.com`, accessToken: encryptToken(`gho_w05a_${RUN}_token_value_0123456789ab`) },
  });
  ownerId = owner.id;
  ids.users.push(owner.id);
  ownerJwt = jwt.sign({ userId: owner.id, username: owner.username }, testJwtSecret(), { expiresIn: '1h' });
  const workspace = await prisma.workspace.create({ data: { name: `W05a ${RUN}`, slug: `w05a-${RUN}` } });
  workspaceId = workspace.id;
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
  const repository = await prisma.repository.create({
    data: {
      userId: owner.id,
      githubRepoId: 900_000 + Math.floor(Math.random() * 99_999),
      name: 'w05a',
      fullName: `acme-${RUN}/w05a`,
      cloneUrl: `https://github.com/acme-${RUN}/w05a.git`,
      defaultBranch: 'main',
    },
  });
  ids.repositories.push(repository.id);
  const project = await prisma.project.create({
    data: { name: `W05a project ${RUN}`, workspaceId: workspace.id, key: `W5${RUN.slice(0, 3).toUpperCase()}`, repositoryId: repository.id },
  });
  projectId = project.id;
  const team = await prisma.team.create({ data: { name: `W05a team ${RUN}`, key: `T5${RUN.slice(0, 2).toUpperCase()}`, projectId: project.id } });
  teamId = team.id;
  await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: 'owner' } });
  const token = generatePersonalAccessToken();
  const pat = await prisma.personalAccessToken.create({
    data: { userId: owner.id, name: `w05a-${RUN}`, tokenHash: hashPersonalAccessToken(token), tokenPrefix: token.slice(0, 15), scopes: ['tasks:write'] },
  });
  writePat = token;
  writePatId = pat.id;

  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.task.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.repository.deleteMany({ where: { id: { in: ids.repositories } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('W05a lease sweeper', () => {
  it('releases an unclaimed attempt whose sidecar died; the task was never touched', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await age(started.attemptId, LEASE + 1_000);
    const result = await sweepLostExecutionAttempts({ leaseMs: LEASE });
    expect(result.released).toBeGreaterThanOrEqual(1);
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: started.attemptId }, include: { capabilities: true } });
    expect(attempt).toMatchObject({ status: 'released', closeReason: 'sidecar_lost', recoveryState: 'abandoned' });
    expect(attempt.sweptAt).not.toBeNull();
    expect(attempt.capabilities.every((capability) => capability.revokedAt !== null)).toBe(true);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'todo', sessionId: null });
  });

  it('releases a claimed task from in_progress (W01 fence) so the user can retry, and fails the run', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await claim(started);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('in_progress');
    await age(started.attemptId, LEASE + 1_000);
    const result = await sweepLostExecutionAttempts({ leaseMs: LEASE });
    expect(result.recoveryRequired).toBeGreaterThanOrEqual(1);

    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row).toMatchObject({ status: 'cancelled', sessionId: null, outcome: LOST_SIDECAR_OUTCOME });
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: started.attemptId }, include: { agentRun: true, capabilities: true } });
    expect(attempt).toMatchObject({ status: 'closed', closeReason: 'sidecar_lost', recoveryState: 'recovery_required', terminalStatus: 'cancelled' });
    expect(attempt.agentRun).toMatchObject({ status: 'failed', errorMessage: 'sidecar_lost' });
    expect(attempt.capabilities.every((capability) => capability.revokedAt !== null)).toBe(true);
    expect(await eventsFor(task.id, 'task:updated')).toBeGreaterThanOrEqual(1);
    expect(await eventsFor(task.id, 'execution:progress')).toBeGreaterThanOrEqual(1);

    // The user can start again right away.
    const retry = await start(task.id);
    expect(retry.attemptId).not.toBe(started.attemptId);
  });

  it('fences a sidecar that comes back: every callback is refused and nothing is rewritten', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await claim(started);
    await age(started.attemptId, LEASE + 1_000);
    await sweepLostExecutionAttempts({ leaseMs: LEASE });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });

    for (const [action, body] of [
      ['heartbeat', {}],
      ['events', { events: [{ seq: 1, type: 'execution:progress', payload: { status: 'executing', message: 'late' } }] }],
      ['terminal', { status: 'done', prUrl: `https://github.com/acme-${RUN}/w05a/pull/1` }],
      ['run', { status: 'succeeded' }],
      ['renew', {}],
      ['git-credential', { purpose: 'publish' }],
      ['close', {}],
    ] as const) {
      const res = await callback(started, action, body);
      expect(res.status, action).toBe(401);
      expect(res.body.code, action).toBe('CAPABILITY_REVOKED');
    }
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after).toMatchObject({ status: before.status, outcome: before.outcome, prUrl: before.prUrl, sessionId: null });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('leaves attempts with a fresh heartbeat alone', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await claim(started);
    await sweepLostExecutionAttempts({ leaseMs: LEASE });
    expect((await prisma.executionAttempt.findUniqueOrThrow({ where: { id: started.attemptId } })).status).toBe('running');
    expect((await callback(started, 'heartbeat')).status).toBe(200);
  });

  it('never touches a task that already belongs to a replacement attempt', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await claim(started);
    // Another execution took the task over (e.g. after a manual release).
    await prisma.task.update({ where: { id: task.id }, data: { sessionId: 'ses_replacement' } });
    await age(started.attemptId, LEASE + 1_000);
    await sweepLostExecutionAttempts({ leaseMs: LEASE });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'in_progress', sessionId: 'ses_replacement' });
    expect(await prisma.executionAttempt.findUniqueOrThrow({ where: { id: started.attemptId } })).toMatchObject({ status: 'closed', recoveryState: 'abandoned', terminalStatus: null });
  });

  it('closes an attempt that lost its sidecar after the terminal projection, finalizing the run from it', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await claim(started);
    expect((await callback(started, 'terminal', { status: 'cancelled', outcome: 'stopped' })).status).toBe(200);
    await age(started.attemptId, LEASE + 1_000);
    const result = await sweepLostExecutionAttempts({ leaseMs: LEASE });
    expect(result.closed).toBeGreaterThanOrEqual(1);
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: started.attemptId }, include: { agentRun: true } });
    expect(attempt).toMatchObject({ status: 'closed', closeReason: 'sidecar_lost_after_terminal' });
    expect(attempt.agentRun?.status).toBe('failed');
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'cancelled', outcome: 'stopped' });
  });

  it('fences each attempt exactly once under concurrent sweeps', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await claim(started);
    await age(started.attemptId, LEASE + 1_000);
    const [a, b] = await Promise.all([sweepLostExecutionAttempts({ leaseMs: LEASE }), sweepLostExecutionAttempts({ leaseMs: LEASE })]);
    const fenced = await prisma.executionAttempt.count({ where: { id: started.attemptId, status: 'closed', recoveryState: 'recovery_required' } });
    expect(fenced).toBe(1);
    expect(a.recoveryRequired + b.recoveryRequired).toBeGreaterThanOrEqual(1);
    expect(await eventsFor(task.id, 'execution:progress')).toBe(1);
  });

  it('lets a heartbeat that lands before the lock win over the sweep', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await claim(started);
    await age(started.attemptId, LEASE + 1_000);
    expect((await callback(started, 'heartbeat')).status).toBe(200);
    await sweepLostExecutionAttempts({ leaseMs: LEASE });
    expect((await prisma.executionAttempt.findUniqueOrThrow({ where: { id: started.attemptId } })).status).toBe('running');
  });
});

describe('W05a capability renewal', () => {
  it('rotates the capability; the previous one survives only a short grace window', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await claim(started);
    const renewed = await callback(started, 'renew');
    expect(renewed.status).toBe(200);
    const capability = renewed.body.capability as { token: string; expiresAt: string };
    expect(capability.token).toMatch(/^olx_/);
    expect(capability.token).not.toBe(started.token);
    expect(renewed.body.renewals).toBe(1);
    expect(Date.parse(String(renewed.body.previousExpiresAt))).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1_000);
    expect((await callback({ attemptId: started.attemptId, token: capability.token }, 'heartbeat')).status).toBe(200);
    expect((await callback(started, 'heartbeat')).status).toBe(200);
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: started.attemptId }, include: { capabilities: true } });
    expect(attempt.renewals).toBe(1);
    expect(attempt.renewedAt).not.toBeNull();
    expect(attempt.capabilities).toHaveLength(2);
    // Close revokes every capability, old and new.
    expect((await callback({ attemptId: started.attemptId, token: capability.token }, 'close')).status).toBe(200);
    expect((await callback(started, 'heartbeat')).body.code).toBe('CAPABILITY_REVOKED');
  });

  it('refuses to renew a lapsed lease or an attempt past its lifetime', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    await claim(started);
    await age(started.attemptId, 10 * 60_000);
    const lapsed = await callback(started, 'renew');
    expect(lapsed.status).toBe(409);
    expect(lapsed.body.code).toBe('ATTEMPT_LEASE_EXPIRED');

    await prisma.executionAttempt.update({ where: { id: started.attemptId }, data: { heartbeatAt: new Date(), createdAt: new Date(Date.now() - 25 * 60 * 60_000) } });
    const expired = await callback(started, 'renew');
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe('ATTEMPT_LIFETIME_EXCEEDED');
  });

  it('re-authorizes the initiator: a revoked PAT cannot extend its attempt', async () => {
    const task = await makeTask();
    const started = await start(task.id, writePat);
    await claim(started);
    await prisma.personalAccessToken.update({ where: { id: writePatId }, data: { revokedAt: new Date() } });
    try {
      const res = await callback(started, 'renew');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EXECUTION_ACCESS_REVOKED');
    } finally {
      await prisma.personalAccessToken.update({ where: { id: writePatId }, data: { revokedAt: null } });
    }
  });

  it('is capability-only: user credentials are refused', async () => {
    const task = await makeTask();
    const started = await start(task.id);
    for (const bearer of [ownerJwt, writePat]) {
      const res = await callback(started, 'renew', {}, bearer);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('CAPABILITY_REQUIRED');
    }
  });
});
