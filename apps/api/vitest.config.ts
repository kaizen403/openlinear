import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import { resolve } from 'node:path';

const externalDatabaseUrl = process.env.DATABASE_URL;
config({ path: resolve(import.meta.dirname, '../../.env') });

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  externalDatabaseUrl ??
  'postgresql://openlinear:openlinear@localhost:5432/openlinear_test';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
