/**
 * Guard for every perf script that writes to or reads from a database.
 *
 * The perf fixture TRUNCATEs every table. A database is accepted only when its
 * host is loopback AND its name ends in `_test`. There is no override: point
 * PERF_DATABASE_URL at a disposable local database.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class UnsafePerfDatabaseError extends Error {
  constructor(reason: string) {
    super(
      `${reason}\nRefusing to touch this database. Set PERF_DATABASE_URL to a loopback database whose name ends in _test, e.g.\n` +
        '  PERF_DATABASE_URL=postgresql://openlinear@127.0.0.1:5432/openlinear_perf_test',
    );
    this.name = 'UnsafePerfDatabaseError';
  }
}

export interface PerfDatabase {
  url: string;
  host: string;
  port: string;
  database: string;
  user: string;
  /** host:port/database, safe to print and to store in reports. */
  label: string;
}

export function assertPerfDatabaseUrl(raw: string | undefined): PerfDatabase {
  if (!raw) throw new UnsafePerfDatabaseError('PERF_DATABASE_URL is not set.');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafePerfDatabaseError('PERF_DATABASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new UnsafePerfDatabaseError(`PERF_DATABASE_URL must be a postgres URL (got ${parsed.protocol}).`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new UnsafePerfDatabaseError(`PERF_DATABASE_URL host "${host}" is not loopback.`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database.endsWith('_test')) {
    throw new UnsafePerfDatabaseError(`PERF_DATABASE_URL database "${database}" does not end in "_test".`);
  }
  if (parsed.searchParams.has('host')) {
    throw new UnsafePerfDatabaseError('PERF_DATABASE_URL must not override the host through ?host=.');
  }
  const port = parsed.port || '5432';
  return {
    url: raw,
    host,
    port,
    database,
    user: decodeURIComponent(parsed.username),
    label: `${host}:${port}/${database}`,
  };
}

/**
 * Point this process's Prisma client at the perf database. Must run before
 * anything imports `@openlinear/db`'s client for the first time.
 */
export function bindPerfDatabase(): PerfDatabase {
  const db = assertPerfDatabaseUrl(process.env.PERF_DATABASE_URL);
  process.env.DATABASE_URL = db.url;
  return db;
}

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * The API entry point loads `<repo>/.env` with dotenv (which does not override
 * variables already set). The bench sets every variable it relies on, but a
 * repository `.env` could still inject others (Redis, provider keys), so refuse
 * to run next to one unless explicitly allowed.
 */
export function assertNoRepositoryDotenv(): void {
  if (existsSync(resolve(REPO_ROOT, '.env')) && process.env.PERF_ALLOW_REPO_DOTENV !== '1') {
    throw new Error(
      'A repository .env exists; the API would load it. Move it aside or set PERF_ALLOW_REPO_DOTENV=1 after checking it holds nothing remote.',
    );
  }
}
