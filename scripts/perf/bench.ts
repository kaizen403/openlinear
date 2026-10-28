/**
 * API latency baseline (performance plan, Phase 0).
 *
 *   PERF_DATABASE_URL=postgresql://openlinear@127.0.0.1:5432/openlinear_perf_test pnpm perf:bench -- --label baseline
 *
 * Drives the REAL API (the esbuild bundle `apps/api/dist/index.js`, NODE_ENV=
 * production, so production auth/limits/logging apply) against the seeded
 * perf database and records, per scenario: client latency (p50/p95/p99), time
 * to first byte, response bytes, status codes, and from the API's own
 * route-timing log lines the server-side duration and the number of Prisma
 * queries per request. Chat streaming is timed against a local fake
 * OpenAI-compatible provider (no paid inference).
 *
 * Options (flags or env):
 *   --label <name>        output name (default: baseline)
 *   --rounds <n>          full repetitions (default 3; PERF_ROUNDS)
 *   --iterations <n>      measured requests per read scenario per round (default 100; PERF_ITERATIONS)
 *   --only <a,b>          scenario name prefixes to run
 *   --out <dir>           report directory (default docs/reports/perf-baseline-2026-10-26)
 *   PERF_API_PORT         default 5050      PERF_FAKE_LLM_PORT  default 5051
 *   PERF_OUT_DIR          manifest + raw API log (default $TMPDIR/openlinear-perf)
 *   PERF_INSTRUMENTATION  sample (default: log every request, slow-query 100 ms),
 *                         prod (production defaults: slow/query-heavy requests only),
 *                         off (route timing and Prisma query events disabled) —
 *                         the last two measure the instrumentation's own overhead
 *
 * Rate limits: the default limiter keys on client IP (trust proxy = 1), so each
 * request carries a distinct synthetic X-Forwarded-For. Search and chat
 * limiters key on the user; requests rotate across the 16 bench users, which
 * share identical memberships.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem, release, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { prisma } from '../../packages/db/src/index.ts';
import { startFakeLlm } from './lib/fake-llm.ts';
import { type FixtureManifest, perfOutDir, readManifest } from './lib/manifest.ts';
import { assertNoRepositoryDotenv, bindPerfDatabase, REPO_ROOT } from './lib/safety.ts';
import { type Distribution, distribution, median, round2 } from './lib/stats.ts';

const database = bindPerfDatabase();
process.env.OPENLINEAR_SLOW_QUERY_MS = 'off';
assertNoRepositoryDotenv();

const { values: flags } = parseArgs({
  // `pnpm perf:x -- --flag` may forward the separator itself.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    label: { type: 'string' },
    rounds: { type: 'string' },
    iterations: { type: 'string' },
    only: { type: 'string' },
    out: { type: 'string' },
  },
  allowPositionals: true,
});

const LABEL = (flags.label ?? process.env.PERF_LABEL ?? 'baseline').replace(/[^A-Za-z0-9_.-]/g, '-');
const ROUNDS = Number.parseInt(flags.rounds ?? process.env.PERF_ROUNDS ?? '3', 10);
const ITERATIONS = Number.parseInt(flags.iterations ?? process.env.PERF_ITERATIONS ?? '100', 10);
const ONLY = (flags.only ?? process.env.PERF_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const REPORT_DIR = resolve(REPO_ROOT, flags.out ?? process.env.PERF_REPORT_DIR ?? 'docs/reports/perf-baseline-2026-10-26');
const API_PORT = Number.parseInt(process.env.PERF_API_PORT ?? '5050', 10);
const FAKE_LLM_PORT = Number.parseInt(process.env.PERF_FAKE_LLM_PORT ?? '5051', 10);
const WARMUP = Number.parseInt(process.env.PERF_WARMUP ?? '10', 10);
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_ENTRY = resolve(REPO_ROOT, 'apps/api/dist/index.js');
const INSTRUMENTATION = process.env.PERF_INSTRUMENTATION ?? 'sample';
if (!['sample', 'prod', 'off'].includes(INSTRUMENTATION)) throw new Error('PERF_INSTRUMENTATION must be sample, prod or off');
const instrumentationEnv: Record<string, string> =
  INSTRUMENTATION === 'off'
    ? { OPENLINEAR_ROUTE_TIMING: 'off', OPENLINEAR_SLOW_QUERY_MS: 'off' }
    : INSTRUMENTATION === 'prod'
      ? {}
      : { OPENLINEAR_ROUTE_TIMING_SAMPLE: '1', OPENLINEAR_SLOW_QUERY_MS: process.env.PERF_SLOW_QUERY_MS ?? '100' };

function log(message: string): void {
  process.stdout.write(`[perf:bench] ${message}\n`);
}

// ─── Fixture + credentials ───────────────────────────────────────────────────

const manifest: FixtureManifest = readManifest(database.database);
if (!manifest.credentials) throw new Error('Fixture has no credentials; run `pnpm perf:seed -- --tokens-only`.');
const credentials: NonNullable<FixtureManifest['credentials']> = manifest.credentials;
const mintedAgeHours = (Date.now() - Date.parse(credentials.mintedAt)) / 3_600_000;
if (mintedAgeHours > 11) {
  throw new Error(`Bench credentials are ${mintedAgeHours.toFixed(1)} h old; run \`pnpm perf:seed -- --tokens-only\`.`);
}
const users = credentials.users;
if (!existsSync(API_ENTRY)) {
  throw new Error('apps/api/dist/index.js is missing; run `pnpm --filter @openlinear/api build` first.');
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

type Auth = 'jwt' | 'pat';
interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  auth?: Auth;
}
interface Scenario {
  name: string;
  group: string;
  description: string;
  iterations: number;
  warmup?: number;
  /** Requests in flight at once (default 1). */
  concurrency?: number;
  /**
   * Always use this bench user (0 = perf-owner). Default: rotate across all
   * 16. The owner carries the heavy personal volumes (4,000 notifications,
   * 20,000 MCP calls); the other bench users have 300 and 0, so rotating
   * mixes a light p50 with an owner-driven p95.
   */
  pinUser?: number;
  /** Build request `i` for user `userIndex`. */
  build: (i: number, userIndex: number) => RequestSpec;
  kind?: 'json' | 'chat' | 'fanout';
}

const large = manifest.projects.large;
const medium = manifest.projects.medium;
const small = manifest.projects.small;
const ws = manifest.workspaces.primary;
const detail = manifest.detailTaskIds;
const PROJECT_FIELDS = 'id,workspaceId,key,name,description,status,color,icon,targetDate,repoUrl,localPath,repositoryId,teams,_count';
// perf1: a keyset cursor half-way back through the fixture's activity history
// (15 days before the anchor). Builds without the cursor param ignore it.
const ACTIVITY_MID_CURSOR = Buffer.from(
  `${new Date(Date.parse(manifest.anchor) - 15 * 86_400_000).toISOString()}|ffffffff-ffff-ffff-ffff-ffffffffffff`,
  'utf8',
).toString('base64url');

const scenarios: Scenario[] = [
  // App shell (first paint of the authenticated app).
  { name: 'shell.me', group: 'app-shell', description: 'GET /api/auth/me', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/auth/me' }) },
  { name: 'shell.workspaces', group: 'app-shell', description: 'GET /api/workspaces', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/workspaces' }) },
  { name: 'shell.projects.ui-fields', group: 'app-shell', description: 'GET /api/projects?workspaceId&fields=<UI list fields>', iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/projects?workspaceId=${ws}&fields=${PROJECT_FIELDS}` }) },
  { name: 'shell.projects.default', group: 'app-shell', description: 'GET /api/projects (default projection)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/projects' }) },
  { name: 'shell.teams.ui-fields', group: 'app-shell', description: 'GET /api/teams?workspaceId&fields=id,name,color,projectId', iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/teams?workspaceId=${ws}&fields=id,name,color,projectId` }) },
  { name: 'shell.workspace-structure', group: 'app-shell', description: 'GET /api/workspaces/:id/structure', iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/workspaces/${ws}/structure` }) },
  { name: 'shell.workspace-structure.summary', group: 'app-shell', description: 'GET /api/workspaces/:id/structure?view=summary (perf1; older builds ignore view)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/workspaces/${ws}/structure?view=summary` }) },
  // Board.
  { name: 'board.project-large', group: 'board', description: `GET /api/tasks?projectId (${large.tasks} tasks)&pageSize=200`, iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/tasks?pageSize=200&projectId=${large.id}` }) },
  { name: 'board.project-large.pat', group: 'board', description: 'same, authenticated with a PAT (MCP/API client path)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/tasks?pageSize=200&projectId=${large.id}`, auth: 'pat' }) },
  { name: 'board.project-medium', group: 'board', description: `GET /api/tasks?projectId (${medium.tasks} tasks)&pageSize=200`, iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/tasks?pageSize=200&projectId=${medium.id}` }) },
  { name: 'board.project-small', group: 'board', description: `GET /api/tasks?projectId (${small.tasks} tasks)&pageSize=200`, iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/tasks?pageSize=200&projectId=${small.id}` }) },
  { name: 'board.team', group: 'board', description: 'GET /api/tasks?teamId&pageSize=200 (team board)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/tasks?pageSize=200&teamId=${manifest.teamId}` }) },
  { name: 'board.all', group: 'board', description: 'GET /api/tasks?pageSize=200 (no filter: every visible task)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/tasks?pageSize=200' }) },
  { name: 'board.my-issues', group: 'board', description: 'GET /api/tasks?assignee=me&pageSize=200', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/tasks?pageSize=200&assignee=me' }) },
  { name: 'board.deep-page', group: 'board', description: 'GET /api/tasks?projectId (large)&pageSize=50&page=100 (OFFSET 4950)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/tasks?pageSize=50&page=100&projectId=${large.id}` }) },
  { name: 'board.archived', group: 'board', description: 'GET /api/tasks/archived?pageSize=50', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/tasks/archived?pageSize=50' }) },
  // Task detail.
  { name: 'task.get', group: 'task', description: 'GET /api/tasks/:id', iterations: ITERATIONS, build: (i) => ({ method: 'GET', path: `/api/tasks/${detail[i % detail.length]}` }) },
  { name: 'task.comments', group: 'task', description: 'GET /api/tasks/:id/comments', iterations: ITERATIONS, build: (i) => ({ method: 'GET', path: `/api/tasks/${detail[i % detail.length]}/comments` }) },
  { name: 'task.patch', group: 'task', description: 'PATCH /api/tasks/:id {priority}', iterations: ITERATIONS, build: (i) => ({ method: 'PATCH', path: `/api/tasks/${detail[i % detail.length]}`, body: { priority: i % 2 === 0 ? 'high' : 'medium' } }) },
  // Search (user-keyed limiter: 30/min/user; rotate users).
  { name: 'search.common', group: 'search', description: `GET /api/search?q=${manifest.search.common} (~4% of titles)`, iterations: Math.min(ITERATIONS, 60), build: () => ({ method: 'GET', path: `/api/search?q=${manifest.search.common}` }) },
  { name: 'search.rare', group: 'search', description: `GET /api/search?q=${manifest.search.rare} (12 titles)`, iterations: Math.min(ITERATIONS, 60), build: () => ({ method: 'GET', path: `/api/search?q=${manifest.search.rare}` }) },
  { name: 'search.identifier', group: 'search', description: `GET /api/search?q=${manifest.search.identifier}`, iterations: Math.min(ITERATIONS, 60), build: () => ({ method: 'GET', path: `/api/search?q=${manifest.search.identifier}` }) },
  { name: 'search.no-match', group: 'search', description: 'GET /api/search?q=<no match>', iterations: Math.min(ITERATIONS, 60), build: () => ({ method: 'GET', path: `/api/search?q=${manifest.search.none}` }) },
  // Inbox and notifications.
  { name: 'inbox.list', group: 'inbox', description: 'GET /api/inbox?pageSize=50', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/inbox?pageSize=50' }) },
  { name: 'inbox.count', group: 'inbox', description: 'GET /api/inbox/count', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/inbox/count' }) },
  { name: 'notifications.page', group: 'notifications', description: 'GET /api/notifications?pageSize=100 (inbox page)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/notifications?pageSize=100' }) },
  { name: 'notifications.page.owner', group: 'notifications', description: 'GET /api/notifications?pageSize=100 as perf-owner (4,000 notifications)', iterations: ITERATIONS, pinUser: 0, build: () => ({ method: 'GET', path: '/api/notifications?pageSize=100' }) },
  { name: 'notifications.badge', group: 'notifications', description: 'GET /api/notifications?pageSize=1 (sidebar badge)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/notifications?pageSize=1' }) },
  // Dashboard, usage, activity.
  { name: 'dashboard.tasks', group: 'dashboard', description: 'GET /api/dashboard/tasks', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/dashboard/tasks' }) },
  { name: 'dashboard.projects', group: 'dashboard', description: 'GET /api/dashboard/projects', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/dashboard/projects' }) },
  { name: 'usage.summary', group: 'usage', description: 'GET /api/usage/summary (30-day window)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/usage/summary' }) },
  { name: 'usage.by-task', group: 'usage', description: 'GET /api/usage/by-task?sort=cost', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/usage/by-task?sort=cost&pageSize=25' }) },
  { name: 'usage.mcp', group: 'usage', description: 'GET /api/mcp/usage', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/mcp/usage' }) },
  { name: 'usage.mcp.owner', group: 'usage', description: 'GET /api/mcp/usage as perf-owner (20,000 MCP calls)', iterations: ITERATIONS, pinUser: 0, build: () => ({ method: 'GET', path: '/api/mcp/usage' }) },
  { name: 'activity.feed', group: 'activity', description: 'GET /api/activity?pageSize=50 (scoped feed)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/activity?pageSize=50' }) },
  { name: 'activity.project', group: 'activity', description: 'GET /api/activity?projectId (large)&pageSize=50', iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/activity?pageSize=50&projectId=${large.id}` }) },
  { name: 'activity.feed.deep-offset', group: 'activity', description: 'GET /api/activity?pageSize=50&page=200 (OFFSET 9,950)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: '/api/activity?pageSize=50&page=200' }) },
  { name: 'activity.feed.cursor', group: 'activity', description: 'GET /api/activity?pageSize=50&cursor=<15 days back> (keyset page, perf1; older builds ignore cursor)', iterations: ITERATIONS, build: () => ({ method: 'GET', path: `/api/activity?pageSize=50&cursor=${ACTIVITY_MID_CURSOR}` }) },
  // Bulk moves.
  { name: 'bulk.status-100', group: 'bulk', description: 'PATCH /api/tasks/bulk-status, 100 tasks (one request)', iterations: 20, warmup: 2, build: (i) => ({ method: 'PATCH', path: '/api/tasks/bulk-status', body: { projectId: large.id, status: i % 2 === 0 ? 'in_progress' : 'todo', taskIds: manifest.bulkMoveTaskIds } }) },
  { name: 'bulk.fanout-100', group: 'bulk', description: '100 x PATCH /api/tasks/:id {status}, 6 in flight (what the board sends today)', iterations: 5, warmup: 1, kind: 'fanout', build: (i) => ({ method: 'PATCH', path: '', body: { status: i % 2 === 0 ? 'in_progress' : 'todo' } }) },
  // Chat streaming against the fake provider.
  { name: 'chat.stream', group: 'chat', description: 'POST /api/chat/sessions/:id/messages (fake provider, 0 ms model latency)', iterations: 20, warmup: 2, kind: 'chat', build: (_i, u) => ({ method: 'POST', path: `/api/chat/sessions/${manifest.chatSessions[users[u].id]}/messages`, body: { content: 'Summarise the board for me.' } }) },
  // Concurrency.
  { name: 'concurrent8.board-large', group: 'concurrency', description: 'board.project-large with 8 in flight', iterations: 160, concurrency: 8, build: () => ({ method: 'GET', path: `/api/tasks?pageSize=200&projectId=${large.id}` }) },
  { name: 'concurrent8.inbox-count', group: 'concurrency', description: 'inbox.count with 8 in flight', iterations: 160, concurrency: 8, build: () => ({ method: 'GET', path: '/api/inbox/count' }) },
];

const selected = ONLY.length ? scenarios.filter((s) => ONLY.some((prefix) => s.name.startsWith(prefix))) : scenarios;

// ─── HTTP ────────────────────────────────────────────────────────────────────

let ipCounter = 0;
function syntheticIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

interface Sample {
  ms: number;
  ttfbMs: number;
  status: number;
  bytes: number;
  requestId: string;
  /** chat only */
  firstEventMs?: number;
  firstDeltaMs?: number;
}

async function send(spec: RequestSpec, userIndex: number, requestId: string): Promise<Sample> {
  const token = spec.auth === 'pat' ? credentials.pat.token : users[userIndex].accessToken;
  const started = performance.now();
  const res = await fetch(`${BASE}${spec.path}`, {
    method: spec.method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-request-id': requestId,
      'x-forwarded-for': syntheticIp(),
      ...(spec.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
  });
  const ttfbMs = performance.now() - started;
  const body = await res.arrayBuffer();
  return { ms: performance.now() - started, ttfbMs, status: res.status, bytes: body.byteLength, requestId };
}

async function sendChat(spec: RequestSpec, userIndex: number, requestId: string): Promise<Sample> {
  const started = performance.now();
  const res = await fetch(`${BASE}${spec.path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${users[userIndex].accessToken}`,
      'x-request-id': requestId,
      'x-forwarded-for': syntheticIp(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(spec.body),
  });
  const ttfbMs = performance.now() - started;
  let firstEventMs: number | undefined;
  let firstDeltaMs: number | undefined;
  let bytes = 0;
  let text = '';
  if (res.body) {
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (firstEventMs === undefined && text.includes('event: ')) firstEventMs = performance.now() - started;
      if (firstDeltaMs === undefined && text.includes('event: assistant_delta')) firstDeltaMs = performance.now() - started;
    }
  }
  const ok = res.status === 200 && text.includes('event: done') && !text.includes('event: error');
  return { ms: performance.now() - started, ttfbMs, status: ok ? res.status : res.status === 200 ? 599 : res.status, bytes, requestId, firstEventMs, firstDeltaMs };
}

async function sendFanout(spec: RequestSpec, userIndex: number, requestId: string): Promise<Sample & { inner: Sample[] }> {
  const ids = manifest.fanoutMoveTaskIds;
  const inner: Sample[] = [];
  let cursor = 0;
  const started = performance.now();
  const worker = async () => {
    while (cursor < ids.length) {
      const k = cursor;
      cursor += 1;
      inner.push(await send({ method: 'PATCH', path: `/api/tasks/${ids[k]}`, body: spec.body }, userIndex, `${requestId}-${k}`));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const failed = inner.filter((s) => s.status >= 400).length;
  return {
    ms: performance.now() - started,
    ttfbMs: 0,
    status: failed > 0 ? 500 : 200,
    bytes: inner.reduce((sum, s) => sum + s.bytes, 0),
    requestId,
    inner,
  };
}

// ─── API process ─────────────────────────────────────────────────────────────

const logDir = perfOutDir();
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const apiLogPath = resolve(logDir, `api-${LABEL}.log`);

async function startApi(llmUrl: string): Promise<ChildProcess> {
  const { openSync } = await import('node:fs');
  const out = openSync(apiLogPath, 'w', 0o600);
  const child = spawn(process.execPath, [API_ENTRY], {
    cwd: resolve(REPO_ROOT, 'apps/api'),
    stdio: ['ignore', out, out],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      NODE_ENV: 'production',
      API_PORT: String(API_PORT),
      DATABASE_URL: database.url,
      JWT_SECRET: credentials.jwtSecret,
      TOKEN_ENCRYPTION_KEY: credentials.tokenEncryptionKey,
      LOG_LEVEL: 'info',
      CORS_ORIGIN: 'http://127.0.0.1:3000',
      OPENLINEAR_JOBS_RUNNER: 'worker',
      ...instrumentationEnv,
      CHAT_LLM_BASE_URL: llmUrl,
      CHAT_LLM_API_KEY: 'perf-fake-provider',
      CHAT_LLM_MODEL: 'perf-fake',
    },
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited with ${child.exitCode}; see ${apiLogPath}`);
    try {
      const res = await fetch(`${BASE}/readyz`);
      if (res.ok) return child;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  child.kill('SIGTERM');
  throw new Error(`API did not become ready in 30 s; see ${apiLogPath}`);
}

async function stopApi(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(15_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

// ─── Server-side log join ────────────────────────────────────────────────────

interface ServerLine {
  durationMs: number;
  queries: number;
  queryMs: number;
  route: string;
  status: number;
}
interface SlowQueryLine {
  fingerprint: string;
  route?: string;
  durationMs: number;
  sql: string;
}

async function readApiLog(): Promise<{ timing: Map<string, ServerLine>; slow: SlowQueryLine[] }> {
  const timing = new Map<string, ServerLine>();
  const slow: SlowQueryLine[] = [];
  const lines = createInterface({ input: createReadStream(apiLogPath, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.startsWith('{')) continue;
    if (!line.includes('"evt":"route_timing"') && !line.includes('"evt":"slow_query"')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.evt === 'route_timing' && typeof parsed.requestId === 'string') {
      timing.set(parsed.requestId, {
        durationMs: Number(parsed.durationMs),
        queries: Number(parsed.queries),
        queryMs: Number(parsed.queryMs),
        route: String(parsed.route),
        status: Number(parsed.status),
      });
    } else if (parsed.evt === 'slow_query') {
      slow.push({
        fingerprint: String(parsed.fingerprint),
        route: typeof parsed.route === 'string' ? parsed.route : undefined,
        durationMs: Number(parsed.durationMs),
        sql: String(parsed.sql).slice(0, 700),
      });
    }
  }
  return { timing, slow };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

interface RoundResult {
  round: number;
  client: Distribution;
  ttfb: Distribution;
  server: Distribution;
  queries: { mean: number; max: number; min: number };
  queryMs: Distribution;
  bytes: { mean: number; max: number };
  statuses: Record<string, number>;
  errors: number;
  firstEvent?: Distribution;
  firstDelta?: Distribution;
  /** fan-out only: the 100 inner PATCH requests */
  inner?: Distribution;
  innerServer?: Distribution;
  innerQueries?: { mean: number; max: number; total: number };
  samplesMs: number[];
  wallMs: number;
  throughputRps: number;
}

const loadSamples: number[] = [];
const loadTimer = setInterval(() => loadSamples.push(loadavg()[0]), 5_000);
loadTimer.unref();

async function runScenario(scenario: Scenario, round: number): Promise<{ samples: Array<Sample & { inner?: Sample[] }>; wallMs: number }> {
  const warmup = scenario.warmup ?? WARMUP;
  const concurrency = scenario.concurrency ?? 1;
  const exec = (i: number, phase: 'w' | 'm'): Promise<Sample & { inner?: Sample[] }> => {
    const userIndex = scenario.pinUser ?? i % users.length;
    const spec = scenario.build(i, userIndex);
    const requestId = `perf-${LABEL}-r${round}-${scenario.name}-${phase}${i}`;
    if (scenario.kind === 'chat') return sendChat(spec, userIndex, requestId);
    if (scenario.kind === 'fanout') return sendFanout(spec, userIndex, requestId);
    return send(spec, userIndex, requestId);
  };
  for (let i = 0; i < warmup; i += 1) await exec(i, 'w');
  const samples: Array<Sample & { inner?: Sample[] }> = [];
  const started = performance.now();
  let next = 0;
  const worker = async () => {
    while (next < scenario.iterations) {
      const i = next;
      next += 1;
      samples.push(await exec(warmup + i, 'm'));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { samples, wallMs: performance.now() - started };
}

function summarizeRound(
  round: number,
  scenario: Scenario,
  run: { samples: Array<Sample & { inner?: Sample[] }>; wallMs: number },
  timing: Map<string, ServerLine>,
): RoundResult {
  const ok = run.samples.filter((s) => s.status < 400);
  const statuses: Record<string, number> = {};
  for (const s of run.samples) statuses[s.status] = (statuses[s.status] ?? 0) + 1;
  const server = ok.map((s) => timing.get(s.requestId)).filter((line): line is ServerLine => line !== undefined);
  const queries = server.map((line) => line.queries);
  const result: RoundResult = {
    round,
    client: distribution(ok.map((s) => s.ms)),
    ttfb: distribution(ok.map((s) => s.ttfbMs)),
    server: distribution(server.map((line) => line.durationMs)),
    queries: {
      mean: queries.length ? round2(queries.reduce((a, b) => a + b, 0) / queries.length) : 0,
      max: queries.length ? Math.max(...queries) : 0,
      min: queries.length ? Math.min(...queries) : 0,
    },
    queryMs: distribution(server.map((line) => line.queryMs)),
    bytes: {
      mean: ok.length ? Math.round(ok.reduce((a, s) => a + s.bytes, 0) / ok.length) : 0,
      max: ok.length ? Math.max(...ok.map((s) => s.bytes)) : 0,
    },
    statuses,
    errors: run.samples.length - ok.length,
    samplesMs: run.samples.map((s) => round2(s.ms)),
    wallMs: round2(run.wallMs),
    throughputRps: round2((run.samples.length / run.wallMs) * 1000),
  };
  if (scenario.kind === 'chat') {
    result.firstEvent = distribution(ok.map((s) => s.firstEventMs ?? s.ms));
    result.firstDelta = distribution(ok.map((s) => s.firstDeltaMs ?? s.ms));
  }
  if (scenario.kind === 'fanout') {
    const inner = run.samples.flatMap((s) => s.inner ?? []);
    const innerServer = inner.map((s) => timing.get(s.requestId)).filter((line): line is ServerLine => line !== undefined);
    const innerQueries = innerServer.map((line) => line.queries);
    result.inner = distribution(inner.map((s) => s.ms));
    result.innerServer = distribution(innerServer.map((line) => line.durationMs));
    result.innerQueries = {
      mean: innerQueries.length ? round2(innerQueries.reduce((a, b) => a + b, 0) / innerQueries.length) : 0,
      max: innerQueries.length ? Math.max(...innerQueries) : 0,
      total: innerQueries.reduce((a, b) => a + b, 0),
    };
    // Per fan-out: total queries across its 100 requests.
    result.queries = { mean: round2((result.innerQueries.total / Math.max(1, run.samples.length))), max: result.queries.max, min: result.queries.min };
  }
  return result;
}

async function environment() {
  const [version] = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
  const settings = await prisma.$queryRaw<Array<{ name: string; setting: string; unit: string | null }>>`
    SELECT name, setting, unit FROM pg_settings
    WHERE name IN ('shared_buffers','work_mem','effective_cache_size','random_page_cost','max_connections','jit')`;
  const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('tasks','activity_logs','linear_projects','teams') ORDER BY indexname`;
  const cpu = cpus();
  const bundle = statSync(API_ENTRY);
  return {
    host: { platform: platform(), release: release(), arch: arch(), cpu: cpu[0]?.model ?? 'unknown', cores: cpu.length, memoryGiB: round2(totalmem() / 2 ** 30) },
    node: process.version,
    postgres: version.version,
    postgresSettings: Object.fromEntries(settings.map((s) => [s.name, s.unit ? `${s.setting} ${s.unit}` : s.setting])),
    apiBundle: { path: 'apps/api/dist/index.js', bytes: bundle.size, mtime: bundle.mtime.toISOString() },
    hotPathIndexes: indexes.map((i) => i.indexname),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const env = await environment();
log(`fixture ${manifest.database} (${manifest.counts.tasks} tasks); ${selected.length} scenarios x ${ROUNDS} rounds; label ${LABEL}`);
const llm = await startFakeLlm(FAKE_LLM_PORT, Number.parseInt(process.env.PERF_FAKE_LLM_DELAY_MS ?? '0', 10));
const api = await startApi(llm.url);
log(`API up on ${BASE} (log ${apiLogPath})`);

const runs: Array<{ round: number; scenario: Scenario; run: { samples: Array<Sample & { inner?: Sample[] }>; wallMs: number } }> = [];
const rounds: Array<{ round: number; loadBefore: number[]; loadAfter: number[]; seconds: number }> = [];
try {
  for (let round = 1; round <= ROUNDS; round += 1) {
    const loadBefore = loadavg().map(round2);
    const started = performance.now();
    for (const scenario of selected) {
      const run = await runScenario(scenario, round);
      runs.push({ round, scenario, run });
      const ok = run.samples.filter((s) => s.status < 400).length;
      log(`round ${round} ${scenario.name}: ${ok}/${run.samples.length} ok, p95 ${distribution(run.samples.map((s) => s.ms)).p95} ms`);
    }
    rounds.push({ round, loadBefore, loadAfter: loadavg().map(round2), seconds: round2((performance.now() - started) / 1000) });
  }
} finally {
  await stopApi(api);
  await llm.close();
  clearInterval(loadTimer);
}

const { timing, slow } = await readApiLog();

interface ScenarioReport {
  name: string;
  group: string;
  description: string;
  iterationsPerRound: number;
  concurrency: number;
  rounds: RoundResult[];
  aggregate: {
    p50: number;
    p95: number;
    p99: number;
    p95Spread: [number, number];
    serverP50: number;
    serverP95: number;
    serverP99: number;
    ttfbP95: number;
    queriesMean: number;
    queriesMax: number;
    bytesMean: number;
    errors: number;
    n: number;
    firstEventP95?: number;
    firstDeltaP95?: number;
    innerP95?: number;
    innerServerP95?: number;
  };
}

const reports: ScenarioReport[] = selected.map((scenario) => {
  const roundResults = runs
    .filter((r) => r.scenario.name === scenario.name)
    .map((r) => summarizeRound(r.round, scenario, r.run, timing));
  const p95s = roundResults.map((r) => r.client.p95);
  return {
    name: scenario.name,
    group: scenario.group,
    description: scenario.description,
    iterationsPerRound: scenario.iterations,
    concurrency: scenario.concurrency ?? 1,
    rounds: roundResults,
    aggregate: {
      p50: median(roundResults.map((r) => r.client.p50)),
      p95: median(p95s),
      p99: median(roundResults.map((r) => r.client.p99)),
      p95Spread: [Math.min(...p95s), Math.max(...p95s)],
      serverP50: median(roundResults.map((r) => r.server.p50)),
      serverP95: median(roundResults.map((r) => r.server.p95)),
      serverP99: median(roundResults.map((r) => r.server.p99)),
      ttfbP95: median(roundResults.map((r) => r.ttfb.p95)),
      queriesMean: median(roundResults.map((r) => r.queries.mean)),
      queriesMax: Math.max(...roundResults.map((r) => r.queries.max)),
      bytesMean: median(roundResults.map((r) => r.bytes.mean)),
      errors: roundResults.reduce((sum, r) => sum + r.errors, 0),
      n: roundResults.reduce((sum, r) => sum + r.client.n, 0),
      ...(scenario.kind === 'chat'
        ? {
            firstEventP95: median(roundResults.map((r) => r.firstEvent?.p95 ?? 0)),
            firstDeltaP95: median(roundResults.map((r) => r.firstDelta?.p95 ?? 0)),
          }
        : {}),
      ...(scenario.kind === 'fanout'
        ? {
            innerP95: median(roundResults.map((r) => r.inner?.p95 ?? 0)),
            innerServerP95: median(roundResults.map((r) => r.innerServer?.p95 ?? 0)),
          }
        : {}),
    },
  };
});

// Slow queries grouped by statement.
const slowGroups = new Map<string, { fingerprint: string; count: number; routes: Set<string>; durations: number[]; sql: string }>();
for (const line of slow) {
  const group = slowGroups.get(line.fingerprint) ?? { fingerprint: line.fingerprint, count: 0, routes: new Set<string>(), durations: [], sql: line.sql };
  group.count += 1;
  if (line.route) group.routes.add(line.route);
  group.durations.push(line.durationMs);
  slowGroups.set(line.fingerprint, group);
}
const slowQueries = [...slowGroups.values()]
  .map((g) => ({ fingerprint: g.fingerprint, count: g.count, routes: [...g.routes], ...distribution(g.durations), sql: g.sql }))
  .sort((a, b) => b.count * b.p50 - a.count * a.p50)
  .slice(0, 40);

const output = {
  label: LABEL,
  generatedAt: new Date().toISOString(),
  method: {
    target: `apps/api/dist/index.js, NODE_ENV=production, LOG_LEVEL=info, instrumentation=${INSTRUMENTATION} ${JSON.stringify(instrumentationEnv)}`,
    client: 'Node fetch (undici) on loopback; one keep-alive pool; latency = request start to last body byte',
    rounds: ROUNDS,
    warmupPerScenario: WARMUP,
    percentiles: 'nearest-rank over raw samples; aggregate = median across rounds; spread = min..max of per-round p95',
    rateLimits: 'distinct X-Forwarded-For per request; requests rotate across 16 bench users with identical memberships',
    caveat: 'Descriptive baseline on one laptop with other workloads running; not an SLA claim.',
  },
  environment: env,
  load: {
    rounds,
    oneMinuteLoadSampled: distribution(loadSamples),
  },
  fixture: { database: manifest.database, anchor: manifest.anchor, seed: manifest.seed, counts: manifest.counts, large: large.tasks, medium: medium.tasks, small: small.tasks },
  scenarios: reports,
  slowQueries,
  fakeLlmRequests: llm.requests(),
};

mkdirSync(REPORT_DIR, { recursive: true });
const jsonPath = resolve(REPORT_DIR, `bench-${LABEL}.json`);
writeFileSync(jsonPath, `${JSON.stringify(output, null, 1)}\n`);

const md: string[] = [];
md.push(`# API benchmark: ${LABEL}`, '');
md.push(`Generated ${output.generatedAt} by \`scripts/perf/bench.ts\`. Raw data: \`bench-${LABEL}.json\`.`, '');
md.push(
  `Host: ${env.host.cpu}, ${env.host.cores} cores, ${env.host.memoryGiB} GiB, ${env.host.platform} ${env.host.release}; Node ${env.node}; ${env.postgres.split(',')[0]}.`,
  `Load (1-min avg) sampled every 5 s during the run: mean ${output.load.oneMinuteLoadSampled.mean}, max ${output.load.oneMinuteLoadSampled.max}. Other engineers' test suites were running on the same machine.`,
  `Fixture: ${manifest.counts.tasks} tasks (large project ${large.tasks}, medium ${medium.tasks}, small ${small.tasks}), ${manifest.counts.activity_logs} activity rows, ${manifest.counts.comments} comments.`,
  `Rounds: ${ROUNDS}; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.`,
  '',
);
md.push('| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |');
md.push('|---|---:|---:|---:|---:|---|---:|---:|---:|---:|');
for (const r of reports) {
  const a = r.aggregate;
  const serverP95 = r.name === 'bulk.fanout-100' ? '—' : String(a.serverP95);
  const queries = r.name === 'bulk.fanout-100' ? `${a.queriesMean} per move` : `${a.queriesMean} (${a.queriesMax})`;
  md.push(
    `| ${r.name} | ${a.n} | ${a.p50} | ${a.p95} | ${a.p99} | ${a.p95Spread[0]}–${a.p95Spread[1]} | ${serverP95} | ${queries} | ${a.bytesMean} | ${a.errors} |`,
  );
}
md.push('');
const chat = reports.find((r) => r.name === 'chat.stream');
if (chat) {
  md.push(`Chat stream (fake provider): headers p95 ${chat.aggregate.ttfbP95} ms, first SSE event p95 ${chat.aggregate.firstEventP95} ms, first assistant delta p95 ${chat.aggregate.firstDeltaP95} ms, full turn p95 ${chat.aggregate.p95} ms.`, '');
}
const fanout = reports.find((r) => r.name === 'bulk.fanout-100');
if (fanout) {
  md.push(
    `Fan-out: one 100-task move = 100 PATCH requests (6 in flight); per-request client p95 ${fanout.aggregate.innerP95} ms, server p95 ${fanout.aggregate.innerServerP95} ms; ${fanout.aggregate.queriesMean} queries per move.`,
    '',
  );
}
md.push('## Slowest statements (server log, threshold 100 ms)', '');
md.push('| fingerprint | count | p50 ms | max ms | routes |', '|---|---:|---:|---:|---|');
for (const q of slowQueries.slice(0, 15)) md.push(`| ${q.fingerprint} | ${q.count} | ${q.p50} | ${q.max} | ${q.routes.join(', ')} |`);
md.push('');
writeFileSync(resolve(REPORT_DIR, `bench-${LABEL}.md`), `${md.join('\n')}\n`);
log(`wrote ${jsonPath}`);
await prisma.$disconnect();
