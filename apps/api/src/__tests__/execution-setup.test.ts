/**
 * W16a environment setup recipes on the control plane: the project's setup
 * steps live in the verification settings (`executionSettings.verification
 * .setup`), are edited by workspace owners/admins with the same strict
 * parser and validation-error shape as the checks, and are sealed into the
 * attempt snapshot at start (a later edit never changes a started attempt).
 *
 * Real PostgreSQL (TEST_DATABASE_URL); the API is served on an ephemeral
 * loopback port. Fixtures delete only the rows they create.
 */
import { createHash, randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checksHashOf, parseProjectVerificationSettings, resolveSetupPlan, SETUP_LIMITS } from '@openlinear/execution-core';
import { encryptToken, Prisma, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { sealedVerificationSettings } from '../services/execution-verification';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const ids = { users: [] as string[], workspaces: [] as string[], repositories: [] as string[] };
let server: Server | undefined;
let baseUrl = '';
let ownerId = '';
let ownerJwt = '';
let memberJwt = '';
let readPat = '';
let projectId = '';
let teamId = '';
let workspaceId = '';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function api(method: string, path: string, bearer: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

const putSettings = (body: unknown, bearer = ownerJwt) => api('PUT', `/api/projects/${projectId}/verification-settings`, bearer, body);
const getSettings = (bearer = ownerJwt) => api('GET', `/api/projects/${projectId}/verification-settings`, bearer);

const SETUP = [
  { name: 'install', run: 'pnpm install --frozen-lockfile', network: 'registries', timeoutSeconds: 900 },
  { id: 'db', name: 'Generate the Prisma client', command: ['pnpm', 'db:generate'], cwd: 'packages/db', required: false },
];

function setupHash(steps: unknown): string {
  const parsed = parseProjectVerificationSettings({ setup: steps });
  if (!parsed.ok) throw new Error('fixture setup invalid');
  return checksHashOf(parsed.value.setup, sha256);
}

interface SetupStepView {
  id: string;
  name: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  network: { mode: string; registries?: boolean };
  required: boolean;
}

function stepsOf(body: Record<string, unknown>): SetupStepView[] {
  return (body.settings as { setup: SetupStepView[] }).setup;
}

async function startAttempt(): Promise<{ attemptId: string; snapshot: Record<string, unknown> }> {
  const task = await prisma.task.create({
    data: { title: `w16a task ${randomUUID().slice(0, 6)}`, description: 'W16a fixture', model: 'stub/model', projectId, teamId, workspaceId, creatorId: ownerId },
  });
  const res = await api('POST', '/api/executions/attempts', ownerJwt, { taskId: task.id });
  expect(res.status).toBe(201);
  return { attemptId: (res.body.attempt as { id: string }).id, snapshot: res.body.snapshot as Record<string, unknown> };
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { username: `w16a-owner-${RUN}`, email: `w16a-owner-${RUN}@example.com`, accessToken: encryptToken(`gho_w16a_${RUN}_token_value_0123456789ab`) },
  });
  const member = await prisma.user.create({ data: { username: `w16a-member-${RUN}`, email: `w16a-member-${RUN}@example.com` } });
  ownerId = owner.id;
  ids.users.push(owner.id, member.id);
  ownerJwt = jwt.sign({ userId: owner.id, username: owner.username }, testJwtSecret(), { expiresIn: '1h' });
  memberJwt = jwt.sign({ userId: member.id, username: member.username }, testJwtSecret(), { expiresIn: '1h' });
  const workspace = await prisma.workspace.create({ data: { name: `W16a ${RUN}`, slug: `w16a-${RUN}` } });
  workspaceId = workspace.id;
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: owner.id, role: 'owner' } });
  await prisma.workspaceMember.create({ data: { workspaceId, userId: member.id, role: 'member' } });
  const fullName = `acme-${RUN}/w16a`;
  const repository = await prisma.repository.create({
    data: {
      userId: owner.id,
      githubRepoId: 800_000 + Math.floor(Math.random() * 99_999),
      name: 'w16a',
      fullName,
      cloneUrl: `https://github.com/${fullName}.git`,
      defaultBranch: 'main',
    },
  });
  ids.repositories.push(repository.id);
  const project = await prisma.project.create({
    data: { name: `W16a project ${RUN}`, workspaceId, key: `WS${RUN.slice(0, 3).toUpperCase()}`, repositoryId: repository.id },
  });
  projectId = project.id;
  await prisma.projectAccess.create({ data: { projectId, userId: member.id, permission: 'full' } });
  const team = await prisma.team.create({ data: { name: `W16a team ${RUN}`, key: `TS${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  teamId = team.id;
  await prisma.teamMember.create({ data: { teamId, userId: owner.id, role: 'owner' } });
  readPat = generatePersonalAccessToken();
  await prisma.personalAccessToken.create({
    data: { userId: owner.id, name: `w16a-${RUN}`, tokenHash: hashPersonalAccessToken(readPat), tokenPrefix: readPat.slice(0, 15), scopes: ['read'] },
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

describe('W16a project setup steps', () => {
  it('defaults to no setup; owners store normalized steps next to the checks; audited', async () => {
    const initial = await getSettings();
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ configured: false, settings: { setup: [] }, setupHash: checksHashOf([], sha256) });

    const saved = await putSettings({ policy: 'warn', checks: [{ name: 'Unit tests', run: 'pnpm test' }], setup: SETUP });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, setupHash: setupHash(SETUP) });
    const steps = stepsOf(saved.body);
    expect(steps.map((step) => step.id)).toEqual(['install', 'db']);
    expect(steps[0]).toEqual({
      id: 'install', name: 'install', argv: ['/bin/sh', '-c', 'pnpm install --frozen-lockfile'], cwd: '', timeoutMs: 900_000,
      network: { mode: 'egress', hosts: [], registries: true }, required: true,
    });
    expect(steps[1]).toMatchObject({ argv: ['pnpm', 'db:generate'], cwd: 'packages/db', network: { mode: 'none' }, required: false });
    // Stored inside the verification settings (one strict parser, one sealed value).
    const stored = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { executionSettings: true } });
    expect(stored.executionSettings).toMatchObject({ verification: { setup: [{ id: 'install' }, { id: 'db' }] } });
    expect((await getSettings(readPat)).body).toMatchObject({ settings: { setup: [{ id: 'install' }, { id: 'db' }] } });

    const audit = await prisma.auditLog.findFirst({
      where: { resourceId: projectId, action: 'project.verification_settings_updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.metadata).toMatchObject({ setupSteps: 2, setupHash: setupHash(SETUP) });
  });

  it('validates setup strictly with the same error shape; members and read-only tokens cannot change it', async () => {
    const invalid = await putSettings({
      setup: [
        { name: 'escape', run: 'true', cwd: '../..' },
        { name: 'both', run: 'true', command: ['true'] },
        { name: 'net', run: 'true', network: 'anything' },
        { name: 'x', run: 'true', shell: 'zsh' },
      ],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION_ERROR');
    const errors = (invalid.body.details as { errors: string[] }).errors.join('\n');
    expect(errors).toMatch(/setup\[0\]\.cwd must stay inside the checkout/);
    expect(errors).toMatch(/setup\[1\] must set either "run" or "command"/);
    expect(errors).toMatch(/setup\[2\]\.network must be/);
    expect(errors).toMatch(/setup\[3\]\.shell is not a known setting/);

    const tooMany = await putSettings({ setup: Array.from({ length: SETUP_LIMITS.maxSteps + 1 }, (_, i) => ({ name: `s${i}`, run: 'true' })) });
    expect(tooMany.status).toBe(400);
    expect((tooMany.body.details as { errors: string[] }).errors).toEqual([`at most ${SETUP_LIMITS.maxSteps} setup steps are allowed`]);
    expect((await putSettings({ setup: 'pnpm install' })).status).toBe(400);

    expect((await putSettings({ setup: SETUP }, memberJwt)).status).toBe(403);
    expect((await putSettings({ setup: SETUP }, readPat)).status).toBe(403);
    expect((await getSettings()).body).toMatchObject({ configured: false, settings: { setup: [] } });
  });

  it('a body without setup keeps the stored steps; setup: [] clears them', async () => {
    await putSettings({ setup: SETUP });
    const policyOnly = await putSettings({ policy: 'require-pass', checks: [{ name: 'Unit tests', run: 'pnpm test' }] });
    expect(policyOnly.status).toBe(200);
    expect(policyOnly.body).toMatchObject({ settings: { policy: 'require-pass' }, setupHash: setupHash(SETUP) });
    expect(stepsOf(policyOnly.body).map((step) => step.id)).toEqual(['install', 'db']);

    const cleared = await putSettings({ policy: 'require-pass', setup: [] });
    expect(stepsOf(cleared.body)).toEqual([]);
    expect(cleared.body.setupHash).toBe(checksHashOf([], sha256));
  });

  it('the attempt snapshot seals the setup steps at start; later edits do not change a started attempt', async () => {
    await putSettings({ policy: 'off', setup: SETUP });
    const started = await startAttempt();
    // Setup is independent of the verification policy: sealed even with policy off.
    const sealed = resolveSetupPlan(started.snapshot.verification, sha256);
    expect(sealed.problems).toEqual([]);
    expect(sealed.steps.map((step) => step.id)).toEqual(['install', 'db']);
    expect(sealed.setupHash).toBe(setupHash(SETUP));

    await putSettings({ policy: 'off', setup: [{ name: 'other', run: 'make deps' }] });
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
    expect(sealedVerificationSettings(attempt)?.setup.map((step) => step.id)).toEqual(['install', 'db']);
    const next = await startAttempt();
    expect(resolveSetupPlan(next.snapshot.verification, sha256).steps.map((step) => step.id)).toEqual(['other']);

    await putSettings({ policy: 'warn', setup: [] });
    const none = await startAttempt();
    expect(resolveSetupPlan(none.snapshot.verification, sha256)).toMatchObject({ steps: [], problems: [] });
  });
});
