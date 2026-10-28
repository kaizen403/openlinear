import { createMcpHandler, originValidationResponse, validateOriginHeader } from '@modelcontextprotocol/server';
import { authenticate, PatVerifier } from './auth';
import type { WorkerConfig } from './config';
import { RequestScope, scopeFromAuthInfo } from './mcp/context';
import { createOpenLinearServer } from './mcp/server';
import type { FetchLike } from './openlinear/client';
import { SERVER_NAME, SERVER_VERSION } from './version';

/** Largest JSON-RPC POST body accepted (a maximal bulk_create_plan is well below this). */
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const PRM_PATH = '/.well-known/oauth-protected-resource';
const ALLOW_HEADERS =
  'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID';
const EXPOSE_HEADERS = 'WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id';

export interface WorkerDependencies {
  /** Used for every call to the OpenLinear API (tests point it at a fake). */
  fetch?: FetchLike;
  verifier?: PatVerifier;
  apiTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type WaitUntil = (promise: Promise<unknown>) => void;

export interface OpenLinearWorker {
  fetch(request: Request, waitUntil: WaitUntil): Promise<Response>;
  verifier: PatVerifier;
}

function log(level: 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.warn(line);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  if (Object.keys(headers).length === 0) return response;
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
  return copy;
}

/**
 * The worker's HTTP surface:
 *
 * - `POST /mcp`: MCP over Streamable HTTP, stateless. 2026-07-28 clients are
 *   served per request; 2025-era clients (initialize handshake, protocol
 *   2024-10-07 … 2025-11-25) are served by the SDK's stateless legacy leg.
 *   Every POST needs a valid OpenLinear personal access token.
 * - `GET|DELETE /mcp`: 405 (no sessions, no standalone SSE stream).
 * - `GET /.well-known/oauth-protected-resource[/mcp]`: RFC 9728 metadata.
 * - `GET /healthz`: liveness and version.
 */
export function createWorker(config: WorkerConfig, deps: WorkerDependencies = {}): OpenLinearWorker {
  const verifier = deps.verifier ?? new PatVerifier({ apiUrl: config.apiUrl, fetch: deps.fetch });
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const scope = scopeFromAuthInfo(authInfo);
      if (!scope) throw new Error('request scope missing from authInfo');
      return createOpenLinearServer(scope);
    },
    {
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      onerror: (error) => log('warn', 'mcp request rejected or failed', { error: `${error.name}: ${error.message}` }),
    },
  );

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get('origin');
    if (!origin || config.allowedOrigins.length === 0) return {};
    if (!validateOriginHeader(origin, config.allowedOrigins).ok) return {};
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': EXPOSE_HEADERS, Vary: 'Origin' };
  }

  function protectedResourceMetadata(origin: string): Record<string, unknown> {
    return {
      resource: `${origin}/mcp`,
      resource_name: 'OpenLinear MCP',
      resource_documentation: config.docsUrl,
      bearer_methods_supported: ['header'],
      ...(config.authorizationServers.length > 0 ? { authorization_servers: config.authorizationServers } : {}),
    };
  }

  async function serveMcp(request: Request, origin: string, waitUntil: WaitUntil): Promise<Response> {
    const rejected = originValidationResponse(request, config.allowedOrigins);
    if (rejected) return rejected;
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          Allow: 'POST, OPTIONS',
          ...(cors['Access-Control-Allow-Origin']
            ? {
                'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': ALLOW_HEADERS,
                'Access-Control-Max-Age': '600',
              }
            : {}),
        },
      });
    }
    if (request.method !== 'POST') return withHeaders(await handler.fetch(request), cors);

    const auth = await authenticate(request, verifier, {
      resourceMetadataUrl: `${origin}${PRM_PATH}/mcp`,
      docsUrl: config.docsUrl,
    });
    if (!auth.ok) return withHeaders(auth.response, cors);

    const { cacheKey } = auth;
    const scope = new RequestScope({
      apiUrl: config.apiUrl,
      token: auth.token,
      principal: auth.principal,
      fetch: deps.fetch,
      waitUntil,
      onUnauthorized: () => verifier.invalidate(cacheKey),
      usageLogging: verifier.usageLoggingEnabled(cacheKey),
      disableUsageLogging: () => verifier.disableUsageLogging(cacheKey),
      apiTimeoutMs: deps.apiTimeoutMs,
      sleep: deps.sleep,
    });
    const response = await handler.fetch(request, { authInfo: scope.toAuthInfo(Math.floor(Date.now() / 1000) + 300) });
    return withHeaders(response, cors);
  }

  async function route(request: Request, waitUntil: WaitUntil): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/mcp') return serveMcp(request, url.origin, waitUntil);

    if (path === PRM_PATH || path === `${PRM_PATH}/mcp`) {
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' },
        });
      }
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, OPTIONS' });
      return Response.json(protectedResourceMetadata(url.origin), {
        headers: { ...cors, 'Cache-Control': 'public, max-age=3600' },
      });
    }

    if (path === '/healthz' && request.method === 'GET') {
      return json({ ok: true, ts: Date.now(), name: SERVER_NAME, version: SERVER_VERSION });
    }

    if (path === '/' && request.method === 'GET') {
      return json({ name: SERVER_NAME, version: SERVER_VERSION, endpoint: `${url.origin}/mcp`, docs: config.docsUrl });
    }

    return json({ error: 'not_found' }, 404);
  }

  return {
    verifier,
    async fetch(request, waitUntil) {
      try {
        return await route(request, waitUntil);
      } catch (error) {
        log('error', 'unhandled worker error', { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
        return json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, 500);
      }
    },
  };
}
