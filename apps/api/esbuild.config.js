import { build } from 'esbuild';
import { resolve } from 'path';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/index.js',
  sourcemap: true,
  nodePaths: [resolve('../../node_modules/.pnpm/node_modules')],
  // Do NOT add @prisma/adapter-pg here — it lives in packages/db/node_modules,
  // not resolvable from dist/ at runtime (caused production crash).
  external: [
    'express',
    'cors',
    'cookie-parser',
    'jsonwebtoken',
    'bcryptjs',
    'dotenv',
    'zod',
    'dockerode',
    '@anthropic-ai/sdk',
    '@opencode-ai/sdk',
    'openai',
    'get-port',
    'ssh2',
    'cpu-features',
  ],
  banner: {
    // Prisma generated client uses require() internally (CJS).
    // In ESM output we need to provide a require function.
    js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
  },
});

console.log('✓ API built successfully');
