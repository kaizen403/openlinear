import { afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';

describe('Auth API', () => {
  const app = createApp();
  const originalGitHubRedirectUri = process.env.GITHUB_REDIRECT_URI;
  const originalCorsOrigin = process.env.CORS_ORIGIN;

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
    it('redirects to GitHub OAuth URL', async () => {
      const res = await request(app).get('/api/auth/github').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('github.com/login/oauth/authorize');
    });

    it('includes correct scopes in redirect URL', async () => {
      const res = await request(app).get('/api/auth/github').redirects(0);
      const location = res.headers.location;
      expect(location).toContain('scope=');
      expect(location).toContain('read%3Auser');  // read:user URL-encoded
    });

    it('uses the current loopback sidecar port for desktop OAuth redirects', async () => {
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

    it('renders a desktop callback bridge when desktop OAuth returns an error', async () => {
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

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('OpenLinear sign-in failed');
      expect(res.text).toContain('openlinear://callback?error=access_denied');
      expect(res.text).toContain('aria-label="OpenLinear"');
      expect(res.text).toContain('id="open-app"');
      expect(res.text).toContain('id="copy-app-link"');
      expect(res.text).not.toContain('setTimeout(requestOpenLinear');
      expect(res.text).not.toContain('preventDefault()');
      expect(res.text).not.toContain('requestOpenLinear');
    });
  });

  describe('GET /api/auth/github/callback', () => {
    it('redirects with error when error param is present', async () => {
      const res = await request(app)
        .get('/api/auth/github/callback?error=access_denied&error_description=User+denied')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
    });

    it('redirects with error when code is missing', async () => {
      const res = await request(app)
        .get('/api/auth/github/callback')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=missing_code');
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
    it('returns success', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
