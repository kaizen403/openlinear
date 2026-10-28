/**
 * W02b SSO login state: opaque single-use state, PKCE verifier and nonce kept
 * server-side, callback bound to the initiating browser. The identity
 * provider is simulated by mocking `openid-client` discovery and the code
 * exchange; URL building is the real library.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@openlinear/db';

const idp = vi.hoisted(() => ({
  grants: [] as Array<{ pkceCodeVerifier?: string; expectedNonce?: string; expectedState?: string; currentUrl: string }>,
  claims: { sub: 'subject-1', email: 'alice@example.com' } as { sub: string; email: string },
}));

vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: vi.fn(async (issuer: URL, clientId: string, secret?: unknown) => new actual.Configuration(
      {
        issuer: issuer.href,
        authorization_endpoint: `${issuer.origin}/authorize`,
        token_endpoint: `${issuer.origin}/token`,
      },
      clientId,
      typeof secret === 'string' ? secret : undefined,
    )),
    authorizationCodeGrant: vi.fn(async (
      _config: unknown,
      currentUrl: URL,
      checks: { pkceCodeVerifier?: string; expectedNonce?: string; expectedState?: string },
    ) => {
      idp.grants.push({ ...checks, currentUrl: currentUrl.href });
      return {
        access_token: 'idp-access-token',
        token_type: 'bearer',
        claims: () => ({ ...idp.claims, nonce: checks.expectedNonce }),
      };
    }),
  };
});

import { createApp } from '../app';
import { encryptSecret, SSO_BINDING_COOKIE, SSO_STATE_TTL_MS } from '../services/sso';
import type { Server } from 'node:http';
import { closeServer, listen } from './auth-helpers';

const suffix = randomUUID().slice(0, 8);
const domain = `sso-${suffix}.example.com`;
const issuer = `https://idp-${suffix}.example.test`;

function s256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

interface StartedFlow {
  authUrl: URL;
  state: string;
  cookie: string;
  setCookie: string;
}

describe('W02b SSO login state', () => {
  const app = createApp();
  let server: Server | undefined;
  let baseUrl = '';
  let workspaceId = '';

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(app));
    const workspace = await prisma.workspace.create({ data: { name: `SSO ${suffix}`, slug: `sso-${suffix}` } });
    workspaceId = workspace.id;
    await prisma.sSOConfig.create({
      data: {
        workspaceId,
        issuerUrl: issuer,
        clientId: `client-${suffix}`,
        clientSecretEncrypted: encryptSecret('idp-client-secret'),
        allowedDomains: [domain],
        domainVerifiedAt: new Date(),
      },
    });
  });

  beforeEach(() => {
    idp.grants.length = 0;
    idp.claims = { sub: `subject-${randomUUID()}`, email: `alice@${domain}` };
  });

  afterAll(async () => {
    await closeServer(server);
    const identities = await prisma.identity.findMany({ where: { issuer }, select: { userId: true } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: { in: identities.map((row) => row.userId) } } });
    await prisma.ssoAuthState.deleteMany({ where: { issuerUrl: issuer } });
  });

  async function start(): Promise<StartedFlow> {
    const res = await request(baseUrl).get('/api/auth/sso/check').query({ email: `alice@${domain}` });
    expect(res.status).toBe(200);
    expect(res.body.ssoEnabled).toBe(true);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${SSO_BINDING_COOKIE}=`));
    expect(setCookie).toBeDefined();
    const cookie = (setCookie ?? '').split(';')[0] ?? '';
    const authUrl = new URL(res.body.authUrl as string);
    return { authUrl, state: authUrl.searchParams.get('state') ?? '', cookie, setCookie: setCookie ?? '' };
  }

  function callback(flow: { state: string }, cookie?: string) {
    let req = request(baseUrl).get('/api/auth/sso/callback').query({ code: `code-${randomUUID()}`, state: flow.state });
    if (cookie) req = req.set('Cookie', cookie);
    return req.redirects(0);
  }

  it('keeps the PKCE verifier and nonce out of the authorization URL and the state', async () => {
    const flow = await start();
    // Opaque random state: not base64url JSON, no signature part.
    expect(flow.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => JSON.parse(Buffer.from(flow.state, 'base64url').toString('utf8'))).toThrow();
    expect(flow.authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = flow.authUrl.searchParams.get('code_challenge');
    const nonce = flow.authUrl.searchParams.get('nonce');
    expect(challenge).toBeTruthy();

    // Browser binding cookie: HttpOnly, SameSite=Lax, scoped to the SSO routes, 10 minutes.
    expect(flow.setCookie).toMatch(/HttpOnly/i);
    expect(flow.setCookie).toMatch(/SameSite=Lax/i);
    expect(flow.setCookie).toMatch(/Path=\/api\/auth\/sso/);
    expect(flow.setCookie).toMatch(new RegExp(`Max-Age=${SSO_STATE_TTL_MS / 1000}`));

    // Server-side row: state stored hashed, verifier encrypted at rest.
    const row = await prisma.ssoAuthState.findUnique({
      where: { stateHash: createHash('sha256').update(flow.state).digest('hex') },
    });
    expect(row).not.toBeNull();
    expect(row?.codeVerifierEncrypted.startsWith('enc:v1:')).toBe(true);
    expect(row?.nonce).toBe(nonce);

    const done = await callback(flow, flow.cookie);
    expect(done.status).toBe(302);
    expect(done.headers.location).toContain('/auth/session?token=');
    expect(idp.grants).toHaveLength(1);
    const grant = idp.grants[0]!;
    // The verifier reached the token endpoint exchange, and it never appeared anywhere in the URL.
    expect(grant.pkceCodeVerifier).toBeTruthy();
    expect(s256(grant.pkceCodeVerifier ?? '')).toBe(challenge);
    expect(flow.authUrl.href).not.toContain(grant.pkceCodeVerifier ?? '<none>');
    expect(flow.state).not.toContain(grant.pkceCodeVerifier ?? '<none>');
    expect(grant.expectedNonce).toBe(nonce);
    expect(grant.expectedState).toBe(flow.state);
    // The binding cookie is cleared once the flow completes.
    expect(([] as string[]).concat(done.headers['set-cookie'] ?? []).join(';')).toMatch(new RegExp(`${SSO_BINDING_COOKIE}=;`));
  });

  it('rejects a replayed state without a second code exchange', async () => {
    const flow = await start();
    expect((await callback(flow, flow.cookie)).status).toBe(302);
    const replay = await callback(flow, flow.cookie);
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('SSO_STATE_INVALID');
    expect(replay.body.details.reason).toBe('replayed');
    expect(idp.grants).toHaveLength(1);
  });

  it('rejects a callback from another browser without burning the real one', async () => {
    const flow = await start();
    const other = await start();
    const noCookie = await callback(flow);
    expect(noCookie.status).toBe(400);
    expect(noCookie.body.details.reason).toBe('browser-mismatch');
    const wrongCookie = await callback(flow, other.cookie);
    expect(wrongCookie.status).toBe(400);
    expect(wrongCookie.body.details.reason).toBe('browser-mismatch');
    expect(idp.grants).toHaveLength(0);
    // The browser that started the flow can still finish it.
    expect((await callback(flow, flow.cookie)).status).toBe(302);
  });

  it('rejects an expired state', async () => {
    const flow = await start();
    await prisma.ssoAuthState.update({
      where: { stateHash: createHash('sha256').update(flow.state).digest('hex') },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const res = await callback(flow, flow.cookie);
    expect(res.status).toBe(400);
    expect(res.body.details.reason).toBe('expired');
    expect(idp.grants).toHaveLength(0);
  });

  it('rejects a tampered state and the old signed-state format', async () => {
    const flow = await start();
    const last = flow.state.at(-1) === 'A' ? 'B' : 'A';
    const tampered = await callback({ state: `${flow.state.slice(0, -1)}${last}` }, flow.cookie);
    expect(tampered.status).toBe(400);
    expect(tampered.body.details.reason).toBe('unknown');

    const legacyBody = Buffer.from(JSON.stringify({ workspaceId, codeVerifier: 'v'.repeat(43), nonce: 'n', ts: Date.now() })).toString('base64url');
    const legacy = await callback({ state: `${legacyBody}.signature` }, flow.cookie);
    expect(legacy.status).toBe(400);
    expect(legacy.body.details.reason).toBe('unknown');
    expect(idp.grants).toHaveLength(0);
  });

  it('lets exactly one of several concurrent callbacks use a state', async () => {
    const flow = await start();
    const results = await Promise.all(Array.from({ length: 5 }, () => callback(flow, flow.cookie)));
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([302, 400, 400, 400, 400]);
    expect(idp.grants).toHaveLength(1);
  });
});
