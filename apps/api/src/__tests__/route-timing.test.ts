import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Query events must be subscribed before the Prisma client is first built.
// 50 ms: high enough that ordinary test queries are not "slow", low enough
// for a deliberate pg_sleep to cross it.
vi.hoisted(() => {
  process.env.OPENLINEAR_SLOW_QUERY_MS = '50';
  delete (globalThis as { prisma?: unknown }).prisma;
});

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import pino from 'pino';
import request from 'supertest';
import {
  prisma,
  redactSql,
  resolveSlowQueryThresholdMs,
  fingerprintSql,
} from '@openlinear/db';
import { createApp } from '../app';
import { durationBucket, LatencyHistogram, latencyHistogramInternals } from '../lib/latency-histogram';
import {
  createRouteTemplateMatcher,
  getRouteTimingSnapshot,
  MAX_SERIES,
  resetRouteTiming,
  resolveRouteTimingOptions,
  routeTiming,
} from '../middleware/route-timing';
import { ROUTE_REGISTRY } from '../registry';
import { testJwtSecret } from './test-env';

type LogLine = Record<string, unknown>;

function captureLogger(): { logger: pino.Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger = pino(
    { level: 'debug' },
    {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as LogLine);
      },
    },
  );
  return { logger, lines };
}

/** One listening server per app: fewer short-lived sockets than per-request supertest servers. */
async function withServer(app: express.Express | ReturnType<typeof createApp>, fn: (server: Server) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    await fn(server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function entryFor(method: string, route: string) {
  return getRouteTimingSnapshot().find((entry) => entry.method === method && entry.route === route);
}

describe('route template matcher', () => {
  const match = createRouteTemplateMatcher([
    { method: 'GET', path: '/api/tasks/:id' },
    { method: 'GET', path: '/api/tasks/archived' },
    { method: 'GET', path: '/api/tasks' },
    { method: 'POST', path: '/api/tasks/:id/comments' },
    { method: 'GET', path: '/livez' },
  ]);

  it('prefers static segments over parameters', () => {
    expect(match('GET', '/api/tasks/archived')).toBe('/api/tasks/archived');
    expect(match('GET', '/api/tasks/7f1c2a5e-0000-4000-8000-000000000001')).toBe('/api/tasks/:id');
  });

  it('tolerates a trailing slash and case, maps HEAD to GET, and rejects unknown paths', () => {
    expect(match('GET', '/api/tasks/')).toBe('/api/tasks');
    expect(match('GET', '/API/Tasks')).toBe('/api/tasks');
    expect(match('HEAD', '/livez')).toBe('/livez');
    expect(match('POST', '/api/tasks/abc/comments')).toBe('/api/tasks/:id/comments');
    expect(match('DELETE', '/api/tasks/abc')).toBeNull();
    expect(match('GET', '/api/tasks/abc/def')).toBeNull();
    expect(match('GET', '/etc/passwd')).toBeNull();
  });

  it('covers every registry route with its own template', () => {
    const registry = createRouteTemplateMatcher(ROUTE_REGISTRY);
    for (const route of ROUTE_REGISTRY) {
      const concrete = route.path.replace(/:[A-Za-z]+/g, '0b5f3c7e-1d2a-4c3b-9e8f-112233445566');
      expect(registry(route.method, concrete)).toBe(route.path);
    }
  });
});

describe('latency histogram', () => {
  it('reads percentiles within half a bucket of the exact value', () => {
    const histogram = new LatencyHistogram();
    const samples: number[] = [];
    for (let i = 1; i <= 10_000; i += 1) {
      // Skewed: mostly fast, a long tail.
      const value = i % 100 === 0 ? 400 + (i % 700) : 2 + (i % 50) * 0.7;
      samples.push(value);
      histogram.record(value);
    }
    samples.sort((a, b) => a - b);
    for (const q of [0.5, 0.95, 0.99]) {
      const exact = samples[Math.ceil(q * samples.length) - 1];
      const estimate = histogram.quantile(q);
      expect(Math.abs(estimate - exact) / exact).toBeLessThan(0.05);
    }
    const summary = histogram.summary();
    expect(summary.count).toBe(10_000);
    expect(summary.maxMs).toBe(samples.at(-1));
  });

  it('keeps constant memory and ignores invalid samples', () => {
    const histogram = new LatencyHistogram();
    histogram.record(Number.NaN);
    histogram.record(-1);
    expect(histogram.count).toBe(0);
    expect(histogram.quantile(0.95)).toBe(0);
    histogram.record(10_000_000); // overflow bucket
    expect(histogram.quantile(0.5)).toBe(10_000_000);
    expect(latencyHistogramInternals.BUCKETS).toBeLessThan(200);
  });

  it('labels durations with a bounded set of buckets', () => {
    const labels = new Set([0, 5, 20, 70, 120, 300, 700, 1200, 3000, 60_000].map(durationBucket));
    expect(labels.size).toBe(9);
    expect(durationBucket(99.9)).toBe('50-100ms');
    expect(durationBucket(100)).toBe('100-250ms');
  });
});

describe('route timing options', () => {
  it('defaults by environment and clamps overrides', () => {
    expect(resolveRouteTimingOptions({ NODE_ENV: 'production' })).toMatchObject({
      enabled: true,
      slowMs: 250,
      maxQueries: 25,
      sampleRate: 0,
      summaryIntervalMs: 0,
    });
    expect(resolveRouteTimingOptions({ NODE_ENV: 'development' }).slowMs).toBe(100);
    expect(resolveRouteTimingOptions({ OPENLINEAR_ROUTE_TIMING: 'off' }).enabled).toBe(false);
    expect(resolveRouteTimingOptions({ OPENLINEAR_ROUTE_TIMING_SAMPLE: '7' }).sampleRate).toBe(1);
    expect(resolveRouteTimingOptions({ OPENLINEAR_ROUTE_TIMING_SLOW_MS: 'nope' }).slowMs).toBe(100);
  });
});

describe('slow-query configuration', () => {
  it('resolves thresholds per environment', () => {
    expect(resolveSlowQueryThresholdMs({ NODE_ENV: 'production' })).toBe(250);
    expect(resolveSlowQueryThresholdMs({ NODE_ENV: 'development' })).toBe(100);
    expect(resolveSlowQueryThresholdMs({})).toBe(100);
    expect(resolveSlowQueryThresholdMs({ NODE_ENV: 'test' })).toBeNull();
    expect(resolveSlowQueryThresholdMs({ NODE_ENV: 'production', OPENLINEAR_SLOW_QUERY_MS: '40' })).toBe(40);
    expect(resolveSlowQueryThresholdMs({ OPENLINEAR_SLOW_QUERY_MS: 'off' })).toBeNull();
    expect(resolveSlowQueryThresholdMs({ OPENLINEAR_SLOW_QUERY_MS: '-1' })).toBeNull();
    expect(resolveSlowQueryThresholdMs({ NODE_ENV: 'production', OPENLINEAR_SLOW_QUERY_MS: 'abc' })).toBe(250);
  });

  it('masks literals and bounds statement size', () => {
    const sql = `SELECT "id" FROM "users" WHERE "email" = 'alice@example.com' AND "note" = E'it''s' AND "x" = $$secret$$ AND "id" = $1 LIMIT 5`;
    const redacted = redactSql(sql);
    expect(redacted).not.toContain('alice@example.com');
    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain("it''s");
    expect(redacted).toContain('$1');
    expect(redacted).toContain('LIMIT 5');
    expect(fingerprintSql(redacted)).toMatch(/^[0-9a-f]{12}$/);
    const huge = redactSql(`SELECT 1 WHERE "id" IN (${Array.from({ length: 2000 }, (_, i) => `$${i + 1}`).join(', ')})`);
    expect(huge.length).toBeLessThan(2_100);
    expect(huge).toContain('[+');
  });
});

describe('route timing middleware', () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  let token = '';

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, username: `route-timing-${userId.slice(0, 8)}` } });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        name: 'Route timing',
        slug: `route-timing-${workspaceId.slice(0, 8)}`,
        members: { create: { userId, role: 'owner' } },
      },
    });
    token = jwt.sign({ userId, username: 'route-timing' }, testJwtSecret(), { expiresIn: '1h' });
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(() => {
    resetRouteTiming();
  });

  it('aggregates by route template, never by raw path or query string', async () => {
    const taskId = randomUUID();
    await withServer(createApp(), async (server) => {
      await request(server)
        .get(`/api/tasks/${taskId}?token=super-secret-query-value`)
        .set('Authorization', `Bearer ${token}`);
      await request(server).get('/api/tasks?pageSize=5').set('Authorization', `Bearer ${token}`);
      await request(server).get('/livez');
    });

    const snapshot = getRouteTimingSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(taskId);
    expect(serialized).not.toContain('super-secret-query-value');

    const detail = entryFor('GET', '/api/tasks/:id');
    expect(detail?.count).toBe(1);
    expect(detail?.status['4xx']).toBe(1);

    const list = entryFor('GET', '/api/tasks');
    expect(list?.count).toBe(1);
    expect(list?.status['2xx']).toBe(1);
    expect(list?.meanBytes).toBeGreaterThan(0);
    // Auth, tenancy and the list itself: counted through the query observer.
    expect(list?.meanQueries).toBeGreaterThan(2);

    const livez = entryFor('GET', '/livez');
    expect(livez?.meanQueries).toBe(0);
  });

  it('collapses unknown paths into one bounded series', async () => {
    await withServer(createApp(), async (server) => {
      for (let i = 0; i < 30; i += 1) {
        await request(server).get(`/no-such-route-${i}/${randomUUID()}`);
      }
    });
    const snapshot = getRouteTimingSnapshot();
    expect(snapshot.filter((entry) => entry.route === 'UNMATCHED')).toHaveLength(1);
    expect(entryFor('GET', 'UNMATCHED')?.count).toBe(30);
    expect(snapshot.length).toBeLessThanOrEqual(MAX_SERIES);
  });

  it('logs slow, query-heavy and sampled requests with bounded fields only', async () => {
    const slowLog = captureLogger();
    const slowApp = express();
    slowApp.use(routeTiming({ logger: slowLog.logger, slowMs: 40, maxQueries: 1_000, sampleRate: 0 }));
    slowApp.get('/__timing/slow/:id', async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      res.json({ ok: true });
    });
    slowApp.get('/__timing/fast', (_req, res) => {
      res.status(204).end();
    });
    await request(slowApp).get('/__timing/slow/abc123?q=private');
    await request(slowApp).get('/__timing/fast');

    expect(slowLog.lines.filter((line) => line.evt === 'route_timing')).toHaveLength(1);
    const slow = slowLog.lines.find((line) => line.reason === 'slow');
    expect(slow).toMatchObject({
      method: 'GET',
      route: '/__timing/slow/:id',
      status: 200,
      queries: 0,
      auth: 'anon',
    });
    expect(Number(slow?.durationMs)).toBeGreaterThanOrEqual(40);
    expect(['50-100ms', '100-250ms', '250-500ms', '500ms-1s']).toContain(slow?.bucket);
    expect(slow?.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(slowLog.lines)).not.toContain('abc123');
    expect(JSON.stringify(slowLog.lines)).not.toContain('private');

    const heavyLog = captureLogger();
    const heavyApp = express();
    heavyApp.use(routeTiming({ logger: heavyLog.logger, slowMs: 60_000, maxQueries: 3, sampleRate: 0 }));
    heavyApp.get('/__timing/many', async (_req, res) => {
      for (let i = 0; i < 5; i += 1) await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    });
    await request(heavyApp).get('/__timing/many');
    expect(heavyLog.lines.filter((line) => line.evt === 'route_timing')).toMatchObject([
      { reason: 'queries', route: '/__timing/many', queries: 5 },
    ]);

    // Sampling picks up ordinary requests when enabled.
    const sampled = captureLogger();
    const sampledApp = express();
    sampledApp.use(routeTiming({ logger: sampled.logger, slowMs: 60_000, sampleRate: 0.5, random: () => 0.1 }));
    sampledApp.get('/__timing/fast', (_req, res) => {
      res.status(204).end();
    });
    await request(sampledApp).get('/__timing/fast');
    expect(sampled.lines.filter((line) => line.evt === 'route_timing')).toMatchObject([
      { reason: 'sample', route: '/__timing/fast', status: 204, queries: 0 },
    ]);
  });

  it('logs slow Prisma queries with request context and without parameter values', async () => {
    const { logger, lines } = captureLogger();
    const app = express();
    app.use(routeTiming({ logger, slowMs: 60_000 }));
    app.get('/__timing/db/:id', async (_req, res) => {
      await prisma.$queryRaw`SELECT pg_sleep(${0.08})::text AS slept, ${'parameter-value-must-not-leak'}::text AS v`;
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    });

    const res = await request(app).get('/__timing/db/xyz789').set('x-request-id', 'req-slow-1');
    expect(res.status).toBe(200);

    const slowQueries = lines.filter((line) => line.evt === 'slow_query' && line.route === '/__timing/db/:id');
    expect(slowQueries).toHaveLength(1);
    expect(slowQueries[0]).toMatchObject({
      route: '/__timing/db/:id',
      method: 'GET',
      thresholdMs: 50,
    });
    expect(slowQueries[0].durationMs).toBeGreaterThanOrEqual(50);
    expect(String(slowQueries[0].sql)).toContain('pg_sleep');
    expect(String(slowQueries[0].sql)).toMatch(/\$1/);
    expect(JSON.stringify(lines)).not.toContain('parameter-value-must-not-leak');
    expect(JSON.stringify(lines)).not.toContain('xyz789');

    const entry = entryFor('GET', '/__timing/db/:id');
    expect(entry?.meanQueries).toBe(2);
    expect(entry?.meanQueryMs).toBeGreaterThanOrEqual(50);
  });

  it('is a no-op when disabled', async () => {
    const { logger, lines } = captureLogger();
    const app = express();
    app.use(routeTiming({ enabled: false, logger, slowMs: 0, sampleRate: 1 }));
    app.get('/__timing/off', (_req, res) => {
      res.json({ ok: true });
    });
    await request(app).get('/__timing/off');
    expect(lines).toHaveLength(0);
    expect(entryFor('GET', '/__timing/off')).toBeUndefined();
  });
});
