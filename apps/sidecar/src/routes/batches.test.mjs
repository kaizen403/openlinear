import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBatch: vi.fn(),
  startBatch: vi.fn(),
  cancelBatch: vi.fn(),
  cancelTask: vi.fn(),
  getBatch: vi.fn(),
  getActiveBatches: vi.fn(),
  approveNextTask: vi.fn(),
  assertTaskOwned: vi.fn(),
  decryptToken: vi.fn((value) => (value ? `decrypted:${value}` : null)),
  userFindUnique: vi.fn(),
  toBatchStatusResponse: vi.fn((batch) => ({ mapped: 'status', id: batch.id })),
  toBatchTaskSummaries: vi.fn((batch) => batch.tasks.map((t) => ({ taskId: t.taskId }))),
  toCreateBatchResponse: vi.fn((batch) => ({ mapped: 'created', id: batch.id })),
}));

vi.mock('@openlinear/db', () => ({
  decryptToken: mocks.decryptToken,
  prisma: {
    user: { findUnique: mocks.userFindUnique },
  },
}));

// Mirrors requireAuth's observable contract: no proof of identity, no access
// at all — the fix for C6a F4 (this router previously used `optionalAuth`).
vi.mock('@openlinear/api/middleware', () => ({
  requireAuth: (req, res, next) => {
    const userId = req.get('x-user-id');
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.userId = userId;
    next();
  },
}));

vi.mock('@openlinear/api/ownership', () => ({
  assertTaskOwned: mocks.assertTaskOwned,
}));

vi.mock('@openlinear/execution-core', () => ({
  toBatchStatusResponse: mocks.toBatchStatusResponse,
  toBatchTaskSummaries: mocks.toBatchTaskSummaries,
  toCreateBatchResponse: mocks.toCreateBatchResponse,
}));

vi.mock('../services/batch', () => ({
  createBatch: mocks.createBatch,
  startBatch: mocks.startBatch,
  cancelBatch: mocks.cancelBatch,
  cancelTask: mocks.cancelTask,
  getBatch: mocks.getBatch,
  getActiveBatches: mocks.getActiveBatches,
  approveNextTask: mocks.approveNextTask,
}));

const { default: batchesRouter } = await import('./batches');
const AUTH_HEADERS = { 'x-user-id': 'user-1' };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', batchesRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

async function request(app, method, path, options = {}) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const body = options.body ? JSON.stringify(options.body) : undefined;
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: {
          ...(options.headers || {}),
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        },
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeBatch(overrides = {}) {
  return {
    id: 'batch-1',
    status: 'running',
    mode: 'parallel',
    tasks: [{ taskId: 'task-1' }, { taskId: 'task-2' }],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('batches routes', () => {
  let app;

  beforeEach(() => {
    app = makeApp();
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.decryptToken.mockImplementation((value) => (value ? `decrypted:${value}` : null));
    mocks.toBatchStatusResponse.mockImplementation((batch) => ({ mapped: 'status', id: batch.id }));
    mocks.toBatchTaskSummaries.mockImplementation((batch) => batch.tasks.map((t) => ({ taskId: t.taskId })));
    mocks.toCreateBatchResponse.mockImplementation((batch) => ({ mapped: 'created', id: batch.id }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('unauthenticated requests', () => {
    it.each([
      ['POST', '/'],
      ['GET', '/'],
      ['GET', '/batch-1'],
      ['POST', '/batch-1/cancel'],
      ['POST', '/batch-1/tasks/task-1/cancel'],
      ['POST', '/batch-1/approve'],
    ])('rejects %s %s with 401 and never touches batch state', async (method, path) => {
      await expect(request(app, method, path, {
        body: method === 'POST' && path === '/' ? { taskIds: ['task-1'], mode: 'parallel' } : undefined,
      })).resolves.toEqual({
        status: 401,
        body: { error: 'Authentication required' },
      });

      expect(mocks.assertTaskOwned).not.toHaveBeenCalled();
      expect(mocks.createBatch).not.toHaveBeenCalled();
      expect(mocks.getBatch).not.toHaveBeenCalled();
      expect(mocks.getActiveBatches).not.toHaveBeenCalled();
      expect(mocks.cancelBatch).not.toHaveBeenCalled();
      expect(mocks.cancelTask).not.toHaveBeenCalled();
      expect(mocks.approveNextTask).not.toHaveBeenCalled();
    });
  });

  it('creates a batch after checking ownership of every task and starts it', async () => {
    const batch = makeBatch();
    mocks.createBatch.mockResolvedValueOnce(batch);
    mocks.userFindUnique.mockResolvedValueOnce({ accessToken: 'secret' });

    await expect(request(app, 'POST', '/', {
      headers: AUTH_HEADERS,
      body: { taskIds: ['task-1', 'task-2'], mode: 'parallel' },
    })).resolves.toEqual({
      status: 201,
      body: { mapped: 'created', id: 'batch-1' },
    });

    expect(mocks.assertTaskOwned).toHaveBeenNthCalledWith(1, 'task-1', 'user-1');
    expect(mocks.assertTaskOwned).toHaveBeenNthCalledWith(2, 'task-2', 'user-1');
    expect(mocks.createBatch).toHaveBeenCalledWith({
      taskIds: ['task-1', 'task-2'],
      mode: 'parallel',
      projectId: '',
      userId: 'user-1',
      accessToken: 'decrypted:secret',
    });
    expect(mocks.startBatch).toHaveBeenCalledWith('batch-1');
  });

  it('rejects an invalid create-batch body with 400 before checking ownership', async () => {
    await expect(request(app, 'POST', '/', {
      headers: AUTH_HEADERS,
      body: { taskIds: [], mode: 'bogus' },
    })).resolves.toMatchObject({ status: 400 });

    expect(mocks.assertTaskOwned).not.toHaveBeenCalled();
    expect(mocks.createBatch).not.toHaveBeenCalled();
  });

  it('propagates ownership failures on create as a 500 via next(error)', async () => {
    mocks.assertTaskOwned.mockRejectedValueOnce(new Error('not yours'));

    await expect(request(app, 'POST', '/', {
      headers: AUTH_HEADERS,
      body: { taskIds: ['task-1'], mode: 'parallel' },
    })).resolves.toEqual({ status: 500, body: { error: 'not yours' } });

    expect(mocks.createBatch).not.toHaveBeenCalled();
  });

  it('creates the batch with a null token when decryption fails', async () => {
    mocks.createBatch.mockResolvedValueOnce(makeBatch());
    mocks.userFindUnique.mockResolvedValueOnce({ accessToken: 'secret' });
    mocks.decryptToken.mockImplementationOnce(() => {
      throw new Error('decrypt failed');
    });

    await expect(request(app, 'POST', '/', {
      headers: AUTH_HEADERS,
      body: { taskIds: ['task-1'], mode: 'queue' },
    })).resolves.toMatchObject({ status: 201 });

    expect(mocks.createBatch).toHaveBeenCalledWith(expect.objectContaining({ accessToken: null }));
  });

  it('lists only batches owned by the caller', async () => {
    const ownedBatch = makeBatch({ id: 'batch-owned' });
    const otherBatch = makeBatch({ id: 'batch-other', tasks: [{ taskId: 'task-x' }] });
    mocks.getActiveBatches.mockReturnValueOnce([ownedBatch, otherBatch]);
    mocks.assertTaskOwned.mockImplementation((taskId) => {
      if (taskId === 'task-x') return Promise.reject(new Error('not yours'));
      return Promise.resolve();
    });

    const result = await request(app, 'GET', '/', { headers: AUTH_HEADERS });
    expect(result.status).toBe(200);
    expect(result.body).toEqual([
      {
        id: 'batch-owned',
        status: 'running',
        mode: 'parallel',
        taskCount: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('returns batch status for an owned batch and 404 for a missing one', async () => {
    mocks.getBatch.mockReturnValueOnce(undefined);
    await expect(request(app, 'GET', '/missing', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 404,
      body: { error: 'Batch not found' },
    });

    const batch = makeBatch();
    mocks.getBatch.mockReturnValueOnce(batch);
    await expect(request(app, 'GET', '/batch-1', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { mapped: 'status', id: 'batch-1' },
    });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-1', 'user-1');
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-2', 'user-1');
  });

  it('rejects reading a batch owned by someone else', async () => {
    mocks.getBatch.mockReturnValueOnce(makeBatch());
    mocks.assertTaskOwned.mockRejectedValueOnce(new Error('not yours'));

    await expect(request(app, 'GET', '/batch-1', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 500,
      body: { error: 'not yours' },
    });
  });

  it('cancels an owned batch and 404s for a missing one', async () => {
    mocks.getBatch.mockReturnValueOnce(undefined);
    await expect(request(app, 'POST', '/missing/cancel', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 404,
      body: { error: 'Batch not found' },
    });

    mocks.getBatch.mockReturnValueOnce(makeBatch());
    await expect(request(app, 'POST', '/batch-1/cancel', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { success: true },
    });
    expect(mocks.cancelBatch).toHaveBeenCalledWith('batch-1');
  });

  it('cancels a single task within a batch after an ownership check', async () => {
    await expect(request(app, 'POST', '/batch-1/tasks/task-1/cancel', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { success: true },
    });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-1', 'user-1');
    expect(mocks.cancelTask).toHaveBeenCalledWith('batch-1', 'task-1');
  });

  it('approves the next task in an owned batch and 404s for a missing one', async () => {
    mocks.getBatch.mockReturnValueOnce(undefined);
    await expect(request(app, 'POST', '/missing/approve', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 404,
      body: { error: 'Batch not found' },
    });

    const batch = makeBatch();
    mocks.getBatch.mockReturnValueOnce(batch).mockReturnValueOnce(batch);
    await expect(request(app, 'POST', '/batch-1/approve', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: {
        id: 'batch-1',
        status: 'running',
        mode: 'parallel',
        tasks: [{ taskId: 'task-1' }, { taskId: 'task-2' }],
      },
    });
    expect(mocks.approveNextTask).toHaveBeenCalledWith('batch-1');
  });

  it('rejects approving a batch not owned by the caller without ever launching a task', async () => {
    mocks.getBatch.mockReturnValueOnce(makeBatch());
    mocks.assertTaskOwned.mockRejectedValueOnce(new Error('not yours'));

    await expect(request(app, 'POST', '/batch-1/approve', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 500,
      body: { error: 'not yours' },
    });
    expect(mocks.approveNextTask).not.toHaveBeenCalled();
  });
});
