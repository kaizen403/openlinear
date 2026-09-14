import { resolve } from 'node:path'

export default {
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, '.'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['**/*.test.{mjs,ts,tsx}'],
    testTimeout: 10000,
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
      exclude: [
        'components/ui/**',
        'lib/design-tokens.ts',
        'types/**',
        'test/**',
        '**/*.test.{mjs,ts,tsx}',
      ],
    },
  },
}
