/**
 * Guard against destructive test runs against a non-test database.
 *
 * The API test suite truncates tables with unscoped `deleteMany({})` calls.
 * Before this guard existed, `vitest.config.ts` fell back to the ambient
 * `DATABASE_URL` — which in this repo's `.env` points at a live Neon pooler —
 * so a plain `pnpm test` would wipe production data.
 *
 * A database is considered safe only when BOTH hold:
 *   1. the host is loopback (localhost / 127.0.0.1 / ::1), or the URL is
 *      explicitly marked disposable via `OPENLINEAR_ALLOW_NONLOCAL_TEST_DB=1`
 *      (used by CI, which provisions a throwaway Postgres service container);
 *   2. the database name ends in `_test`.
 *
 * Anything else throws before a connection is opened.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(
      `${message}\n\n` +
        'Refusing to run destructive tests against this database.\n' +
        'Set TEST_DATABASE_URL to a local, disposable database, e.g.\n' +
        '  TEST_DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear_test\n' +
        'CI may set OPENLINEAR_ALLOW_NONLOCAL_TEST_DB=1 for an ephemeral service container.\n',
    );
    this.name = 'UnsafeTestDatabaseError';
  }
}

export function assertTestDatabaseUrl(
  rawUrl: string | undefined = process.env.DATABASE_URL,
  allowNonLocal: boolean = process.env.OPENLINEAR_ALLOW_NONLOCAL_TEST_DB === '1',
): void {
  if (!rawUrl) {
    throw new UnsafeTestDatabaseError('DATABASE_URL is not set.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeTestDatabaseError('DATABASE_URL is not a valid URL.');
  }

  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\//, '');

  if (!LOOPBACK_HOSTS.has(host) && !allowNonLocal) {
    throw new UnsafeTestDatabaseError(
      `DATABASE_URL points at a non-local host (${host}).`,
    );
  }

  if (!database.endsWith('_test')) {
    throw new UnsafeTestDatabaseError(
      `DATABASE_URL database name "${database}" does not end in "_test".`,
    );
  }
}
