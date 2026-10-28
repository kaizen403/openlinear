/**
 * Route timing (performance plan, Phase 0).
 *
 * One middleware, mounted once in `createApp()`, that records for every
 * request: the route TEMPLATE (never the raw path), method, status, response
 * bytes, duration, a coarse duration bucket, the auth source, and the number
 * and total time of Prisma queries the request issued (counted through an
 * AsyncLocalStorage store and the `@openlinear/db` query observer).
 *
 * Cost and cardinality are bounded:
 *  - labels are the route templates from `ROUTE_REGISTRY` (plus Express route
 *    templates for routers mounted outside it, e.g. the sidecar), capped at
 *    MAX_SERIES; anything else is `UNMATCHED` / `OTHER`;
 *  - per-series state is one fixed-size histogram;
 *  - nothing from the query string, body, headers or parameter values is
 *    recorded.
 *
 * Logging (pino, `evt: 'route_timing'`), all optional and env-driven:
 *  - OPENLINEAR_ROUTE_TIMING=off            disable the middleware entirely
 *  - OPENLINEAR_ROUTE_TIMING_SLOW_MS        log requests at or above this
 *                                           (default 250 in production, 100 otherwise)
 *  - OPENLINEAR_ROUTE_TIMING_MAX_QUERIES    log requests issuing more queries (default 25)
 *  - OPENLINEAR_ROUTE_TIMING_SAMPLE         fraction (0..1) of other requests to log (default 0)
 *  - OPENLINEAR_ROUTE_TIMING_SUMMARY_MS     log a per-route p50/p95/p99 summary at this
 *                                           interval and start a new window (default off)
 *
 * Slow Prisma queries (threshold from OPENLINEAR_SLOW_QUERY_MS, see
 * packages/db/src/query-observer.ts) are logged here with the route and
 * request id of the request that issued them (`evt: 'slow_query'`).
 *
 * `getRouteTimingSnapshot()` returns the aggregated per-route percentiles for
 * in-process consumers (tests, a future internal metrics endpoint).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { setQueryObserver, type QueryObservation } from '@openlinear/db';
import { durationBucket, LatencyHistogram, type LatencySummary } from '../lib/latency-histogram';
import { logger as defaultLogger } from '../logger';
import { ROUTE_REGISTRY } from '../registry';
import type { AuthRequest } from './auth';

// ─── Route templates ─────────────────────────────────────────────────────────

interface CompiledTemplate {
  template: string;
  pattern: RegExp;
  staticSegments: number;
  segments: number;
}

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTemplate(template: string): CompiledTemplate {
  const parts = template.split('/').filter(Boolean);
  const source = parts
    .map((part) => (part.startsWith(':') ? '/[^/]+' : `/${escapeRegExp(part)}`))
    .join('');
  return {
    template,
    pattern: new RegExp(`^${source || '/'}/?$`, 'i'),
    staticSegments: parts.filter((part) => !part.startsWith(':')).length,
    segments: parts.length,
  };
}

export type RouteTemplateMatcher = (method: string, path: string) => string | null;

/**
 * Build a matcher from `{ method, path }` route declarations. Static segments
 * win over parameters (`/api/tasks/archived` before `/api/tasks/:id`), as
 * Express resolves them in this codebase.
 */
export function createRouteTemplateMatcher(
  routes: ReadonlyArray<{ method: string; path: string }>,
): RouteTemplateMatcher {
  const byMethod = new Map<string, CompiledTemplate[]>();
  for (const route of routes) {
    const method = route.method.toUpperCase();
    const list = byMethod.get(method) ?? [];
    list.push(compileTemplate(route.path));
    byMethod.set(method, list);
  }
  for (const list of byMethod.values()) {
    list.sort((a, b) => b.staticSegments - a.staticSegments || b.segments - a.segments);
  }
  return (method, path) => {
    const candidates = byMethod.get(method === 'HEAD' ? 'GET' : method.toUpperCase());
    if (!candidates) return null;
    for (const candidate of candidates) {
      if (candidate.pattern.test(path)) return candidate.template;
    }
    return null;
  };
}

const registryMatcher = createRouteTemplateMatcher(ROUTE_REGISTRY);

function pathOf(req: Request): string {
  const url = req.originalUrl || req.url || '/';
  const queryAt = url.indexOf('?');
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

/** Template from Express itself, for routes mounted outside the registry (sidecar). */
function expressTemplate(req: Request): string | null {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath !== 'string') return null;
  return `${req.baseUrl ?? ''}${routePath}` || '/';
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/** Hard cap on distinct (method, route) series held in memory. */
export const MAX_SERIES = 512;

interface RouteSeries {
  method: string;
  route: string;
  latency: LatencyHistogram;
  status: { '2xx': number; '3xx': number; '4xx': number; '5xx': number };
  bytes: number;
  queries: number;
  queryMs: number;
  maxQueries: number;
  aborted: number;
  streams: number;
}

export interface RouteTimingSnapshotEntry extends LatencySummary {
  method: string;
  route: string;
  status: RouteSeries['status'];
  meanBytes: number;
  meanQueries: number;
  maxQueries: number;
  meanQueryMs: number;
  aborted: number;
  streams: number;
}

const series = new Map<string, RouteSeries>();

function seriesFor(method: string, route: string): RouteSeries {
  let key = `${method} ${route}`;
  let entry = series.get(key);
  if (entry) return entry;
  if (series.size >= MAX_SERIES) {
    key = 'OTHER OTHER';
    entry = series.get(key);
    if (entry) return entry;
    method = 'OTHER';
    route = 'OTHER';
  }
  entry = {
    method,
    route,
    latency: new LatencyHistogram(),
    status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    bytes: 0,
    queries: 0,
    queryMs: 0,
    maxQueries: 0,
    aborted: 0,
    streams: 0,
  };
  series.set(key, entry);
  return entry;
}

function statusClass(status: number): keyof RouteSeries['status'] {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

/** Per-route aggregate since start (or the last summary window). */
export function getRouteTimingSnapshot(): RouteTimingSnapshotEntry[] {
  const round = (value: number) => Math.round(value * 100) / 100;
  return [...series.values()].map((entry) => {
    const completed = entry.latency.count;
    return {
      method: entry.method,
      route: entry.route,
      ...entry.latency.summary(),
      status: { ...entry.status },
      meanBytes: completed === 0 ? 0 : Math.round(entry.bytes / completed),
      meanQueries: completed === 0 ? 0 : round(entry.queries / completed),
      maxQueries: entry.maxQueries,
      meanQueryMs: completed === 0 ? 0 : round(entry.queryMs / completed),
      aborted: entry.aborted,
      streams: entry.streams,
    };
  });
}

export function resetRouteTiming(): void {
  series.clear();
}

// ─── Per-request context ─────────────────────────────────────────────────────

interface RequestTiming {
  method: string;
  route: string;
  req: Request;
  requestId: string | undefined;
  queries: number;
  queryMs: number;
  slowQueries: number;
}

const requestTiming = new AsyncLocalStorage<RequestTiming>();

/** Registry template, else the Express template once a route has matched. */
function routeOf(store: RequestTiming): string {
  if (store.route === 'UNMATCHED') {
    const fallback = expressTemplate(store.req);
    if (fallback) store.route = fallback;
  }
  return store.route;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface RouteTimingOptions {
  enabled: boolean;
  slowMs: number;
  maxQueries: number;
  sampleRate: number;
  summaryIntervalMs: number;
  logger: Logger;
  /** Injected for tests. */
  random: () => number;
}

function numberFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function resolveRouteTimingOptions(env: NodeJS.ProcessEnv = process.env): Omit<RouteTimingOptions, 'logger' | 'random'> {
  const isProd = env.NODE_ENV === 'production';
  const toggle = env.OPENLINEAR_ROUTE_TIMING?.trim().toLowerCase();
  return {
    enabled: toggle !== 'off' && toggle !== '0' && toggle !== 'false',
    slowMs: numberFromEnv(env.OPENLINEAR_ROUTE_TIMING_SLOW_MS, isProd ? 250 : 100, 0, 600_000),
    maxQueries: numberFromEnv(env.OPENLINEAR_ROUTE_TIMING_MAX_QUERIES, 25, 1, 100_000),
    sampleRate: numberFromEnv(env.OPENLINEAR_ROUTE_TIMING_SAMPLE, 0, 0, 1),
    summaryIntervalMs: numberFromEnv(env.OPENLINEAR_ROUTE_TIMING_SUMMARY_MS, 0, 0, 86_400_000),
  };
}

// ─── Slow queries ────────────────────────────────────────────────────────────

let queryLogger: Logger = defaultLogger;

function observeQuery(observation: QueryObservation): void {
  const store = requestTiming.getStore();
  if (store) {
    store.queries += 1;
    store.queryMs += observation.durationMs;
    if (observation.slow) store.slowQueries += 1;
  }
  if (!observation.slow) return;
  queryLogger.warn(
    {
      evt: 'slow_query',
      durationMs: Math.round(observation.durationMs * 100) / 100,
      thresholdMs: observation.thresholdMs,
      fingerprint: observation.fingerprint(),
      sql: observation.sql(),
      ...(store ? { method: store.method, route: routeOf(store), requestId: store.requestId } : {}),
    },
    'prisma slow query',
  );
}

// ─── Summary window ──────────────────────────────────────────────────────────

let summaryTimer: NodeJS.Timeout | null = null;
const SUMMARY_TOP_N = 25;

function logSummary(log: Logger): void {
  const snapshot = getRouteTimingSnapshot()
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, SUMMARY_TOP_N);
  resetRouteTiming();
  if (snapshot.length === 0) return;
  log.info({ evt: 'route_timing_summary', routes: snapshot }, 'route timing summary');
}

/** Stop the periodic summary (tests, shutdown). */
export function stopRouteTimingSummary(): void {
  if (summaryTimer) clearInterval(summaryTimer);
  summaryTimer = null;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

export function routeTiming(overrides: Partial<RouteTimingOptions> = {}): RequestHandler {
  const options: RouteTimingOptions = {
    ...resolveRouteTimingOptions(),
    logger: defaultLogger,
    random: Math.random,
    ...overrides,
  };
  if (!options.enabled) {
    return (_req, _res, next) => next();
  }

  const log = options.logger;
  queryLogger = log;
  setQueryObserver(observeQuery);

  if (options.summaryIntervalMs > 0 && !summaryTimer) {
    summaryTimer = setInterval(() => logSummary(log), options.summaryIntervalMs);
    summaryTimer.unref();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    const method = KNOWN_METHODS.has(req.method) ? req.method : req.method === 'HEAD' ? 'GET' : 'OTHER';
    const store: RequestTiming = {
      method,
      route: registryMatcher(req.method, pathOf(req)) ?? 'UNMATCHED',
      req,
      requestId: typeof req.id === 'string' ? req.id : undefined,
      queries: 0,
      queryMs: 0,
      slowQueries: 0,
    };

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const route = routeOf(store);
      const status = res.statusCode;
      const aborted = !res.writableFinished;
      const contentType = res.getHeader('content-type');
      const stream = typeof contentType === 'string' && contentType.startsWith('text/event-stream');
      const lengthHeader = res.getHeader('content-length');
      const bytes = lengthHeader === undefined ? undefined : Number(lengthHeader);

      const entry = seriesFor(method, route);
      if (stream) {
        // A stream's lifetime is not a latency; keep it out of the percentiles.
        entry.streams += 1;
      } else {
        entry.latency.record(durationMs);
        entry.status[statusClass(status)] += 1;
        entry.bytes += bytes !== undefined && Number.isFinite(bytes) ? bytes : 0;
        entry.queries += store.queries;
        entry.queryMs += store.queryMs;
        if (store.queries > entry.maxQueries) entry.maxQueries = store.queries;
      }
      if (aborted) entry.aborted += 1;

      let reason: 'slow' | 'queries' | 'sample' | null = null;
      if (!stream && durationMs >= options.slowMs) reason = 'slow';
      else if (store.queries > options.maxQueries) reason = 'queries';
      else if (options.sampleRate > 0 && options.random() < options.sampleRate) reason = 'sample';
      if (!reason) return;

      log.info(
        {
          evt: 'route_timing',
          reason,
          method,
          route,
          status,
          durationMs: Math.round(durationMs * 100) / 100,
          bucket: durationBucket(durationMs),
          ...(bytes !== undefined && Number.isFinite(bytes) ? { bytes } : {}),
          queries: store.queries,
          queryMs: Math.round(store.queryMs * 100) / 100,
          ...(store.slowQueries > 0 ? { slowQueries: store.slowQueries } : {}),
          auth: (req as AuthRequest).authSource ?? 'anon',
          ...(stream ? { stream: true } : {}),
          ...(aborted ? { aborted: true } : {}),
          requestId: store.requestId,
        },
        'route timing',
      );
    };
    res.once('finish', finish);
    res.once('close', finish);
    requestTiming.run(store, next);
  };
}
