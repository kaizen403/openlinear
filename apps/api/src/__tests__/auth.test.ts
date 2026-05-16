import { afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';

describe('Auth API', () => {
  const app = createApp();
  const originalGitHubRedirectUri = process.env.GITHUB_REDIRECT_URI;

  afterEach(() => {
    if (originalGitHubRedirectUri === undefined) {
      delete process.env.GITHUB_REDIRECT_URI;
    } else {
      process.env.GITHUB_REDIRECT_URI = originalGitHubRedirectUri;
    }
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
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 with invalid token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token-here');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid token');
    });

    it('returns 401 with malformed authorization header', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'NotBearer some-token');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
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
