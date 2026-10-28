/**
 * W07a end to end: the real API app (this process, test database) and the
 * real sidecar as a CHILD PROCESS with NO `OPENLINEAR_RUN_ENGINE` (v2 is the
 * default), no DATABASE_URL / signing secret / encryption key, the OpenCode
 * runner against the durable stub (it outlives a SIGKILLed sidecar), a
 * loopback GitHub stub that tracks open PRs per branch, a local bare origin
 * and an explicit trusted-host grant.
 *
 * 1. Follow-up turn (always on): execute → done → `POST /follow-up` with a
 *    message and line comments → the SAME OpenCode session gets one more
 *    (deterministic) prompt in the SAME worktree → a second commit
 *    fast-forwards the same branch → the existing PR is reused (no second
 *    POST) → done; the follow-up error contract (400/404/409).
 * 2. Soak (opt-in, RUN_ENGINE_SOAK=1; RUN_ENGINE_SOAK_TASKS, default 50): N
 *    tasks through v2 with random cancels and one SIGKILL of the sidecar
 *    mid-flight; asserts zero leaked reservations, exactly one terminal per
 *    run, no duplicate prompt, every relayed event delivered once, bounded
 *    journal and disk, and prints the numbers (RUN_ENGINE_SOAK_REPORT=<file>
 *    also writes them as JSON).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { encryptToken, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(HERE, '../../../sidecar');
const STUB = join(HERE, 'fixtures', 'opencode-stub-durable.mjs');
const REPO_FULL_NAME = `acme-v2n-${RUN}/repo`;
const FORBIDDEN_CHILD_ENV = ['DATABASE_URL', 'TEST_DATABASE_URL', 'JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'VITEST', 'OPENLINEAR_RUN_ENGINE'];
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'recovery_required', 'abandoned']);
const SOAK = process.env.RUN_ENGINE_SOAK === '1';
const SOAK_TASKS = Math.max(1, Number.parseInt(process.env.RUN_ENGINE_SOAK_TASKS ?? '50', 10) || 50);

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

/** Deterministic PRNG for the soak plan (seeded; reported). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
    snapshot_json: z.string(),
    workspace_json: z.string().nullable(),
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
      runs: db.prepare('SELECT run_id, task_id, state, last_seq, relay_ack_seq, attempt_id, session_id, snapshot_json, workspace_json FROM run_attempts ORDER BY created_at').all(),
      events: db.prepare('SELECT run_id, seq, kind, relay, payload_json FROM run_attempt_events ORDER BY run_id, seq').all(),
      effects: db.prepare('SELECT run_id, key, kind, status, receipt_json, dispatches FROM run_effects').all(),
    };
    process.stdout.write(JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ['--no-warnings', '-e', script, path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`journal read failed: ${result.stderr}`);
  return journalSchema.parse(JSON.parse(result.stdout));
}

const statsSchema = z.object({
  prompts: z.record(z.number()),
  promptTexts: z.record(z.array(z.string())),
  aborts: z.record(z.number()),
  streams: z.number(),
  sessions: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
});
type StubStats = z.infer<typeof statsSchema>;

function dirBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(path);
  return total;
}

const ids = { users: [] as string[], workspaces: [] as string[], repositories: [] as string[] };

describe('W07a: v2 by default — follow-up turns and the soak', () => {
  let root = '';
  let appData = '';
  let journalPath = '';
  let pidDir = '';
  let origin = '';
  let apiServer: Server | undefined;
  let githubServer: Server | undefined;
  let ownerJwt = '';
  let makeTask: (title: string) => Promise<string> = async () => '';
  const githubPosts: string[] = [];
  const childEnv: NodeJS.ProcessEnv = {};
  const children: ChildProcess[] = [];

  interface Sidecar {
    child: ChildProcess;
    url: string;
    output: () => string;
  }
  let current: Sidecar | undefined;

  async function startSidecar(): Promise<Sidecar> {
    let output = '';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: SIDECAR_DIR,
      env: childEnv,
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

  let rateLimited = 0;
  async function call(method: string, path: string, body?: unknown, token = ownerJwt): Promise<{ status: number; body: Record<string, unknown> }> {
    for (let attempt = 0; ; attempt += 1) {
      if (!current) throw new Error('no sidecar');
      const res = await fetch(`${current.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      // The sidecar's per-client limiter (120/min) pushes back on the soak's bursts; wait it out.
      if (res.status === 429 && attempt < 90) {
        rateLimited += 1;
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
    }
  }

  function stubs(): Array<{ pid: number; url: string }> {
    if (!existsSync(pidDir)) return [];
    return readdirSync(pidDir).filter((name) => name.endsWith('.json')).map((name) =>
      z.object({ pid: z.number(), url: z.string() }).parse(JSON.parse(readFileSync(join(pidDir, name), 'utf8'))));
  }

  async function allStubStats(): Promise<Array<{ url: string; stats: StubStats }>> {
    const out: Array<{ url: string; stats: StubStats }> = [];
    for (const stub of stubs()) {
      try {
        out.push({ url: stub.url, stats: statsSchema.parse(await (await fetch(`${stub.url}/__stub/stats`)).json()) });
      } catch {
        // a dead stub
      }
    }
    return out;
  }

  async function sessionFor(runId: string): Promise<{ url: string; id: string } | null> {
    for (const { url, stats } of await allStubStats()) {
      const session = stats.sessions.find((candidate) => candidate.title === `openlinear:${runId}`);
      if (session) return { url, id: session.id };
    }
    return null;
  }

  async function settledRun(runId: string, timeoutMs = 60_000) {
    return waitFor(async () => {
      const journal = readJournal(journalPath);
      const run = journal.runs.find((candidate) => candidate.run_id === runId);
      if (!run || !TERMINAL.has(run.state)) return null;
      return journal.effects.some((effect) => effect.run_id === runId && effect.status === 'pending') ? null : run;
    }, `terminal run ${runId}`, timeoutMs);
  }

  function terminalCount(journal: JournalDump, runId: string): number {
    return journal.events.filter((event) => event.run_id === runId && event.kind === 'run.state'
      && TERMINAL.has(String((JSON.parse(event.payload_json) as { to?: unknown }).to))).length;
  }

  function relayable(journal: JournalDump, runId: string) {
    return journal.events.filter((event) => event.run_id === runId && event.relay === 1 && ['log', 'progress', 'run.state'].includes(event.kind));
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ol-v2native-e2e-'));
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
    writeFileSync(join(seed, 'README.md'), 'v2native e2e fixture\n');
    git(seed, ['add', '.']);
    git(seed, ['-c', 'user.name=OpenLinear Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'seed']);
    git(seed, ['push', origin, 'main']);

    const owner = await prisma.user.create({
      data: { username: `w07a-e2e-owner-${RUN}`, accessToken: encryptToken(`gho_e2e_${RUN}_token_value_0123456789abcd`) },
    });
    ids.users.push(owner.id);
    ownerJwt = jwt.sign({ userId: owner.id, username: owner.username }, testJwtSecret(), { expiresIn: '1h', jwtid: randomUUID() });
    await prisma.settings.create({ data: { userId: owner.id, parallelLimit: 3 } });
    const workspace = await prisma.workspace.create({ data: { name: `W07a e2e ${RUN}`, slug: `w07a-e2e-${RUN}` } });
    ids.workspaces.push(workspace.id);
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const repository = await prisma.repository.create({
      data: {
        userId: owner.id,
        githubRepoId: 700_000 + Math.floor(Math.random() * 99_999),
        name: 'repo',
        fullName: REPO_FULL_NAME,
        cloneUrl: `file://${origin}`,
        defaultBranch: 'main',
      },
    });
    ids.repositories.push(repository.id);
    const project = await prisma.project.create({
      data: { name: `W07a e2e project ${RUN}`, workspaceId: workspace.id, key: `V${RUN.slice(0, 3).toUpperCase()}`, repositoryId: repository.id },
    });
    const team = await prisma.team.create({ data: { name: `W07a e2e team ${RUN}`, key: `N${RUN.slice(0, 3).toUpperCase()}`, projectId: project.id } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: 'owner' } });
    makeTask = async (title: string) => (await prisma.task.create({
      data: { title, description: 'W07a e2e', model: 'stub/model', projectId: project.id, teamId: team.id, workspaceId: workspace.id, creatorId: owner.id },
    })).id;

    apiServer = http.createServer(createApp());
    const apiUrl = `http://127.0.0.1:${await listen(apiServer)}`;

    // GitHub stub: one PR per head branch; GET lists the open PR of a head.
    const prs = new Map<string, string>();
    githubServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/pulls')) {
        let raw = '';
        req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        req.on('end', () => {
          const head = z.object({ head: z.string() }).safeParse(JSON.parse(raw || '{}'));
          const branch = head.success ? head.data.head.split(':').slice(-1)[0] ?? '' : '';
          const number = prs.size + 1;
          const url = `https://github.com/${REPO_FULL_NAME}/pull/${number}`;
          prs.set(branch, url);
          githubPosts.push(branch);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ html_url: url, number }));
        });
        return;
      }
      const head = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('head')?.split(':').slice(1).join(':') ?? '';
      const url = prs.get(head);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(url ? [{ html_url: url }] : []));
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
      // No OPENLINEAR_RUN_ENGINE: v2 must be the default.
      OPENLINEAR_SANDBOX_MODE: 'trusted-host',
      OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: JSON.stringify({
        actor: 'run-engine.v2native.e2e.test',
        reason: 'stub OpenCode under test; sandbox enforcement is covered by the sandbox corpus',
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        paths: [root],
      }),
    });
    for (const key of FORBIDDEN_CHILD_ENV) expect(childEnv[key], key).toBeUndefined();
    current = await startSidecar();
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

  it('follow-up: same session, same worktree and branch, fast-forward push, same PR, done once', async () => {
    const taskId = await makeTask(`Follow-up e2e ${RUN}`);
    const started = await call('POST', `/api/tasks/${taskId}/execute`);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ message: 'Task execution started', state: 'running' });
    const firstRunId = String(started.body.runId);
    const first = await settledRun(firstRunId);
    expect(first.state).toBe('succeeded');
    const session = await waitFor(() => sessionFor(firstRunId), 'first session');
    const branch = `openlinear/${firstRunId}`;
    const firstSha = git(origin, ['rev-parse', `refs/heads/${branch}`]);
    const prUrl = (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).prUrl;
    expect(prUrl).toMatch(/\/pull\/\d+$/);
    const postsBefore = githubPosts.length;

    // Contract errors first: validation, unknown task, turn in progress.
    expect((await call('POST', `/api/tasks/${taskId}/follow-up`, { message: '' })).status).toBe(400);
    expect(await call('POST', `/api/tasks/${randomUUID()}/follow-up`, { message: 'hello' })).toMatchObject({ status: 404, body: { code: 'TASK_NOT_FOUND' } });

    const review = {
      // "[hold]" keeps the stub's turn busy until released, so "a turn is in progress" is deterministic.
      message: 'Please also cover the empty case. [hold]',
      comments: [{ path: `durable-${session.id}.txt`, line: 1, side: 'new', body: 'Say why this changed.' }],
    };
    const turn = await call('POST', `/api/tasks/${taskId}/follow-up`, review);
    expect(turn.status).toBe(202);
    expect(turn.body).toEqual({ runId: expect.any(String), attemptId: expect.any(String), state: 'running' });
    const turnRunId = String(turn.body.runId);
    const turnAttemptId = String(turn.body.attemptId);
    expect(await call('POST', `/api/tasks/${taskId}/follow-up`, review)).toMatchObject({ status: 409, body: { code: 'RUN_ACTIVE' } });
    await waitFor(async () => (await allStubStats()).find((entry) => entry.url === session.url)?.stats.prompts[session.id] === 2, 'follow-up prompt');
    expect((await fetch(`${session.url}/__stub/release/${session.id}`, { method: 'POST' })).status).toBe(200);

    const done = await settledRun(turnRunId);
    expect(done.state).toBe('succeeded');
    const journal = readJournal(journalPath);
    const record = journal.runs.find((candidate) => candidate.run_id === turnRunId);
    expect(record?.session_id).toBe(session.id);
    expect(JSON.parse(record?.snapshot_json ?? '{}')).toMatchObject({ followUp: { parentRunId: firstRunId, message: review.message, comments: review.comments } });
    expect(JSON.parse(record?.workspace_json ?? '{}')).toMatchObject({ branch, continuedFrom: firstRunId });
    expect(terminalCount(journal, turnRunId)).toBe(1);
    const seqs = journal.events.filter((event) => event.run_id === turnRunId).map((event) => event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));

    // The same session got exactly one more prompt: the deterministic review prompt.
    const stats = (await allStubStats()).find((entry) => entry.url === session.url)?.stats;
    expect(stats?.prompts[session.id]).toBe(2);
    const prompt = stats?.promptTexts[session.id]?.[1] ?? '';
    expect(prompt).toContain(`Follow-up review of your previous turn on branch "${branch}".`);
    expect(prompt).toContain(`Comment 1 — file "durable-${session.id}.txt", line 1 (new side of the diff):\n> Say why this changed.`);
    expect(prompt).toContain('Reviewer message:\nPlease also cover the empty case. [hold]');

    // Same branch, fast-forwarded by one effect-trailed commit; the same PR, no second POST.
    const secondSha = git(origin, ['rev-parse', `refs/heads/${branch}`]);
    expect(secondSha).not.toBe(firstSha);
    expect(git(origin, ['rev-list', '--count', `${firstSha}..${secondSha}`])).toBe('1');
    expect(git(origin, ['merge-base', '--is-ancestor', firstSha, secondSha])).toBe('');
    expect(git(origin, ['log', '-1', '--format=%B', secondSha])).toContain(`OpenLinear-Effect: ${turnRunId}:git.commit`);
    expect(githubPosts.length).toBe(postsBefore);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'done', prUrl, sessionId: null });
    expect(await prisma.executionAttempt.findUniqueOrThrow({ where: { id: turnAttemptId }, include: { agentRun: true } })).toMatchObject({
      status: 'closed', terminalStatus: 'done', agentRun: { status: 'succeeded', prUrl },
    });
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: turnAttemptId } });
    expect(attempt.lastEventSeq).toBe(relayable(journal, turnRunId).at(-1)?.seq);
    const state = await call('GET', `/api/tasks/${taskId}/run`);
    expect(state.body.run).toMatchObject({ runId: turnRunId, state: 'succeeded', followUp: { parentRunId: firstRunId, mode: 'resume' } });
  }, 180_000);

  it.skipIf(!SOAK)(`soak: ${SOAK_TASKS} tasks with random cancels and one sidecar SIGKILL`, async () => {
    const seed = Number.parseInt(process.env.RUN_ENGINE_SOAK_SEED ?? '20261026', 10);
    const rng = mulberry32(seed);
    const plan: Array<{
      id: string; hold: boolean; cancel: boolean; cancelAfterMs: number; releaseAfterMs: number;
      runId: string | null; cancelSent: boolean; released: boolean; startedAt: number;
    }> = [];
    for (let index = 0; index < SOAK_TASKS; index += 1) {
      // Half the agents stay busy until released (or cancelled); a third of all tasks get a cancel at a random moment.
      const hold = rng() < 0.5;
      const cancel = rng() < 0.33;
      plan.push({
        id: await makeTask(`Soak ${index} ${hold ? '[hold] ' : ''}${RUN}`),
        hold,
        cancel,
        cancelAfterMs: Math.floor(rng() * 900),
        releaseAfterMs: 200 + Math.floor(rng() * 1_300),
        runId: null,
        cancelSent: false,
        released: false,
        startedAt: 0,
      });
    }
    const t0 = Date.now();
    const killAfter = Math.floor(SOAK_TASKS * 0.45);
    let killed = false;
    let killAt = 0;
    let restartMs = 0;
    let next = 0;
    let limitRefusals = 0;
    const cancelOutcomes: Record<string, number> = {};
    const executeStatus: Record<string, number> = {};
    const submitLatency: number[] = [];

    for (;;) {
      const journal = readJournal(journalPath);
      const states = new Map(journal.runs.map((run) => [run.run_id, run.state]));
      const live = plan.filter((entry) => entry.runId && !TERMINAL.has(states.get(entry.runId) ?? 'queued')).length;
      // Submit while the local queue has room (limit 3 + queue 10).
      while (next < plan.length && live + 1 <= 12) {
        const entry = plan[next];
        if (!entry) break;
        const begin = Date.now();
        const res = await call('POST', `/api/tasks/${entry.id}/execute`);
        submitLatency.push(Date.now() - begin);
        executeStatus[String(res.status)] = (executeStatus[String(res.status)] ?? 0) + 1;
        if (res.status === 400 && res.body.code === 'PARALLEL_LIMIT_REACHED') {
          limitRefusals += 1;
          break;
        }
        expect([200, 202]).toContain(res.status);
        entry.runId = String(res.body.runId);
        entry.startedAt = Date.now();
        next += 1;
        break;
      }
      // Drive the held agents: cancel the planned ones, release the others after a short while.
      for (const entry of plan) {
        if (!entry.runId) continue;
        const state = states.get(entry.runId);
        if (!state || TERMINAL.has(state)) continue;
        if (entry.cancel && !entry.cancelSent && Date.now() - entry.startedAt > entry.cancelAfterMs) {
          entry.cancelSent = true;
          const res = await call('POST', `/api/tasks/${entry.id}/cancel`);
          const key = `${res.status}:${state}`;
          cancelOutcomes[key] = (cancelOutcomes[key] ?? 0) + 1;
          continue;
        }
        if (entry.hold && !entry.released && state === 'running' && Date.now() - entry.startedAt > entry.releaseAfterMs) {
          const session = await sessionFor(entry.runId);
          if (session) {
            const released = await fetch(`${session.url}/__stub/release/${session.id}`, { method: 'POST' });
            if (released.status === 200) entry.released = true;
          }
        }
      }
      // One SIGKILL with several runs in flight, then a restart on the same app data.
      const running = plan.filter((entry) => entry.runId && states.get(entry.runId) === 'running').length;
      if (!killed && next >= killAfter && running >= 3 && current) {
        killed = true;
        killAt = Date.now();
        await kill(current);
        current = await startSidecar();
        restartMs = Date.now() - killAt;
        // Held sessions that survived on the old stub are released below as usual.
        for (const entry of plan) entry.released = entry.released && !entry.hold;
      }
      const allTerminal = next >= plan.length && plan.every((entry) => entry.runId && TERMINAL.has(states.get(entry.runId) ?? ''))
        && !journal.effects.some((effect) => effect.status === 'pending');
      if (allTerminal) break;
      if (Date.now() - t0 > 15 * 60_000) throw new Error('soak did not converge within 15 minutes');
      await new Promise((r) => setTimeout(r, 150));
    }
    const elapsedMs = Date.now() - t0;

    // Let the last projections and relays land.
    await new Promise((r) => setTimeout(r, 1_500));
    const journal = readJournal(journalPath);
    const soakRuns = journal.runs.filter((run) => plan.some((entry) => entry.runId === run.run_id));
    expect(soakRuns).toHaveLength(plan.length);

    // Exactly one terminal per run, gap-free sequences, nothing undelivered or duplicated at the control plane.
    for (const run of soakRuns) {
      expect(terminalCount(journal, run.run_id), run.run_id).toBe(1);
      const seqs = journal.events.filter((event) => event.run_id === run.run_id).map((event) => event.seq);
      expect(seqs, run.run_id).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
      const relay = relayable(journal, run.run_id);
      if (run.state !== 'abandoned' && run.attempt_id) {
        const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: run.attempt_id } });
        expect(['closed', 'released'], `${run.run_id} attempt ${attempt.status}`).toContain(attempt.status);
        const trail = journal.events.filter((event) => event.run_id === run.run_id)
          .map((event) => `${event.seq}:${event.kind}${event.relay ? '*' : ''}:${event.payload_json.slice(0, 90)}`).join('\n');
        const label = `${run.run_id} ${run.state} ack=${run.relay_ack_seq} attempt=${attempt.lastEventSeq}\n${trail}`;
        expect(run.relay_ack_seq, label).toBe(relay.at(-1)?.seq ?? 0);
        expect(attempt.lastEventSeq, label).toBe(relay.at(-1)?.seq ?? 0);
      }
    }
    // Zero leaked reservations: locally (sidecar) and at the control plane.
    for (const entry of plan) {
      expect(await call('GET', `/api/tasks/${entry.id}/running`), entry.id).toEqual({ status: 200, body: { running: false } });
    }
    const stuck = await prisma.task.count({ where: { id: { in: plan.map((entry) => entry.id) }, status: 'in_progress' } });
    expect(stuck).toBe(0);
    const openAttempts = await prisma.executionAttempt.count({ where: { taskId: { in: plan.map((entry) => entry.id) }, status: { in: ['preparing', 'running', 'finishing'] } } });
    expect(openAttempts).toBe(0);
    // No duplicate prompt: every session got at most one.
    const stats = await allStubStats();
    const promptCounts = stats.flatMap(({ stats: s }) => s.sessions.filter((session) => soakRuns.some((run) => session.title === `openlinear:${run.run_id}`)).map((session) => s.prompts[session.id] ?? 0));
    expect(promptCounts.every((count) => count <= 1)).toBe(true);
    // A prompt reaches the runtime only after its intent was journaled (a kill in between leaves an intent without a prompt).
    const prompted = soakRuns.filter((run) => journal.effects.some((effect) => effect.run_id === run.run_id && effect.kind === 'prompt.submit'));
    expect(promptCounts.filter((count) => count === 1).length).toBeLessThanOrEqual(prompted.length);
    // PRs: one POST per published branch, never two; every succeeded run has its PR.
    const succeeded = soakRuns.filter((run) => run.state === 'succeeded');
    const soakPosts = githubPosts.filter((branch) => soakRuns.some((run) => branch === `openlinear/${run.run_id}`));
    expect(new Set(soakPosts).size).toBe(soakPosts.length);
    for (const run of succeeded) expect(soakPosts, run.run_id).toContain(`openlinear/${run.run_id}`);
    // Bounded journal and disk.
    const journalBytes = ['', '-wal', '-shm'].reduce((sum, suffix) => sum + (existsSync(`${journalPath}${suffix}`) ? statSync(`${journalPath}${suffix}`).size : 0), 0);
    const eventsPerRun = soakRuns.map((run) => journal.events.filter((event) => event.run_id === run.run_id).length);
    const reposBytes = dirBytes(join(appData, 'repos'));
    expect(Math.max(...eventsPerRun)).toBeLessThan(20_000);
    expect(journalBytes).toBeLessThan(64 * 1024 * 1024);
    const recoveries = journal.events.filter((event) => soakRuns.some((run) => run.run_id === event.run_id) && event.kind === 'recovery' && 'decision' in (JSON.parse(event.payload_json) as object))
      .map((event) => String((JSON.parse(event.payload_json) as { decision?: unknown }).decision));

    const sorted = [...submitLatency].sort((a, b) => a - b);
    const report = {
      seed,
      tasks: plan.length,
      elapsedMs,
      sigkill: { killed, atTask: killAfter, restartMs },
      byState: Object.fromEntries([...TERMINAL].map((state) => [state, soakRuns.filter((run) => run.state === state).length])),
      recoveryDecisions: recoveries.reduce<Record<string, number>>((acc, decision) => {
        acc[decision] = (acc[decision] ?? 0) + 1;
        return acc;
      }, {}),
      cancelsSent: plan.filter((entry) => entry.cancelSent).length,
      cancelOutcomes,
      executeStatus,
      limitRefusals,
      sidecarRateLimitedCalls: rateLimited,
      submitLatencyMs: { p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 },
      prompts: { sessions: promptCounts.length, prompted: prompted.length, max: Math.max(0, ...promptCounts) },
      prPosts: soakPosts.length,
      leakedReservations: 0,
      stuckTasks: stuck,
      openAttempts,
      journal: { bytes: journalBytes, events: journal.events.length, maxEventsPerRun: Math.max(...eventsPerRun), runs: journal.runs.length },
      disk: { reposBytes, worktrees: existsSync(join(appData, 'repos', 'worktrees')) ? readdirSync(join(appData, 'repos', 'worktrees')).length : 0 },
    };
    process.stdout.write(`\n[run-engine soak] ${JSON.stringify(report, null, 2)}\n`);
    if (process.env.RUN_ENGINE_SOAK_REPORT) writeFileSync(process.env.RUN_ENGINE_SOAK_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    expect(killed).toBe(true);
  }, 20 * 60_000);
});
