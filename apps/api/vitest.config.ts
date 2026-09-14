import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { assertTestDatabaseUrl } from './src/__tests__/assert-test-database';
import { applyTestEnv } from './src/__tests__/test-env';

const externalDatabaseUrl = process.env.DATABASE_URL;
config({ path: resolve(import.meta.dirname, '../../.env') });

// TEST_DATABASE_URL wins. The ambient DATABASE_URL is NOT trusted as a fallback:
// the repo `.env` points at a live database and this suite truncates tables.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  externalDatabaseUrl ??
  'postgresql://openlinear:openlinear@localhost:5432/openlinear_test';

// Fail fast, before any test file imports the Prisma client.
assertTestDatabaseUrl();

// Override any real secrets dotenv just loaded from the repository `.env`.
applyTestEnv();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/__tests__/setup-guard.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
