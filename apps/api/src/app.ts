import express, {
  Application,
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import labelRoutes from './routes/labels';
import tasksRouter from './routes/tasks';
import settingsRouter from './routes/settings';
import authRouter from './routes/auth';
import reposRouter from './routes/repos';
import teamsRouter from './routes/teams';
import projectsRouter from './routes/projects';
import inboxRouter from './routes/inbox';
import searchRouter from './routes/search';
import commentsRouter from './routes/comments';
import notificationsRouter from './routes/notifications';
import activityLogRouter from './routes/activity-log';
import agentRunsRouter from './routes/agent-runs';
import usageRouter from './routes/usage';
import jwt from 'jsonwebtoken';
import { clients, SSEClient } from './sse';
import { logger } from './logger';
import { isOwnershipError } from './services/ownership';
import { isValidationError, isHttpError } from './errors';
import { Prisma, prisma } from '@openlinear/db';
import { getUserTeamIds } from './services/team-scope';

function buildCorsOrigin(): cors.CorsOptions['origin'] {
  const raw = process.env.CORS_ORIGIN || 'http://localhost:3000';
  const allowed = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  allowed.add('tauri://localhost');
  allowed.add('https://tauri.localhost');

  return (origin, callback) => {
    if (!origin || allowed.has(origin)) {
      callback(null, true);
      return;
    }
    // Bug fix (T4): never throw inside the CORS origin callback — that escapes
    // the Express middleware error-handling chain on some versions and crashes
    // the request. Returning false produces a clean CORS rejection.
    callback(null, false);
  };
}

function makeRateLimiter(windowMs: number, max: number, name: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => {
      if (process.env.NODE_ENV === 'test') return true;
      return req.path === '/api/events' || req.path.startsWith('/api/events');
    },
    handler: (req, res) => {
      res.status(429).json({
        error: 'rate_limited',
        scope: name,
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      });
    },
  });
}

function isMountedGithubOAuthPath(path: string): boolean {
  return path === '/github' || path.startsWith('/github/');
}

export function createApp(): Application {
  const app: Application = express();

  // Security headers — CSP disabled because Tauri owns CSP in the desktop UI
  app.use(
    helmet({
      contentSecurityPolicy: false,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
      },
    }),
  );

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          (typeof incoming === 'string' && incoming) || randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.query.token',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(
    cors({
      origin: buildCorsOrigin(),
      credentials: true,
    }),
  );

  // Rate limiters mount BEFORE body parsing so floods are cheap to reject
  const defaultLimiter = makeRateLimiter(60_000, 100, 'default');
  const authLimiter = makeRateLimiter(60_000, 5, 'auth');
  const githubOAuthLimiter = makeRateLimiter(60_000, 30, 'github-oauth');
  const reposUrlLimiter = makeRateLimiter(60_000, 10, 'repos-url');

  app.use((req, res, next) => {
    if (req.path === '/api/events' || req.path.startsWith('/api/events')) {
      return next();
    }
    return defaultLimiter(req, res, next);
  });
  app.use('/api/auth/github', githubOAuthLimiter);
  app.use('/api/auth', (req, res, next) => {
    if (isMountedGithubOAuthPath(req.path)) {
      return next();
    }
    return authLimiter(req, res, next);
  });
  app.use('/api/repos/url', reposUrlLimiter);

  app.use(express.json({ limit: '256kb' }));

  app.use('/api/auth', authRouter);
  app.use('/api/repos', reposRouter);
  app.use('/api/labels', labelRoutes);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/inbox', inboxRouter);
  app.use('/api', commentsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/activity', activityLogRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/agent-runs', agentRunsRouter);
  app.use('/api/usage', usageRouter);

  app.get('/health', async (req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        clients: clients.size,
        database: 'ok',
      });
    } catch (err) {
      req.log?.warn({ err }, '[Health] database check failed');
      res.status(503).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        clients: clients.size,
        database: 'error',
      });
    }
  });

  app.get('/api/events', async (req: Request, res: Response) => {
    const tokenRaw = req.query.token;
    const token = typeof tokenRaw === 'string' ? tokenRaw : '';
    if (!token) {
      res.status(401).json({ error: 'unauthorized', code: 'SSE_TOKEN_REQUIRED' });
      return;
    }

    const secret =
      process.env.JWT_SECRET ||
      (process.env.NODE_ENV === 'production'
        ? null
        : 'openlinear-dev-secret-change-in-production');
    if (!secret) {
      res.status(500).json({ error: 'server_misconfigured' });
      return;
    }

    let userId: string;
    try {
      const claims = jwt.verify(token, secret) as { userId?: string };
      if (!claims?.userId) {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }
      userId = claims.userId;
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    let teamIds: string[] = [];
    try {
      teamIds = await getUserTeamIds(userId);
    } catch (err) {
      req.log?.warn({ err, userId }, '[SSE] failed to load team memberships');
    }

    const clientId = randomUUID();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const client: SSEClient = { id: clientId, res, userId, teamIds };
    clients.set(clientId, client);

    req.log?.info(
      { clientId, userId, teamCount: teamIds.length, total: clients.size },
      '[SSE] client connected',
    );

    try {
      res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
    } catch (err) {
      req.log?.warn({ err, clientId }, '[SSE] initial write failed');
    }

    const heartbeatInterval = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write(`: heartbeat\n\n`);
      } catch (err) {
        req.log?.debug({ err, clientId }, '[SSE] heartbeat write failed');
        cleanup();
      }
    }, 30000);

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeatInterval);
      clients.delete(clientId);
      req.log?.info(
        { clientId, userId, total: clients.size },
        '[SSE] client disconnected',
      );
    }

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  app.use(buildErrorHandler());

  return app;
}

/**
 * Build the shared JSON error envelope handler.
 *
 * Exported so the sidecar can re-mount it AFTER appending its own routers
 * (executionRouter, batchesRouter, opencodeRouter). Without re-mounting,
 * `next(error)` calls from sidecar routes would fall through to Express's
 * default HTML 404 page, breaking the `{ error, code, message, details }`
 * contract the desktop UI relies on.
 */
export function buildErrorHandler(): ErrorRequestHandler {
  const errorHandler: ErrorRequestHandler = (
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const requestId =
      (res.getHeader('x-request-id') as string | undefined) ??
      (typeof (req as Request & { id?: unknown }).id === 'string'
        ? ((req as Request & { id?: string }).id as string)
        : undefined) ??
      randomUUID();

    const logFn = (req as Request & { log?: typeof logger }).log ?? logger;
    logFn.error({ err, requestId, path: req.path, method: req.method }, 'unhandled error');

    if (res.headersSent) {
      return;
    }

    if (isOwnershipError(err)) {
      const status = err.reason === 'not_found' ? 404 : 403;
      res.status(status).json({
        error: status === 404 ? 'not_found' : 'forbidden',
        code: err.code,
        resourceType: err.resourceType,
        resourceId: err.resourceId,
        ...(err.requiredRoles ? { requiredRoles: err.requiredRoles } : {}),
        requestId,
      });
      return;
    }

    if (isValidationError(err)) {
      res.status(err.statusCode).json({
        error: 'validation_error',
        code: err.code,
        message: err.message || 'Validation failed',
        ...(err.details !== undefined ? { details: err.details } : {}),
        requestId,
      });
      return;
    }

    if (isHttpError(err)) {
      res.status(err.statusCode).json({
        error: err.statusCode >= 500 ? 'internal_error' : 'request_failed',
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
        requestId,
      });
      return;
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const prismaErr = err as Prisma.PrismaClientKnownRequestError;
      if (prismaErr.code === 'P2002') {
        res.status(409).json({
          error: 'conflict',
          code: 'P2002',
          message: 'Unique constraint violation',
          ...(prismaErr.meta ? { details: prismaErr.meta } : {}),
          requestId,
        });
        return;
      }
      if (prismaErr.code === 'P2025') {
        res.status(404).json({
          error: 'not_found',
          code: 'P2025',
          message: 'Record not found',
          requestId,
        });
        return;
      }
      if (prismaErr.code === 'P2003') {
        res.status(409).json({
          error: 'conflict',
          code: 'P2003',
          message: 'Foreign key constraint violation',
          ...(prismaErr.meta ? { details: prismaErr.meta } : {}),
          requestId,
        });
        return;
      }
    }

    const status =
      typeof (err as { statusCode?: unknown })?.statusCode === 'number'
        ? ((err as { statusCode: number }).statusCode)
        : typeof (err as { status?: unknown })?.status === 'number'
          ? ((err as { status: number }).status)
          : 500;

    res.status(status).json({
      error: status >= 500 ? 'internal_error' : 'request_failed',
      code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED',
      requestId,
    });
  };
  return errorHandler;
}
