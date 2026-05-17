import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { exchangeCodeForToken, getGitHubRepos } from '../services/github';

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
});
