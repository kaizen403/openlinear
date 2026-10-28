import http, { type Server } from 'node:http';
import express, { type NextFunction, type Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthedRequest, SidecarPrincipal } from '../auth/principal';
import { createErrorHandler, HttpError } from '../lib/errors';

/**
 * W19a routes: authenticated; the person who ran the task is served
 * directly, anyone else is authorized by the control plane (`write` to
 * start/cancel, `full` to read); no v2 engine = nothing to list and no
 * review to start.
 */

vi.mock('../auth/principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/principal')>();
  return {
    ...actual,
    requireSidecarAuth: (req: AuthedRequest, res: Response, next: NextFunction) => {
      const token = actual.bearerFrom(req);
      if (!token) {
        res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED', message: 'Authentication required' });
        return;
      }
      const principal: SidecarPrincipal = { userId: token, authSource: 'session', scopes: [], workspaceRestriction: null, tokenHash: 'h' };
      req.principal = principal;
      req.credential = { principal, token };
      req.userId = principal.userId;
      next();
    },
  };
});

const access = vi.hoisted(() => ({ calls: [] as Array<{ userId: string; taskId: string; level: string }>, allow: true }));
vi.mock('../auth/task-access', () => ({
  authorizeTaskAccess: async (credential: { principal: { userId: string } }, taskId: string, level: string) => {
    access.calls.push({ userId: credential.principal.userId, taskId, level });
    if (!access.allow) throw new HttpError(403, 'FORBIDDEN', 'No access to this task');
  },
}));

const engine = vi.hoisted(() => ({
  active: true,
  started: [] as Array<{ taskId: string; userId: string }>,
  cancelled: [] as string[],
  cancelResult: true,
  noRun: false,
}));
vi.mock('../run/index', () => ({
  runEngineActive: () => engine.active,
  getRunService: () => ({ reviewSubject: () => (engine.noRun ? { ok: false } : { ok: true, subject: { userId: 'owner' } }) }),
  getReviewer: () => ({
    start: async (taskId: string, userId: string) => {
      engine.started.push({ taskId, userId });
      return { id: 'rev-1', taskId, status: 'running', bootId: 'boot', findings: [] };
    },
    list: async (taskId: string) => [{ id: 'rev-1', taskId, status: 'completed', findings: [], headCommit: null }],
    isReviewing: () => false,
    cancel: (_taskId: string, reviewId: string) => {
      engine.cancelled.push(reviewId);
      return engine.cancelResult;
    },
  }),
}));

const { default: reviewsRouter } = await import('./reviews');

let server: Server | undefined;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', reviewsRouter);
  app.use(createErrorHandler());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(() => {
  access.calls.length = 0;
  access.allow = true;
  engine.active = true;
  engine.started.length = 0;
  engine.cancelled.length = 0;
  engine.cancelResult = true;
  engine.noRun = false;
});

async function call(method: 'GET' | 'POST', path: string, user: string | null): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, { method, headers: user ? { authorization: `Bearer ${user}` } : {} });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

describe('W19a review routes', () => {
  it('authenticates every route', async () => {
    expect((await call('POST', '/api/tasks/t1/reviews', null)).status).toBe(401);
    expect((await call('GET', '/api/tasks/t1/reviews', null)).status).toBe(401);
    expect((await call('POST', '/api/tasks/t1/reviews/rev-1/cancel', null)).status).toBe(401);
  });

  it('the run owner starts, lists and cancels without a control-plane check', async () => {
    const started = await call('POST', '/api/tasks/t1/reviews', 'owner');
    expect(started.status).toBe(202);
    expect(started.json.review).toEqual({ id: 'rev-1', taskId: 't1', status: 'running', findings: [], headCommit: null });
    expect(engine.started).toEqual([{ taskId: 't1', userId: 'owner' }]);
    expect(await call('GET', '/api/tasks/t1/reviews', 'owner')).toEqual({ status: 200, json: { reviews: [{ id: 'rev-1', taskId: 't1', status: 'completed', findings: [], headCommit: null }], reviewing: false } });
    expect(await call('POST', '/api/tasks/t1/reviews/rev-1/cancel', 'owner')).toEqual({ status: 202, json: { cancelled: true } });
    expect(access.calls).toEqual([]);
  });

  it('like the local diff, nobody but the run owner sees or starts a run\'s reviews', async () => {
    expect(await call('POST', '/api/tasks/t1/reviews', 'member')).toMatchObject({ status: 403, json: { code: 'RUN_PRINCIPAL_MISMATCH' } });
    expect(await call('GET', '/api/tasks/t1/reviews', 'member')).toMatchObject({ status: 403, json: { code: 'RUN_PRINCIPAL_MISMATCH' } });
    expect(await call('POST', '/api/tasks/t1/reviews/rev-1/cancel', 'member')).toMatchObject({ status: 403, json: { code: 'RUN_PRINCIPAL_MISMATCH' } });
    expect(engine.started).toEqual([]);
    expect(access.calls).toEqual([]);
  });

  it('without a run on this device the control plane decides (full to read)', async () => {
    engine.noRun = true;
    expect((await call('GET', '/api/tasks/t1/reviews', 'member')).status).toBe(200);
    expect(access.calls.map((entry) => entry.level)).toEqual(['full']);
    access.allow = false;
    expect(await call('GET', '/api/tasks/t1/reviews', 'stranger')).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
  });

  it('a review that is not running cannot be cancelled; no v2 engine means nothing to review', async () => {
    engine.cancelResult = false;
    expect(await call('POST', '/api/tasks/t1/reviews/rev-9/cancel', 'owner')).toMatchObject({ status: 404, json: { code: 'REVIEW_NOT_RUNNING' } });
    engine.active = false;
    expect(await call('GET', '/api/tasks/t1/reviews', 'owner')).toEqual({ status: 200, json: { reviews: [], reviewing: false } });
    expect(await call('POST', '/api/tasks/t1/reviews', 'owner')).toMatchObject({ status: 409, json: { code: 'REVIEW_UNSUPPORTED' } });
  });
});
