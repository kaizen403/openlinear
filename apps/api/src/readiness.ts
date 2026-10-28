import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prisma } from '@openlinear/db';

/**
 * Readiness for `GET /readyz`: the database answers AND every migration this
 * build ships has been applied. A revision deployed before its migration ran
 * stays out of rotation instead of serving 500s on missing columns.
 *
 * Extra migrations in the database are fine: under expand/contract the
 * previous revision keeps working while the next one's migration is applied.
 */

export const MIGRATIONS_DIR_ENV = 'OPENLINEAR_MIGRATIONS_DIR';

/** Positive results are cached so probes stay one cheap query. */
const MIGRATIONS_OK_TTL_MS = 60_000;

export type MigrationCheck =
  | { state: 'ok'; expected: number }
  | { state: 'pending'; expected: number; missing: string[] }
  | { state: 'unchecked'; reason: string };

export type ReadinessResult =
  | { ready: true; migrations: MigrationCheck }
  | { ready: false; reason: 'database'; error: unknown }
  | { ready: false; reason: 'migrations'; migrations: Extract<MigrationCheck, { state: 'pending' }> };

/**
 * Where this build's migrations live:
 * - image: `/app/prisma/migrations` (the Dockerfile sets OPENLINEAR_MIGRATIONS_DIR);
 * - workspace: `packages/db/prisma/migrations`, from `apps/api` or the repo root.
 */
export function migrationDirCandidates(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const explicit = env[MIGRATIONS_DIR_ENV]?.trim();
  if (explicit) return [resolve(cwd, explicit)];
  return [
    resolve(cwd, 'prisma/migrations'),
    resolve(cwd, '../../packages/db/prisma/migrations'),
    resolve(cwd, 'packages/db/prisma/migrations'),
  ];
}

/** Migration directory names, sorted; `null` when no migrations directory exists. */
export function readExpectedMigrations(candidates: string[] = migrationDirCandidates()): string[] | null {
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'migration.sql')))
      .map((entry) => entry.name)
      .sort();
  }
  return null;
}

export interface ReadinessDeps {
  ping: () => Promise<void>;
  /** Names of migrations Prisma recorded as finished and not rolled back. */
  appliedMigrations: () => Promise<string[]>;
  expectedMigrations: () => string[] | null;
  now: () => number;
}

/** True for "relation _prisma_migrations does not exist" as surfaced by Prisma + adapter-pg. */
export function isMissingMigrationsTableError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /_prisma_migrations/.test(text) && /does not exist|42P01/.test(text);
}

const defaultDeps: ReadinessDeps = {
  ping: async () => {
    await prisma.$queryRaw`SELECT 1`;
  },
  appliedMigrations: async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      `;
      return rows.map((row) => row.migration_name);
    } catch (err) {
      // A database that never ran `prisma migrate deploy` has no history table:
      // every migration is pending, which is a readiness failure, not an outage.
      if (isMissingMigrationsTableError(err)) return [];
      throw err;
    }
  },
  expectedMigrations: (() => {
    let cached: string[] | null | undefined;
    return () => {
      if (cached === undefined) cached = readExpectedMigrations();
      return cached;
    };
  })(),
  now: () => Date.now(),
};

export function createReadinessCheck(deps: ReadinessDeps = defaultDeps): () => Promise<ReadinessResult> {
  let migrationsOkUntil = 0;
  let migrationsOk: MigrationCheck | null = null;

  return async () => {
    try {
      await deps.ping();
    } catch (error) {
      return { ready: false, reason: 'database', error };
    }

    if (migrationsOk && deps.now() < migrationsOkUntil) {
      return { ready: true, migrations: migrationsOk };
    }

    let expected: string[] | null;
    try {
      expected = deps.expectedMigrations();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ready: true, migrations: { state: 'unchecked', reason: `cannot read migrations: ${reason}` } };
    }
    if (expected === null) {
      return {
        ready: true,
        migrations: {
          state: 'unchecked',
          reason: `no migrations directory found (set ${MIGRATIONS_DIR_ENV})`,
        },
      };
    }

    let applied: string[];
    try {
      applied = await deps.appliedMigrations();
    } catch (error) {
      return { ready: false, reason: 'database', error };
    }
    const appliedSet = new Set(applied);
    const missing = expected.filter((name) => !appliedSet.has(name));
    if (missing.length > 0) {
      migrationsOk = null;
      return {
        ready: false,
        reason: 'migrations',
        migrations: { state: 'pending', expected: expected.length, missing },
      };
    }

    migrationsOk = { state: 'ok', expected: expected.length };
    migrationsOkUntil = deps.now() + MIGRATIONS_OK_TTL_MS;
    return { ready: true, migrations: migrationsOk };
  };
}

let activeCheck = createReadinessCheck();

export function checkReadiness(): Promise<ReadinessResult> {
  return activeCheck();
}

/** Test seam: swap the dependencies behind `GET /readyz`; `null` restores the defaults. */
export function setReadinessDepsForTests(deps: Partial<ReadinessDeps> | null): void {
  activeCheck = createReadinessCheck(deps ? { ...defaultDeps, ...deps } : defaultDeps);
}
