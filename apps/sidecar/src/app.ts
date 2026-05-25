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

export function createSidecarApp() {
  const app = createApp();

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
