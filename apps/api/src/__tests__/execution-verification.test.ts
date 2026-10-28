/**
 * W11a "done means verified" on the control plane: project verification
 * settings, sealing in the attempt snapshot, evidence recording
 * (idempotent, bound to the sealed policy/checks) and the require-pass gate
 * on `done`.
 *
 * Real PostgreSQL (TEST_DATABASE_URL); the API is served on an ephemeral
 * loopback port. Fixtures delete only the rows they create.
 */
import { createHash, randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checksHashOf, parseProjectVerificationSettings } from '@openlinear/execution-core';
import { encryptToken, Prisma, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const ids = { users: [] as string[], workspaces: [] as string[], repositories: [] as string[] };
let server: Server | undefined;
let baseUrl = '';
let ownerId = '';
let ownerJwt = '';
let memberJwt = '';
let strangerJwt = '';
let readPat = '';
let projectId = '';
let teamId = '';
let workspaceId = '';
let repoFullName = '';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

interface Started {
  attemptId: string;
  token: string;
  taskId: string;
  snapshot: Record<string, unknown>;
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

async function start(): Promise<Started> {
  const task = await prisma.task.create({
    data: { title: `w11a task ${randomUUID().slice(0, 6)}`, description: 'W11a fixture', model: 'stub/model', projectId, teamId, workspaceId, creatorId: ownerId },
  });
  const res = await api('POST', '/api/executions/attempts', ownerJwt, { taskId: task.id });
  expect(res.status).toBe(201);
  return {
    attemptId: (res.body.attempt as { id: string }).id,
    token: (res.body.capability as { token: string }).token,
    taskId: task.id,
    snapshot: res.body.snapshot as Record<string, unknown>,
  };
}

function callback(started: Started, action: string, body: unknown = {}) {
  return api('POST', `/api/executions/attempts/${started.attemptId}/${action}`, started.token, body);
}

async function claim(started: Started): Promise<void> {
  const res = await callback(started, 'claim', { sessionId: `ses_${randomUUID().slice(0, 8)}`, runner: 'opencode', model: 'stub/model' });
  expect(res.status).toBe(200);
}

function putSettings(body: unknown, bearer = ownerJwt) {
  return api('PUT', `/api/projects/${projectId}/verification-settings`, bearer, body);
}

const PROJECT_CHECKS = [
  { name: 'Typecheck', run: 'pnpm typecheck' },
  { id: 'unit', name: 'Unit tests', command: ['pnpm', 'test'], timeoutSeconds: 300 },
];

function projectChecksHash(): string {
  const parsed = parseProjectVerificationSettings({ checks: PROJECT_CHECKS });
  if (!parsed.ok) throw new Error('fixture checks invalid');
  return checksHashOf(parsed.value.checks, (text) => createHash('sha256').update(text).digest('hex'));
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    runId: `run-${RUN}`,
    commitSha: SHA_A,
    baseSha: SHA_B,
    checksHash: projectChecksHash(),
    policy: 'warn',
    status: 'passed',
    publication: 'allowed',
    source: 'project',
    runner: 'opencode',
    environment: { sandboxMode: 'enforce', provider: 'seatbelt', providerVersion: '1', policyHashes: ['c'.repeat(64)], platform: 'darwin', arch: 'arm64', checkout: 'pristine-clone' },
    checks: [
      {
        id: 'typecheck', name: 'Typecheck', required: true, status: 'passed', exitCode: 0, signal: null, durationMs: 1200, network: 'none',
        command: 'pnpm typecheck', logSha256: 'd'.repeat(64), logBytes: 42, logTruncated: false, logTail: 'ok', detail: null,
      },
    ],
    warnings: [],
    detail: null,
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T10:00:05.000Z',
    ...overrides,
  };
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { username: `w11a-owner-${RUN}`, email: `w11a-owner-${RUN}@example.com`, accessToken: encryptToken(`gho_w11a_${RUN}_token_value_0123456789ab`) },
  });
  const member = await prisma.user.create({ data: { username: `w11a-member-${RUN}`, email: `w11a-member-${RUN}@example.com` } });
  const stranger = await prisma.user.create({ data: { username: `w11a-stranger-${RUN}`, email: `w11a-stranger-${RUN}@example.com` } });
  ownerId = owner.id;
  ids.users.push(owner.id, member.id, stranger.id);
  ownerJwt = jwt.sign({ userId: owner.id, username: owner.username }, testJwtSecret(), { expiresIn: '1h' });
  memberJwt = jwt.sign({ userId: member.id, username: member.username }, testJwtSecret(), { expiresIn: '1h' });
  strangerJwt = jwt.sign({ userId: stranger.id, username: stranger.username }, testJwtSecret(), { expiresIn: '1h' });
  const workspace = await prisma.workspace.create({ data: { name: `W11a ${RUN}`, slug: `w11a-${RUN}` } });
  workspaceId = workspace.id;
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: owner.id, role: 'owner' } });
  await prisma.workspaceMember.create({ data: { workspaceId, userId: member.id, role: 'member' } });
  repoFullName = `acme-${RUN}/w11a`;
  const repository = await prisma.repository.create({
    data: {
      userId: owner.id,
      githubRepoId: 700_000 + Math.floor(Math.random() * 99_999),
      name: 'w11a',
      fullName: repoFullName,
      cloneUrl: `https://github.com/${repoFullName}.git`,
      defaultBranch: 'main',
    },
  });
  ids.repositories.push(repository.id);
  const project = await prisma.project.create({
    data: { name: `W11a project ${RUN}`, workspaceId, key: `WB${RUN.slice(0, 3).toUpperCase()}`, repositoryId: repository.id },
  });
  projectId = project.id;
  await prisma.projectAccess.create({ data: { projectId, userId: member.id, permission: 'full' } });
  const team = await prisma.team.create({ data: { name: `W11a team ${RUN}`, key: `TB${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  teamId = team.id;
  await prisma.teamMember.create({ data: { teamId, userId: owner.id, role: 'owner' } });
  readPat = generatePersonalAccessToken();
  await prisma.personalAccessToken.create({
    data: { userId: owner.id, name: `w11a-${RUN}`, tokenHash: hashPersonalAccessToken(readPat), tokenPrefix: readPat.slice(0, 15), scopes: ['read'] },
  });

  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await prisma.project.update({ where: { id: projectId }, data: { executionSettings: Prisma.DbNull } });
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

describe('W11a project verification settings', () => {
  it('defaults to warn with no checks; owners save strictly validated settings; members and read-only tokens cannot', async () => {
    const initial = await api('GET', `/api/projects/${projectId}/verification-settings`, ownerJwt);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ configured: false, settings: { policy: 'warn', checks: [], autoDetect: false, repositoryChecks: true } });

    const saved = await putSettings({ policy: 'require-pass', checks: PROJECT_CHECKS });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, checksHash: projectChecksHash(), settings: { policy: 'require-pass' } });
    const checks = (saved.body.settings as { checks: Array<{ id: string; argv: string[]; timeoutMs: number }> }).checks;
    expect(checks.map((check) => check.id)).toEqual(['typecheck', 'unit']);
    expect(checks[0]?.argv).toEqual(['/bin/sh', '-c', 'pnpm typecheck']);
    expect(checks[1]?.timeoutMs).toBe(300_000);
    expect((await api('GET', `/api/projects/${projectId}/verification-settings`, readPat)).body).toMatchObject({ configured: true });
    expect(await prisma.auditLog.count({ where: { resourceId: projectId, action: 'project.verification_settings_updated' } })).toBeGreaterThanOrEqual(1);

    const invalid = await putSettings({ policy: 'sometimes', checks: [{ name: 'escape', run: 'true', cwd: '../..' }], extra: 1 });
    expect(invalid.status).toBe(400);
    const errors = ((invalid.body.details as { errors: string[] }).errors).join('\n');
    expect(errors).toMatch(/policy must be one of/);
    expect(errors).toMatch(/must stay inside the checkout/);
    expect(errors).toMatch(/extra is not a known setting/);

    expect((await putSettings({ policy: 'off' }, memberJwt)).status).toBe(403);
    expect((await putSettings({ policy: 'off' }, readPat)).status).toBe(403);
    expect((await api('GET', `/api/projects/${projectId}/verification-settings`, strangerJwt)).status).toBeGreaterThanOrEqual(403);
  });

  it('the attempt snapshot seals the settings at start; later edits do not change a running attempt', async () => {
    await putSettings({ policy: 'require-pass', checks: PROJECT_CHECKS });
    const started = await start();
    expect(started.snapshot.verification).toMatchObject({ policy: 'require-pass' });
    await putSettings({ policy: 'warn' });
    await claim(started);
    // Still require-pass for this attempt: done without evidence is refused.
    const done = await callback(started, 'terminal', { status: 'done', prUrl: `https://github.com/${repoFullName}/pull/7` });
    expect(done.status).toBe(422);
    expect(done.body.code).toBe('VERIFICATION_REQUIRED');

    const unconfigured = await (async () => {
      await prisma.project.update({ where: { id: projectId }, data: { executionSettings: Prisma.DbNull } });
      return start();
    })();
    expect(unconfigured.snapshot.verification).toBeNull();
  });
});

describe('W11a verification evidence', () => {
  it('records once per commit and checks hash; replays are idempotent, different bodies conflict', async () => {
    await putSettings({ policy: 'warn', checks: PROJECT_CHECKS });
    const started = await start();
    const early = await callback(started, 'verification', evidence());
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('ATTEMPT_STATE_CONFLICT');

    await claim(started);
    const first = await callback(started, 'verification', evidence());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ attemptId: started.attemptId, repeated: false });
    const replay = await callback(started, 'verification', evidence());
    expect(replay.body).toMatchObject({ id: first.body.id, repeated: true });
    const different = await callback(started, 'verification', evidence({ status: 'failed' }));
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('VERIFICATION_CONFLICT');
    const otherCommit = await callback(started, 'verification', evidence({ commitSha: SHA_B, status: 'failed' }));
    expect(otherCommit.body).toMatchObject({ repeated: false });

    const list = await api('GET', `/api/executions/tasks/${started.taskId}/verifications`, ownerJwt);
    expect(list.status).toBe(200);
    const items = list.body.items as Array<{ commitSha: string; status: string; checks: unknown[] }>;
    expect(items.map((item) => item.commitSha)).toEqual([SHA_B, SHA_A]);
    expect(items[1]).toMatchObject({ status: 'passed' });
    expect((await api('GET', `/api/executions/tasks/${started.taskId}/verifications`, strangerJwt)).status).toBeGreaterThanOrEqual(403);
  });

  it('refuses evidence that contradicts the sealed policy, the sealed project checks or the publication rule', async () => {
    await putSettings({ policy: 'require-pass', checks: PROJECT_CHECKS });
    const started = await start();
    await claim(started);

    const downgraded = await callback(started, 'verification', evidence({ policy: 'warn' }));
    expect(downgraded.status).toBe(409);
    expect(downgraded.body.code).toBe('VERIFICATION_POLICY_MISMATCH');

    const otherChecks = await callback(started, 'verification', evidence({ policy: 'require-pass', source: 'repository', checksHash: 'e'.repeat(64) }));
    expect(otherChecks.status).toBe(409);
    expect(otherChecks.body.code).toBe('VERIFICATION_CHECKS_MISMATCH');

    const inconsistent = await callback(started, 'verification', evidence({ policy: 'require-pass', status: 'failed', publication: 'allowed' }));
    expect(inconsistent.status).toBe(400);

    const localPath = await callback(started, 'verification', evidence({
      policy: 'require-pass',
      checks: [{ ...evidence().checks[0], artifact: '/Users/someone/Library/OpenLinear/artifacts/x.log' }],
    }));
    expect(localPath.status).toBe(400);
    expect(await prisma.executionVerification.count({ where: { attemptId: started.attemptId } })).toBe(0);
  });

  it('require-pass: done needs a passing record for the attempt; a failed (blocked) record is not enough', async () => {
    await putSettings({ policy: 'require-pass', checks: PROJECT_CHECKS });
    const started = await start();
    await claim(started);
    const prUrl = `https://github.com/${repoFullName}/pull/11`;

    const blocked = await callback(started, 'verification', evidence({ policy: 'require-pass', status: 'failed', publication: 'blocked', commitSha: SHA_B }));
    expect(blocked.status).toBe(200);
    expect((await callback(started, 'terminal', { status: 'done', prUrl })).status).toBe(422);

    const passed = await callback(started, 'verification', evidence({ policy: 'require-pass' }));
    expect(passed.status).toBe(200);
    const done = await callback(started, 'terminal', { status: 'done', prUrl, outcome: 'verified' });
    expect(done.status).toBe(200);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: started.taskId } })).toMatchObject({ status: 'done', prUrl });
    // Evidence is still accepted while finishing (the terminal projection may precede a resend).
    expect((await callback(started, 'verification', evidence({ policy: 'require-pass' }))).body).toMatchObject({ repeated: true });
  });

  it('warn (and no settings): done does not need evidence', async () => {
    const started = await start();
    await claim(started);
    const done = await callback(started, 'terminal', { status: 'done', prUrl: `https://github.com/${repoFullName}/pull/12` });
    expect(done.status).toBe(200);
  });
});
