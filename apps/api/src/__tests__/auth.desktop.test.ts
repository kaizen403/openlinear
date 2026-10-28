/**
 * Desktop sign-in through the cloud API (RFC 8252 + RFC 7636 PKCE).
 *
 * GitHub is stubbed at the network boundary (global fetch), so the real
 * authorize -> callback -> exchange path runs end to end against Postgres.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { hashToken } from '../services/sessions';
import { computeS256Challenge } from '../services/desktop-auth';
import { useTestServer, type TestClient } from './http';

const ENV_KEYS = [
  'OPENLINEAR_ENABLE_GITHUB_OAUTH',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_REDIRECT_URI',
] as const;

const suffix = randomUUID().slice(0, 8);
let githubIdCounter = Number.parseInt(randomBytes(3).toString('hex'), 16) + 7_000_000;
const createdUserIds = new Set<string>();

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function appState(): string {
  return randomBytes(24).toString('base64url');
}

interface StubbedGitHubUser {
  id: number;
  login: string;
  email: string;
}

function nextGitHubUser(label: string): StubbedGitHubUser {
  githubIdCounter += 1;
  return {
    id: githubIdCounter,
    login: `desk-${label}-${suffix}-${githubIdCounter}`,
    email: `desk-${label}-${suffix}-${githubIdCounter}@example.com`,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stub GitHub's token exchange and user endpoints; anything else fails. */
function stubGitHub(user: StubbedGitHubUser): { tokenRequests: Array<Record<string, unknown>> } {
  const tokenRequests: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://github.com/login/oauth/access_token') {
        tokenRequests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({ access_token: `gho_test_${user.id}` });
      }
      if (url === 'https://api.github.com/user') {
        return jsonResponse({
          id: user.id,
          login: user.login,
          email: user.email,
          avatar_url: 'https://avatars.example.com/u.png',
        });
      }
      throw new Error(`unexpected network call in test: ${url}`);
    }),
  );
  return { tokenRequests };
}

function enableGitHubOAuth(): void {
  process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = '1';
  process.env.GITHUB_CLIENT_ID = 'test-desktop-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-desktop-client-secret';
  process.env.GITHUB_REDIRECT_URI = 'http://localhost:3001/api/auth/github/callback';
}

type App = () => TestClient;

async function authorize(app: App, pkce: { challenge: string }, state: string) {
  return app()
    .post('/api/auth/desktop/authorize')
    .send({ codeChallenge: pkce.challenge, codeChallengeMethod: 'S256', state });
}

interface DeepLink {
  code: string | null;
  state: string | null;
  error: string | null;
  raw: string;
}

function parseDeepLink(location: string): DeepLink {
  const url = new URL(location);
  expect(url.protocol).toBe('openlinear:');
  expect(url.hostname).toBe('callback');
  return {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    error: url.searchParams.get('error'),
    raw: location,
  };
}

/** authorize -> (stubbed) GitHub -> callback; returns the deep link the app receives. */
async function completeBrowserLeg(
  app: App,
  options: { label: string; pkce?: { verifier: string; challenge: string }; state?: string } = { label: 'flow' },
) {
  const pkce = options.pkce ?? pkcePair();
  const state = options.state ?? appState();
  const authorized = await authorize(app, pkce, state);
  expect(authorized.status).toBe(200);
  const authorizeUrl = new URL(authorized.body.authorizeUrl as string);
  expect(authorizeUrl.origin).toBe('https://github.com');
  const signedState = authorizeUrl.searchParams.get('state') ?? '';

  const githubUser = nextGitHubUser(options.label);
  const stub = stubGitHub(githubUser);
  const callback = await app()
    .get(`/api/auth/github/callback?code=gh-code-${githubUser.id}&state=${encodeURIComponent(signedState)}`)
    .redirects(0);
  expect(callback.status).toBe(302);
  expect(callback.headers['cache-control']).toBe('no-store');
  const deepLink = parseDeepLink(callback.headers.location as string);

  const user = await prisma.user.findUniqueOrThrow({ where: { githubId: String(githubUser.id) } });
  createdUserIds.add(user.id);
  return { pkce, state, deepLink, user, authorizeUrl, stub };
}

async function redeem(app: App, code: string, codeVerifier: string) {
  return app().post('/api/auth/desktop/token').send({ code, codeVerifier });
}

describe('Desktop sign-in through the cloud API', () => {
  const app = useTestServer(() => createApp());
  const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    enableGitHubOAuth();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    const ids = [...createdUserIds];
    if (ids.length > 0) {
      await prisma.desktopAuthCode.deleteMany({ where: { userId: { in: ids } } });
      await prisma.twoFactorChallenge.deleteMany({ where: { userId: { in: ids } } });
      await prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
  });

  describe('availability', () => {
    it('reports GitHub sign-in as disabled until it is enabled with credentials', async () => {
      delete process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH;
      const off = await app().get('/api/auth/providers');
      expect(off.status).toBe(200);
      expect(off.body).toEqual({ github: { enabled: false } });

      enableGitHubOAuth();
      const on = await app().get('/api/auth/providers');
      expect(on.body).toEqual({ github: { enabled: true } });
    });

    it('stays disabled without client credentials, even with the flag', async () => {
      delete process.env.GITHUB_CLIENT_SECRET;
      const res = await authorize(app, pkcePair(), appState());
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('GITHUB_OAUTH_DISABLED');
    });

    it('never re-enables a revoked OAuth app', async () => {
      process.env.GITHUB_CLIENT_ID = 'Ov23liy8-revoked-test-value';
      const providers = await app().get('/api/auth/providers');
      expect(providers.body).toEqual({ github: { enabled: false } });
      const res = await app().get('/api/auth/github').redirects(0);
      expect(res.status).toBe(503);
    });

    it('can be enabled in production with the flag and new credentials', async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await app().get('/api/auth/providers');
        expect(res.body).toEqual({ github: { enabled: true } });
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    it('answers 503 on every desktop endpoint while disabled', async () => {
      delete process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH;
      const pkce = pkcePair();
      const auth = await authorize(app, pkce, appState());
      expect(auth.status).toBe(503);
      const token = await redeem(app, randomBytes(32).toString('base64url'), pkce.verifier);
      expect(token.status).toBe(503);
      expect(token.body.code).toBe('GITHUB_OAUTH_DISABLED');
    });
  });

  describe('POST /api/auth/desktop/authorize', () => {
    it('binds the GitHub state to the PKCE challenge and returns the authorize URL', async () => {
      const pkce = pkcePair();
      const res = await authorize(app, pkce, appState());
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const url = new URL(res.body.authorizeUrl as string);
      expect(url.href.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
      expect(url.searchParams.get('client_id')).toBe('test-desktop-client-id');
      // The configured callback, never a value derived from request headers.
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3001/api/auth/github/callback');
      expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(res.body.expiresIn).toBe(600);
    });

    it('ignores the request Host when choosing the redirect URI', async () => {
      const res = await app()
        .post('/api/auth/desktop/authorize')
        .set('Host', '127.0.0.1:45678')
        .send({ codeChallenge: pkcePair().challenge, codeChallengeMethod: 'S256', state: appState() });
      expect(new URL(res.body.authorizeUrl as string).searchParams.get('redirect_uri')).toBe(
        'http://localhost:3001/api/auth/github/callback',
      );
    });

    it.each([
      ['plain challenge method', { codeChallengeMethod: 'plain' }],
      ['short challenge', { codeChallenge: 'abc' }],
      ['challenge with padding', { codeChallenge: `${'a'.repeat(42)}=` }],
      ['short state', { state: 'short' }],
      ['state with unsafe characters', { state: 'state with spaces and more chars' }],
    ])('rejects a %s', async (_label, override) => {
      const res = await app()
        .post('/api/auth/desktop/authorize')
        .send({ codeChallenge: pkcePair().challenge, codeChallengeMethod: 'S256', state: appState(), ...override });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('refuses the old browser-only desktop entry point', async () => {
      const res = await app().get('/api/auth/github?client=desktop').redirects(0);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DESKTOP_PKCE_REQUIRED');
    });
  });

  describe('GitHub callback for a desktop sign-in', () => {
    it('hands the app a one-time code and its own state, never a token', async () => {
      const { deepLink, state, stub } = await completeBrowserLeg(app, { label: 'link' });
      expect(deepLink.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(deepLink.state).toBe(state);
      expect(deepLink.error).toBeNull();
      const params = new URL(deepLink.raw).searchParams;
      expect([...params.keys()].sort()).toEqual(['code', 'state']);
      expect(deepLink.raw).not.toMatch(/token|eyJ/i);
      // The GitHub code exchange uses the app's registered callback.
      expect(stub.tokenRequests).toHaveLength(1);
      expect(stub.tokenRequests[0]).not.toHaveProperty('redirect_uri');
    });

    it('stores only the hash of the code, bound to the challenge', async () => {
      const { deepLink, pkce, user } = await completeBrowserLeg(app, { label: 'hash' });
      const row = await prisma.desktopAuthCode.findUnique({ where: { codeHash: hashToken(deepLink.code!) } });
      expect(row).not.toBeNull();
      expect(row?.userId).toBe(user.id);
      expect(row?.codeChallenge).toBe(pkce.challenge);
      expect(row?.consumedAt).toBeNull();
      const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(2 * 60 * 1000 + 1_000);
      const plaintext = await prisma.desktopAuthCode.count({ where: { codeHash: deepLink.code! } });
      expect(plaintext).toBe(0);
    });

    it('returns provider errors to the app with its state', async () => {
      const pkce = pkcePair();
      const state = appState();
      const authorized = await authorize(app, pkce, state);
      const signedState = new URL(authorized.body.authorizeUrl as string).searchParams.get('state') ?? '';
      const res = await app()
        .get(`/api/auth/github/callback?error=access_denied&state=${encodeURIComponent(signedState)}`)
        .redirects(0);
      expect(res.status).toBe(302);
      const deepLink = parseDeepLink(res.headers.location as string);
      expect(deepLink).toMatchObject({ code: null, error: 'access_denied', state });
    });

    it('treats a tampered state as a web error, not a desktop hand-off', async () => {
      const authorized = await authorize(app, pkcePair(), appState());
      const signedState = new URL(authorized.body.authorizeUrl as string).searchParams.get('state') ?? '';
      const [body, sig] = signedState.split('.');
      const forged = Buffer.from(body!, 'base64url').toString().replace('"desktop"', '"desktop" ');
      const res = await app()
        .get(`/api/auth/github/callback?code=x&state=${encodeURIComponent(`${Buffer.from(forged).toString('base64url')}.${sig}`)}`)
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/auth/session?error=invalid_state');
    });
  });

  describe('POST /api/auth/desktop/token', () => {
    it('exchanges the code and verifier for working tokens', async () => {
      const { deepLink, pkce, user } = await completeBrowserLeg(app, { label: 'redeem' });
      const res = await redeem(app, deepLink.code!, pkce.verifier);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).toMatchObject({ tokenType: 'Bearer' });
      expect(typeof res.body.token).toBe('string');
      expect(typeof res.body.refreshToken).toBe('string');

      const me = await app().get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
      expect(me.status).toBe(200);
      expect(me.body.id).toBe(user.id);

      const refreshed = await app().post('/api/auth/refresh').send({ refreshToken: res.body.refreshToken });
      expect(refreshed.status).toBe(200);
      expect(typeof refreshed.body.token).toBe('string');
      expect(typeof refreshed.body.refreshToken).toBe('string');
    });

    it('is single use: a replay is rejected and the first session stays valid', async () => {
      const { deepLink, pkce, user } = await completeBrowserLeg(app, { label: 'replay' });
      const first = await redeem(app, deepLink.code!, pkce.verifier);
      expect(first.status).toBe(200);

      const replay = await redeem(app, deepLink.code!, pkce.verifier);
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('DESKTOP_AUTH_CODE_INVALID');
      expect(replay.body).not.toHaveProperty('token');

      const sessions = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
      expect(sessions).toBe(1);
      const me = await app().get('/api/auth/me').set('Authorization', `Bearer ${first.body.token}`);
      expect(me.status).toBe(200);
    });

    it('rejects a verifier that does not match, without consuming the code', async () => {
      const { deepLink, pkce } = await completeBrowserLeg(app, { label: 'mismatch' });
      const wrong = await redeem(app, deepLink.code!, pkcePair().verifier);
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('DESKTOP_AUTH_CODE_INVALID');

      const row = await prisma.desktopAuthCode.findUnique({ where: { codeHash: hashToken(deepLink.code!) } });
      expect(row?.consumedAt).toBeNull();

      const right = await redeem(app, deepLink.code!, pkce.verifier);
      expect(right.status).toBe(200);
    });

    it('rejects a code from another sign-in even when both are valid', async () => {
      const a = await completeBrowserLeg(app, { label: 'cross-a' });
      const b = await completeBrowserLeg(app, { label: 'cross-b' });
      const swapped = await redeem(app, a.deepLink.code!, b.pkce.verifier);
      expect(swapped.status).toBe(400);
      expect(computeS256Challenge(b.pkce.verifier)).not.toBe(a.pkce.challenge);
    });

    it('rejects an expired code', async () => {
      const { deepLink, pkce, user } = await completeBrowserLeg(app, { label: 'expired' });
      await prisma.desktopAuthCode.update({
        where: { codeHash: hashToken(deepLink.code!) },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const res = await redeem(app, deepLink.code!, pkce.verifier);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DESKTOP_AUTH_CODE_INVALID');
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    });

    it('rejects an unknown code and malformed input', async () => {
      const unknown = await redeem(app, randomBytes(32).toString('base64url'), pkcePair().verifier);
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('DESKTOP_AUTH_CODE_INVALID');

      const malformed = await redeem(app, 'not-a-code', 'short');
      expect(malformed.status).toBe(400);
      expect(malformed.body.code).toBe('VALIDATION_ERROR');
    });

    it('lets exactly one of many concurrent redemptions succeed', async () => {
      const { deepLink, pkce, user } = await completeBrowserLeg(app, { label: 'race' });
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () => redeem(app, deepLink.code!, pkce.verifier)),
      );
      const statuses = attempts.map((res) => res.status).sort();
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 400)).toHaveLength(7);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    });

    it('requires the second factor for TOTP users instead of issuing a session', async () => {
      const { deepLink, pkce, user } = await completeBrowserLeg(app, { label: 'totp' });
      await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } });

      const res = await redeem(app, deepLink.code!, pkce.verifier);
      expect(res.status).toBe(200);
      expect(res.body.twoFactorRequired).toBe(true);
      expect(typeof res.body.tempToken).toBe('string');
      expect(res.body).not.toHaveProperty('token');
      expect(res.body).not.toHaveProperty('refreshToken');
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
      expect(await prisma.twoFactorChallenge.count({ where: { userId: user.id } })).toBe(1);
    });
  });

  describe('refresh and logout', () => {
    async function signedIn(label: string) {
      const { deepLink, pkce } = await completeBrowserLeg(app, { label });
      const res = await redeem(app, deepLink.code!, pkce.verifier);
      expect(res.status).toBe(200);
      return res.body as { token: string; refreshToken: string };
    }

    it('keeps a cookie-held refresh token out of the response body', async () => {
      const { refreshToken } = await signedIn('cookie');
      const res = await app()
        .post('/api/auth/refresh')
        .set('Cookie', `ol_refresh=${encodeURIComponent(refreshToken)}`)
        .send({});
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
      expect(res.body).not.toHaveProperty('refreshToken');
      const cookie = String(res.headers['set-cookie'] ?? '');
      expect(cookie).toMatch(/ol_refresh=[^;]+;/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Path=\/api\/auth/);
    });

    it('returns a rotated refresh token to body clients without setting a cookie', async () => {
      const { refreshToken } = await signedIn('body');
      const res = await app().post('/api/auth/refresh').send({ refreshToken });
      expect(res.status).toBe(200);
      expect(typeof res.body.refreshToken).toBe('string');
      expect(res.body.refreshToken).not.toBe(refreshToken);
      expect(res.headers['set-cookie']).toBeUndefined();

      const reused = await app().post('/api/auth/refresh').send({ refreshToken });
      expect(reused.status).toBe(401);
    });

    it('clears the refresh cookie on logout and revokes the session', async () => {
      const { token, refreshToken } = await signedIn('logout');
      const out = await app().post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
      expect(out.status).toBe(200);
      expect(String(out.headers['set-cookie'] ?? '')).toMatch(/ol_refresh=;/);
      const refresh = await app().post('/api/auth/refresh').send({ refreshToken });
      expect(refresh.status).toBe(401);
    });
  });
});
