/**
 * W03a end-to-end: the real API app (this process, test database) and the
 * real sidecar as a CHILD PROCESS whose environment has no DATABASE_URL, no
 * JWT signing secret and no token-encryption key. OpenCode is a loopback stub
 * (fixtures/opencode-stub.mjs), GitHub is a loopback stub, the repository is a
 * local bare origin. No model, no network beyond loopback.
 *
 * Proves: execute -> progress -> done (PR confirmed), logs, cancel,
 * foreign-user denial, stale capability denied after terminal, PAT handling,
 * and fail-closed behaviour when the API is unreachable.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptToken, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(HERE, '../../../sidecar');
const STUB = join(HERE, 'fixtures', 'opencode-stub.mjs');
const REPO_FULL_NAME = `acme-e2e-${RUN}/repo`;
const PR_URL = `https://github.com/${REPO_FULL_NAME}/pull/42`;
const FORBIDDEN_CHILD_ENV = ['DATABASE_URL', 'TEST_DATABASE_URL', 'JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'VITEST'];

function sign(userId: string, username: string): string {
  return jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h', jwtid: randomUUID() });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('no TCP address'));
      else resolveListen(address.port);
    });
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.closeAllConnections();
    server.close(() => resolveClose());
  });
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ids = { users: [] as string[], workspaces: [] as string[], repositories: [] as string[] };

describe('W03a: API-only sidecar end to end', () => {
  let root = '';
  let apiServer: Server | undefined;
  let githubServer: Server | undefined;
  let sidecar: ChildProcess | undefined;
  let sidecarOutput = '';
  let sidecarUrl = '';
  let apiUrl = '';
  const githubRequests: string[] = [];
  const childEnv: NodeJS.ProcessEnv = {};

  let ownerJwt = '';
  let ownerId = '';
  let outsiderJwt = '';
  let readOnlyPat = '';
  let writePat = '';
  const tasks = { done: '', cancel: '', foreign: '', capability: '', patWrite: '', remoteCancel: '' };

  async function call(method: string, path: string, bearer?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${sidecarUrl}${path}`, {
      method,
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ol-w03a-e2e-'));
    const home = join(root, 'home');
    const appData = join(root, 'app');
    mkdirSync(home, { recursive: true });
    mkdirSync(appData, { recursive: true });
    const gitconfig = join(root, 'gitconfig');
    writeFileSync(gitconfig, '');

    // Local bare origin with one commit on main.
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    mkdirSync(seed);
    git(root, ['init', '--bare', '--initial-branch=main', origin]);
    git(seed, ['init', '--initial-branch=main']);
    writeFileSync(join(seed, 'README.md'), 'e2e fixture\n');
    git(seed, ['add', '.']);
    git(seed, ['-c', 'user.name=OpenLinear Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'seed']);
    git(seed, ['push', origin, 'main']);

    // Fixtures.
    const owner = await prisma.user.create({
      data: { username: `w03a-e2e-owner-${RUN}`, accessToken: encryptToken(`gho_e2e_${RUN}_token_value_0123456789abcd`) },
    });
    const outsider = await prisma.user.create({ data: { username: `w03a-e2e-outsider-${RUN}` } });
    ids.users.push(owner.id, outsider.id);
    ownerId = owner.id;
    ownerJwt = sign(owner.id, owner.username);
    outsiderJwt = sign(outsider.id, outsider.username);
    const workspace = await prisma.workspace.create({ data: { name: `W03a e2e ${RUN}`, slug: `w03a-e2e-${RUN}` } });
    const otherWorkspace = await prisma.workspace.create({ data: { name: `W03a e2e other ${RUN}`, slug: `w03a-e2e-o-${RUN}` } });
    ids.workspaces.push(workspace.id, otherWorkspace.id);
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
        { workspaceId: otherWorkspace.id, userId: outsider.id, role: 'owner' },
      ],
    });
    const repository = await prisma.repository.create({
      data: {
        userId: owner.id,
        githubRepoId: 800_000 + Math.floor(Math.random() * 99_999),
        name: 'repo',
        fullName: REPO_FULL_NAME,
        cloneUrl: `file://${origin}`,
        defaultBranch: 'main',
      },
    });
    ids.repositories.push(repository.id);
    const project = await prisma.project.create({
      data: { name: `W03a e2e project ${RUN}`, workspaceId: workspace.id, key: `E${RUN.slice(0, 3).toUpperCase()}`, repositoryId: repository.id },
    });
    const team = await prisma.team.create({ data: { name: `W03a e2e team ${RUN}`, key: `T${RUN.slice(0, 3).toUpperCase()}`, projectId: project.id } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: 'owner' } });
    const makeTask = async (title: string) => (await prisma.task.create({
      data: { title, description: 'W03a e2e', model: 'stub/model', projectId: project.id, teamId: team.id, workspaceId: workspace.id, creatorId: owner.id },
    })).id;
    tasks.done = await makeTask(`Write the e2e change ${RUN}`);
    tasks.cancel = await makeTask(`Long running [hang] ${RUN}`);
    tasks.foreign = await makeTask(`Foreign probe ${RUN}`);
    tasks.capability = await makeTask(`Capability probe ${RUN}`);
    tasks.patWrite = await makeTask(`PAT probe [hang] ${RUN}`);
    tasks.remoteCancel = await makeTask(`Remote cancel [hang] ${RUN}`);
    const pat = async (scopes: string[]) => {
      const token = generatePersonalAccessToken();
      await prisma.personalAccessToken.create({
        data: { userId: owner.id, name: `w03a-e2e-${RUN}`, tokenHash: hashPersonalAccessToken(token), tokenPrefix: token.slice(0, 15), scopes },
      });
      return token;
    };
    readOnlyPat = await pat(['read']);
    writePat = await pat(['tasks:write']);

    // The real API app against the test database.
    apiServer = http.createServer(createApp());
    apiUrl = `http://127.0.0.1:${await listen(apiServer)}`;

    // Loopback GitHub stub: pull request creation only.
    githubServer = http.createServer((req, res) => {
      githubRequests.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url?.endsWith('/pulls')) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ html_url: PR_URL, number: 42 }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('[]');
    });
    const githubUrl = `http://127.0.0.1:${await listen(githubServer)}`;

    // OpenCode stub launcher.
    const wrapper = join(root, 'opencode');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
    chmodSync(wrapper, 0o755);

    Object.assign(childEnv, {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: root,
      NODE_ENV: 'test',
      OPENLINEAR_ALLOW_FILE_GIT: '1',
      OPENLINEAR_SKIP_DOTENV: '1',
      API_PORT: '0',
      OAUTH_INTERCEPTOR_PORT: '0',
      OPENLINEAR_API_URL: apiUrl,
      OPENCODE_BIN: wrapper,
      OPENLINEAR_APP_DATA: appData,
      REPOS_DIR: join(appData, 'repos'),
      OPENLINEAR_GITHUB_API_URL: githubUrl,
      GIT_CONFIG_GLOBAL: gitconfig,
      LOG_LEVEL: 'info',
      OPENLINEAR_ATTEMPT_HEARTBEAT_MS: '1000',
      // W07a: v2 is the default engine; this suite is the legacy (W01/W03a)
      // lifecycle's acceptance test, still selectable, so it pins legacy.
      // The v2 engine has its own end-to-end suites (run-engine*.e2e).
      OPENLINEAR_RUN_ENGINE: 'legacy',
      // W09a: the sidecar fails closed (SANDBOX_UNAVAILABLE) without a verified
      // sandbox or an explicit, expiring trusted-host grant. This test proves
      // API-only persistence with a stub OpenCode; sandbox enforcement has its
      // own corpus (apps/sidecar/src/sandbox), so grant the stub's fixture root.
      OPENLINEAR_SANDBOX_MODE: 'trusted-host',
      OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: JSON.stringify({
        actor: 'sidecar-api-only.e2e.test',
        reason: 'stub OpenCode under test; sandbox enforcement is covered by the sandbox corpus',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        paths: [root],
      }),
    });
    for (const key of FORBIDDEN_CHILD_ENV) expect(childEnv[key], key).toBeUndefined();

    sidecar = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: SIDECAR_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sidecar.stdout?.on('data', (chunk: Buffer) => { sidecarOutput += chunk.toString(); });
    sidecar.stderr?.on('data', (chunk: Buffer) => { sidecarOutput += chunk.toString(); });
    const port = await waitFor(async () => {
      const match = /"port":(\d+),"msg":"\[Sidecar\] server listening"/.exec(sidecarOutput);
      return match && match[1] !== '0' ? Number(match[1]) : null;
    }, `sidecar listening\n${sidecarOutput}`, 60_000);
    sidecarUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => sidecarOutput.includes('OpenCode agent ready'), 'OpenCode stub ready', 30_000);
  }, 120_000);

  afterAll(async () => {
    if (sidecar && sidecar.exitCode === null) {
      sidecar.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1_500));
      if (sidecar.exitCode === null) sidecar.kill('SIGKILL');
    }
    if (githubServer) await closeServer(githubServer);
    if (apiServer?.listening) await closeServer(apiServer);
    await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
    await prisma.task.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
    await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
    await prisma.repository.deleteMany({ where: { id: { in: ids.repositories } } });
    await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('runs with no database URL, signing secret or encryption key and refuses anonymous callers', async () => {
    for (const key of FORBIDDEN_CHILD_ENV) expect(childEnv[key]).toBeUndefined();
    const health = await fetch(`${sidecarUrl}/health`).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect(health).toEqual({ ok: true, service: 'sidecar', persistence: 'api' });
    expect((await call('POST', `/api/tasks/${tasks.done}/execute`)).status).toBe(401);
    expect((await call('GET', `/api/tasks/${tasks.done}/logs`, 'not-a-real-token')).status).toBe(401);
  });

  it('denies a foreign principal before any execution side effect', async () => {
    const execute = await call('POST', `/api/tasks/${tasks.foreign}/execute`, outsiderJwt);
    expect([403, 404]).toContain(execute.status);
    expect([403, 404]).toContain((await call('GET', `/api/tasks/${tasks.foreign}/logs`, outsiderJwt)).status);
    expect([403, 404]).toContain((await call('POST', `/api/tasks/${tasks.foreign}/cancel`, outsiderJwt)).status);
    expect([403, 404]).toContain((await call('GET', `/api/tasks/${tasks.foreign}/running`, outsiderJwt)).status);
    expect(await prisma.executionAttempt.count({ where: { taskId: tasks.foreign } })).toBe(0);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tasks.foreign } })).status).toBe('todo');
  });

  it('executes a task through the attempt capability: claim, progress, publication, done, logs', async () => {
    const started = await call('POST', `/api/tasks/${tasks.done}/execute`, ownerJwt);
    expect(started).toEqual({ status: 200, body: { message: 'Task execution started' } });

    const done = await waitFor(async () => {
      const row = await prisma.task.findUniqueOrThrow({ where: { id: tasks.done } });
      return row.status === 'done' ? row : null;
    }, `task done\n${sidecarOutput.slice(-4000)}`, 60_000);
    expect(done).toMatchObject({ prUrl: PR_URL, sessionId: null, executionProgress: 100 });
    expect(githubRequests.some((line) => line.startsWith('POST') && line.includes('/pulls'))).toBe(true);
    expect(git(join(root, 'origin.git'), ['branch', '--list'])).toMatch(/openlinear\//);

    const attempt = await waitFor(async () => {
      const row = await prisma.executionAttempt.findFirst({ where: { taskId: tasks.done }, include: { capabilities: true, agentRun: true } });
      return row?.status === 'closed' ? row : null;
    }, 'attempt closed');
    expect(attempt).toMatchObject({ userId: ownerId, terminalStatus: 'done', authSource: 'session', runner: 'opencode' });
    expect(attempt.agentRun).toMatchObject({ status: 'succeeded', prUrl: PR_URL, runner: 'opencode' });
    expect(attempt.capabilities.every((capability) => capability.revokedAt !== null)).toBe(true);
    expect(attempt.lastEventSeq).toBeGreaterThan(0);

    // Progress reached the control plane, bound to the task's project.
    const progress = await prisma.domainEvent.findMany({ where: { type: 'execution:progress', actorId: ownerId } });
    const mine = progress.filter((row) => (row.payload as { taskId?: string }).taskId === tasks.done);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((row) => row.resourceType === 'project')).toBe(true);

    // Logs: persisted snapshot served through the control plane after cleanup.
    // The snapshot is written after the terminal status (attempt `finishing`)
    // and before the attempt closes: read the row again now that it is closed
    // (`done` above can predate the snapshot; that raced on loaded machines).
    const afterClose = await prisma.task.findUniqueOrThrow({ where: { id: tasks.done } });
    expect(Array.isArray(afterClose.executionLogs) && afterClose.executionLogs.length > 0).toBe(true);
    const logs = await call('GET', `/api/tasks/${tasks.done}/logs`, ownerJwt);
    expect(logs.status).toBe(200);
    expect((logs.body.logs as unknown[]).length).toBeGreaterThan(0);
    expect(await call('GET', `/api/tasks/${tasks.done}/running`, ownerJwt)).toEqual({ status: 200, body: { running: false } });
    expect([403, 404]).toContain((await call('GET', `/api/tasks/${tasks.done}/logs`, outsiderJwt)).status);
  }, 90_000);

  it('cancels a running attempt with a positive stop receipt', async () => {
    expect((await call('POST', `/api/tasks/${tasks.cancel}/execute`, ownerJwt)).status).toBe(200);
    await waitFor(async () => (await prisma.task.findUniqueOrThrow({ where: { id: tasks.cancel } })).status === 'in_progress', 'claimed');
    expect(await call('GET', `/api/tasks/${tasks.cancel}/running`, ownerJwt)).toEqual({ status: 200, body: { running: true } });
    const live = await call('GET', `/api/tasks/${tasks.cancel}/logs`, ownerJwt);
    expect((live.body.logs as unknown[]).length).toBeGreaterThan(0);
    expect([403, 404]).toContain((await call('POST', `/api/tasks/${tasks.cancel}/cancel`, outsiderJwt)).status);

    expect(await call('POST', `/api/tasks/${tasks.cancel}/cancel`, ownerJwt)).toEqual({ status: 200, body: { message: 'Task cancelled' } });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: tasks.cancel } });
    expect(row).toMatchObject({ status: 'cancelled', sessionId: null });
    const attempt = await prisma.executionAttempt.findFirstOrThrow({ where: { taskId: tasks.cancel }, include: { agentRun: true, capabilities: true } });
    expect(attempt).toMatchObject({ status: 'closed', terminalStatus: 'cancelled' });
    expect(attempt.cancelAcknowledgedAt).not.toBeNull();
    expect(attempt.agentRun?.status).toBe('cancelled');
    expect(attempt.capabilities.every((capability) => capability.revokedAt !== null)).toBe(true);
  }, 60_000);

  it('honours a cancellation requested through the control plane and acknowledges the stop', async () => {
    expect((await call('POST', `/api/tasks/${tasks.remoteCancel}/execute`, ownerJwt)).status).toBe(200);
    await waitFor(async () => (await prisma.task.findUniqueOrThrow({ where: { id: tasks.remoteCancel } })).status === 'in_progress', 'claimed');
    // Another client (web, CLI) asks the cloud API, not the sidecar.
    const requested = await fetch(`${apiUrl}/api/executions/tasks/${tasks.remoteCancel}/cancellation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(requested.status).toBe(202);
    const attempt = await waitFor(async () => {
      const row = await prisma.executionAttempt.findFirst({ where: { taskId: tasks.remoteCancel }, include: { agentRun: true } });
      return row?.status === 'closed' ? row : null;
    }, `remote cancellation\n${sidecarOutput.slice(-3000)}`, 30_000);
    expect(attempt.terminalStatus).toBe('cancelled');
    expect(attempt.cancelRequestedAt).not.toBeNull();
    expect(attempt.cancelAcknowledgedAt).not.toBeNull();
    expect(attempt.agentRun?.status).toBe('cancelled');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tasks.remoteCancel } })).status).toBe('cancelled');
  }, 60_000);

  it('denies a stale capability after the attempt reached its terminal state', async () => {
    const startRes = await fetch(`${apiUrl}/api/executions/attempts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: tasks.capability }),
    });
    expect(startRes.status).toBe(201);
    const started = await startRes.json() as { attempt: { id: string }; capability: { token: string } };
    const post = (action: string, body: unknown) => fetch(`${apiUrl}/api/executions/attempts/${started.attempt.id}/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${started.capability.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await post('claim', { sessionId: 'ses_capability_probe', runner: 'opencode', model: 'stub/model' })).status).toBe(200);
    expect((await post('terminal', { status: 'cancelled', outcome: 'probe' })).status).toBe(200);
    expect((await post('close', {})).status).toBe(200);
    const stale = await post('terminal', { status: 'cancelled', outcome: 'stale rewrite' });
    expect(stale.status).toBe(401);
    expect((await stale.json() as { code: string }).code).toBe('CAPABILITY_REVOKED');
    // The capability is not a user credential at the sidecar either.
    expect((await call('GET', `/api/tasks/${tasks.capability}/logs`, started.capability.token)).status).toBe(401);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tasks.capability } })).outcome).toBe('probe');
  });

  it('accepts PATs only as far as the control plane allows', async () => {
    // Read-only PAT: may read logs, may not start an execution.
    expect((await call('GET', `/api/tasks/${tasks.done}/logs`, readOnlyPat)).status).toBe(200);
    const denied = await call('POST', `/api/tasks/${tasks.patWrite}/execute`, readOnlyPat);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('INSUFFICIENT_SCOPE');
    // tasks:write PAT: may execute; the attempt records the PAT principal.
    expect((await call('POST', `/api/tasks/${tasks.patWrite}/execute`, writePat)).status).toBe(200);
    const attempt = await prisma.executionAttempt.findFirstOrThrow({ where: { taskId: tasks.patWrite } });
    expect(attempt.authSource).toBe('pat');
    expect((await call('POST', `/api/tasks/${tasks.patWrite}/cancel`, writePat)).status).toBe(200);
  }, 60_000);

  it('fails closed when the control plane is unreachable', async () => {
    if (apiServer) await closeServer(apiServer);
    // An uncached credential cannot be validated: 503, never 200 or a sign-out 401.
    const fresh = sign(ownerId, `w03a-e2e-owner-${RUN}`);
    const logs = await call('GET', `/api/tasks/${tasks.done}/logs`, fresh);
    expect(logs.status).toBe(503);
    expect(logs.body.code).toBe('CLOUD_API_UNREACHABLE');
    // A recently validated credential still cannot start work: the attempt
    // start itself needs the control plane.
    const execute = await call('POST', `/api/tasks/${tasks.foreign}/execute`, ownerJwt);
    expect(execute.status).toBe(503);
    expect(execute.body.code).toBe('CLOUD_API_UNREACHABLE');
    expect(await prisma.executionAttempt.count({ where: { taskId: tasks.foreign } })).toBe(0);
  });
});
