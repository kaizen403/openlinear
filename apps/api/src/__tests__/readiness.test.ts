import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import {
  MIGRATIONS_DIR_ENV,
  type ReadinessDeps,
  createReadinessCheck,
  isMissingMigrationsTableError,
  migrationDirCandidates,
  readExpectedMigrations,
  setReadinessDepsForTests,
} from '../readiness';
import { useTestServer } from './http';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../packages/db/prisma/migrations');

function deps(overrides: Partial<ReadinessDeps>): ReadinessDeps {
  return {
    ping: async () => undefined,
    appliedMigrations: async () => ['m1', 'm2'],
    expectedMigrations: () => ['m1', 'm2'],
    now: () => 0,
    ...overrides,
  };
}

describe('readiness check', () => {
  it('fails on the database before looking at migrations', async () => {
    const appliedMigrations = vi.fn(async () => ['m1', 'm2']);
    const check = createReadinessCheck(deps({
      ping: async () => {
        throw new Error('connection refused');
      },
      appliedMigrations,
    }));

    const result = await check();

    expect(result).toMatchObject({ ready: false, reason: 'database' });
    expect(appliedMigrations).not.toHaveBeenCalled();
  });

  it('is ready when every shipped migration is applied, and tolerates a schema that is ahead', async () => {
    const check = createReadinessCheck(deps({ appliedMigrations: async () => ['m1', 'm2', 'm3-next-release'] }));

    await expect(check()).resolves.toEqual({ ready: true, migrations: { state: 'ok', expected: 2 } });
  });

  it('is not ready while a shipped migration is missing, and recovers once it is applied', async () => {
    let applied = ['m1'];
    const check = createReadinessCheck(deps({ appliedMigrations: async () => applied }));

    await expect(check()).resolves.toEqual({
      ready: false,
      reason: 'migrations',
      migrations: { state: 'pending', expected: 2, missing: ['m2'] },
    });

    applied = ['m1', 'm2'];
    await expect(check()).resolves.toMatchObject({ ready: true, migrations: { state: 'ok' } });
  });

  it('caches a passing migration check for a minute but always pings the database', async () => {
    let now = 1_000;
    const ping = vi.fn(async () => undefined);
    const appliedMigrations = vi.fn(async () => ['m1', 'm2']);
    const check = createReadinessCheck(deps({ ping, appliedMigrations, now: () => now }));

    await check();
    now += 59_000;
    await check();
    expect(appliedMigrations).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(2);

    now += 2_000;
    await check();
    expect(appliedMigrations).toHaveBeenCalledTimes(2);
  });

  it('reports a failing migration-history query as a database failure', async () => {
    const check = createReadinessCheck(deps({
      appliedMigrations: async () => {
        throw new Error('timeout');
      },
    }));

    await expect(check()).resolves.toMatchObject({ ready: false, reason: 'database' });
  });

  it('stays ready but says "unchecked" when the build has no migrations directory', async () => {
    const check = createReadinessCheck(deps({ expectedMigrations: () => null }));

    await expect(check()).resolves.toMatchObject({ ready: true, migrations: { state: 'unchecked' } });
  });

  it('recognises the error for a database that never ran prisma migrate deploy', () => {
    // Shape observed from Prisma 7 + @prisma/adapter-pg against Postgres.
    const err = new Error(
      '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `42P01`. Message: `relation "_prisma_migrations" does not exist`',
    );
    expect(isMissingMigrationsTableError(err)).toBe(true);
    expect(isMissingMigrationsTableError(new Error('relation "tasks" does not exist'))).toBe(false);
    expect(isMissingMigrationsTableError(new Error('Connection terminated unexpectedly'))).toBe(false);
  });
});

describe('expected migrations', () => {
  it('lists the migration directories shipped with this build, sorted', () => {
    const expected = readExpectedMigrations([MIGRATIONS_DIR]);
    const onDisk = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(expected).toEqual(onDisk);
    expect(expected?.[0]).toBe('20260430213500_init');
    expect(expected).not.toContain('migration_lock.toml');
  });

  it('returns null when no candidate directory exists', () => {
    expect(readExpectedMigrations(['/nonexistent/openlinear/migrations'])).toBeNull();
  });

  it('prefers an explicit OPENLINEAR_MIGRATIONS_DIR over the workspace layout', () => {
    expect(migrationDirCandidates({ [MIGRATIONS_DIR_ENV]: '/app/prisma/migrations' }, '/app')).toEqual([
      '/app/prisma/migrations',
    ]);
    expect(migrationDirCandidates({}, '/repo/apps/api')).toEqual([
      '/repo/apps/api/prisma/migrations',
      '/repo/packages/db/prisma/migrations',
      '/repo/apps/api/packages/db/prisma/migrations',
    ]);
  });
});

describe('GET /readyz (test database)', () => {
  const app = createApp();
  const http = useTestServer(() => app);

  afterEach(() => {
    setReadinessDepsForTests(null);
  });

  it('returns 200 when the database is reachable and fully migrated', async () => {
    // The test database is prepared with `prisma migrate deploy`.
    setReadinessDepsForTests({ expectedMigrations: () => readExpectedMigrations([MIGRATIONS_DIR]) });

    const res = await http().get('/readyz');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'ok', migrations: 'ok' });
    expect(res.body).toHaveProperty('secrets');
  });

  it('returns 503 MIGRATIONS_PENDING when this build ships a migration the database lacks', async () => {
    const shipped = readExpectedMigrations([MIGRATIONS_DIR]) ?? [];
    setReadinessDepsForTests({ expectedMigrations: () => [...shipped, '99999999999999_not_applied'] });

    const res = await http().get('/readyz');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATIONS_PENDING');
    expect(res.body.error).toMatchObject({ code: 'MIGRATIONS_PENDING' });
    expect(res.body.details).toEqual({ missing: ['99999999999999_not_applied'], expected: shipped.length + 1 });
    expect(res.body).toMatchObject({ status: 'unavailable', database: 'ok', migrations: 'pending' });
  });

  it('returns 503 DATABASE_UNAVAILABLE when the database does not answer', async () => {
    setReadinessDepsForTests({
      ping: async () => {
        throw new Error('db down');
      },
    });

    const res = await http().get('/readyz');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DATABASE_UNAVAILABLE');
    expect(res.body).toMatchObject({ status: 'unavailable', database: 'unavailable' });
  });

  it('keeps /livez free of database work', async () => {
    setReadinessDepsForTests({
      ping: async () => {
        throw new Error('db down');
      },
    });

    const res = await http().get('/livez');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
