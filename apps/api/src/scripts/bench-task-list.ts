/**
 * Task-list query benchmark (W14): runs `GET /api/tasks` service calls
 * against a seeded local database, captures the SQL Prisma sends, and
 * prints EXPLAIN (ANALYZE, BUFFERS) plus p50/p95 latency per scenario.
 *
 *   createdb … openlinear_apicontract_bench && prisma migrate deploy
 *   psql … -f docs/reports/revamp-2026-10-26/apicontract-seed.sql
 *   DATABASE_URL=postgresql://…/openlinear_apicontract_bench \
 *     pnpm --filter @openlinear/api exec tsx src/scripts/bench-task-list.ts [--plans] [--runs=20] [--only=<name>]
 *
 * Refuses to run against a database whose name does not contain "bench".
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PrismaClient } from '@openlinear/db';

const url = process.env.DATABASE_URL ?? '';
if (!/bench/.test(new URL(url).pathname)) {
  throw new Error('bench-task-list: DATABASE_URL must name a disposable *bench* database');
}

interface CapturedQuery {
  query: string;
  params: string;
}

// The driver adapter is a dependency of @openlinear/db, not of this package;
// load it from there (a query-logging client needs its own adapter).
type AdapterFactory = NonNullable<ConstructorParameters<typeof PrismaClient>[0]>['adapter'];
const requireFromDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
const { PrismaPg } = requireFromDb('@prisma/adapter-pg') as {
  PrismaPg: new (options: { connectionString: string }) => AdapterFactory;
};

const captured: CapturedQuery[] = [];
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
  log: [{ emit: 'event', level: 'query' }],
});
client.$on('query', (event) => {
  captured.push({ query: event.query, params: event.params });
});
// The services import `prisma` from @openlinear/db, which reuses this global.
(globalThis as unknown as { prisma: PrismaClient }).prisma = client;

function uuid(kind: string): string {
  const hex = createHash('md5').update(kind).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? 'true'] as const;
}));
const runs = Number(args.get('runs') ?? 20);
const showPlans = args.has('plans');
const only = args.get('only');

async function main(): Promise<void> {
  const { listTasksByCursor, listTasksPaginated } = await import('../services/tasks');
  const { searchWorkspaceData } = await import('../services/search');
  // --user=<n>: user 0 sees ~45 % of all tasks; user 137 belongs to one
  // small workspace only (~1 %), the worst case for an ordered index scan.
  const userId = uuid(`user:${args.get('user') ?? '0'}`);
  const bigProject = uuid('project:0');
  const smallProject = uuid('project:7');
  const label = uuid('label:0:0');
  const parent = uuid('task:20');

  // Project scenarios need user 0 (a member of workspace 0); others skip them.
  const seesBigProject = userId === uuid('user:0');
  const firstPage = seesBigProject ? await listTasksByCursor({ userId, projectId: bigProject, pageSize: 50 }) : { nextCursor: null };
  const deepCursor = seesBigProject
    ? (await listTasksPaginated({ userId, projectId: bigProject, page: 500, pageSize: 50 })).nextCursor ?? undefined
    : undefined;

  const scenarios: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'board offset p1 (+count)', run: () => listTasksPaginated({ userId, projectId: bigProject, page: 1, pageSize: 50 }) },
    { name: 'board offset p500 (+count)', run: () => listTasksPaginated({ userId, projectId: bigProject, page: 500, pageSize: 50 }) },
    { name: 'board cursor p1', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50 }) },
    { name: 'board cursor p2', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, cursor: firstPage.nextCursor ?? undefined }) },
    { name: 'board cursor deep (row 25 000)', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, cursor: deepCursor }) },
    { name: 'board 200/page compact', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 200, compact: true }) },
    { name: 'status=in_progress (10%)', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, status: ['in_progress'] }) },
    { name: 'status=cancelled (5%)', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, status: ['cancelled'] }) },
    { name: 'status=todo,in_progress', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, status: ['todo', 'in_progress'] }) },
    { name: 'labelId', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, labelIds: [label] }) },
    { name: 'parentId (sub-issues)', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, parentId: parent }) },
    { name: 'parentId without project', run: () => listTasksByCursor({ userId, pageSize: 50, parentId: parent }) },
    { name: 'parentId=none', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, parentId: 'none' }) },
    { name: 'assignee=none', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, assignee: 'none' }) },
    { name: 'assignee=me (all projects)', run: () => listTasksByCursor({ userId, pageSize: 50, assignee: 'me' }) },
    { name: 'q=billing (project)', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, q: 'billing' }) },
    { name: 'q=ref-123456 (rare, project)', run: () => listTasksByCursor({ userId, projectId: bigProject, pageSize: 50, q: 'ref-59999' }) },
    { name: 'q=ref-123456 (rare, all)', run: () => listTasksByCursor({ userId, pageSize: 50, q: 'ref-60999' }) },
    { name: 'small project cursor p1', run: () => listTasksByCursor({ userId, projectId: smallProject, pageSize: 50 }) },
    { name: 'all visible, no filter', run: () => listTasksByCursor({ userId, pageSize: 50 }) },
    { name: 'all visible, status=todo', run: () => listTasksByCursor({ userId, pageSize: 50, status: ['todo'] }) },
    { name: 'search tasks, rare term', run: () => searchWorkspaceData({ userId, query: 'ref-60999', types: ['tasks'] }) },
    { name: 'search tasks, common term', run: () => searchWorkspaceData({ userId, query: 'billing', types: ['tasks'] }) },
    { name: 'search all types, rare term', run: () => searchWorkspaceData({ userId, query: 'ref-60999' }) },
  ];

  for (const scenario of scenarios) {
    if (only && !scenario.name.includes(only)) continue;
    try {
      await scenario.run(); // warm
    } catch (error) {
      console.log(`\n## ${scenario.name}: skipped (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const timings: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      const started = process.hrtime.bigint();
      await scenario.run();
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)];
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))];
    captured.length = 0;
    await scenario.run();
    const queries = captured.splice(0);
    const listQuery = queries.find((entry) => /FROM "public"\."tasks"/.test(entry.query) && /ORDER BY/.test(entry.query));
    const countQuery = queries.find((entry) => /COUNT\(/i.test(entry.query) && /"public"\."tasks"/.test(entry.query));
    console.log(`\n## ${scenario.name}: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, ${queries.length} queries`);
    if (showPlans) {
      for (const [label, entry] of [['list', listQuery], ['count', countQuery]] as const) {
        if (!entry) continue;
        const params = JSON.parse(entry.params) as unknown[];
        const plan = await client.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN (ANALYZE, BUFFERS) ${entry.query}`,
          ...params,
        );
        console.log(`### ${label} query\n${plan.map((row) => row['QUERY PLAN']).join('\n')}`);
      }
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.$disconnect();
  });
