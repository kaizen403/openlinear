import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTask: vi.fn(),
  cancelTask: vi.fn(),
  isTaskRunning: vi.fn(),
  getExecutionLogs: vi.fn(),
  getBatchExecutionLogs: vi.fn(),
  assertTaskOwned: vi.fn(),
  decryptToken: vi.fn((value) => value ? `decrypted:${value}` : null),
  userFindUnique: vi.fn(),
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn(),
  taskUpdateMany: vi.fn(),
  queryRaw: vi.fn(),
  broadcastToTask: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@openlinear/db', () => ({
  decryptToken: mocks.decryptToken,
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: {
      findUnique: mocks.taskFindUnique,
      update: mocks.taskUpdate,
      updateMany: mocks.taskUpdateMany,
    },
    $queryRaw: mocks.queryRaw,
  },
}));

vi.mock('@openlinear/api/sse', () => ({
  broadcastToTask: mocks.broadcastToTask,
}));

// Mirrors requireAuth's observable contract for this router: a request
// without proof of identity (here, a stand-in `x-user-id` header) never
// reaches the handler at all. This is the fix for C6a F4 — previously this
// router used `optionalAuth`, which let an unauthenticated caller through
// with `req.userId` simply left undefined.
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

vi.mock('../services/execution', () => ({
  executeTask: mocks.executeTask,
  cancelTask: mocks.cancelTask,
  isTaskRunning: mocks.isTaskRunning,
  getExecutionLogs: mocks.getExecutionLogs,
}));

vi.mock('../services/batch', () => ({
  getBatchExecutionLogs: mocks.getBatchExecutionLogs,
}));

const { default: executionRouter } = await import('./execution');
const originalFetch = globalThis.fetch;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', executionRouter);
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

const AUTH_HEADERS = { 'x-user-id': 'user-1' };

describe('execution routes', () => {
  let app;

  beforeEach(() => {
    app = makeApp();
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.decryptToken.mockImplementation((value) => value ? `decrypted:${value}` : null);
    globalThis.fetch = mocks.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  describe('unauthenticated requests', () => {
    it.each([
      ['POST', '/task-1/execute'],
      ['POST', '/task-1/refresh-pr'],
      ['GET', '/task-1/running'],
      ['GET', '/task-1/logs'],
      ['POST', '/task-1/cancel'],
    ])('rejects %s %s with 401 and never reaches ownership or execution logic', async (method, path) => {
      await expect(request(app, method, path)).resolves.toEqual({
        status: 401,
        body: { error: 'Authentication required' },
      });

      expect(mocks.assertTaskOwned).not.toHaveBeenCalled();
      expect(mocks.executeTask).not.toHaveBeenCalled();
      expect(mocks.cancelTask).not.toHaveBeenCalled();
      expect(mocks.isTaskRunning).not.toHaveBeenCalled();
      expect(mocks.getExecutionLogs).not.toHaveBeenCalled();
      expect(mocks.taskFindUnique).not.toHaveBeenCalled();
    });
  });

  it('starts execution for owned tasks and returns route-level failures as 400', async () => {
    mocks.executeTask.mockResolvedValueOnce({ success: true });

    await expect(request(app, 'POST', '/task-1/execute', {
      headers: AUTH_HEADERS,
    })).resolves.toEqual({
      status: 200,
      body: { message: 'Task execution started' },
    });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-1', 'user-1');
    expect(mocks.executeTask).toHaveBeenCalledWith({ taskId: 'task-1', userId: 'user-1' });

    mocks.executeTask.mockResolvedValueOnce({ success: false, error: 'No active project selected' });
    await expect(request(app, 'POST', '/task-1/execute', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 400,
      body: { error: 'No active project selected' },
    });

    mocks.executeTask.mockRejectedValueOnce(new Error('execute exploded'));
    await expect(request(app, 'POST', '/task-1/execute', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 500,
      body: { error: 'execute exploded' },
    });
  });

  it('propagates ownership failures for execute as a 500 via next(error)', async () => {
    mocks.assertTaskOwned.mockRejectedValueOnce(new Error('not yours'));

    await expect(request(app, 'POST', '/task-1/execute', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 500,
      body: { error: 'not yours' },
    });
    expect(mocks.executeTask).not.toHaveBeenCalled();
  });

  it('reports running state and cancels only running tasks', async () => {
    mocks.isTaskRunning.mockReturnValueOnce(true);
    await expect(request(app, 'GET', '/task-1/running', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { running: true },
    });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-1', 'user-1');

    mocks.assertTaskOwned.mockRejectedValueOnce(new Error('not yours'));
    await expect(request(app, 'GET', '/task-1/running', {
      headers: AUTH_HEADERS,
    })).resolves.toEqual({
      status: 500,
      body: { error: 'not yours' },
    });

    mocks.isTaskRunning.mockReturnValueOnce(false);
    await expect(request(app, 'POST', '/task-1/cancel', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 400,
      body: { error: 'Task is not running' },
    });

    mocks.isTaskRunning.mockReturnValueOnce(true);
    mocks.cancelTask.mockResolvedValueOnce({ success: true });
    await expect(request(app, 'POST', '/task-1/cancel', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { message: 'Task cancelled' },
    });

    mocks.isTaskRunning.mockReturnValueOnce(true);
    mocks.cancelTask.mockResolvedValueOnce({ success: false, error: 'Abort failed' });
    await expect(request(app, 'POST', '/task-1/cancel', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 400,
      body: { error: 'Abort failed' },
    });

    mocks.isTaskRunning.mockImplementationOnce(() => {
      throw new Error('state read failed');
    });
    await expect(request(app, 'POST', '/task-1/cancel', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 500,
      body: { error: 'state read failed' },
    });

    mocks.assertTaskOwned.mockResolvedValueOnce(undefined);
    mocks.isTaskRunning.mockReturnValueOnce(true);
    mocks.cancelTask.mockResolvedValueOnce({ success: true });
    await expect(request(app, 'POST', '/task-1/cancel', {
      headers: AUTH_HEADERS,
    })).resolves.toEqual({
      status: 200,
      body: { message: 'Task cancelled' },
    });
  });

  it('returns active, batch, or persisted execution logs in priority order', async () => {
    const activeLogs = [{ timestamp: 'now', type: 'info', message: 'active' }];
    mocks.getExecutionLogs.mockReturnValueOnce(activeLogs);
    await expect(request(app, 'GET', '/task-1/logs', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { logs: activeLogs },
    });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-1', 'user-1');

    const batchLogs = [{ timestamp: 'now', type: 'info', message: 'batch' }];
    mocks.getExecutionLogs.mockReturnValueOnce([]);
    mocks.getBatchExecutionLogs.mockReturnValueOnce(batchLogs);
    await expect(request(app, 'GET', '/task-1/logs', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { logs: batchLogs },
    });

    const persistedLogs = [{ timestamp: 'now', type: 'info', message: 'persisted' }];
    mocks.getExecutionLogs.mockReturnValueOnce([]);
    mocks.getBatchExecutionLogs.mockReturnValueOnce([]);
    mocks.queryRaw.mockResolvedValueOnce([{ executionLogs: persistedLogs }]);
    await expect(request(app, 'GET', '/task-1/logs', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { logs: persistedLogs },
    });

    mocks.getExecutionLogs.mockReturnValueOnce([]);
    mocks.getBatchExecutionLogs.mockReturnValueOnce([]);
    mocks.queryRaw.mockRejectedValueOnce(new Error('logs query failed'));
    await expect(request(app, 'GET', '/task-1/logs', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 500,
      body: { error: 'logs query failed' },
    });

    mocks.getExecutionLogs.mockReturnValueOnce([]);
    mocks.getBatchExecutionLogs.mockReturnValueOnce([]);
    mocks.queryRaw.mockResolvedValueOnce([]);
    await expect(request(app, 'GET', '/task-1/logs', {
      headers: AUTH_HEADERS,
    })).resolves.toEqual({
      status: 200,
      body: { logs: [] },
    });
  });

  it('refreshes compare links into PR links and updates batch siblings', async () => {
    mocks.taskFindUnique.mockResolvedValue({
      prUrl: 'https://github.com/acme/repo/compare/main...openlinear%2Ftask-1',
      batchId: 'batch-1',
    });
    mocks.userFindUnique.mockResolvedValue({ accessToken: 'secret' });
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ html_url: 'https://github.com/acme/repo/pull/7' }],
    });
    mocks.taskUpdate.mockResolvedValue({
      id: 'task-1',
      prUrl: 'https://github.com/acme/repo/pull/7',
      labels: [{ label: { id: 'label-1', name: 'bug', color: '#f00' } }],
    });

    await expect(request(app, 'POST', '/task-1/refresh-pr', {
      headers: AUTH_HEADERS,
    })).resolves.toEqual({
      status: 200,
      body: { prUrl: 'https://github.com/acme/repo/pull/7', refreshed: true },
    });

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/repo/pulls?head=acme:openlinear/task-1&state=all&per_page=1',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer decrypted:secret' }),
      }),
    );
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: {
        batchId: 'batch-1',
        prUrl: 'https://github.com/acme/repo/compare/main...openlinear%2Ftask-1',
      },
      data: { prUrl: 'https://github.com/acme/repo/pull/7' },
    });
    expect(mocks.broadcastToTask).toHaveBeenCalledWith('task:updated', {
      id: 'task-1',
      prUrl: 'https://github.com/acme/repo/pull/7',
      labels: [{ id: 'label-1', name: 'bug', color: '#f00' }],
    });

    mocks.taskFindUnique.mockResolvedValue({
      prUrl: 'https://github.com/acme/repo/compare/main...openlinear%2Ftask-2',
      batchId: null,
    });
    mocks.userFindUnique.mockResolvedValue({ accessToken: 'secret' });
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ html_url: 'https://github.com/acme/repo/pull/8' }],
    });
    mocks.taskUpdate.mockResolvedValue({
      id: 'task-2',
      prUrl: 'https://github.com/acme/repo/pull/8',
      labels: [],
    });
    mocks.taskUpdateMany.mockClear();

    await expect(request(app, 'POST', '/task-2/refresh-pr', {
      headers: AUTH_HEADERS,
    })).resolves.toEqual({
      status: 200,
      body: { prUrl: 'https://github.com/acme/repo/pull/8', refreshed: true },
    });
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it('does not refresh missing tasks, non-compare links, or compare links with no stored GitHub token', async () => {
    mocks.taskFindUnique.mockResolvedValueOnce(null);
    await expect(request(app, 'POST', '/missing/refresh-pr', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 404,
      body: { error: 'Task not found' },
    });

    mocks.taskFindUnique.mockResolvedValueOnce({ prUrl: 'https://github.com/acme/repo/pull/1', batchId: null });
    await expect(request(app, 'POST', '/task-1/refresh-pr', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { prUrl: 'https://github.com/acme/repo/pull/1', refreshed: false },
    });

    mocks.taskFindUnique.mockResolvedValueOnce({ prUrl: 'https://github.com/acme/repo/compare/no-dots', batchId: null });
    await expect(request(app, 'POST', '/task-1/refresh-pr', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 200,
      body: { prUrl: 'https://github.com/acme/repo/compare/no-dots', refreshed: false },
    });

    mocks.taskFindUnique.mockResolvedValueOnce({
      prUrl: 'https://github.com/acme/repo/compare/main...branch',
      batchId: null,
    });
    mocks.userFindUnique.mockResolvedValueOnce({ accessToken: null });
    await expect(request(app, 'POST', '/task-1/refresh-pr', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 400,
      body: { error: 'GitHub authentication required to refresh PR status' },
    });

    mocks.taskFindUnique.mockResolvedValueOnce({
      prUrl: 'https://github.com/acme/repo/compare/main...branch',
      batchId: null,
    });
    mocks.userFindUnique.mockResolvedValueOnce({ accessToken: 'secret' });
    mocks.decryptToken.mockImplementationOnce(() => {
      throw new Error('decrypt failed');
    });
    await expect(request(app, 'POST', '/task-1/refresh-pr', {
      headers: AUTH_HEADERS,
    })).resolves.toEqual({
      status: 400,
      body: { error: 'GitHub authentication required to refresh PR status' },
    });

    mocks.taskFindUnique.mockResolvedValueOnce({
      prUrl: 'https://github.com/acme/repo/compare/main...branch',
      batchId: null,
    });
    mocks.userFindUnique.mockResolvedValueOnce({ accessToken: 'secret' });
    mocks.fetch.mockResolvedValueOnce({ ok: false });
    await expect(request(app, 'POST', '/task-1/refresh-pr', {
      headers: AUTH_HEADERS,
    })).resolves.toEqual({
      status: 502,
      body: { error: 'GitHub API request failed' },
    });

    mocks.taskFindUnique.mockResolvedValueOnce({
      prUrl: 'https://github.com/acme/repo/compare/main...branch',
      batchId: null,
    });
    mocks.userFindUnique.mockResolvedValueOnce({ accessToken: 'secret' });
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await expect(request(app, 'POST', '/task-1/refresh-pr', {
      headers: AUTH_HEADERS,
    })).resolves.toEqual({
      status: 200,
      body: {
        prUrl: 'https://github.com/acme/repo/compare/main...branch',
        refreshed: false,
        message: 'No PR found for this branch yet',
      },
    });

    mocks.taskFindUnique.mockRejectedValueOnce(new Error('refresh failed'));
    await expect(request(app, 'POST', '/task-1/refresh-pr', { headers: AUTH_HEADERS })).resolves.toEqual({
      status: 500,
      body: { error: 'Failed to refresh PR status' },
    });
  });
});
