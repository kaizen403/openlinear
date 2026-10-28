import express, { type NextFunction, type Request, type Response } from 'express';
import http, { type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, createErrorHandler } from '../lib/errors';

/**
 * W13a route wiring: in API persistence with the v2 engine, /api/batches goes
 * to the batch coordinator and never to the legacy (Prisma) engine; only the
 * creator sees a batch; members are authorized before anything starts; the
 * user's max batch size applies; the legacy engine in API mode fails closed.
 */
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(async (_credential: unknown, _taskId: unknown): Promise<void> => undefined),
  runEngineActive: vi.fn(() => true),
  loadBatchServices: vi.fn(),
  getSettings: vi.fn(async () => ({ queueAutoApprove: true, stopOnFailure: true, maxBatchSize: 3 })),
  coordinator: {
    create: vi.fn(),
    view: vi.fn(),
    active: vi.fn(() => []),
    cancel: vi.fn(async () => undefined),
    cancelTask: vi.fn(async () => undefined),
    approveNext: vi.fn(),
  },
}));

vi.mock('../auth/principal', () => ({
  requireSidecarAuth: (req: Request & { credential?: unknown }, _res: Response, next: NextFunction) => {
    const userId = req.headers['x-test-user'] === 'other' ? 'user-2' : 'user-1';
    req.credential = { principal: { userId, authSource: 'session', scopes: [], workspaceRestriction: null, tokenHash: 'h' }, token: `token-${userId}` };
    next();
  },
  credentialOf: (req: Request & { credential?: unknown }) => req.credential,
}));
vi.mock('../auth/task-access', () => ({ authorizeTaskAccess: mocks.authorize }));
vi.mock('../persistence/store', () => ({ resolvePersistenceMode: () => 'api', getSidecarStore: vi.fn() }));
vi.mock('../persistence/prisma-loader', () => ({ loadBatchServices: mocks.loadBatchServices }));
vi.mock('../config/cloud-api', () => ({ createPrincipalClient: () => ({ getSettings: mocks.getSettings }) }));
vi.mock('../run/index', () => ({ runEngineActive: mocks.runEngineActive, getBatchCoordinator: () => mocks.coordinator }));

const { default: router } = await import('./batches');

let server: Server | undefined;
let base = '';

function view(overrides: { userId?: string; status?: string; mode?: string } = {}) {
  return {
    batch: { batchId: 'b1', userId: overrides.userId ?? 'user-1', mode: overrides.mode ?? 'parallel', status: overrides.status ?? 'running', settings: {}, cancelRequestedAt: null, createdAt: 0, updatedAt: 0, finishedAt: null },
    members: [
      { batchId: 'b1', position: 0, taskId: 't1', title: 'Fix login', runId: 'run-1', outcome: null, error: null, finalStatus: null, updatedAt: 0, status: 'running', runState: 'running', prUrl: null, startedAt: 1, finishedAt: null },
      { batchId: 'b1', position: 1, taskId: 't2', title: '', runId: null, outcome: null, error: null, finalStatus: null, updatedAt: 0, status: 'queued', runState: null, prUrl: null, startedAt: null, finishedAt: null },
    ],
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/batches', router);
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
  vi.clearAllMocks();
  mocks.runEngineActive.mockReturnValue(true);
  mocks.authorize.mockImplementation(async () => undefined);
  mocks.getSettings.mockImplementation(async () => ({ queueAutoApprove: true, stopOnFailure: true, maxBatchSize: 3 }));
  mocks.coordinator.view.mockImplementation(() => view());
  mocks.coordinator.create.mockImplementation(async () => view());
  mocks.coordinator.approveNext.mockImplementation(async () => view({ mode: 'queue' }));
});

async function call(method: string, path: string, body?: unknown, user?: 'other') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

describe('W13a /api/batches on the v2 engine', () => {
  it('creates through the coordinator with the user\'s queue settings, after authorizing every member', async () => {
    const res = await call('POST', '/api/batches', { taskIds: ['t1', 't2'], mode: 'queue' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'b1', status: 'running', tasks: [{ taskId: 't1', title: 'Fix login', branch: 'openlinear/run-1' }, { taskId: 't2', branch: '' }] });
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.coordinator.create).toHaveBeenCalledWith(expect.objectContaining({ taskIds: ['t1', 't2'], mode: 'queue', settings: { autoApprove: true, stopOnFailure: true } }));
    expect(mocks.loadBatchServices).not.toHaveBeenCalled();
  });

  it('refuses before starting anything: an unauthorized member, too many tasks, invalid bodies', async () => {
    mocks.authorize.mockImplementation(async (_credential: unknown, taskId: unknown) => {
      if (taskId === 't2') throw new HttpError(403, 'OWNERSHIP_REQUIRED', 'no access');
    });
    expect((await call('POST', '/api/batches', { taskIds: ['t1', 't2'], mode: 'parallel' })).status).toBe(403);
    const tooMany = await call('POST', '/api/batches', { taskIds: ['a', 'b', 'c', 'd'], mode: 'parallel' });
    expect(tooMany).toMatchObject({ status: 400, body: { code: 'INVALID_BATCH', details: { maxBatchSize: 3 } } });
    expect((await call('POST', '/api/batches', { taskIds: ['a', 'a'], mode: 'parallel' })).status).toBe(400);
    expect(mocks.coordinator.create).not.toHaveBeenCalled();
  });

  it('falls back to default settings when the token cannot read them', async () => {
    mocks.getSettings.mockImplementation(async () => { throw new Error('INSUFFICIENT_SCOPE'); });
    await call('POST', '/api/batches', { taskIds: ['t1'], mode: 'queue' });
    expect(mocks.coordinator.create).toHaveBeenCalledWith(expect.objectContaining({ settings: { autoApprove: false, stopOnFailure: false } }));
  });

  it('only the creator sees and controls a batch', async () => {
    const own = await call('GET', '/api/batches/b1');
    expect(own).toMatchObject({ status: 200, body: { id: 'b1', engine: 'v2', prUrl: null, progress: { total: 2, running: 1, queued: 1 } } });
    for (const [method, path] of [['GET', '/api/batches/b1'], ['POST', '/api/batches/b1/cancel'], ['POST', '/api/batches/b1/approve'], ['POST', '/api/batches/b1/tasks/t1/cancel']] as const) {
      const res = await call(method, path, method === 'POST' ? {} : undefined, 'other');
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(mocks.coordinator.cancel).not.toHaveBeenCalled();
    expect(mocks.coordinator.approveNext).not.toHaveBeenCalled();
  });

  it('cancel, member cancel, approve and the active list reach the coordinator', async () => {
    expect((await call('POST', '/api/batches/b1/cancel', {})).body).toEqual({ success: true });
    expect(mocks.coordinator.cancel).toHaveBeenCalledWith('b1');
    await call('POST', '/api/batches/b1/tasks/t2/cancel', {});
    expect(mocks.coordinator.cancelTask).toHaveBeenCalledWith('b1', 't2');
    const approved = await call('POST', '/api/batches/b1/approve', {});
    expect(approved.body).toMatchObject({ id: 'b1', mode: 'queue', tasks: [{ taskId: 't1' }, { taskId: 't2' }] });
    mocks.coordinator.active.mockImplementation(() => [view()] as never);
    expect((await call('GET', '/api/batches')).body).toEqual([{ id: 'b1', status: 'running', mode: 'parallel', taskCount: 2, createdAt: new Date(0).toISOString() }]);
  });

  it('with the legacy engine selected, API mode still fails closed', async () => {
    mocks.runEngineActive.mockReturnValue(false);
    const res = await call('POST', '/api/batches', { taskIds: ['t1'], mode: 'parallel' });
    expect(res).toMatchObject({ status: 501, body: { code: 'BATCH_REQUIRES_API_PERSISTENCE' } });
    expect(mocks.loadBatchServices).not.toHaveBeenCalled();
  });
});
