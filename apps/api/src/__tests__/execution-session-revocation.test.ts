/**
 * W12a: an execution started from an interactive session stops being
 * authorized when that session is signed out or revoked — like a revoked PAT
 * — but survives the routine refresh rotation (the user is still signed in).
 *
 * Real PostgreSQL (TEST_DATABASE_URL); session-bound access tokens (no
 * sessionless fallback); fixtures delete only what they create.
 */
import { randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptToken, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { clearTenancyCache } from '../tenancy/context';
import { createTestSession, makeUser } from './auth-helpers';

const RUN = randomUUID().slice(0, 8);
const ids = { users: [] as string[], workspaces: [] as string[], repositories: [] as string[] };
let server: Server | undefined;
let baseUrl = '';
let user = { id: '', username: '' };
let projectId = '';
let teamId = '';
let workspaceId = '';

async function api(method: string, path: string, bearer: string, body: unknown = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function startWith(accessToken: string) {
  const task = await prisma.task.create({
    data: { title: `w12a ${randomUUID().slice(0, 6)}`, description: 'W12a', model: 'stub/model', projectId, teamId, workspaceId, creatorId: user.id },
  });
  const res = await api('POST', '/api/executions/attempts', accessToken, { taskId: task.id });
  expect(res.status).toBe(201);
  const started = { attemptId: (res.body.attempt as { id: string }).id, token: (res.body.capability as { token: string }).token };
  const claimed = await api('POST', `/api/executions/attempts/${started.attemptId}/claim`, started.token, { sessionId: `ses_${RUN}`, runner: 'opencode', model: 'stub/model' });
  expect(claimed.status).toBe(200);
  return started;
}

function credential(started: { attemptId: string; token: string }) {
  return api('POST', `/api/executions/attempts/${started.attemptId}/git-credential`, started.token, { effect: 'push' });
}

beforeAll(async () => {
  const made = await makeUser('w12a', RUN);
  user = { id: made.id, username: made.username };
  ids.users.push(made.id);
  await prisma.user.update({ where: { id: made.id }, data: { accessToken: encryptToken(`gho_w12a_${RUN}_token_value_0123456789ab`) } });
  const workspace = await prisma.workspace.create({ data: { name: `W12a ${RUN}`, slug: `w12a-${RUN}` } });
  workspaceId = workspace.id;
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: made.id, role: 'owner' } });
  const repository = await prisma.repository.create({
    data: { userId: made.id, githubRepoId: 600_000 + Math.floor(Math.random() * 99_999), name: 'w12a', fullName: `acme-${RUN}/w12a`, cloneUrl: `https://github.com/acme-${RUN}/w12a.git`, defaultBranch: 'main' },
  });
  ids.repositories.push(repository.id);
  const project = await prisma.project.create({ data: { name: `W12a ${RUN}`, workspaceId, key: `WC${RUN.slice(0, 3).toUpperCase()}`, repositoryId: repository.id } });
  projectId = project.id;
  const team = await prisma.team.create({ data: { name: `W12a team ${RUN}`, key: `TC${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  teamId = team.id;
  await prisma.teamMember.create({ data: { teamId, userId: made.id, role: 'owner' } });

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

describe('W12a session revocation reaches running executions', () => {
  it('records the starting session and stops the attempt when it is signed out', async () => {
    const session = await createTestSession(user);
    const started = await startWith(session.accessToken);
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
    expect(attempt).toMatchObject({ authSource: 'session', credentialId: session.sessionId });
    expect((await credential(started)).status).toBe(200);

    await prisma.session.update({ where: { id: session.sessionId }, data: { revokedAt: new Date() } });
    clearTenancyCache();
    const refused = await credential(started);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('EXECUTION_ACCESS_REVOKED');
    const renewal = await api('POST', `/api/executions/attempts/${started.attemptId}/renew`, started.token, {});
    expect(renewal.status).toBe(403);
  });

  it('survives refresh rotation while the family has a live successor; a revoked family stops it', async () => {
    const session = await createTestSession(user);
    const started = await startWith(session.accessToken);
    // The refresh flow: the presented session is rotated, a successor in the same family is minted.
    const now = new Date();
    await prisma.session.update({ where: { id: session.sessionId }, data: { revokedAt: now, rotatedAt: now } });
    const successor = await createTestSession(user, session.familyId);
    clearTenancyCache();
    expect((await credential(started)).status).toBe(200);

    // Refresh-token reuse (or "sign out everywhere") revokes the whole family.
    await prisma.session.update({ where: { id: successor.sessionId }, data: { revokedAt: new Date() } });
    clearTenancyCache();
    expect((await credential(started)).status).toBe(403);
  });

  it('an expired session stops the attempt', async () => {
    const session = await createTestSession(user);
    const started = await startWith(session.accessToken);
    await prisma.session.update({ where: { id: session.sessionId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    clearTenancyCache();
    expect((await credential(started)).status).toBe(403);
  });
});
