import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { encryptToken, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { exchangeCodeForToken, getGitHubBranches, getGitHubRepos } from '../services/github';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

function generateToken(userId: string, username: string = 'testuser') {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Repos API auth', () => {
  const app = createApp();

  it('requires auth for public repository reads', async () => {
    const publicRes = await request(app).get('/api/repos/public');
    const activeRes = await request(app).get('/api/repos/active/public');

    expect(publicRes.status).toBe(401);
    expect(activeRes.status).toBe(401);
  });

  it('requires auth for public repository writes', async () => {
    const addRes = await request(app)
      .post('/api/repos/url')
      .send({ url: 'https://github.com/openai/openai-node' });
    const activateRes = await request(app).post('/api/repos/repo-id/activate/public');

    expect(addRes.status).toBe(401);
    expect(activateRes.status).toBe(401);
  });
});

describe('GitHub branch route', () => {
  const app = createApp();

  it('returns branches for the authenticated user repository', async () => {
    const user = await prisma.user.upsert({
      where: { githubId: 'repos-branches-user' },
      update: { accessToken: encryptToken('github-token') },
      create: {
        githubId: 'repos-branches-user',
        username: 'octo',
        email: 'octo@example.com',
        accessToken: encryptToken('github-token'),
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: 'main', commit: { sha: 'abc123', url: 'https://api.github.com/repos/octo/app/commits/abc123' } },
          { name: 'release/2026', protected: true },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app)
      .get('/api/repos/github/octo/app/branches')
      .set('Authorization', `Bearer ${generateToken(user.id, user.username)}`);

    expect(res.status).toBe(200);
    expect(res.body.branches.map((branch: { name: string }) => branch.name)).toEqual(['main', 'release/2026']);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/repos/octo/app/branches');
    expect(url.searchParams.get('per_page')).toBe('100');
  });
});

describe('GitHub repo service', () => {
  it('includes the loopback redirect URI when exchanging a desktop OAuth code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'github-token' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await exchangeCodeForToken(
      'oauth-code',
      'http://localhost:45678/api/auth/github/callback',
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      code: 'oauth-code',
      redirect_uri: 'http://localhost:45678/api/auth/github/callback',
    });
  });

  it('returns a paged envelope from /user/repos by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 1,
            name: 'openlinear',
            full_name: 'octo/openlinear',
            clone_url: 'https://github.com/octo/openlinear.git',
            default_branch: 'main',
            private: false,
            description: null,
            fork: false,
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getGitHubRepos('token', {
      userId: 'repo-service-default',
      username: 'octo',
      page: 1,
      perPage: 30,
      sort: 'pushed',
      filter: 'all',
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/user/repos');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('per_page')).toBe('30');
    expect(url.searchParams.get('sort')).toBe('pushed');
    expect(result).toEqual({
      repos: expect.arrayContaining([expect.objectContaining({ full_name: 'octo/openlinear' })]),
      hasMore: false,
      totalCount: 1,
    });
  });

  it('uses repository search when a query is provided', async () => {
    const fetchMock = vi.fn().mockImplementation((rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/user/orgs') {
        return Promise.resolve(new Response(JSON.stringify([{ login: 'acme' }]), { status: 200 }));
      }

      const isOrgSearch = url.searchParams.get('q')?.includes('org:acme');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            total_count: isOrgSearch ? 1 : 75,
            items: [
              {
                id: isOrgSearch ? 3 : 2,
                name: isOrgSearch ? 'org-app' : 'private-app',
                full_name: isOrgSearch ? 'acme/org-app' : 'octo/private-app',
                clone_url: isOrgSearch
                  ? 'https://github.com/acme/org-app.git'
                  : 'https://github.com/octo/private-app.git',
                default_branch: 'main',
                private: true,
                description: null,
                stargazers_count: isOrgSearch ? 4 : 10,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getGitHubRepos('token', {
      userId: 'repo-service-search',
      username: 'octo',
      page: 1,
      perPage: 30,
      sort: 'stars',
      filter: 'private',
      q: 'app',
    });

    const url = new URL(fetchMock.mock.calls[1][0] as string);
    expect(url.pathname).toBe('/search/repositories');
    expect(url.searchParams.get('q')).toContain('app');
    expect(url.searchParams.get('q')).toContain('user:octo');
    expect(url.searchParams.get('q')).toContain('is:private');
    expect(url.searchParams.get('sort')).toBe('stars');
    expect(result.hasMore).toBe(true);
    expect(result.totalCount).toBe(76);
    expect(result.repos.map((repo) => repo.full_name)).toEqual(['octo/private-app', 'acme/org-app']);
  });

  it('limits repository search to the first five organization scopes', async () => {
    const fetchMock = vi.fn().mockImplementation((rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/user/orgs') {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              Array.from({ length: 8 }, (_, index) => ({ login: `org-${index + 1}` })),
            ),
            { status: 200 },
          ),
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            total_count: 1,
            items: [
              {
                id: Number(fetchMock.mock.calls.length),
                name: 'app',
                full_name: 'octo/app',
                clone_url: 'https://github.com/octo/app.git',
                default_branch: 'main',
                private: false,
                description: null,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await getGitHubRepos('token-org-scope-cap', {
      userId: 'repo-service-search-cap',
      username: 'octo',
      page: 1,
      perPage: 30,
      sort: 'pushed',
      filter: 'all',
      q: 'app',
    });

    const searchUrls = fetchMock.mock.calls
      .map((call) => new URL(call[0] as string))
      .filter((url) => url.pathname === '/search/repositories');

    expect(searchUrls).toHaveLength(6);
    expect(searchUrls.map((url) => url.searchParams.get('q'))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('user:octo'),
        expect.stringContaining('org:org-1'),
        expect.stringContaining('org:org-5'),
      ]),
    );
    expect(searchUrls.some((url) => url.searchParams.get('q')?.includes('org:org-6'))).toBe(false);
  });

  it('fetches repository branches from GitHub', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: 'main' },
          { name: 'develop' },
          { name: '' },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const branches = await getGitHubBranches('token', 'octo', 'openlinear');

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/repos/octo/openlinear/branches');
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(branches.map((branch) => branch.name)).toEqual(['main', 'develop']);
  });

  it('caches repository branches per token and repository', async () => {
    const fetchMock = vi.fn().mockImplementation(() => (
      Promise.resolve(new Response(JSON.stringify([{ name: 'main' }]), { status: 200 }))
    ));
    vi.stubGlobal('fetch', fetchMock);

    const first = await getGitHubBranches('token-cache-a', 'octo', 'cached');
    const second = await getGitHubBranches('token-cache-a', 'octo', 'cached');
    const third = await getGitHubBranches('token-cache-b', 'octo', 'cached');

    expect(first.map((branch) => branch.name)).toEqual(['main']);
    expect(second.map((branch) => branch.name)).toEqual(['main']);
    expect(third.map((branch) => branch.name)).toEqual(['main']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
