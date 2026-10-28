const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function withCloudApiRequested(argv = process.argv, env = process.env): boolean {
  return argv.includes('--with-cloud-api') || env.OPENLINEAR_WITH_CLOUD_API === '1';
}

export function isSidecarTestEnv(env = process.env): boolean {
  return env.NODE_ENV === 'test' || env.VITEST === 'true';
}

/**
 * Sidecar must not talk to Postgres on user machines.
 * DATABASE_URL is allowed only with --with-cloud-api (local _test / loopback).
 */
export function assertSidecarPersistenceMode(env = process.env, argv = process.argv): void {
  const hasDb = Boolean(env.DATABASE_URL);
  const flagged = withCloudApiRequested(argv, env);
  if (isSidecarTestEnv(env)) return;

  if (hasDb && !flagged) {
    throw new Error(
      'DATABASE_URL is set but --with-cloud-api was not passed. ' +
        'The sidecar persists through the OpenLinear API only. ' +
        'Unset DATABASE_URL, or pass --with-cloud-api against a local *_test database.',
    );
  }

  if (flagged && hasDb) {
    assertLocalTestDatabase(env.DATABASE_URL as string);
  }
}

export function assertLocalTestDatabase(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('--with-cloud-api requires a valid local DATABASE_URL ending in _test');
  }
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(host)) {
    throw new Error(`--with-cloud-api refuses non-loopback DATABASE_URL host (${host})`);
  }
  if (!database.endsWith('_test')) {
    throw new Error(`--with-cloud-api requires a database name ending in _test, got "${database}"`);
  }
}

/**
 * Prisma persistence is a development/test mode only:
 * - `--with-cloud-api` with a (loopback `*_test`) DATABASE_URL, or
 * - a test process, unless it is configured exactly like production (an
 *   OPENLINEAR_API_URL and no DATABASE_URL) — the API-only end-to-end test
 *   runs the sidecar that way.
 */
export function shouldUsePrisma(env = process.env, argv = process.argv): boolean {
  if (withCloudApiRequested(argv, env) && Boolean(env.DATABASE_URL)) return true;
  if (!isSidecarTestEnv(env)) return false;
  return Boolean(env.DATABASE_URL) || !env.OPENLINEAR_API_URL;
}
