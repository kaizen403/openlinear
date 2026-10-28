import { build } from 'esbuild';
import { resolve } from 'path';

/**
 * Two outputs:
 * - default: ESM development bundle (dist/index.js); runtime packages stay
 *   external and resolve from node_modules.
 * - `--packaged`: self-contained CommonJS bundle (dist/bundle.cjs) for `pkg`
 *   (scripts/build-sidecar.sh). The shipped sidecar is API-only (W03a): the
 *   Prisma persistence loader is swapped for its packaged stub, so neither
 *   `@openlinear/db` nor the batch engine is bundled, and the build fails if
 *   any database or cloud-API source slips into the bundle.
 */
const packaged = process.argv.includes('--packaged');

const packagedPersistence = {
  name: 'openlinear-packaged-persistence',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\/prisma-loader$/ }, (args) => ({
      path: resolve(args.resolveDir, `${args.path}.packaged.ts`),
    }));
  },
};

const FORBIDDEN_INPUTS = [
  /(^|\/)packages\/db\//,
  /(^|\/)apps\/api\//,
  /@prisma\//,
  /(^|\/)node_modules\/\.prisma\//,
];

const result = await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: !packaged,
  nodePaths: [resolve('../../node_modules/.pnpm/node_modules')],
  ...(packaged
    ? {
        format: 'cjs',
        outfile: 'dist/bundle.cjs',
        plugins: [packagedPersistence],
        metafile: true,
        define: { 'process.env.OPENLINEAR_PACKAGED': '"1"' },
        logOverride: { 'empty-import-meta': 'silent' },
      }
    : {
        format: 'esm',
        outfile: 'dist/index.js',
        external: [
          'express',
          'cors',
          'cookie-parser',
          'dotenv',
          'zod',
          '@opencode-ai/sdk',
        ],
        banner: {
          js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
        },
      }),
});

if (packaged) {
  const inputs = Object.keys(result.metafile.inputs);
  const leaked = inputs.filter((input) => FORBIDDEN_INPUTS.some((pattern) => pattern.test(input)));
  if (leaked.length > 0) {
    console.error('✗ Packaged sidecar bundle includes database/cloud-API sources:\n  ' + leaked.join('\n  '));
    process.exit(1);
  }
  console.log(`✓ Packaged sidecar bundle (${inputs.length} inputs, no Prisma, no @openlinear/api)`);
} else {
  console.log('✓ Sidecar built successfully');
}
