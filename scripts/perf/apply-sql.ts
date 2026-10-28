/**
 * Run a SQL file against the perf database only (same loopback + *_test guard
 * as the seed). Each statement runs on its own in autocommit, so
 * `CREATE INDEX CONCURRENTLY` works.
 *
 *   PERF_DATABASE_URL=... pnpm perf:sql scripts/perf/sql/phase0-hot-path-indexes.bench.sql
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { prisma } from '../../packages/db/src/index.ts';
import { bindPerfDatabase } from './lib/safety.ts';

const database = bindPerfDatabase();
process.env.OPENLINEAR_SLOW_QUERY_MS = 'off';

const file = process.argv.slice(2).find((arg) => arg !== '--');
if (!file) throw new Error('usage: perf:sql <file.sql>');
const statements = readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .split(/;\s*(?:\n|$)/)
  .map((statement) => statement.trim())
  .filter(Boolean);

process.stdout.write(`[perf:sql] ${database.label}: ${statements.length} statements from ${file}\n`);
let failed = 0;
for (const statement of statements) {
  const started = performance.now();
  try {
    await prisma.$executeRawUnsafe(statement);
    process.stdout.write(`  ok   ${((performance.now() - started) / 1000).toFixed(2)}s  ${statement.replace(/\s+/g, ' ').slice(0, 110)}\n`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message.split('\n').filter(Boolean).slice(-1)[0] : String(error);
    process.stdout.write(`  FAIL ${statement.replace(/\s+/g, ' ').slice(0, 110)}\n       ${message}\n`);
    if (process.env.PERF_SQL_CONTINUE !== '1') break;
  }
}
await prisma.$disconnect();
process.exit(failed > 0 ? 1 : 0);
