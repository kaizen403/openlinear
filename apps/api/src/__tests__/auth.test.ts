import { afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { hashToken } from '../services/sessions';
import { testJwtSecret } from './test-env';

describe('Auth API', () => {
  const app = createApp();
  const originalGitHubRedirectUri = process.env.GITHUB_REDIRECT_URI;
  const originalCorsOrigin = process.env.CORS_ORIGIN;
  const originalGitHubOAuth = process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH;

  afterEach(() => {
    if (originalGitHubRedirectUri === undefined) {
      delete process.env.GITHUB_REDIRECT_URI;
    } else {
      process.env.GITHUB_REDIRECT_URI = originalGitHubRedirectUri;
    }
    if (originalCorsOrigin === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = originalCorsOrigin;
    }
    if (originalGitHubOAuth === undefined) {
      delete process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH;
    } else {
      process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = originalGitHubOAuth;
    }
  });

  describe('CORS loopback origins', () => {
    it('allows the 127.0.0.1 desktop origin with default CORS settings', async () => {
      delete process.env.CORS_ORIGIN;

      const res = await request(createApp())
        .get('/api/auth/me')
        .set('Origin', 'http://127.0.0.1:3000');

      expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    });

    it('expands configured localhost origins to the matching 127.0.0.1 origin', async () => {
      process.env.CORS_ORIGIN = 'http://localhost:3000';

      const res = await request(createApp())
        .get('/api/auth/me')
        .set('Origin', 'http://127.0.0.1:3000');

      expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    });
  });

  describe('GET /api/auth/github', () => {
    it('stays disabled unless OPENLINEAR_ENABLE_GITHUB_OAUTH=1', async () => {
      delete process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH;
      const res = await request(app).get('/api/auth/github').redirects(0);
      expect(res.status).toBe(503);
      expect(res.body.error?.code ?? res.body.code).toBe('GITHUB_OAUTH_DISABLED');
    });

    it('redirects to GitHub OAuth URL', async () => {
      process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = '1';
      const res = await request(app).get('/api/auth/github').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('github.com/login/oauth/authorize');
    });

    it('includes correct scopes in redirect URL', async () => {
      process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = '1';
      const res = await request(app).get('/api/auth/github').redirects(0);
      const location = res.headers.location;
      expect(location).toContain('scope=');
      expect(location).toContain('read%3Auser');  // read:user URL-encoded
    });

    it('uses the current loopback sidecar port for desktop OAuth redirects', async () => {
      process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = '1';
      process.env.GITHUB_REDIRECT_URI = 'http://localhost:3001/api/auth/github/callback';

      const res = await request(app)
        .get('/api/auth/github?client=desktop')
        .set('Host', '127.0.0.1:45678')
        .redirects(0);

      const location = new URL(res.headers.location);
      expect(location.hostname).toBe('github.com');
      expect(location.searchParams.get('redirect_uri')).toBe(
        'http://localhost:45678/api/auth/github/callback',
      );
    });

    it('keeps the configured redirect URI for web OAuth redirects', async () => {
      process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = '1';
      process.env.GITHUB_REDIRECT_URI = 'http://localhost:3001/api/auth/github/callback';

      const res = await request(app)
        .get('/api/auth/github')
        .set('Host', '127.0.0.1:45678')
        .redirects(0);

      const location = new URL(res.headers.location);
      expect(location.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3001/api/auth/github/callback',
      );
    });

    it('redirects directly to the desktop callback when desktop OAuth returns an error', async () => {
      process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = '1';
      process.env.GITHUB_REDIRECT_URI = 'http://localhost:3001/api/auth/github/callback';

      const startRes = await request(app)
        .get('/api/auth/github?client=desktop')
        .set('Host', '127.0.0.1:45678')
        .redirects(0);
      const state = new URL(startRes.headers.location).searchParams.get('state');

      const res = await request(app)
        .get(`/api/auth/github/callback?error=access_denied&state=${encodeURIComponent(state ?? '')}`)
        .set('Host', '127.0.0.1:45678')
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('openlinear://callback?error=access_denied');
      expect(res.text).not.toContain('Copy app link');
      expect(res.text).not.toContain('paste it into the sign-in screen');
    });
  });

  describe('GET /api/auth/github/callback', () => {
    it('stays disabled unless OPENLINEAR_ENABLE_GITHUB_OAUTH=1', async () => {
      delete process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH;
      const res = await request(app).get('/api/auth/github/callback?code=x').redirects(0);
      expect(res.status).toBe(503);
      expect(res.body.error?.code ?? res.body.code).toBe('GITHUB_OAUTH_DISABLED');
    });

    it('redirects with error when error param is present', async () => {
      process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = '1';
      const res = await request(app)
        .get('/api/auth/github/callback?error=access_denied&error_description=User+denied')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
    });

    it('redirects with error when code is missing', async () => {
      process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = '1';
      const res = await request(app)
        .get('/api/auth/github/callback')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=missing_code');
    });

    it('sends the web client to the dedicated session-adoption route', async () => {
      process.env.OPENLINEAR_ENABLE_GITHUB_OAUTH = '1';
      // Contract with apps/desktop-ui: the app no longer reads `?token=` on
      // arbitrary routes (that let any link swap the victim's session), so the
      // OAuth redirect must land on /auth/session, which verifies the token
      // before adopting it. If this assertion is changed, the web login flow
      // and the frontend route must be changed together.
      const res = await request(app)
        .get('/api/auth/github/callback')
        .redirects(0);
      expect(res.headers.location).toContain('/auth/session?');
      expect(res.headers.location).not.toMatch(/^https?:\/\/[^/]+\/?\?/);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns 401 without authorization header', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    });

    it('returns 401 with invalid token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token-here');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid token',
      });
    });

    it('returns 401 with malformed authorization header', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'NotBearer some-token');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    });
  });

  describe('POST /api/auth/logout', () => {
    it('requires authentication', async () => {
      // Logout must revoke a specific session server-side, so it needs to know
      // which token is being surrendered. It used to be an unauthenticated
      // no-op that returned success while the bearer token stayed valid for its
      // full 7-day lifetime.
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(401);
    });

    it('revokes the session so the token stops working', async () => {
      const user = await prisma.user.upsert({
        where: { username: 'logouttester' },
        update: {},
        create: {
          githubId: '990777',
          username: 'logouttester',
          email: 'logouttester@example.com',
        },
      });

      const token = jwt.sign(
        { userId: user.id, username: user.username },
        testJwtSecret(),
        { expiresIn: '1h' },
      );
      await prisma.session.create({
        data: { userId: user.id, tokenHash: hashToken(token) },
      });

      const before = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(before.status).toBe(200);

      const out = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`);
      expect(out.status).toBe(200);
      expect(out.body.success).toBe(true);

      const after = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(after.status).toBe(401);

      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });
  });
});
