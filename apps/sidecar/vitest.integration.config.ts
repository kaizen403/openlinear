import { defineConfig } from 'vitest/config';
import { assertTestDatabaseUrl } from '../api/src/__tests__/assert-test-database';

// Require an explicit disposable loopback database before importing Prisma.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable loopback database ending in _test');
assertTestDatabaseUrl(process.env.TEST_DATABASE_URL, false);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
