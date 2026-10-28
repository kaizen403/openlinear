/**
 * W05a/W06a acceptance, end to end: the real API app (this process, test
 * database) and the real sidecar as a CHILD PROCESS with
 * OPENLINEAR_RUN_ENGINE=v2, no DATABASE_URL / signing secret / encryption
 * key, the existing OpenCode runner (AgentRunner contract) against a stub
 * OpenCode server that outlives the sidecar, a loopback GitHub stub, a
 * local bare origin, and an explicit trusted-host sandbox grant.
 *
 * Kill points (SIGKILL of the sidecar child, then a restart on the same app
 * data):
 *   1. after prompt dispatch (external SIGKILL while the agent works);
 *   2. after the commit receipt, before the push (crash point);
 *   3. after the push was dispatched, before its receipt (crash point, during
 *      the recovery of 2);
 *   4. dead sidecar never restarted in time: the control-plane sweeper
 *      releases the task; the sidecar that comes back is fenced.
 * Each run is checked for: no duplicate prompt, journal sequence continuity
 * with nothing lost or duplicated at the control plane, effects reconciled,
 * exactly one terminal state, task not stuck.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { encryptToken, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { sweepLostExecutionAttempts } from '../services/execution-sweeper';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(HERE, '../../../sidecar');
const STUB = join(HERE, 'fixtures', 'opencode-stub-durable.mjs');
const REPO_FULL_NAME = `acme-run-${RUN}/repo`;
const PR_URL = `https://github.com/${REPO_FULL_NAME}/pull/7`;
const FORBIDDEN_CHILD_ENV = ['DATABASE_URL', 'TEST_DATABASE_URL', 'JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'VITEST'];
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'recovery_required', 'abandoned']);

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

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const journalSchema = z.object({
  runs: z.array(z.object({
    run_id: z.string(),
    task_id: z.string(),
    state: z.string(),
    last_seq: z.number(),
    relay_ack_seq: z.number(),
    attempt_id: z.string().nullable(),
    session_id: z.string().nullable(),
    terminal_json: z.string().nullable(),
  })),
  events: z.array(z.object({ run_id: z.string(), seq: z.number(), kind: z.string(), relay: z.number(), payload_json: z.string() })),
  effects: z.array(z.object({ run_id: z.string(), key: z.string(), kind: z.string(), status: z.string(), receipt_json: z.string().nullable(), dispatches: z.number() })),
});
type JournalDump = z.infer<typeof journalSchema>;

/** Read the sidecar's SQLite journal in a child (the API package has no node:sqlite typings). */
function readJournal(path: string): JournalDump {
  if (!existsSync(path)) return { runs: [], events: [], effects: [] };
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const out = {
      runs: db.prepare('SELECT run_id, task_id, state, last_seq, relay_ack_seq, attempt_id, session_id, terminal_json FROM run_attempts').all(),
      events: db.prepare('SELECT run_id, seq, kind, relay, payload_json FROM run_attempt_events ORDER BY run_id, seq').all(),
      effects: db.prepare('SELECT run_id, key, kind, status, receipt_json, dispatches FROM run_effects').all(),
    };
    process.stdout.write(JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ['--no-warnings', '-e', script, path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`journal read failed: ${result.stderr}`);
  return journalSchema.parse(JSON.parse(result.stdout));
}

const statsSchema = z.object({
  prompts: z.record(z.number()),
  aborts: z.record(z.number()),
  streams: z.number(),
  sessions: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
});

const ids = { users: [] as string[], workspaces: [] as string[], repositories: [] as string[] };

describe('W05a/W06a: durable run engine survives SIGKILL of the sidecar', () => {
  let root = '';
  let appData = '';
  let journalPath = '';
  let pidDir = '';
  let origin = '';
  let apiServer: Server | undefined;
  let githubServer: Server | undefined;
  let apiUrl = '';
  let ownerJwt = '';
  let ownerId = '';
  const githubPosts: string[] = [];
  const childEnv: NodeJS.ProcessEnv = {};
  const children: ChildProcess[] = [];
  const tasks = { done: '', held: '', swept: '', published: '', cancel: '' };

  interface Sidecar {
    child: ChildProcess;
    url: string;
    output: () => string;
  }

  async function startSidecar(extraEnv: NodeJS.ProcessEnv = {}): Promise<Sidecar> {
    let output = '';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: SIDECAR_DIR,
      env: { ...childEnv, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const port = await waitFor(async () => {
      const match = /"port":(\d+),"msg":"\[Sidecar\] server listening"/.exec(output);
      return match && match[1] !== '0' ? Number(match[1]) : null;
    }, 'sidecar listening', 60_000);
    await waitFor(async () => output.includes('OpenCode agent ready'), 'OpenCode stub ready', 30_000);
    return { child, url: `http://127.0.0.1:${port}`, output: () => output };
  }

  async function kill(sidecar: Sidecar): Promise<void> {
    if (sidecar.child.exitCode === null && sidecar.child.signalCode === null) sidecar.child.kill('SIGKILL');
    await waitFor(async () => sidecar.child.exitCode !== null || sidecar.child.signalCode !== null, 'sidecar exit', 10_000);
  }

  async function call(sidecar: Sidecar, method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${sidecar.url}${path}`, { method, headers: { Authorization: `Bearer ${ownerJwt}` } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  }

  function stubs(): Array<{ pid: number; url: string }> {
    if (!existsSync(pidDir)) return [];
    return readdirSync(pidDir).filter((name) => name.endsWith('.json')).map((name) => {
      const parsed = z.object({ pid: z.number(), url: z.string() }).parse(JSON.parse(readFileSync(join(pidDir, name), 'utf8')));
      return parsed;
    });
  }

  async function stubStats(url: string) {
    return statsSchema.parse(await (await fetch(`${url}/__stub/stats`)).json());
  }

  /** The stub that holds the run's session, and the session id. */
  async function sessionFor(runId: string): Promise<{ url: string; id: string }> {
    return waitFor(async () => {
      for (const stub of stubs()) {
        try {
          const stats = await stubStats(stub.url);
          const session = stats.sessions.find((candidate) => candidate.title === `openlinear:${runId}`);
          if (session) return { url: stub.url, id: session.id };
        } catch {
          // a dead stub
        }
      }
      return null;
    }, `stub session for ${runId}`);
  }

  function runFor(taskId: string) {
    return readJournal(journalPath).runs.find((run) => run.task_id === taskId);
  }

  async function terminalRun(taskId: string, timeoutMs = 60_000) {
    return waitFor(async () => {
      const run = runFor(taskId);
      if (!run || !TERMINAL.has(run.state)) return null;
      const journal = readJournal(journalPath);
      const pending = journal.effects.filter((effect) => effect.run_id === run.run_id && effect.status === 'pending');
      return pending.length === 0 ? run : null;
    }, `terminal run for ${taskId}`, timeoutMs);
  }

  /** Sequence continuity, one terminal transition, and nothing lost or duplicated at the control plane. */
  async function assertRunIntegrity(runId: string, attemptId: string, taskId: string): Promise<void> {
    const journal = readJournal(journalPath);
    const run = journal.runs.find((candidate) => candidate.run_id === runId);
    const events = journal.events.filter((event) => event.run_id === runId);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
    expect(events.at(-1)?.seq).toBe(run?.last_seq);
    const terminal = events.filter((event) => event.kind === 'run.state' && TERMINAL.has(String((JSON.parse(event.payload_json) as { to?: unknown }).to)));
    expect(terminal).toHaveLength(1);
    const relayable = events.filter((event) => event.relay === 1 && ['log', 'progress', 'run.state'].includes(event.kind));
    expect(run?.relay_ack_seq).toBe(relayable.at(-1)?.seq);
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.lastEventSeq).toBe(relayable.at(-1)?.seq);
    // Every relayed journal event became exactly one control-plane event.
    const delivered = await prisma.domainEvent.findMany({ where: { type: { in: ['execution:progress', 'execution:log'] }, actorId: ownerId } });
    const forTask = delivered.filter((row) => (row.payload as { taskId?: string }).taskId === taskId);
    expect(forTask.length).toBe(relayable.length);
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ol-run-engine-e2e-'));
    const home = join(root, 'home');
    appData = join(root, 'app');
    pidDir = join(root, 'stubs');
    journalPath = join(appData, 'journal', 'runs-v2.sqlite');
    mkdirSync(home, { recursive: true });
    mkdirSync(appData, { recursive: true });
    const gitconfig = join(root, 'gitconfig');
    writeFileSync(gitconfig, '');

    origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    mkdirSync(seed);
    git(root, ['init', '--bare', '--initial-branch=main', origin]);
    git(seed, ['init', '--initial-branch=main']);
    writeFileSync(join(seed, 'README.md'), 'run engine e2e fixture\n');
    git(seed, ['add', '.']);
    git(seed, ['-c', 'user.name=OpenLinear Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'seed']);
    git(seed, ['push', origin, 'main']);

    const owner = await prisma.user.create({
      data: { username: `w05a-e2e-owner-${RUN}`, accessToken: encryptToken(`gho_e2e_${RUN}_token_value_0123456789abcd`) },
    });
    ids.users.push(owner.id);
    ownerId = owner.id;
    ownerJwt = jwt.sign({ userId: owner.id, username: owner.username }, testJwtSecret(), { expiresIn: '1h', jwtid: randomUUID() });
    const workspace = await prisma.workspace.create({ data: { name: `W05a e2e ${RUN}`, slug: `w05a-e2e-${RUN}` } });
    ids.workspaces.push(workspace.id);
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const repository = await prisma.repository.create({
      data: {
        userId: owner.id,
        githubRepoId: 600_000 + Math.floor(Math.random() * 99_999),
        name: 'repo',
        fullName: REPO_FULL_NAME,
        cloneUrl: `file://${origin}`,
        defaultBranch: 'main',
      },
    });
    ids.repositories.push(repository.id);
    const project = await prisma.project.create({
      data: { name: `W05a e2e project ${RUN}`, workspaceId: workspace.id, key: `R${RUN.slice(0, 3).toUpperCase()}`, repositoryId: repository.id },
    });
    const team = await prisma.team.create({ data: { name: `W05a e2e team ${RUN}`, key: `Q${RUN.slice(0, 3).toUpperCase()}`, projectId: project.id } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: 'owner' } });
    const makeTask = async (title: string) => (await prisma.task.create({
      data: { title, description: 'W05a e2e', model: 'stub/model', projectId: project.id, teamId: team.id, workspaceId: workspace.id, creatorId: owner.id },
    })).id;
    tasks.done = await makeTask(`Durable happy path ${RUN}`);
    tasks.held = await makeTask(`Durable held [hold] ${RUN}`);
    tasks.swept = await makeTask(`Durable swept [hang] ${RUN}`);
    tasks.published = await makeTask(`Durable publish crash ${RUN}`);
    tasks.cancel = await makeTask(`Durable cancel [hang] ${RUN}`);

    apiServer = http.createServer(createApp());
    apiUrl = `http://127.0.0.1:${await listen(apiServer)}`;

    const prHeads = new Set<string>();
    githubServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/pulls')) {
        let raw = '';
        req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        req.on('end', () => {
          const head = z.object({ head: z.string() }).safeParse(JSON.parse(raw || '{}'));
          if (head.success) prHeads.add(head.data.head);
          githubPosts.push(head.success ? head.data.head : '');
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ html_url: PR_URL, number: 7 }));
        });
        return;
      }
      // GET pulls?head=owner:branch: an open PR exists only for a branch one was created for.
      const head = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('head')?.split(':').slice(1).join(':') ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(prHeads.has(head) ? [{ html_url: PR_URL }] : []));
    });
    const githubUrl = `http://127.0.0.1:${await listen(githubServer)}`;

    const wrapper = join(root, 'opencode');
    writeFileSync(wrapper, `#!/bin/sh\nSTUB_PID_DIR="${pidDir}" exec "${process.execPath}" "${STUB}" "$@"\n`);
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
      OPENLINEAR_RUN_ENGINE: 'v2',
      OPENLINEAR_SANDBOX_MODE: 'trusted-host',
      OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: JSON.stringify({
        actor: 'run-engine.e2e.test',
        reason: 'stub OpenCode under test; sandbox enforcement is covered by the sandbox corpus',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        paths: [root],
      }),
    });
    for (const key of FORBIDDEN_CHILD_ENV) expect(childEnv[key], key).toBeUndefined();
  }, 120_000);

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const stub of stubs()) {
      try {
        process.kill(stub.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    for (const server of [githubServer, apiServer]) {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    }
    await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
    await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
    await prisma.task.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
    await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
    await prisma.repository.deleteMany({ where: { id: { in: ids.repositories } } });
    await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  let current: Sidecar | undefined;

  it('(a) runs a single attempt start → events → done with journal and API state', async () => {
    current = await startSidecar();
    const started = await call(current, 'POST', `/api/tasks/${tasks.done}/execute`);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ message: 'Task execution started', state: 'running' });
    const runId = String(started.body.runId);
    const attemptId = String(started.body.attemptId);

    const run = await terminalRun(tasks.done);
    expect(run).toMatchObject({ run_id: runId, state: 'succeeded' });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: tasks.done } });
    expect(task).toMatchObject({ status: 'done', prUrl: PR_URL, sessionId: null, executionProgress: 100 });
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { agentRun: true, capabilities: true } });
    expect(attempt).toMatchObject({ status: 'closed', terminalStatus: 'done', runner: 'opencode' });
    expect(attempt.agentRun).toMatchObject({ status: 'succeeded', prUrl: PR_URL });
    expect(attempt.capabilities.every((capability) => capability.revokedAt !== null)).toBe(true);
    await assertRunIntegrity(runId, attemptId, tasks.done);
    const journal = readJournal(journalPath);
    expect(journal.effects.filter((effect) => effect.run_id === runId).map((effect) => `${effect.kind}:${effect.status}`)).toEqual(expect.arrayContaining([
      'attempt.claim:confirmed', 'prompt.submit:confirmed', 'git.commit:confirmed', 'git.push:confirmed', 'pr.create:confirmed',
      'task.terminal:confirmed', 'run.finalize:confirmed', 'attempt.close:confirmed',
    ]));
    const session = await sessionFor(runId);
    expect((await stubStats(session.url)).prompts[session.id]).toBe(1);
    expect(git(origin, ['branch', '--list', `openlinear/${runId}`])).toContain(runId);
    const state = await call(current, 'GET', `/api/tasks/${tasks.done}/run`);
    expect(state.body.run).toMatchObject({ runId, state: 'succeeded' });
  }, 120_000);

  it('(b1) SIGKILL after prompt dispatch: reattaches without a second prompt and finishes exactly once', async () => {
    if (!current) throw new Error('no sidecar');
    const started = await call(current, 'POST', `/api/tasks/${tasks.held}/execute`);
    expect(started.status).toBe(200);
    const runId = String(started.body.runId);
    const attemptId = String(started.body.attemptId);
    const session = await sessionFor(runId);
    await waitFor(async () => (await stubStats(session.url)).prompts[session.id] === 1, 'prompt dispatched');
    await waitFor(async () => (await prisma.task.findUniqueOrThrow({ where: { id: tasks.held } })).status === 'in_progress', 'claimed');
    await waitFor(async () => (runFor(tasks.held)?.relay_ack_seq ?? 0) > 0, 'some events relayed before the kill');
    await kill(current);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tasks.held } })).status).toBe('in_progress');

    current = await startSidecar();
    // The restarted sidecar reattaches to the surviving runtime's event stream.
    await waitFor(async () => readJournal(journalPath).events.some((event) => event.run_id === runId && event.kind === 'recovery'
      && (JSON.parse(event.payload_json) as { decision?: string }).decision === 'reattach'), 'reattach decision');
    await waitFor(async () => (await stubStats(session.url)).streams > 0, 'reattached stream');
    await new Promise((r) => setTimeout(r, 300));
    expect((await fetch(`${session.url}/__stub/release/${session.id}`, { method: 'POST' })).status).toBe(200);

    const run = await terminalRun(tasks.held);
    expect(run.state).toBe('succeeded');
    expect((await stubStats(session.url)).prompts[session.id]).toBe(1);
    expect((await stubStats(session.url)).aborts[session.id] ?? 0).toBe(0);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: tasks.held } })).toMatchObject({ status: 'done', prUrl: PR_URL, sessionId: null });
    expect(await prisma.executionAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: 'closed', terminalStatus: 'done' });
    await assertRunIntegrity(runId, attemptId, tasks.held);
  }, 180_000);

  it('(c) dead sidecar: the sweeper releases the task and a sidecar that comes back is fenced', async () => {
    if (!current) throw new Error('no sidecar');
    const started = await call(current, 'POST', `/api/tasks/${tasks.swept}/execute`);
    expect(started.status).toBe(200);
    const runId = String(started.body.runId);
    const attemptId = String(started.body.attemptId);
    const session = await sessionFor(runId);
    await waitFor(async () => (await prisma.task.findUniqueOrThrow({ where: { id: tasks.swept } })).status === 'in_progress', 'claimed');
    await kill(current);

    // The lease expires (no sidecar heartbeats), then the sweeper job runs.
    await prisma.executionAttempt.update({ where: { id: attemptId }, data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    const swept = await sweepLostExecutionAttempts({ leaseMs: 60_000 });
    expect(swept.recoveryRequired).toBeGreaterThanOrEqual(1);
    const released = await prisma.task.findUniqueOrThrow({ where: { id: tasks.swept } });
    expect(released).toMatchObject({ status: 'cancelled', sessionId: null });
    expect(await prisma.executionAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: 'closed', recoveryState: 'recovery_required' });

    // The returning sidecar (with the commit crash point armed for the next test).
    current = await startSidecar({ OPENLINEAR_RUN_ENGINE_CRASH_AT: 'after:effect:git.commit:receipt' });
    const run = await terminalRun(tasks.swept);
    expect(run.state).toBe('abandoned');
    // It wrote nothing: the task is exactly as the sweeper left it.
    const after = await prisma.task.findUniqueOrThrow({ where: { id: tasks.swept } });
    expect(after.updatedAt.getTime()).toBe(released.updatedAt.getTime());
    expect(after).toMatchObject({ status: 'cancelled', outcome: released.outcome });
    // It stopped the orphaned agent instead of letting it run on.
    await waitFor(async () => ((await stubStats(session.url)).aborts[session.id] ?? 0) >= 1, 'orphan aborted');
    // The user can retry right away (no stuck in_progress).
    const retry = await fetch(`${apiUrl}/api/executions/attempts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: tasks.swept }),
    });
    expect(retry.status).toBe(201);
    const retried = await retry.json() as { attempt: { id: string }; capability: { token: string } };
    await fetch(`${apiUrl}/api/executions/attempts/${retried.attempt.id}/close`, {
      method: 'POST', headers: { Authorization: `Bearer ${retried.capability.token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
  }, 180_000);

  it('(b2) SIGKILL after commit before push, then again after push dispatch: one commit, one push, one PR, done once', async () => {
    if (!current) throw new Error('no sidecar');
    const crashing = current;
    const started = await call(crashing, 'POST', `/api/tasks/${tasks.published}/execute`);
    expect(started.status).toBe(200);
    const runId = String(started.body.runId);
    const attemptId = String(started.body.attemptId);
    // The sidecar kills itself right after journaling the commit receipt.
    await waitFor(async () => crashing.child.signalCode === 'SIGKILL', 'crash after commit', 60_000);
    let journal = readJournal(journalPath);
    expect(journal.effects.find((effect) => effect.run_id === runId && effect.kind === 'git.commit')?.status).toBe('confirmed');
    expect(journal.effects.some((effect) => effect.run_id === runId && effect.kind === 'git.push')).toBe(false);
    expect(git(origin, ['branch', '--list', `openlinear/${runId}`])).toBe('');
    const postsBefore = githubPosts.length;

    // Restart with the next crash point: it resumes publication and dies right after the push.
    const second = await startSidecar({ OPENLINEAR_RUN_ENGINE_CRASH_AT: 'after:effect:git.push:dispatch' });
    await waitFor(async () => second.child.signalCode === 'SIGKILL', 'crash after push dispatch', 60_000);
    journal = readJournal(journalPath);
    const push = journal.effects.find((effect) => effect.run_id === runId && effect.kind === 'git.push');
    expect(push?.status).toBe('pending');
    const pushedSha = git(origin, ['rev-parse', `refs/heads/openlinear/${runId}`]);

    // Final restart without crash points: the push is reconciled from the remote ref.
    current = await startSidecar();
    const run = await terminalRun(tasks.published);
    expect(run.state).toBe('succeeded');
    journal = readJournal(journalPath);
    const effects = journal.effects.filter((effect) => effect.run_id === runId);
    const reconciledPush = effects.find((effect) => effect.kind === 'git.push');
    expect(reconciledPush?.status).toBe('confirmed');
    expect(JSON.parse(reconciledPush?.receipt_json ?? '{}')).toMatchObject({ reconciled: true, sha: pushedSha });
    expect(reconciledPush?.dispatches).toBe(1);
    expect(effects.filter((effect) => effect.kind === 'git.commit')).toHaveLength(1);
    // One commit with the effect trailer on the published branch.
    const log = git(origin, ['log', '--format=%H %s', `main..openlinear/${runId}`]).split('\n').filter(Boolean);
    expect(log).toHaveLength(1);
    expect(git(origin, ['log', '-1', '--format=%B', `openlinear/${runId}`])).toContain(`OpenLinear-Effect: ${runId}:git.commit`);
    expect(githubPosts.length - postsBefore).toBe(1);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: tasks.published } })).toMatchObject({ status: 'done', prUrl: PR_URL });
    expect(await prisma.executionAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { agentRun: true } })).toMatchObject({
      status: 'closed', terminalStatus: 'done', agentRun: { status: 'succeeded' },
    });
    await assertRunIntegrity(runId, attemptId, tasks.published);
    const session = await sessionFor(runId);
    expect((await stubStats(session.url)).prompts[session.id]).toBe(1);
  }, 240_000);

  it('(d) cancels a running v2 run with a positive stop receipt', async () => {
    if (!current) throw new Error('no sidecar');
    const started = await call(current, 'POST', `/api/tasks/${tasks.cancel}/execute`);
    expect(started.status).toBe(200);
    const attemptId = String(started.body.attemptId);
    await waitFor(async () => (await prisma.task.findUniqueOrThrow({ where: { id: tasks.cancel } })).status === 'in_progress', 'claimed');
    expect(await call(current, 'GET', `/api/tasks/${tasks.cancel}/running`)).toEqual({ status: 200, body: { running: true } });
    expect(await call(current, 'POST', `/api/tasks/${tasks.cancel}/cancel`)).toEqual({ status: 200, body: { message: 'Task cancelled' } });
    const run = await terminalRun(tasks.cancel);
    expect(run.state).toBe('cancelled');
    expect(await prisma.task.findUniqueOrThrow({ where: { id: tasks.cancel } })).toMatchObject({ status: 'cancelled', sessionId: null });
    expect(await prisma.executionAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { agentRun: true } })).toMatchObject({
      status: 'closed', terminalStatus: 'cancelled', agentRun: { status: 'cancelled' },
    });
    expect((await prisma.executionAttempt.findUniqueOrThrow({ where: { id: attemptId } })).cancelAcknowledgedAt).not.toBeNull();
  }, 120_000);
});
