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
  },
}
