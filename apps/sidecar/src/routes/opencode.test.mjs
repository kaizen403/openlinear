import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOpenCodeStatus: vi.fn(),
  getClientForUser: vi.fn(),
}));

vi.mock('../services/opencode', () => ({
  getOpenCodeStatus: mocks.getOpenCodeStatus,
  getClientForUser: mocks.getClientForUser,
}));

// Every other route in this router already used requireAuth before this
// change; `/status` was the one exception (C6a F15). This stand-in mirrors
// requireAuth's observable contract: no proof of identity, no response body.
vi.mock('../auth/principal', () => ({
  requireSidecarAuth: (req, res, next) => {
    const userId = req.get('x-user-id');
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.userId = userId;
    next();
  },
}));

const { default: opencodeRouter } = await import('./opencode');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', opencodeRouter);
  return app;
}

async function request(app, method, path, options = {}) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: options.headers || {},
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
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GET /status', () => {
  beforeEach(() => {
    mocks.getOpenCodeStatus.mockReset();
    mocks.getClientForUser.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an unauthenticated caller with 401 without ever reading status', async () => {
    const app = makeApp();
    await expect(request(app, 'GET', '/status')).resolves.toEqual({
      status: 401,
      body: { error: 'Authentication required' },
    });
    expect(mocks.getOpenCodeStatus).not.toHaveBeenCalled();
  });

  it('never leaks the OpenCode server URL to an authenticated caller', async () => {
    mocks.getOpenCodeStatus.mockReturnValue({
      mode: 'shared',
      serverUrl: 'http://127.0.0.1:54213',
      running: true,
      restartAttempts: 0,
    });
    const app = makeApp();

    const result = await request(app, 'GET', '/status', { headers: { 'x-user-id': 'user-1' } });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ mode: 'shared', running: true, restartAttempts: 0 });
    expect(result.body.serverUrl).toBeUndefined();
    expect(JSON.stringify(result.body)).not.toContain('54213');
  });
});
