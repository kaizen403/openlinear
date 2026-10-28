/**
 * W10a: GitHub App credential broker for execution attempts.
 *
 * A fake GitHub on an ephemeral loopback port (OPENLINEAR_GITHUB_API_URL,
 * honoured only under NODE_ENV=test) verifies every App JWT with the public
 * half of a key generated here, records each request and mints, restricts
 * and revokes installation tokens. Real PostgreSQL (TEST_DATABASE_URL);
 * fixtures delete only the rows they create.
 */
import { createHash, generateKeyPairSync, randomUUID, verify, type KeyObject } from 'node:crypto';
import http, { type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { readGitCredentialFallbackPolicy, readGitHubAppConfig, resolveGitHubApiBaseUrl } from '../services/github-app-config';
import { clearGitHubAppCaches, excessPermissions, missingPermissions } from '../services/github-app';
import { sweepLostExecutionAttempts } from '../services/execution-sweeper';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const APP_ID = '424242';
const SLUG = 'openlinear-test';
const OAUTH_TOKEN = `gho_w10a_${RUN}_token_value_0123456789ab`;
const ids = { users: [] as string[], workspaces: [] as string[], repositories: [] as string[] };
const APP_ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_SLUG', 'GITHUB_APP_WEBHOOK_SECRET', 'OPENLINEAR_GITHUB_API_URL', 'OPENLINEAR_GIT_CREDENTIAL_FALLBACK'] as const;
const savedEnv: Partial<Record<(typeof APP_ENV_KEYS)[number], string | undefined>> = {};

let server: Server | undefined;
let baseUrl = '';
let ownerId = '';
let ownerJwt = '';
let projectId = '';
let teamId = '';
let workspaceId = '';
let repoFullName = '';
let repoGithubId = 0;
let boundPat = '';

// ---------------------------------------------------------------------------
// Fake GitHub
// ---------------------------------------------------------------------------

function rsaPem(): { privatePem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
}

const appKey = rsaPem();
const strangerKey = rsaPem();

interface FakeInstallation {
  id: number;
  account: { login: string; type: string };
  suspended_at: string | null;
  repository_selection: string;
  permissions: Record<string, string>;
}

interface Recorded {
  method: string;
  path: string;
  bearer: string;
  body: Record<string, unknown> | null;
}

type MintMode = 'ok' | 'extra_repository' | 'extra_permission' | 'too_long' | 'unprocessable' | 'outage';

const fake = {
  installations: new Map<string, FakeInstallation>(),
  mintMode: 'ok' as MintMode,
  lookupStatus: null as number | null,
  requests: [] as Recorded[],
  issued: new Set<string>(),
  revoked: new Set<string>(),
  reset() {
    this.installations.clear();
    this.mintMode = 'ok';
    this.lookupStatus = null;
    this.requests = [];
    this.issued.clear();
    this.revoked.clear();
  },
  mints(): Recorded[] {
    return this.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/access_tokens'));
  },
};
let fakeServer: Server | undefined;
let fakeBase = '';

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** RS256 signature by the App key, `iss` = App ID, lifetime within GitHub's 10-minute limit. */
function validAppJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];
  if (!verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), appKey.publicKey, Buffer.from(signature, 'base64url'))) return false;
  const claims = decodeJwtPart(payload);
  const now = Math.floor(Date.now() / 1000);
  return decodeJwtPart(header).alg === 'RS256' && claims.iss === APP_ID
    && typeof claims.iat === 'number' && typeof claims.exp === 'number'
    && claims.exp > now && claims.iat <= now && claims.exp - claims.iat <= 600;
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function handleFake(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const path = req.url ?? '';
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
  fake.requests.push({ method: req.method ?? '', path, bearer, body });

  if (req.method === 'DELETE' && path === '/installation/token') {
    if (!fake.issued.has(bearer) || fake.revoked.has(bearer)) return send(res, 401, { message: 'Bad credentials' });
    fake.revoked.add(bearer);
    return send(res, 204);
  }
  if (!validAppJwt(bearer)) return send(res, 401, { message: 'A JSON web token could not be decoded' });

  if (req.method === 'GET' && path === '/app') return send(res, 200, { id: Number(APP_ID), slug: SLUG });

  const lookup = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
  if (req.method === 'GET' && lookup) {
    if (fake.lookupStatus) return send(res, fake.lookupStatus, { message: 'fake failure' });
    const installation = fake.installations.get(`${decodeURIComponent(lookup[1] ?? '')}/${decodeURIComponent(lookup[2] ?? '')}`.toLowerCase());
    return installation ? send(res, 200, installation) : send(res, 404, { message: 'Not Found' });
  }

  const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
  if (req.method === 'POST' && mint) {
    if (fake.mintMode === 'unprocessable') return send(res, 422, { message: 'permissions not granted' });
    if (fake.mintMode === 'outage') return send(res, 503, { message: 'unavailable' });
    const token = `ghs_${randomUUID().replace(/-/g, '')}`;
    fake.issued.add(token);
    const requested = (body?.permissions ?? {}) as Record<string, string>;
    const permissions: Record<string, string> = { ...requested, metadata: 'read' };
    if (fake.mintMode === 'extra_permission') permissions.administration = 'write';
    const repositories = [{ id: repoGithubId, full_name: repoFullName }];
    if (fake.mintMode === 'extra_repository') repositories.push({ id: repoGithubId + 1, full_name: `${repoFullName}-other` });
    const ttl = fake.mintMode === 'too_long' ? 3 * 60 * 60 * 1000 : 60 * 60 * 1000;
    return send(res, 201, { token, expires_at: new Date(Date.now() + ttl).toISOString(), permissions, repositories });
  }
  return send(res, 404, { message: 'Not Found' });
}

function install(overrides: Partial<FakeInstallation> = {}): FakeInstallation {
  const installation: FakeInstallation = {
    id: 70_000 + Math.floor(Math.random() * 9_999),
    account: { login: `acme-${RUN}`, type: 'Organization' },
    suspended_at: null,
    repository_selection: 'selected',
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    ...overrides,
  };
  fake.installations.set(repoFullName.toLowerCase(), installation);
  return installation;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

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

async function start(bearer = ownerJwt): Promise<Started> {
  const task = await prisma.task.create({
    data: { title: `w10a task ${randomUUID().slice(0, 6)}`, description: 'W10a fixture', model: 'stub/model', projectId, teamId, workspaceId, creatorId: ownerId },
  });
  const res = await api('POST', '/api/executions/attempts', bearer, { taskId: task.id });
  expect(res.status).toBe(201);
  return { attemptId: (res.body.attempt as { id: string }).id, token: (res.body.capability as { token: string }).token };
}

function callback(started: Started, action: string, body: unknown = {}) {
  return api('POST', `/api/executions/attempts/${started.attemptId}/${action}`, started.token, body);
}

async function claim(started: Started): Promise<void> {
  const res = await callback(started, 'claim', { sessionId: `ses_${randomUUID().slice(0, 8)}`, runner: 'opencode', model: 'stub/model' });
  expect(res.status).toBe(200);
}

function credential(started: Started, effect: 'fetch' | 'push' | 'pull_request') {
  return callback(started, 'git-credential', { effect });
}

function grants(attemptId: string) {
  return prisma.executionGitCredential.findMany({ where: { attemptId }, orderBy: { createdAt: 'asc' } });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const key of APP_ENV_KEYS) savedEnv[key] = process.env[key];

  fakeServer = http.createServer((req, res) => {
    handleFake(req, res).catch(() => send(res, 500, { message: 'fake crashed' }));
  });
  await new Promise<void>((resolve) => fakeServer?.listen(0, '127.0.0.1', () => resolve()));
  const fakeAddress = fakeServer.address();
  if (!fakeAddress || typeof fakeAddress === 'string') throw new Error('no fake address');
  fakeBase = `http://127.0.0.1:${fakeAddress.port}`;

  const owner = await prisma.user.create({
    data: { username: `w10a-owner-${RUN}`, email: `w10a-owner-${RUN}@example.com`, accessToken: encryptToken(OAUTH_TOKEN) },
  });
  ownerId = owner.id;
  ids.users.push(owner.id);
  ownerJwt = jwt.sign({ userId: owner.id, username: owner.username }, testJwtSecret(), { expiresIn: '1h' });
  const workspace = await prisma.workspace.create({ data: { name: `W10a ${RUN}`, slug: `w10a-${RUN}` } });
  workspaceId = workspace.id;
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: owner.id, role: 'owner' } });
  repoGithubId = 800_000 + Math.floor(Math.random() * 99_999);
  repoFullName = `acme-${RUN}/w10a`;
  const repository = await prisma.repository.create({
    data: {
      userId: owner.id,
      githubRepoId: repoGithubId,
      name: 'w10a',
      fullName: repoFullName,
      cloneUrl: `https://github.com/${repoFullName}.git`,
      defaultBranch: 'main',
    },
  });
  ids.repositories.push(repository.id);
  const project = await prisma.project.create({
    data: { name: `W10a project ${RUN}`, workspaceId, key: `WA${RUN.slice(0, 3).toUpperCase()}`, repositoryId: repository.id },
  });
  projectId = project.id;
  const team = await prisma.team.create({ data: { name: `W10a team ${RUN}`, key: `TA${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  teamId = team.id;
  await prisma.teamMember.create({ data: { teamId, userId: owner.id, role: 'owner' } });
  boundPat = generatePersonalAccessToken();
  await prisma.personalAccessToken.create({
    data: {
      userId: owner.id, name: `w10a-${RUN}`, tokenHash: hashPersonalAccessToken(boundPat), tokenPrefix: boundPat.slice(0, 15),
      scopes: ['tasks:write'], workspaceId,
    },
  });

  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  process.env.GITHUB_APP_ID = APP_ID;
  process.env.GITHUB_APP_PRIVATE_KEY = appKey.privatePem;
  process.env.OPENLINEAR_GITHUB_API_URL = fakeBase;
  delete process.env.GITHUB_APP_SLUG;
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  delete process.env.OPENLINEAR_GIT_CREDENTIAL_FALLBACK;
  clearGitHubAppCaches();
  fake.reset();
});

afterEach(() => {
  clearGitHubAppCaches();
});

afterAll(async () => {
  for (const key of APP_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const s of [server, fakeServer]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.task.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.repository.deleteMany({ where: { id: { in: ids.repositories } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W10a configuration', () => {
  it('rejects half-configured Apps, weak keys and unknown fallback policies without echoing key material', () => {
    expect(readGitHubAppConfig({})).toBeNull();
    expect(() => readGitHubAppConfig({ GITHUB_APP_ID: APP_ID })).toThrow(/GITHUB_APP_PRIVATE_KEY is not/);
    expect(() => readGitHubAppConfig({ GITHUB_APP_PRIVATE_KEY: appKey.privatePem })).toThrow(/GITHUB_APP_ID is not/);
    expect(() => readGitHubAppConfig({ GITHUB_APP_SLUG: SLUG })).toThrow(/are set but/);
    expect(() => readGitHubAppConfig({ GITHUB_APP_ID: 'not-an-id', GITHUB_APP_PRIVATE_KEY: appKey.privatePem })).toThrow(/numeric App ID/);
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => readGitHubAppConfig({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: weak })).toThrow(/at least 2048 bits/);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => readGitHubAppConfig({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: ec })).toThrow(/must be an RSA private key/);
    const garbage = '-----BEGIN PRIVATE KEY-----\nAAAAsecret-material-AAAA\n-----END PRIVATE KEY-----';
    expect(() => readGitHubAppConfig({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: garbage })).toThrow(/could not be parsed/);
    try {
      readGitHubAppConfig({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: garbage });
    } catch (err) {
      expect(String(err)).not.toContain('secret-material');
    }
    expect(() => readGitCredentialFallbackPolicy({ OPENLINEAR_GIT_CREDENTIAL_FALLBACK: 'maybe' })).toThrow(/must be one of/);
    expect(readGitCredentialFallbackPolicy({})).toBe('user_oauth');
  });

  it('accepts escaped and base64 PEMs; honours the API override only for loopback http under NODE_ENV=test', () => {
    const escaped = appKey.privatePem.replace(/\n/g, '\\n');
    expect(readGitHubAppConfig({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: escaped })?.appId).toBe(APP_ID);
    const b64 = Buffer.from(appKey.privatePem).toString('base64');
    expect(readGitHubAppConfig({ GITHUB_APP_ID: 'Iv1.abcdef0123', GITHUB_APP_PRIVATE_KEY: b64 })?.appId).toBe('Iv1.abcdef0123');
    expect(resolveGitHubApiBaseUrl({ NODE_ENV: 'test', OPENLINEAR_GITHUB_API_URL: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
    expect(resolveGitHubApiBaseUrl({ NODE_ENV: 'production', OPENLINEAR_GITHUB_API_URL: 'http://127.0.0.1:9' })).toBe('https://api.github.com');
    expect(resolveGitHubApiBaseUrl({ NODE_ENV: 'test', OPENLINEAR_GITHUB_API_URL: 'http://evil.example.com' })).toBe('https://api.github.com');
  });

  it('permission arithmetic tolerates metadata:read only', () => {
    expect(excessPermissions({ contents: 'read', metadata: 'read' }, { contents: 'read' })).toEqual([]);
    expect(excessPermissions({ contents: 'write' }, { contents: 'read' })).toEqual(['contents:write']);
    expect(excessPermissions({ contents: 'read', workflows: 'write' }, { contents: 'read' })).toEqual(['workflows:write']);
    expect(missingPermissions({ contents: 'read' }, { contents: 'write', pull_requests: 'write' })).toEqual(['contents:write', 'pull_requests:write']);
  });
});

describe('W10a installation tokens', () => {
  it('mints a token for the attempt repository only, with the effect permissions, signed by a valid App JWT; stores only a hash and ciphertext', async () => {
    const installation = install();
    const started = await start();
    const res = await credential(started, 'fetch');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: 'github', kind: 'installation', effect: 'fetch', repository: repoFullName, reused: false, fallbackReason: null });
    const token = res.body.token as string;
    expect(token).toMatch(/^ghs_/);
    expect(res.body.permissions).toEqual({ contents: 'read', metadata: 'read' });
    const expiresAt = Date.parse(res.body.expiresAt as string);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 5_000);
    expect(Date.parse(res.body.notAfter as string)).toBeLessThanOrEqual(expiresAt);

    const [mint] = fake.mints();
    expect(mint?.path).toBe(`/app/installations/${installation.id}/access_tokens`);
    expect(mint?.body).toEqual({ repository_ids: [repoGithubId], permissions: { contents: 'read' } });
    const [header, payload] = (mint?.bearer ?? '').split('.');
    expect(decodeJwtPart(header ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decodeJwtPart(payload ?? '');
    expect(claims.iss).toBe(APP_ID);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(600);

    const [row] = await grants(started.attemptId);
    expect(row).toMatchObject({ effect: 'fetch', kind: 'installation', repositoryFullName: repoFullName, installationId: String(installation.id), revokedAt: null });
    expect(row?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row?.encryptedToken).not.toContain(token);
    expect(decryptToken(row?.encryptedToken ?? null)).toBe(token);

    const audits = await prisma.auditLog.findMany({ where: { resourceId: started.attemptId, action: 'execution.git_credential_issued' } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain(token);
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain(OAUTH_TOKEN);
  });

  it('reuses a live token per effect, mints the push / pull_request permission sets separately, refreshes near expiry, and revokes everything at close', async () => {
    install();
    const started = await start();
    const first = await credential(started, 'fetch');
    await claim(started);
    const again = await credential(started, 'fetch');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, token: first.body.token });
    expect(fake.mints()).toHaveLength(1);

    const push = await credential(started, 'push');
    expect(push.body).toMatchObject({ kind: 'installation', effect: 'push', reused: false });
    expect(push.body.token).not.toBe(first.body.token);
    const pr = await credential(started, 'pull_request');
    expect(pr.body).toMatchObject({ kind: 'installation', effect: 'pull_request' });
    expect(fake.mints().map((mint) => mint.body?.permissions)).toEqual([
      { contents: 'read' },
      { contents: 'write' },
      { contents: 'write', pull_requests: 'write' },
    ]);

    // Ten-minute refresh margin: a recorded token about to expire is not reused.
    await prisma.executionGitCredential.updateMany({
      where: { attemptId: started.attemptId, effect: 'fetch' },
      data: { expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
    });
    const refreshed = await credential(started, 'fetch');
    expect(refreshed.body).toMatchObject({ reused: false });
    expect(refreshed.body.token).not.toBe(first.body.token);
    expect(fake.mints()).toHaveLength(4);

    const issued = [first, push, pr, refreshed].map((res) => res.body.token as string);
    const closed = await callback(started, 'close', {});
    expect(closed.status).toBe(200);
    for (const token of issued) expect(fake.revoked.has(token)).toBe(true);
    const rows = await grants(started.attemptId);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.revokedAt).not.toBeNull();
      expect(row.revocationStatus).toBe('revoked');
      expect(row.encryptedToken).toBeNull();
    }
    expect(await prisma.auditLog.count({ where: { resourceId: started.attemptId, action: 'execution.git_credential_revoked' } })).toBe(1);
  });

  it('push and pull_request need a running attempt', async () => {
    install();
    const started = await start();
    for (const effect of ['push', 'pull_request'] as const) {
      const res = await credential(started, effect);
      expect(res.status).toBe(409);
    }
    expect(fake.mints()).toHaveLength(0);
  });

  it.each(['extra_repository', 'extra_permission', 'too_long'] as const)('refuses and revokes a token broader than requested (%s)', async (mode) => {
    install();
    fake.mintMode = mode;
    const started = await start();
    const res = await credential(started, 'fetch');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('GITHUB_APP_TOKEN_REJECTED');
    expect(JSON.stringify(res.body)).not.toMatch(/ghs_/);
    const issued = [...fake.issued].filter((token) => !fake.revoked.has(token));
    expect(issued).toEqual([]);
    expect(await grants(started.attemptId)).toHaveLength(0);
  });

  it('a workspace-bound PAT attempt gets the repo-scoped installation token', async () => {
    install();
    const started = await start(boundPat);
    const res = await credential(started, 'fetch');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'installation' });
  });

  it('the lease sweeper revokes the installation tokens of a fenced attempt', async () => {
    install();
    const started = await start();
    await claim(started);
    const res = await credential(started, 'push');
    const token = res.body.token as string;
    await prisma.executionAttempt.update({ where: { id: started.attemptId }, data: { heartbeatAt: new Date(Date.now() - 120_000) } });
    await sweepLostExecutionAttempts({ leaseMs: 60_000 });
    expect(fake.revoked.has(token)).toBe(true);
    const [row] = await grants(started.attemptId);
    expect(row).toMatchObject({ revocationStatus: 'revoked', encryptedToken: null });
    expect(row?.revokedAt).not.toBeNull();
  });
});

describe('W10a fallback policy', () => {
  it('not installed → user OAuth token under the default policy, recorded without token material', async () => {
    const started = await start();
    const res = await credential(started, 'fetch');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'user_oauth', token: OAUTH_TOKEN, fallbackReason: 'app_not_installed', permissions: null, expiresAt: null });
    const [row] = await grants(started.attemptId);
    expect(row).toMatchObject({ kind: 'user_oauth', fallbackReason: 'app_not_installed', tokenHash: null, encryptedToken: null });
    expect(fake.mints()).toHaveLength(0);
  });

  it('App not configured → app_not_configured fallback; GitHub is never called', async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    const started = await start();
    const res = await credential(started, 'fetch');
    expect(res.body).toMatchObject({ kind: 'user_oauth', fallbackReason: 'app_not_configured' });
    expect(fake.requests).toHaveLength(0);
  });

  it('deny policy → 403 GITHUB_APP_REQUIRED with the install URL', async () => {
    process.env.OPENLINEAR_GIT_CREDENTIAL_FALLBACK = 'deny';
    const started = await start();
    const res = await credential(started, 'fetch');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'GITHUB_APP_REQUIRED',
      details: { reason: 'app_not_installed', repository: repoFullName, installUrl: `https://github.com/apps/${SLUG}/installations/new` },
    });
    expect(JSON.stringify(res.body)).not.toContain(OAUTH_TOKEN);
    expect(await grants(started.attemptId)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { resourceId: started.attemptId, action: 'execution.git_credential_denied' } })).toBe(1);
  });

  it('suspended installation → fallback with the manage URL; denied under deny', async () => {
    const installation = install({ suspended_at: new Date().toISOString() });
    const started = await start();
    const allowed = await credential(started, 'fetch');
    expect(allowed.body).toMatchObject({ kind: 'user_oauth', fallbackReason: 'installation_suspended' });
    process.env.OPENLINEAR_GIT_CREDENTIAL_FALLBACK = 'deny';
    const denied = await credential(started, 'fetch');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({
      code: 'GITHUB_APP_REQUIRED',
      details: { reason: 'installation_suspended', installUrl: `https://github.com/organizations/acme-${RUN}/settings/installations/${installation.id}` },
    });
    expect(fake.mints()).toHaveLength(0);
  });

  it('installation lacking a permission (or GitHub answering 422) → installation_permissions_insufficient', async () => {
    install({ permissions: { contents: 'read', metadata: 'read' } });
    const started = await start();
    await claim(started);
    const fetchRes = await credential(started, 'fetch');
    expect(fetchRes.body).toMatchObject({ kind: 'installation' });
    const pushRes = await credential(started, 'push');
    expect(pushRes.body).toMatchObject({ kind: 'user_oauth', fallbackReason: 'installation_permissions_insufficient' });

    install();
    clearGitHubAppCaches();
    fake.mintMode = 'unprocessable';
    const prRes = await credential(started, 'pull_request');
    expect(prRes.body).toMatchObject({ kind: 'user_oauth', fallbackReason: 'installation_permissions_insufficient' });
  });

  it('a workspace-bound PAT attempt never receives the account-wide OAuth token', async () => {
    const started = await start(boundPat);
    const res = await credential(started, 'fetch');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PAT_WORKSPACE_RESTRICTED', details: { reason: 'app_not_installed' } });
    expect(JSON.stringify(res.body)).not.toContain(OAUTH_TOKEN);
  });

  it('refused App credentials or a GitHub outage → 502, never a fallback to the OAuth token', async () => {
    install();
    const started = await start();
    process.env.GITHUB_APP_PRIVATE_KEY = strangerKey.privatePem;
    clearGitHubAppCaches();
    const refused = await credential(started, 'fetch');
    expect(refused.status).toBe(502);
    expect(refused.body.code).toBe('GITHUB_APP_UNAVAILABLE');

    process.env.GITHUB_APP_PRIVATE_KEY = appKey.privatePem;
    clearGitHubAppCaches();
    fake.lookupStatus = 500;
    const lookupDown = await credential(started, 'fetch');
    expect(lookupDown.status).toBe(502);

    fake.lookupStatus = null;
    fake.mintMode = 'outage';
    const mintDown = await credential(started, 'fetch');
    expect(mintDown.status).toBe(502);
    expect(mintDown.body.code).toBe('GITHUB_APP_UNAVAILABLE');
    for (const res of [refused, lookupDown, mintDown]) expect(JSON.stringify(res.body)).not.toContain(OAUTH_TOKEN);
    expect(await grants(started.attemptId)).toHaveLength(0);
  });
});

describe('W10a installation discovery', () => {
  it('reports installation state, missing permissions and install/manage URLs to workspace owners', async () => {
    const installation = install({ permissions: { contents: 'write', metadata: 'read' } });
    const res = await api('GET', `/api/github-app/projects/${projectId}/installation`, ownerJwt);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      projectId,
      repository: repoFullName,
      configured: true,
      installed: true,
      suspended: false,
      installationId: installation.id,
      missingPermissions: ['pull_requests:write'],
      installUrl: `https://github.com/apps/${SLUG}/installations/new`,
      manageUrl: `https://github.com/organizations/acme-${RUN}/settings/installations/${installation.id}`,
      fallbackPolicy: 'user_oauth',
    });

    fake.installations.clear();
    clearGitHubAppCaches();
    const missing = await api('GET', `/api/github-app/projects/${projectId}/installation`, ownerJwt);
    expect(missing.body).toMatchObject({ installed: false, installationId: null });

    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    const unconfigured = await api('GET', `/api/github-app/projects/${projectId}/installation`, ownerJwt);
    expect(unconfigured.body).toMatchObject({ configured: false, installed: null, installUrl: null });
  });
});
