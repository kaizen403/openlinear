import { build } from 'esbuild';
import { resolve } from 'node:path';

// Two self-contained bundles from one build:
//   dist/index.js  — the HTTP API          (`node dist/index.js`)
//   dist/worker.js — background jobs/relay (`node dist/worker.js`)
//
// Every npm dependency and the generated Prisma client (its WASM query
// compiler is inlined as base64) is bundled, so the runtime image needs no
// node_modules at all. Previously express/cors/jsonwebtoken/dotenv/zod were
// left external, which forced the image to carry `pnpm deploy --prod` output:
// ~380 MB, most of it the Prisma CLI, Prisma Studio, React and PGlite pulled
// in as an auto-installed peer of @prisma/client.
await build({
  entryPoints: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  sourcemap: true,
  // Resolves packages that are only hoisted into pnpm's virtual store (for
  // example @prisma/adapter-pg, a dependency of packages/db, not of this app).
  nodePaths: [resolve('../../node_modules/.pnpm/node_modules')],
  logLevel: 'warning',
  banner: {
    // Prisma generated client uses require() internally (CJS).
    // In ESM output we need to provide a require function.
    js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
  },
});

console.log('✓ API built successfully (dist/index.js, dist/worker.js)');
