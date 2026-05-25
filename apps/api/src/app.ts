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
import patsRouter from './routes/pats';
import authRouter from './routes/auth';
import reposRouter from './routes/repos';
import teamsRouter from './routes/teams';
import projectsRouter from './routes/projects';
import workspacesRouter from './routes/workspaces';
import inboxRouter from './routes/inbox';
import searchRouter from './routes/search';
import commentsRouter from './routes/comments';
import notificationsRouter from './routes/notifications';
import activityLogRouter from './routes/activity-log';
import agentRunsRouter from './routes/agent-runs';
import usageRouter from './routes/usage';
import dashboardRouter from './routes/dashboard';
import mcpUsageRouter from './routes/mcp-usage';
import chatRouter from './routes/chat';
import chatAttachmentsRouter from './routes/chat-attachments';
import eventsRouter from './routes/events';
import usersRouter from './routes/users';
import invitationsRouter from './routes/invitations';
import membersRouter from './routes/members';
import ssoRouter from './routes/sso';
import auditRouter from './routes/audit';
import sessionsRouter from './routes/sessions';
import totpRouter from './routes/totp';
import { clients } from './sse';
import { logger } from './logger';
import { isOwnershipError } from './services/ownership';
import { isValidationError, isHttpError } from './errors';
import { buildErrorEnvelope } from './lib/http';
import { Prisma, prisma } from '@openlinear/db';
import { requireAuth } from './middleware/auth';

function addLoopbackAliases(allowed: Set<string>, origin: string) {
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
}

function buildCorsOrigin(): cors.CorsOptions['origin'] {
  const raw = process.env.CORS_ORIGIN || 'http://localhost:3000';
  const allowed = new Set<string>();
  for (const origin of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    addLoopbackAliases(allowed, origin);
  }
  addLoopbackAliases(allowed, 'tauri://localhost');
  addLoopbackAliases(allowed, 'https://tauri.localhost');

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
      const retryAfterSeconds = Math.ceil(windowMs / 1000);
      res.status(429).json(buildErrorEnvelope(
        'RATE_LIMITED',
        'Too many requests',
        {
          details: { scope: name, retryAfterSeconds },
          extras: { scope: name, retryAfterSeconds },
        },
      ));
    },
  });
}

function isMountedGithubOAuthPath(path: string): boolean {
  return path === '/github' || path.startsWith('/github/');
}

function isGithubOAuthPath(path: string): boolean {
  return path === '/api/auth/github' || path.startsWith('/api/auth/github/');
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
  const authLimiter = makeRateLimiter(60_000, 60, 'auth');
  const githubOAuthLimiter = makeRateLimiter(60_000, 120, 'github-oauth');
  const reposUrlLimiter = makeRateLimiter(60_000, 10, 'repos-url');

  app.use((req, res, next) => {
    if (req.path === '/api/events' || req.path.startsWith('/api/events')) {
      return next();
    }
    if (req.path === '/health' || isGithubOAuthPath(req.path)) {
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
  app.use('/api/auth/2fa', totpRouter);
  app.use('/api/repos', reposRouter);
  app.use('/api/labels', labelRoutes);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/pats', requireAuth, patsRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/workspaces', workspacesRouter);
  app.use('/api/inbox', inboxRouter);
  app.use('/api', commentsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/activity', activityLogRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/agent-runs', agentRunsRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/mcp', mcpUsageRouter);
   app.use('/api/chat/attachments', chatAttachmentsRouter);
   app.use('/api/chat', chatRouter);
  app.use('/uploads', express.static('uploads'));
  app.use('/api/events', eventsRouter);
  app.use('/api/users', requireAuth, usersRouter);
  app.use('/api/invitations', requireAuth, invitationsRouter);
app.use('/api/members', requireAuth, membersRouter);
  app.use('/api', ssoRouter);
  app.use('/api/workspaces', auditRouter);
  app.use('/api/sessions', sessionsRouter);

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
      res.status(status).json(buildErrorEnvelope(
        err.code,
        status === 404 ? 'Resource not found' : 'Required role is missing',
        {
          requestId,
          details: {
            resourceType: err.resourceType,
            resourceId: err.resourceId,
            ...(err.requiredRoles ? { requiredRoles: err.requiredRoles } : {}),
          },
          extras: {
            resourceType: err.resourceType,
            resourceId: err.resourceId,
            ...(err.requiredRoles ? { requiredRoles: err.requiredRoles } : {}),
          },
        },
      ));
      return;
    }

    if (isValidationError(err)) {
      res.status(err.statusCode).json(buildErrorEnvelope(
        err.code,
        err.message || 'Validation failed',
        {
          requestId,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      ));
      return;
    }

    if (isHttpError(err)) {
      res.status(err.statusCode).json(buildErrorEnvelope(
        err.code,
        err.message,
        {
          requestId,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      ));
      return;
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const prismaErr = err as Prisma.PrismaClientKnownRequestError;
      if (prismaErr.code === 'P2002') {
        res.status(409).json(buildErrorEnvelope(
          'P2002',
          'Unique constraint violation',
          {
            requestId,
            ...(prismaErr.meta ? { details: prismaErr.meta } : {}),
          },
        ));
        return;
      }
      if (prismaErr.code === 'P2025') {
        res.status(404).json(buildErrorEnvelope(
          'P2025',
          'Record not found',
          { requestId },
        ));
        return;
      }
      if (prismaErr.code === 'P2003') {
        res.status(409).json(buildErrorEnvelope(
          'P2003',
          'Foreign key constraint violation',
          {
            requestId,
            ...(prismaErr.meta ? { details: prismaErr.meta } : {}),
          },
        ));
        return;
      }
    }

    const status =
      typeof (err as { statusCode?: unknown })?.statusCode === 'number'
        ? ((err as { statusCode: number }).statusCode)
        : typeof (err as { status?: unknown })?.status === 'number'
          ? ((err as { status: number }).status)
          : 500;

    res.status(status).json(buildErrorEnvelope(
      status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED',
      status >= 500 ? 'Internal server error' : 'Request failed',
      { requestId },
    ));
  };
  return errorHandler;
}
