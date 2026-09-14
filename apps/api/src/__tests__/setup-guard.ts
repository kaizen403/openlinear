/**
 * Test bootstrap. Runs before every test file.
 *
 *  1. Re-assert the target database is disposable, in case `DATABASE_URL` is
 *     mutated after config load or a test is run through a path that bypasses
 *     `vitest.config.ts`.
 *  2. Re-apply throwaway auth secrets inside the worker process.
 */
import { assertTestDatabaseUrl } from './assert-test-database';
import { applyTestEnv } from './test-env';

assertTestDatabaseUrl();
applyTestEnv();
