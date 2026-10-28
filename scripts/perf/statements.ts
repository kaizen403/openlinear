/**
 * Per-request SQL statement inventory (performance plan, Phase 1).
 *
 *   PERF_DATABASE_URL=... pnpm --filter @openlinear/api exec tsx ../../scripts/perf/statements.ts --label before
 *   ... statements.ts --label before --tenancy-cache off
 *
 * (No root `perf:*` alias on purpose: the root package.json is a merge hotspot.)
 *
 * Boots `createApp()` in-process (NODE_ENV=production) against the perf
 * database with a Prisma client that records each statement IN MEMORY, calls
 * every target three times as the bench owner (JWT) or with the bench PAT and
 * reports, per call, how many statements ran before the response, which
 * tables they touched, and which statements were exact repeats (same SQL and
 * bound values) within one request. Nothing is EXPLAINed and nothing is
 * written to the database except what the routes themselves write.
 *
 * `--tenancy-cache off` sets OPENLINEAR_TENANCY_CACHE=0, i.e. what every
 * request costs when the cross-request principal cache misses (first request
 * of a principal, after an invalidation, or under NODE_ENV=test).
 *
 * Output: docs/reports/perf-baseline-2026-10-26/phase1-statements-<label>.json
 * (and a short table on stdout). Bound values are never written.
 */
import { writeFileSync } from 'node:fs';
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
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    label: { type: 'string' },
    out: { type: 'string' },
    'tenancy-cache': { type: 'string' },
    only: { type: 'string' },
  },
  allowPositionals: true,
});
const LABEL = (flags.label ?? 'statements').replace(/[^A-Za-z0-9_.-]/g, '-');
const TENANCY_CACHE = flags['tenancy-cache'] === 'off' ? 'off' : 'on';
const ONLY = (flags.only ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = resolve(
  REPO_ROOT,
  flags.out ?? 'docs/reports/perf-baseline-2026-10-26',
  `phase1-statements-${LABEL}${TENANCY_CACHE === 'off' ? '-nocache' : ''}.json`,
);
const PORT = Number.parseInt(process.env.PERF_STATEMENTS_PORT ?? '0', 10);

const manifest = readManifest(database.database);
if (!manifest.credentials) throw new Error('Fixture has no credentials; run `pnpm perf:seed -- --tokens-only`.');
const credentials = manifest.credentials;

process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.JWT_SECRET = credentials.jwtSecret;
process.env.TOKEN_ENCRYPTION_KEY = credentials.tokenEncryptionKey;
process.env.OPENLINEAR_ROUTE_TIMING = 'off';
process.env.OPENLINEAR_SLOW_QUERY_MS = 'off';
if (TENANCY_CACHE === 'off') process.env.OPENLINEAR_TENANCY_CACHE = '0';

type AdapterFactory = NonNullable<Prisma.PrismaClientOptions['adapter']>;
const requireFromDb = createRequire(resolve(REPO_ROOT, 'packages/db/package.json'));
const { PrismaPg } = requireFromDb('@prisma/adapter-pg') as {
  PrismaPg: new (config: { connectionString: string }) => AdapterFactory;
};

interface Captured {
  sql: string;
  params: string;
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
  captured.push({ sql: event.query, params: event.params, durationMs: event.duration });
});
(globalThis as { prisma?: unknown }).prisma = client;

const { createApp } = await import('../../apps/api/src/app.ts');

interface Target {
  name: string;
  path: string;
  auth: 'jwt' | 'pat';
}
const large = manifest.projects.large;
const ws = manifest.workspaces.primary;
const task = manifest.detailTaskIds[0];
const allTargets: Target[] = [
  { name: 'activity.feed', path: '/api/activity?pageSize=50', auth: 'jwt' },
  { name: 'activity.project', path: `/api/activity?pageSize=50&projectId=${large.id}`, auth: 'jwt' },
  { name: 'activity.task', path: `/api/activity?pageSize=50&taskId=${task}`, auth: 'jwt' },
  { name: 'usage.summary', path: '/api/usage/summary', auth: 'jwt' },
  { name: 'usage.by-task', path: '/api/usage/by-task?sort=cost&pageSize=25', auth: 'jwt' },
  { name: 'dashboard.tasks', path: '/api/dashboard/tasks', auth: 'jwt' },
  { name: 'dashboard.projects', path: '/api/dashboard/projects', auth: 'jwt' },
  { name: 'inbox.list', path: '/api/inbox?pageSize=50', auth: 'jwt' },
  { name: 'inbox.count', path: '/api/inbox/count', auth: 'jwt' },
  { name: 'notifications.page', path: '/api/notifications?pageSize=100', auth: 'jwt' },
  { name: 'workspaces.list', path: '/api/workspaces', auth: 'jwt' },
  { name: 'workspace.structure', path: `/api/workspaces/${ws}/structure`, auth: 'jwt' },
  { name: 'workspace.structure.summary', path: `/api/workspaces/${ws}/structure?view=summary`, auth: 'jwt' },
  { name: 'task.get', path: `/api/tasks/${task}`, auth: 'jwt' },
  { name: 'task.get.pat', path: `/api/tasks/${task}`, auth: 'pat' },
  { name: 'task.comments', path: `/api/tasks/${task}/comments`, auth: 'jwt' },
  { name: 'board.project-large', path: `/api/tasks?pageSize=50&projectId=${large.id}`, auth: 'jwt' },
  { name: 'board.project-large.pat', path: `/api/tasks?pageSize=50&projectId=${large.id}`, auth: 'pat' },
];
const targets = ONLY.length ? allTargets.filter((t) => ONLY.some((prefix) => t.name.startsWith(prefix))) : allTargets;

const app = createApp();
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const owner = credentials.users[0];

let ip = 0;
async function call(target: Target): Promise<{ status: number; bytes: number }> {
  ip += 1;
  const token = target.auth === 'pat' ? credentials.pat.token : owner.accessToken;
  const res = await fetch(`${base}${target.path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': `10.251.0.${ip % 250}` },
  });
  const body = await res.arrayBuffer();
  return { status: res.status, bytes: body.byteLength };
}
const settle = () => new Promise((r) => setTimeout(r, 300));

function tablesOf(sql: string): string[] {
  const tables = new Set<string>();
  for (const match of sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+"public"\."([a-z_]+)"/gi)) tables.add(match[1]);
  return [...tables];
}

function shortSql(sql: string): string {
  const compact = sql.replace(/\s+/g, ' ').trim();
  const verb = compact.slice(0, 6).toUpperCase();
  const tables = tablesOf(compact);
  return `${verb} ${tables.join(',')}`.trim();
}

interface CallReport {
  status: number;
  bytes: number;
  statements: number;
  dbMs: number;
  repeats: number;
  list: string[];
}
const report: Array<{ name: string; path: string; auth: string; calls: CallReport[] }> = [];

try {
  for (const target of targets) {
    const calls: CallReport[] = [];
    for (let i = 0; i < 3; i += 1) {
      captured = [];
      capturing = true;
      const { status, bytes } = await call(target);
      const inResponse = captured.slice();
      capturing = false;
      await settle();
      const seen = new Map<string, number>();
      let repeats = 0;
      for (const stmt of inResponse) {
        const key = `${stmt.sql}\u0000${stmt.params}`;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > 1) repeats += 1;
      }
      calls.push({
        status,
        bytes,
        statements: inResponse.length,
        dbMs: round2(inResponse.reduce((sum, s) => sum + s.durationMs, 0)),
        repeats,
        list: inResponse.map((s) => shortSql(s.sql)),
      });
    }
    report.push({
      name: target.name,
      path: target.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'),
      auth: target.auth,
      calls,
    });
    const [cold, warm] = calls;
    process.stdout.write(
      `[perf:statements] ${target.name.padEnd(26)} status ${warm.status} cold ${String(cold.statements).padStart(3)} warm ${String(warm.statements).padStart(3)} repeats ${warm.repeats} bytes ${warm.bytes}\n`,
    );
  }
} finally {
  server.close();
}

writeFileSync(
  OUT,
  `${JSON.stringify({ label: LABEL, tenancyCache: TENANCY_CACHE, generatedAt: new Date().toISOString(), fixture: manifest.counts, routes: report }, null, 1)}\n`,
);
process.stdout.write(`[perf:statements] wrote ${OUT}\n`);
await client.$disconnect();
process.exit(0);
