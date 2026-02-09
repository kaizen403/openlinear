import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';

describe('Auth API', () => {
  const app = createApp();

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
