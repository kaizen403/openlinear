import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PatVerifier } from '../src/auth';
import { connectClient, type Harness, seedBasics, startHarness } from './harness';
import { initializeMessage, rpc } from './helpers';

const PRM_PATH = '/.well-known/oauth-protected-resource/mcp';

describe('authentication', () => {
  let harness: Harness;
  let seed: ReturnType<typeof seedBasics>;

  beforeAll(async () => {
    harness = await startHarness();
    seed = seedBasics(harness.api);
  });
  afterAll(async () => harness.stop());
  afterEach(() => {
    harness.api.failures.splice(0);
  });

  const probes = () => harness.api.callsTo('GET', /^\/api\/users\/me$/).length;

  it('answers a request without credentials with 401 and an RFC 6750/9728 challenge', async () => {
    const answer = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'));
    expect(answer.status).toBe(401);
    const challenge = answer.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer realm="OpenLinear MCP"/);
    expect(challenge).not.toContain('error=');
    expect(challenge).toContain(`resource_metadata="${harness.origin}${PRM_PATH}"`);
    expect(answer.body).toMatchObject({ error: 'invalid_token', error_uri: 'https://docs.example.test/mcp' });
  });

  it('rejects malformed credentials without calling the API', async () => {
    const before = probes();
    for (const header of ['Bearer not-a-pat', 'Token ol_pat_0123456789abcdef0123456789abcdef', 'Bearer ol_pat_0123456789ABCDEF0123456789ABCDEF']) {
      const answer = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: header });
      expect(answer.status, header).toBe(401);
      expect(answer.headers.get('www-authenticate')).toContain('error="invalid_token"');
    }
    expect(probes()).toBe(before);
  });

  it('answers an unknown token with 401 invalid_token after checking it with the API', async () => {
    const answer = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), {
      Authorization: 'Bearer ol_pat_0123456789abcdef0123456789abcdef',
    });
    expect(answer.status).toBe(401);
    expect(answer.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(answer.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('requires a valid token for tools/list too (tool discovery is not anonymous)', async () => {
    const answer = await rpc(harness.mcpUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(answer.status).toBe(401);
  });

  it('accepts a case-insensitive scheme and caches a verified token per isolate', async () => {
    const token = harness.api.addPat(seed.alice.id);
    const before = probes();
    for (const scheme of ['Bearer', 'bearer']) {
      const answer = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: `${scheme} ${token}` });
      expect(answer.status).toBe(200);
    }
    expect(probes()).toBe(before + 1);
  });

  it('turns a token revoked after verification into a 401 on the next request', async () => {
    const token = harness.api.addPat(seed.alice.id);
    const client = await connectClient('v1-legacy', harness.mcpUrl, token);
    harness.api.revoke(token);
    // Still cached: the tool reaches the API, which refuses the revoked token.
    const refused = await client.call('openlinear_list_workspaces', {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('rejected the personal access token');
    // The API 401 evicted the cache entry, so the transport now gets a real 401.
    const next = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: `Bearer ${token}` });
    expect(next.status).toBe(401);
    expect(next.headers.get('www-authenticate')).toContain('error="invalid_token"');
    await client.close().catch(() => {});
  });

  it('accepts a valid narrow-scope token that cannot read its owner (403 INSUFFICIENT_SCOPE on /api/users/me)', async () => {
    // W02b: /api/users/me needs account:read, which tasks:* / projects:* tokens lack.
    const token = harness.api.addPat(seed.alice.id, { scopes: ['tasks:write', 'projects:read'] });
    const answer = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: `Bearer ${token}` });
    expect(answer.status).toBe(200);
    const verification = harness.api.callsTo('GET', /^\/api\/users\/me$/).at(-1);
    expect(verification?.status).toBe(403);
    // Cached like any verified token.
    const before = probes();
    expect((await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: `Bearer ${token}` })).status).toBe(200);
    expect(probes()).toBe(before);
  });

  it('answers any other 403 from token verification with 403 insufficient_scope', async () => {
    const token = harness.api.addPat(seed.alice.id);
    harness.api.fail({
      method: 'GET',
      path: /^\/api\/users\/me$/,
      status: 403,
      body: { error: { code: 'PAT_ROUTE_UNDECLARED', message: 'This route does not accept personal access tokens.' } },
    });
    const answer = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: `Bearer ${token}` });
    expect(answer.status).toBe(403);
    expect(answer.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(answer.headers.get('www-authenticate')).toContain('scope="read"');
  });

  it('answers 503 when the API cannot verify the token, and does not cache the failure', async () => {
    const token = harness.api.addPat(seed.alice.id);
    harness.api.fail({ method: 'GET', path: /^\/api\/users\/me$/, status: 502, rawBody: '<html>bad gateway</html>' });
    const down = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: `Bearer ${token}` });
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('5');
    expect(down.raw).not.toContain('bad gateway');
    const up = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: `Bearer ${token}` });
    expect(up.status).toBe(200);
  });

  it('serves RFC 9728 protected-resource metadata without authorization servers until one exists', async () => {
    for (const path of [PRM_PATH, '/.well-known/oauth-protected-resource']) {
      const response = await fetch(`${harness.origin}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      const document = await response.json();
      expect(document).toEqual({
        resource: harness.mcpUrl,
        resource_name: 'OpenLinear MCP',
        resource_documentation: 'https://docs.example.test/mcp',
        bearer_methods_supported: ['header'],
      });
    }
    expect((await fetch(`${harness.origin}${PRM_PATH}`, { method: 'POST' })).status).toBe(405);
  });

  it('advertises configured authorization servers', async () => {
    const configured = await startHarness({ config: { authorizationServers: ['https://auth.example.test'] } });
    try {
      const document = await (await fetch(`${configured.origin}${PRM_PATH}`)).json();
      expect(document).toMatchObject({ authorization_servers: ['https://auth.example.test'] });
    } finally {
      await configured.stop();
    }
  });

  it('verifier cache expires after its TTL', async () => {
    let now = 1_000_000;
    const verifier = new PatVerifier({ apiUrl: harness.api.url, ttlMs: 1_000, now: () => now });
    const token = harness.api.addPat(seed.alice.id);
    const before = probes();
    expect((await verifier.verify(token)).ok).toBe(true);
    expect((await verifier.verify(token)).ok).toBe(true);
    now += 1_001;
    expect((await verifier.verify(token)).ok).toBe(true);
    expect(probes()).toBe(before + 2);
  });
});

describe('browser origins', () => {
  let harness: Harness;
  let token: string;
  beforeAll(async () => {
    harness = await startHarness({ config: { allowedOrigins: ['inspector.example.test'] } });
    token = seedBasics(harness.api).token;
  });
  afterAll(async () => harness.stop());

  it('refuses a request from a foreign Origin with 403 before authentication', async () => {
    const answer = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), {
      Authorization: `Bearer ${token}`,
      Origin: 'https://evil.example.test',
    });
    expect(answer.status).toBe(403);
    expect(answer.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves an allow-listed Origin with CORS headers, including on 401 answers', async () => {
    const origin = 'https://inspector.example.test';
    const preflight = await fetch(harness.mcpUrl, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');

    const answer = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: `Bearer ${token}`, Origin: origin });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('access-control-allow-origin')).toBe(origin);

    const unauthenticated = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Origin: origin });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });

  it('keeps serving clients that send no Origin (every non-browser client)', async () => {
    const answer = await rpc(harness.mcpUrl, initializeMessage('2025-06-18'), { Authorization: `Bearer ${token}` });
    expect(answer.status).toBe(200);
  });
});
