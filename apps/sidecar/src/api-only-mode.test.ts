import { build } from 'esbuild';
import express from 'express';
import type http from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCloudApiConfig, parseCloudApiUrl, setCloudApiConfig } from './config/cloud-api';
import { validateSidecarEnv } from './env';
import { resolvePersistenceMode } from './persistence/store';
import { shouldUsePrisma } from './persistence/boot';
import { githubApiBase } from './services/github-publication';

/**
 * W03a: production mode has no database, no signing secret and no
 * token-encryption key; persistence and authorization go through
 * OPENLINEAR_API_URL.
 */
describe('cloud API configuration', () => {
  afterEach(() => setCloudApiConfig(null));

  it('requires https except for loopback and refuses embedded credentials', () => {
    expect(parseCloudApiUrl('https://openlinear.tech/')).toBe('https://openlinear.tech');
    expect(parseCloudApiUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
    expect(parseCloudApiUrl('http://localhost:3001/')).toBe('http://localhost:3001');
    expect(() => parseCloudApiUrl('http://openlinear.tech')).toThrow(/https/);
    expect(() => parseCloudApiUrl('https://user:pass@openlinear.tech')).toThrow(/credentials/);
    expect(() => parseCloudApiUrl('https://openlinear.tech/?token=x')).toThrow(/query/);
    expect(() => parseCloudApiUrl('ftp://openlinear.tech')).toThrow(/http/);
    expect(() => parseCloudApiUrl('not a url')).toThrow(/valid URL/);
  });

  it('selects API persistence exactly when production-shaped (API URL, no database)', () => {
    expect(shouldUsePrisma({ NODE_ENV: 'production', OPENLINEAR_API_URL: 'https://x.test' }, ['node'])).toBe(false);
    expect(shouldUsePrisma({ NODE_ENV: 'test', OPENLINEAR_API_URL: 'http://127.0.0.1:1' }, ['node'])).toBe(false);
    expect(shouldUsePrisma({ NODE_ENV: 'test' }, ['node'])).toBe(true);
    expect(shouldUsePrisma({ NODE_ENV: 'test', OPENLINEAR_API_URL: 'http://127.0.0.1:1', DATABASE_URL: 'postgresql://127.0.0.1/x_test' }, ['node'])).toBe(true);
    expect(shouldUsePrisma({ DATABASE_URL: 'postgresql://127.0.0.1/x_test' }, ['node', '--with-cloud-api'])).toBe(true);
    expect(shouldUsePrisma({ DATABASE_URL: 'postgresql://127.0.0.1/x_test' }, ['node'])).toBe(false);
  });

  it('scrubs cloud-only secrets in API mode and refuses the proxy-auth flag', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      OPENLINEAR_API_URL: 'https://openlinear.tech',
      JWT_SECRET: 'x'.repeat(40),
      TOKEN_ENCRYPTION_KEY: 'y'.repeat(40),
      GITHUB_CLIENT_SECRET: 'z',
    };
    const report = validateSidecarEnv(env, ['node']);
    expect(report).toEqual({ cloudApiConfigured: true, scrubbed: ['JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'GITHUB_CLIENT_SECRET'] });
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.TOKEN_ENCRYPTION_KEY).toBeUndefined();
    expect(getCloudApiConfig()).toEqual({ baseUrl: 'https://openlinear.tech' });
    expect(() => validateSidecarEnv({ OPENLINEAR_TRUST_PROXY_AUTH: '1' }, ['node'])).toThrow(/no longer supported/);
  });

  it('reports an unconfigured sidecar and refuses execution persistence', async () => {
    const report = validateSidecarEnv({ NODE_ENV: 'production' }, ['node']);
    expect(report.cloudApiConfigured).toBe(false);
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(resolvePersistenceMode()).toBe('unconfigured');
      const { getSidecarStore } = await import('./persistence/store');
      await expect(getSidecarStore()).rejects.toMatchObject({ statusCode: 503, code: 'CLOUD_API_NOT_CONFIGURED' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('only redirects the GitHub API to a loopback stub in tests', () => {
    expect(githubApiBase({ NODE_ENV: 'test', OPENLINEAR_GITHUB_API_URL: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
    expect(githubApiBase({ NODE_ENV: 'production', OPENLINEAR_GITHUB_API_URL: 'http://127.0.0.1:9' })).toBe('https://api.github.com');
    expect(githubApiBase({ NODE_ENV: 'test', OPENLINEAR_GITHUB_API_URL: 'https://evil.example' })).toBe('https://api.github.com');
  });
});

describe('batch routes in API-only mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setCloudApiConfig(null);
  });

  it('fail closed with BATCH_REQUIRES_API_PERSISTENCE instead of reaching Prisma (legacy engine)', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    // W13a: with the v2 engine (default) API-mode batches run on the batch
    // coordinator (routes/batches-v2.test.ts); the legacy engine still fails closed.
    vi.stubEnv('OPENLINEAR_RUN_ENGINE', 'legacy');
    setCloudApiConfig({
      baseUrl: 'http://127.0.0.1:4596',
      fetch: (async () => new Response(JSON.stringify({ userId: 'u', authSource: 'session', scopes: [], workspaceId: null }), { status: 200 })) as unknown as typeof fetch,
    });
    const { default: batchesRouter } = await import('./routes/batches');
    const { createErrorHandler } = await import('./lib/errors');
    const app = express();
    app.use(express.json());
    app.use('/api/batches', batchesRouter);
    app.use(createErrorHandler());
    const server = await new Promise<http.Server>((resolveListen) => {
      const listening = app.listen(0, '127.0.0.1', () => resolveListen(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    try {
      for (const [method, path] of [['GET', '/api/batches'], ['POST', '/api/batches'], ['GET', '/api/batches/b1'], ['POST', '/api/batches/b1/approve']] as const) {
        const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method,
          headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify({ taskIds: ['t'], mode: 'parallel' }) } : {}),
        });
        expect(res.status, `${method} ${path}`).toBe(501);
        expect(await res.json()).toMatchObject({ code: 'BATCH_REQUIRES_API_PERSISTENCE' });
      }
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});

describe('packaged sidecar bundle', () => {
  it('contains no Prisma, no database package and no cloud-API source on any path', async () => {
    const sidecarRoot = resolve(import.meta.dirname, '..');
    const result = await build({
      entryPoints: [resolve(sidecarRoot, 'src/index.ts')],
      absWorkingDir: sidecarRoot,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      write: false,
      metafile: true,
      logLevel: 'silent',
      nodePaths: [resolve(sidecarRoot, '../../node_modules/.pnpm/node_modules')],
      plugins: [{
        name: 'openlinear-packaged-persistence',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\/prisma-loader$/ }, (args) => ({ path: resolve(args.resolveDir, `${args.path}.packaged.ts`) }));
        },
      }],
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.length).toBeGreaterThan(50);
    expect(inputs.filter((input) => /packages\/db\/|apps\/api\/|@prisma\/|jsonwebtoken/.test(input))).toEqual([]);
    expect(inputs.some((input) => input.endsWith('persistence/api-store.ts'))).toBe(true);
    expect(inputs.some((input) => input.endsWith('persistence/prisma-store.ts'))).toBe(false);
    expect(inputs.some((input) => input.includes('services/batch/orchestrator'))).toBe(false);
  }, 60_000);
});
