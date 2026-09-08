import type { NextFunction, Request, Response } from 'express';
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { createApp, buildErrorHandler } from '@openlinear/api/app';
import executionRouter from './routes/execution';
import opencodeRouter from './routes/opencode';
import batchesRouter from './routes/batches';
import transcribeRouter from './routes/transcribe';

function makeRateLimiter(windowMs: number, max: number, name: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path === '/api/events' || req.path.startsWith('/api/events'),
    handler: (_req, res) => {
      res.status(429).json({
        error: 'rate_limited',
        scope: name,
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      });
    },
  });
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Per the Fetch metadata spec, these are the values a *same-origin or
// same-site* (or non-browser) request can carry. Anything else (e.g.
// "cross-site") means the request originated from a different site than the
// one the browser has open, which is exactly the shape of a CSRF request.
const SAFE_SEC_FETCH_SITE_VALUES = new Set(['same-origin', 'same-site', 'none']);

/**
 * Builds the same trusted-origin allowlist as `apps/api/src/app.ts`'s
 * `buildCorsOrigin()`/`addLoopbackAliases()` — same `CORS_ORIGIN` env var,
 * same localhost/127.0.0.1 aliasing, same Tauri origins. That helper isn't
 * exported from the API package, so this mirrors it rather than diverging
 * from it; if the two ever need to be shared for real, export one from
 * `@openlinear/api/app` and import it here instead of maintaining two copies.
 */
function buildTrustedOriginAllowlist(): Set<string> {
  const allowed = new Set<string>();

  const addLoopbackAliases = (origin: string) => {
    allowed.add(origin);
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if (url.hostname === 'localhost') {
        url.hostname = '127.0.0.1';
        allowed.add(url.toString().replace(/\/$/, ''));
      } else if (url.hostname === '127.0.0.1' || url.hostname === '[::1]') {
        url.hostname = 'localhost';
        allowed.add(url.toString().replace(/\/$/, ''));
      }
    } catch {
      // Non-URL origins such as Tauri schemes are already added above.
    }
  };

  const raw = process.env.CORS_ORIGIN || 'http://localhost:3000';
  for (const origin of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    addLoopbackAliases(origin);
  }
  addLoopbackAliases('tauri://localhost');
  addLoopbackAliases('https://tauri.localhost');

  return allowed;
}

/**
 * Defends against two threats CORS alone does not stop (see C6a F5):
 *
 * 1. DNS rebinding — a page on an attacker's domain whose DNS resolves to
 *    127.0.0.1 becomes "same host" as the sidecar in the browser's eyes.
 *    Checking the `Host` header the request actually arrived with (which a
 *    rebound page cannot spoof — it's set by the HTTP client, not by JS)
 *    closes that gap.
 * 2. Simple-request CSRF — POST/PATCH/PUT/DELETE requests with a body type
 *    that doesn't force a CORS preflight (e.g. `text/plain`) are delivered
 *    to the server even though the browser wouldn't let the page read the
 *    response. Requiring the `Origin` (when present) to be one we trust, and
 *    `Sec-Fetch-Site` (when present) to be same-origin/same-site/none, stops
 *    the request from having a side effect in the first place.
 */
export function createHostOriginGuard(port: number) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = buildTrustedOriginAllowlist();

  return function hostOriginGuard(req: Request, res: Response, next: NextFunction): void {
    const host = req.headers.host;
    if (!host || !allowedHosts.has(host)) {
      res.status(403).json({ error: 'forbidden_host' });
      return;
    }

    if (STATE_CHANGING_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && !allowedOrigins.has(origin)) {
        res.status(403).json({ error: 'forbidden_origin' });
        return;
      }

      const secFetchSite = req.headers['sec-fetch-site'];
      if (typeof secFetchSite === 'string' && !SAFE_SEC_FETCH_SITE_VALUES.has(secFetchSite)) {
        res.status(403).json({ error: 'forbidden_origin' });
        return;
      }
    }

    next();
  };
}

export function createSidecarApp(options: { port?: number } = {}) {
  const app = createApp();
  const port = options.port ?? Number(process.env.API_PORT ?? 3001);

  // Mounted ahead of every sidecar-owned router below so none of them can be
  // reached with a spoofed Host or a cross-site simple request. Note: this
  // cannot retroactively protect the cloud-API routers `createApp()` already
  // mounted internally (they run earlier in the stack) — see C6a F1 for the
  // separate, larger fix of not mounting the full cloud API in the sidecar.
  app.use(createHostOriginGuard(port));

  app.use('/api/tasks', executionRouter);
  app.use('/api/opencode', opencodeRouter);
  app.use('/api/batches', batchesRouter);
  app.use('/api/transcribe', transcribeRouter);

  // Re-mount the shared JSON error envelope handler AFTER sidecar routes so
  // their `next(error)` calls produce structured JSON instead of falling
  // through to Express's default HTML 404 page. See buildErrorHandler() docs.
  app.use(buildErrorHandler());

  return app;
}
