/**
 * One loopback-bound HTTP server per test file.
 *
 * supertest's `request(app)` calls `app.listen(0)` for every request. That
 * binds the wildcard address, and on a shared machine the kernel can hand
 * out an ephemeral port another process already holds on 127.0.0.1; the
 * more specific listener wins and the probe never reaches the app (socket
 * hang up, stray 401s). A server bound explicitly to 127.0.0.1 cannot share
 * such a port (EADDRINUSE), and one server per file also stops the suite
 * from burning one ephemeral port per request.
 *
 * Usage (inside a file or a describe block):
 *
 *   const http = useTestServer(() => createApp());
 *   const res = await http().get('/api/tasks').set('Authorization', `Bearer ${jwt}`);
 *
 * `http()` returns a supertest client for the running server; call it once
 * per request, exactly like `request(app)`.
 */
import type { Server } from 'node:http';
import type { Application } from 'express';
import request from 'supertest';
import { afterAll, beforeAll } from 'vitest';
import { closeServer, listen } from './auth-helpers';

export type TestClient = ReturnType<typeof request>;

export interface TestServer {
  /** Base URL (`http://127.0.0.1:<port>`) of the running server. */
  readonly baseUrl: string;
  /** A supertest client bound to the server. */
  client: () => TestClient;
  close: () => Promise<void>;
}

/** Start `app` on 127.0.0.1 with an ephemeral port; resolves once listening. */
export async function startTestServer(app: Application): Promise<TestServer> {
  const { server, baseUrl } = await listen(app);
  return {
    baseUrl,
    client: () => request(baseUrl),
    close: () => closeServer(server),
  };
}

/**
 * Register `beforeAll`/`afterAll` hooks that start the app once for the
 * enclosing file or describe block and close it afterwards. The returned
 * function is the per-request client (replacement for `request(app)`).
 */
export function useTestServer(makeApp: () => Application): (() => TestClient) & { baseUrl: () => string } {
  let server: Server | undefined;
  let baseUrl: string | undefined;

  beforeAll(async () => {
    const started = await listen(makeApp());
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    await closeServer(server);
    server = undefined;
    baseUrl = undefined;
  });

  const requireBaseUrl = (): string => {
    if (!baseUrl) throw new Error('useTestServer: the server is not running (call http() inside a test or hook)');
    return baseUrl;
  };
  const client = () => request(requireBaseUrl());
  return Object.assign(client, { baseUrl: requireBaseUrl });
}
