import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `app.ts` imports `createApp`/`buildErrorHandler` from `@openlinear/api/app`
// and mounts the full sidecar router set at module load. Stub all of that
// out (matching the pattern `index.test.mjs` already uses for `./app`) so
// importing this module for `createHostOriginGuard`/`createSidecarApp`
// doesn't pull in the cloud API's 28 routers, Prisma, etc.
vi.mock('@openlinear/api/app', () => ({
  createApp: () => express(),
  buildErrorHandler: () => (err, _req, res, _next) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'error' });
  },
}));

function stubRouter(label) {
  const router = express.Router();
  router.all('/', (_req, res) => res.json({ router: label }));
  router.all('/:rest', (_req, res) => res.json({ router: label }));
  return router;
}

vi.mock('./routes/execution', () => ({ default: stubRouter('execution') }));
vi.mock('./routes/opencode', () => ({ default: stubRouter('opencode') }));
vi.mock('./routes/batches', () => ({ default: stubRouter('batches') }));
vi.mock('./routes/transcribe', () => ({ default: stubRouter('transcribe') }));

const { createHostOriginGuard, createSidecarApp } = await import('./app');

function makeReq({ method = 'GET', host, origin, secFetchSite } = {}) {
  const headers = {};
  if (host !== undefined) headers.host = host;
  if (origin !== undefined) headers.origin = origin;
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite;
  return { method, headers };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function run(guard, req) {
  const res = makeRes();
  let nextCalled = false;
  guard(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe('createHostOriginGuard', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('rejects a request with no Host header at all', () => {
    const guard = createHostOriginGuard(3001);
    const { res, nextCalled } = run(guard, makeReq({}));

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden_host' });
    expect(nextCalled).toBe(false);
  });

  it.each(['127.0.0.1:3001', 'localhost:3001', '[::1]:3001'])(
    'accepts the loopback host %s on the configured port',
    (host) => {
      const guard = createHostOriginGuard(3001);
      const { res, nextCalled } = run(guard, makeReq({ host }));

      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBeNull();
    },
  );

  it('rejects a spoofed Host header — the DNS-rebinding case', () => {
    const guard = createHostOriginGuard(3001);
    const { res, nextCalled } = run(guard, makeReq({ host: 'attacker.example.com' }));

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden_host' });
    expect(nextCalled).toBe(false);
  });

  it('rejects the loopback host on the wrong port', () => {
    const guard = createHostOriginGuard(3001);
    const { res, nextCalled } = run(guard, makeReq({ host: '127.0.0.1:9999' }));

    expect(res.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('ignores a foreign Origin header on a safe GET request', () => {
    const guard = createHostOriginGuard(3001);
    const { nextCalled } = run(
      guard,
      makeReq({ method: 'GET', host: '127.0.0.1:3001', origin: 'https://evil.example.com' }),
    );

    expect(nextCalled).toBe(true);
  });

  it('allows a state-changing request with no Origin or Sec-Fetch-Site headers (non-browser clients)', () => {
    const guard = createHostOriginGuard(3001);
    const { nextCalled } = run(guard, makeReq({ method: 'POST', host: '127.0.0.1:3001' }));

    expect(nextCalled).toBe(true);
  });

  it('rejects a state-changing request whose Origin is untrusted — the simple-request CSRF case', () => {
    const guard = createHostOriginGuard(3001);
    const { res, nextCalled } = run(
      guard,
      makeReq({ method: 'POST', host: '127.0.0.1:3001', origin: 'https://evil.example.com' }),
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden_origin' });
    expect(nextCalled).toBe(false);
  });

  it.each(['PATCH', 'PUT', 'DELETE'])('applies the same Origin check to %s requests', (method) => {
    const guard = createHostOriginGuard(3001);
    const { res, nextCalled } = run(
      guard,
      makeReq({ method, host: '127.0.0.1:3001', origin: 'https://evil.example.com' }),
    );

    expect(res.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('allows a state-changing request whose Origin matches CORS_ORIGIN', () => {
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    const guard = createHostOriginGuard(3001);
    const { nextCalled } = run(
      guard,
      makeReq({ method: 'POST', host: '127.0.0.1:3001', origin: 'http://localhost:3000' }),
    );

    expect(nextCalled).toBe(true);
  });

  it('allows the 127.0.0.1 loopback alias of a configured localhost Origin', () => {
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    const guard = createHostOriginGuard(3001);
    const { nextCalled } = run(
      guard,
      makeReq({ method: 'POST', host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3000' }),
    );

    expect(nextCalled).toBe(true);
  });

  it.each(['tauri://localhost', 'https://tauri.localhost'])(
    'always allows the Tauri desktop origin %s regardless of CORS_ORIGIN',
    (origin) => {
      process.env.CORS_ORIGIN = 'http://localhost:3000';
      const guard = createHostOriginGuard(3001);
      const { nextCalled } = run(guard, makeReq({ method: 'POST', host: '127.0.0.1:3001', origin }));

      expect(nextCalled).toBe(true);
    },
  );

  it('rejects a cross-site Sec-Fetch-Site value even with no Origin header', () => {
    const guard = createHostOriginGuard(3001);
    const { res, nextCalled } = run(
      guard,
      makeReq({ method: 'POST', host: '127.0.0.1:3001', secFetchSite: 'cross-site' }),
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden_origin' });
    expect(nextCalled).toBe(false);
  });

  it.each(['same-origin', 'same-site', 'none'])('allows a %s Sec-Fetch-Site value', (value) => {
    const guard = createHostOriginGuard(3001);
    const { nextCalled } = run(guard, makeReq({ method: 'POST', host: '127.0.0.1:3001', secFetchSite: value }));

    expect(nextCalled).toBe(true);
  });

  it('uses the port passed to the factory, not a hardcoded default', () => {
    const guard = createHostOriginGuard(4321);
    expect(run(guard, makeReq({ host: '127.0.0.1:3001' })).res.statusCode).toBe(403);
    expect(run(guard, makeReq({ host: '127.0.0.1:4321' })).nextCalled).toBe(true);
  });
});

async function request(server, configuredPort, { host, method = 'GET', path = '/api/tasks/x' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      // Requests carry the Host header the guard expects for the *configured*
      // port (what Tauri sets `API_PORT` to), which is independent of
      // whatever ephemeral OS port `.listen(0, ...)` happens to bind this
      // test server to.
      headers: { host: host ?? `127.0.0.1:${configuredPort}` },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createSidecarApp', () => {
  const configuredPort = 5555;
  let app;
  let server;

  beforeEach(async () => {
    app = createSidecarApp({ port: configuredPort });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('blocks a spoofed Host before ever reaching a sidecar router', async () => {
    const result = await request(server, configuredPort, { host: 'attacker.example.com' });
    expect(result).toEqual({ status: 403, body: { error: 'forbidden_host' } });
  });

  it('lets a request with the correct Host through to the stub execution router', async () => {
    const result = await request(server, configuredPort, {});
    expect(result).toEqual({ status: 200, body: { router: 'execution' } });
  });
});
