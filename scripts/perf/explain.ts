/**
 * EXPLAIN (ANALYZE, BUFFERS) baselines for the hot read routes.
 *
 *   PERF_DATABASE_URL=... pnpm perf:explain -- --label baseline
 *
 * Boots `createApp()` in-process against the perf database with a Prisma
 * client that records each statement's SQL and bound values IN MEMORY, calls
 * each route twice as the bench owner (the first call warms the auth/tenancy
 * caches; the second is the steady-state path), then re-runs every SELECT
 * from the second call under EXPLAIN (ANALYZE, BUFFERS). Writes one text file
 * per route plus a JSON digest (statement count, DB time, seq scans, plan
 * execution time) under docs/reports/perf-baseline-2026-10-26/explain/<label>/.
 *
 * Bound values are fixture ids and constants of the synthetic dataset; they
 * appear in the plan text the way Postgres prints custom plans. Writes
 * (PATCH/bulk) are listed with their statement count but never EXPLAIN
 * ANALYZEd, because that would execute them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PrismaClient, type Prisma } from '../../packages/db/src/index.ts';
import { readManifest } from './lib/manifest.ts';
import { bindPerfDatabase, REPO_ROOT } from './lib/safety.ts';
import { round2 } from './lib/stats.ts';

const database = bindPerfDatabase();
const { values: flags } = parseArgs({
  // `pnpm perf:x -- --flag` may forward the separator itself.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { label: { type: 'string' }, out: { type: 'string' } },
  allowPositionals: true,
});
const LABEL = (flags.label ?? process.env.PERF_LABEL ?? 'baseline').replace(/[^A-Za-z0-9_.-]/g, '-');
const OUT = resolve(REPO_ROOT, flags.out ?? 'docs/reports/perf-baseline-2026-10-26', 'explain', LABEL);

const manifest = readManifest(database.database);
if (!manifest.credentials) throw new Error('Fixture has no credentials; run `pnpm perf:seed -- --tokens-only`.');
const credentials = manifest.credentials;

// The app under test reads these at request time.
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.JWT_SECRET = credentials.jwtSecret;
process.env.TOKEN_ENCRYPTION_KEY = credentials.tokenEncryptionKey;
process.env.OPENLINEAR_ROUTE_TIMING = 'off';

// ─── Capturing client, installed as the app's singleton ──────────────────────

type AdapterFactory = NonNullable<Prisma.PrismaClientOptions['adapter']>;
const requireFromDb = createRequire(resolve(REPO_ROOT, 'packages/db/package.json'));
const { PrismaPg } = requireFromDb('@prisma/adapter-pg') as {
  PrismaPg: new (config: { connectionString: string }) => AdapterFactory;
};

interface Captured {
  sql: string;
  params: unknown[];
  durationMs: number;
}
let capturing = false;
let captured: Captured[] = [];
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: database.url }),
  log: [{ emit: 'event', level: 'query' }],
});
client.$on('query', (event) => {
  if (!capturing) return;
  let params: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(event.params);
    if (Array.isArray(parsed)) params = parsed;
  } catch {
    params = [];
  }
  captured.push({ sql: event.query, params, durationMs: event.duration });
});
(globalThis as { prisma?: unknown }).prisma = client;

const { createApp } = await import('../../apps/api/src/app.ts');

// ─── Targets ─────────────────────────────────────────────────────────────────

const large = manifest.projects.large;
interface Target {
  name: string;
  method: 'GET' | 'PATCH';
  path: string;
  body?: unknown;
  /** Writes: body for the measured (second) call, so it changes state again. */
  warmBody?: unknown;
}
const targets: Target[] = [
  { name: 'board.project-large', method: 'GET', path: `/api/tasks?pageSize=200&projectId=${large.id}` },
  { name: 'board.team', method: 'GET', path: `/api/tasks?pageSize=200&teamId=${manifest.teamId}` },
  { name: 'board.all', method: 'GET', path: '/api/tasks?pageSize=200' },
  { name: 'board.deep-page', method: 'GET', path: `/api/tasks?pageSize=50&page=100&projectId=${large.id}` },
  { name: 'inbox.list', method: 'GET', path: '/api/inbox?pageSize=50' },
  { name: 'inbox.count', method: 'GET', path: '/api/inbox/count' },
  { name: 'search.common', method: 'GET', path: `/api/search?q=${manifest.search.common}` },
  { name: 'search.rare', method: 'GET', path: `/api/search?q=${manifest.search.rare}` },
  { name: 'usage.summary', method: 'GET', path: '/api/usage/summary' },
  { name: 'usage.by-task', method: 'GET', path: '/api/usage/by-task?sort=cost&pageSize=25' },
  { name: 'activity.feed', method: 'GET', path: '/api/activity?pageSize=50' },
  { name: 'activity.project', method: 'GET', path: `/api/activity?pageSize=50&projectId=${large.id}` },
  { name: 'notifications.page', method: 'GET', path: '/api/notifications?pageSize=100' },
  { name: 'dashboard.tasks', method: 'GET', path: '/api/dashboard/tasks' },
  {
    name: 'task.patch',
    method: 'PATCH',
    path: `/api/tasks/${manifest.detailTaskIds[0]}`,
    body: { priority: 'high' },
    warmBody: { priority: 'low' },
  },
  {
    name: 'bulk.status-100',
    method: 'PATCH',
    path: '/api/tasks/bulk-status',
    body: { projectId: large.id, status: 'in_progress', taskIds: manifest.bulkMoveTaskIds },
    warmBody: { projectId: large.id, status: 'todo', taskIds: manifest.bulkMoveTaskIds },
  },
];

// ─── Plan digest ─────────────────────────────────────────────────────────────

interface StatementDigest {
  index: number;
  kind: 'select' | 'write' | 'control';
  requestMs: number;
  executionMs?: number;
  planningMs?: number;
  seqScans: string[];
  sharedHit?: number;
  sharedRead?: number;
  rowsRemovedByFilter: number;
  sorts: string[];
  sql: string;
}

function kindOf(sql: string): StatementDigest['kind'] {
  const head = sql.trimStart().slice(0, 12).toUpperCase();
  if (head.startsWith('SELECT') || head.startsWith('WITH')) return 'select';
  if (head.startsWith('BEGIN') || head.startsWith('COMMIT') || head.startsWith('ROLLBACK')) return 'control';
  return 'write';
}

function digestPlan(lines: string[]): Pick<StatementDigest, 'executionMs' | 'planningMs' | 'seqScans' | 'sharedHit' | 'sharedRead' | 'rowsRemovedByFilter' | 'sorts'> {
  const seqScans = new Set<string>();
  const sorts = new Set<string>();
  let rowsRemovedByFilter = 0;
  let executionMs: number | undefined;
  let planningMs: number | undefined;
  let sharedHit: number | undefined;
  let sharedRead: number | undefined;
  for (const line of lines) {
    const seq = /Seq Scan on (\S+)/.exec(line);
    if (seq) seqScans.add(seq[1]);
    const removed = /Rows Removed by Filter: (\d+)/.exec(line);
    if (removed) rowsRemovedByFilter += Number(removed[1]);
    const sort = /Sort Method: (.+)$/.exec(line.trim());
    if (sort) sorts.add(sort[1]);
    const exec = /^Execution Time: ([\d.]+) ms/.exec(line.trim());
    if (exec) executionMs = Number(exec[1]);
    const plan = /^Planning Time: ([\d.]+) ms/.exec(line.trim());
    if (plan) planningMs = Number(plan[1]);
    if (sharedHit === undefined) {
      const buffers = /Buffers: shared(?: hit=(\d+))?(?: read=(\d+))?/.exec(line);
      if (buffers) {
        sharedHit = Number(buffers[1] ?? 0);
        sharedRead = Number(buffers[2] ?? 0);
      }
    }
  }
  return { executionMs, planningMs, seqScans: [...seqScans], sharedHit, sharedRead, rowsRemovedByFilter, sorts: [...sorts] };
}

function prettySql(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/ (FROM|WHERE|LEFT JOIN|INNER JOIN|ORDER BY|GROUP BY|LIMIT|OFFSET|AND \(|OR \() /g, '\n  $1 ')
    .trim();
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const owner = credentials.users[0];

let ip = 0;
async function call(target: Target, body: unknown): Promise<number> {
  ip += 1;
  const res = await fetch(`${base}${target.path}`, {
    method: target.method,
    headers: {
      authorization: `Bearer ${owner.accessToken}`,
      'x-forwarded-for': `10.250.0.${ip % 250}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  await res.arrayBuffer();
  return res.status;
}

/** Fire-and-forget work (outbox rows, activity, PAT/session touches) lands after the response. */
const SETTLE_MS = 400;
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

mkdirSync(OUT, { recursive: true });
const summary: Array<{
  name: string;
  path: string;
  status: number;
  coldStatements: number;
  warmStatements: number;
  /** Statements issued after the response was sent (background writes). */
  afterResponseStatements: number;
  warmDbMs: number;
  statements: StatementDigest[];
}> = [];

try {
  for (const target of targets) {
    capturing = true;
    captured = [];
    await call(target, target.body); // cold: auth + tenancy caches
    await settle();
    const cold = captured.length;
    captured = [];
    const status = await call(target, target.warmBody ?? target.body);
    const warm = captured;
    const inResponse = warm.length;
    await settle();
    capturing = false;
    const afterResponse = warm.length - inResponse;

    const text: string[] = [];
    text.push(`# ${target.name}: ${target.method} ${target.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')}`);
    text.push(
      `# label=${LABEL} status=${status} statements: cold=${cold} warm=${inResponse} (+${afterResponse} after the response) fixture=${manifest.counts.tasks} tasks`,
    );
    text.push('');
    const statements: StatementDigest[] = [];
    for (let i = 0; i < warm.length; i += 1) {
      const stmt = warm[i];
      const kind = kindOf(stmt.sql);
      const digest: StatementDigest = {
        index: i + 1,
        kind,
        requestMs: round2(stmt.durationMs),
        seqScans: [],
        rowsRemovedByFilter: 0,
        sorts: [],
        sql: stmt.sql.replace(/\s+/g, ' ').slice(0, 400),
      };
      text.push(`## statement ${i + 1} (${kind}, ${round2(stmt.durationMs)} ms${i >= inResponse ? ', after the response' : ''})`);
      text.push(prettySql(stmt.sql));
      if (kind === 'select') {
        const rows = await client.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${stmt.sql}`,
          ...stmt.params,
        );
        const plan = rows.map((row) => row['QUERY PLAN']);
        Object.assign(digest, digestPlan(plan));
        text.push('', ...plan);
      }
      text.push('');
      statements.push(digest);
    }
    writeFileSync(resolve(OUT, `${target.name}.txt`), `${text.join('\n')}\n`);
    summary.push({
      name: target.name,
      path: target.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'),
      status,
      coldStatements: cold,
      warmStatements: inResponse,
      afterResponseStatements: afterResponse,
      warmDbMs: round2(warm.slice(0, inResponse).reduce((sum, s) => sum + s.durationMs, 0)),
      statements,
    });
    process.stdout.write(`[perf:explain] ${target.name}: status ${status}, ${inResponse} statements (+${afterResponse} after response; cold ${cold})\n`);
  }
} finally {
  server.close();
}

const indexes = await client.$queryRaw<Array<{ indexname: string }>>`
  SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('tasks','activity_logs','linear_projects','teams') ORDER BY indexname`;
writeFileSync(
  resolve(OUT, '..', `explain-${LABEL}.json`),
  `${JSON.stringify({ label: LABEL, generatedAt: new Date().toISOString(), fixture: manifest.counts, indexes: indexes.map((i) => i.indexname), routes: summary }, null, 1)}\n`,
);
process.stdout.write(`[perf:explain] wrote ${OUT}\n`);
await client.$disconnect();
process.exit(0);
