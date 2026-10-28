import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Real git and child processes; generous but bounded.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
