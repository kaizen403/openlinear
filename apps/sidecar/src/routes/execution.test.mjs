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

vi.mock('@openlinear/api/middleware', () => ({
  optionalAuth: (req, _res, next) => {
    req.userId = req.get('x-user-id') || undefined;
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

  it('starts execution for owned tasks and returns route-level failures as 400', async () => {
    mocks.executeTask.mockResolvedValueOnce({ success: true });

    await expect(request(app, 'POST', '/task-1/execute', {
      headers: { 'x-user-id': 'user-1' },
    })).resolves.toEqual({
      status: 200,
      body: { message: 'Task execution started' },
    });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-1', 'user-1');
    expect(mocks.executeTask).toHaveBeenCalledWith({ taskId: 'task-1', userId: 'user-1' });

    mocks.executeTask.mockResolvedValueOnce({ success: false, error: 'No active project selected' });
    await expect(request(app, 'POST', '/task-1/execute')).resolves.toEqual({
      status: 400,
      body: { error: 'No active project selected' },
    });
  });

  it('reports running state and cancels only running tasks', async () => {
    mocks.isTaskRunning.mockReturnValueOnce(true);
    await expect(request(app, 'GET', '/task-1/running')).resolves.toEqual({
      status: 200,
      body: { running: true },
    });

    mocks.isTaskRunning.mockReturnValueOnce(false);
    await expect(request(app, 'POST', '/task-1/cancel')).resolves.toEqual({
      status: 400,
      body: { error: 'Task is not running' },
    });

    mocks.isTaskRunning.mockReturnValueOnce(true);
    mocks.cancelTask.mockResolvedValueOnce({ success: true });
    await expect(request(app, 'POST', '/task-1/cancel')).resolves.toEqual({
      status: 200,
      body: { message: 'Task cancelled' },
    });
  });

  it('returns active, batch, or persisted execution logs in priority order', async () => {
    const activeLogs = [{ timestamp: 'now', type: 'info', message: 'active' }];
    mocks.getExecutionLogs.mockReturnValueOnce(activeLogs);
    await expect(request(app, 'GET', '/task-1/logs')).resolves.toEqual({
      status: 200,
      body: { logs: activeLogs },
    });

    const batchLogs = [{ timestamp: 'now', type: 'info', message: 'batch' }];
    mocks.getExecutionLogs.mockReturnValueOnce([]);
    mocks.getBatchExecutionLogs.mockReturnValueOnce(batchLogs);
    await expect(request(app, 'GET', '/task-1/logs')).resolves.toEqual({
      status: 200,
      body: { logs: batchLogs },
    });

    const persistedLogs = [{ timestamp: 'now', type: 'info', message: 'persisted' }];
    mocks.getExecutionLogs.mockReturnValueOnce([]);
    mocks.getBatchExecutionLogs.mockReturnValueOnce([]);
    mocks.queryRaw.mockResolvedValueOnce([{ executionLogs: persistedLogs }]);
    await expect(request(app, 'GET', '/task-1/logs')).resolves.toEqual({
      status: 200,
      body: { logs: persistedLogs },
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
      headers: { 'x-user-id': 'user-1' },
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
  });

  it('does not refresh missing tasks, non-compare links, or unauthenticated compare links', async () => {
    mocks.taskFindUnique.mockResolvedValueOnce(null);
    await expect(request(app, 'POST', '/missing/refresh-pr')).resolves.toEqual({
      status: 404,
      body: { error: 'Task not found' },
    });

    mocks.taskFindUnique.mockResolvedValueOnce({ prUrl: 'https://github.com/acme/repo/pull/1', batchId: null });
    await expect(request(app, 'POST', '/task-1/refresh-pr')).resolves.toEqual({
      status: 200,
      body: { prUrl: 'https://github.com/acme/repo/pull/1', refreshed: false },
    });

    mocks.taskFindUnique.mockResolvedValueOnce({
      prUrl: 'https://github.com/acme/repo/compare/main...branch',
      batchId: null,
    });
    await expect(request(app, 'POST', '/task-1/refresh-pr', {
      headers: { 'x-user-id': 'user-1' },
    })).resolves.toEqual({
      status: 400,
      body: { error: 'GitHub authentication required to refresh PR status' },
    });
  });
});
