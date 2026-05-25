import { createHash } from 'node:crypto';
import { prisma, decryptToken, encryptToken } from '@openlinear/db';

export function decryptUserAccessToken(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return decryptToken(stored);
  } catch (err) {
    console.error('[github] Failed to decrypt access token:', err);
    return null;
  }
}

// Read env vars lazily to avoid ESM import hoisting issues with dotenv
function getGitHubConfig() {
  return {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    redirectUri: process.env.GITHUB_REDIRECT_URI || 'http://localhost:3001/api/auth/github/callback',
  };
}

export interface GitHubUser {
  id: number | string;
  login: string;
  email: string | null;
  avatar_url: string;
}

interface GitHubOrg {
  login: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  html_url?: string;
  ssh_url?: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  owner?: {
    login: string;
    avatar_url: string | null;
  };
  pushed_at?: string | null;
  stargazers_count?: number;
  fork?: boolean;
}

export interface GitHubBranch {
  name: string;
  commit?: {
    sha: string;
    url: string;
  };
  protected?: boolean;
}

export type GitHubRepoSort = 'pushed' | 'name' | 'stars';
export type GitHubRepoFilter = 'all' | 'owned' | 'private' | 'public' | 'no_forks';

export interface GetGitHubReposOptions {
  userId: string;
  username: string;
  page: number;
  perPage: number;
  sort: GitHubRepoSort;
  filter: GitHubRepoFilter;
  q?: string;
}

export interface GitHubReposResult {
  repos: GitHubRepo[];
  hasMore: boolean;
  totalCount: number;
}

const GITHUB_REPO_CACHE_TTL_MS = 60_000;
const GITHUB_BRANCH_CACHE_TTL_MS = 60_000;
const GITHUB_ORG_CACHE_TTL_MS = 5 * 60_000;
const MAX_ORG_SEARCH_SCOPES = 5;
const githubRepoCache = new Map<string, { expiresAt: number; result: GitHubReposResult }>();
const githubBranchCache = new Map<string, { expiresAt: number; branches: GitHubBranch[] }>();
const githubOrgCache = new Map<string, { expiresAt: number; orgLogins: string[] }>();

function getGitHubHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'OpenLinear',
  };
}

async function getGitHubErrorMessage(response: Response, fallback: string): Promise<string> {
  let githubMessage = '';
  try {
    const body = (await response.json()) as { message?: string };
    githubMessage = body.message ? `: ${body.message}` : '';
  } catch {}

  if (response.status === 401) {
    return 'GitHub token expired or was revoked. Reconnect GitHub and try again.';
  }

  if (response.status === 403) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      const resetTime = resetHeader
        ? new Date(Number.parseInt(resetHeader, 10) * 1000).toLocaleTimeString()
        : 'soon';
      return `GitHub rate limit exceeded. Resets at ${resetTime}.`;
    }
    return `GitHub rejected the repository request${githubMessage}`;
  }

  return `${fallback}: ${response.status} ${response.statusText}${githubMessage}`.trim();
}

function getCacheKey(options: GetGitHubReposOptions): string {
  return JSON.stringify({
    userId: options.userId,
    username: options.username,
    page: options.page,
    perPage: options.perPage,
    sort: options.sort,
    filter: options.filter,
    q: options.q?.trim() || '',
  });
}

function getAccessTokenCacheKey(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex');
}

function getBranchCacheKey(accessToken: string, owner: string, repo: string): string {
  return `${getAccessTokenCacheKey(accessToken)}:${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

function sortRepos(repos: GitHubRepo[], sort: GitHubRepoSort): GitHubRepo[] {
  if (sort === 'name') {
    return [...repos].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }
  if (sort === 'stars') {
    return [...repos].sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
  }
  return repos;
}

function applyRepoFilter(repos: GitHubRepo[], filter: GitHubRepoFilter): GitHubRepo[] {
  if (filter === 'no_forks') {
    return repos.filter((repo) => !repo.fork);
  }
  return repos;
}

function repoMatchesFilter(repo: GitHubRepo, options: GetGitHubReposOptions): boolean {
  if (options.filter === 'owned') {
    return (repo.owner?.login || repo.full_name.split('/')[0]) === options.username;
  }
  if (options.filter === 'private') return repo.private;
  if (options.filter === 'public') return !repo.private;
  if (options.filter === 'no_forks') return !repo.fork;
  return true;
}

function getExactRepoSlug(query?: string): { owner: string; repo: string } | null {
  const trimmed = query?.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return parseGitHubUrl(trimmed);
}

async function fetchAccessibleRepo(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<GitHubRepo | null> {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const response = await fetch(`https://api.github.com/repos/${encodedOwner}/${encodedRepo}`, {
    headers: getGitHubHeaders(accessToken),
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(await getGitHubErrorMessage(response, `Failed to fetch repository ${owner}/${repo}`));
  }

  return (await response.json()) as GitHubRepo;
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const patterns = [
    /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/,
    /^git@github\.com:([^\/]+)\/([^\/]+?)(\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/,
    /^([^\/]+)\/([^\/]+)$/,
  ];
  
  for (const pattern of patterns) {
    const match = url.trim().match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    }
  }
  return null;
}

export async function fetchPublicRepo(owner: string, repo: string): Promise<GitHubRepo> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'OpenLinear',
  };

  // Use GitHub token if available for higher rate limits (5000/hr vs 60/hr)
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers,
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Repository ${owner}/${repo} not found or is private`);
    }
    if (response.status === 403) {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      const resetTime = resetHeader ? new Date(parseInt(resetHeader) * 1000).toLocaleTimeString() : 'soon';
      throw new Error(`GitHub rate limit exceeded. Resets at ${resetTime}. Add GITHUB_TOKEN to .env for higher limits.`);
    }
    throw new Error(`Failed to fetch repository: ${response.statusText}`);
  }

  return (await response.json()) as GitHubRepo;
}

export async function getGitHubBranches(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<GitHubBranch[]> {
  const cacheKey = getBranchCacheKey(accessToken, owner, repo);
  const now = Date.now();
  const cached = githubBranchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.branches;

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const response = await fetch(
    `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/branches?per_page=100`,
    { headers: getGitHubHeaders(accessToken) },
  );

  if (!response.ok) {
    throw new Error(await getGitHubErrorMessage(response, `Failed to fetch branches for ${owner}/${repo}`));
  }

  const branches = (await response.json()) as GitHubBranch[];
  const filteredBranches = branches.filter((branch) => typeof branch.name === 'string' && branch.name.trim().length > 0);
  githubBranchCache.set(cacheKey, {
    expiresAt: now + GITHUB_BRANCH_CACHE_TTL_MS,
    branches: filteredBranches,
  });
  return filteredBranches;
}

export async function addRepositoryByUrl(url: string): Promise<{
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  isActive: boolean;
}> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    throw new Error('Invalid GitHub URL format');
  }

  const repo = await fetchPublicRepo(parsed.owner, parsed.repo);
  
  if (repo.private) {
    throw new Error('Private repositories require authentication');
  }

  const existing = await prisma.repository.findFirst({
    where: { githubRepoId: repo.id, userId: null },
  });

  if (existing) {
    return prisma.repository.update({
      where: { id: existing.id },
      data: { isActive: true },
    });
  }

  await prisma.repository.updateMany({
    where: { userId: null },
    data: { isActive: false },
  });

  return prisma.repository.create({
    data: {
      githubRepoId: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      isActive: true,
    },
  });
}

function getSyntheticRepoId(url: string): number {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  return -Math.max(1, Math.abs(hash));
}

export async function addRepositoryFromCloneUrl(
  userId: string,
  url: string,
  defaultBranch = 'main',
): Promise<{
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  isActive: boolean;
}> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    throw new Error('Invalid GitHub clone URL format');
  }

  const fullName = `${parsed.owner}/${parsed.repo}`;
  const githubRepoId = getSyntheticRepoId(`${userId}:${url.trim()}`);

  return prisma.repository.upsert({
    where: {
      userId_githubRepoId: { userId, githubRepoId },
    },
    update: {
      name: parsed.repo,
      fullName,
      cloneUrl: url.trim(),
      defaultBranch,
      isActive: true,
    },
    create: {
      githubRepoId,
      name: parsed.repo,
      fullName,
      cloneUrl: url.trim(),
      defaultBranch,
      userId,
      isActive: true,
    },
  });
}

export function getConfiguredGitHubRedirectUri(): string {
  return getGitHubConfig().redirectUri;
}

export function getAuthorizationUrl(state: string, redirectUriOverride?: string): string {
  const { clientId, redirectUri } = getGitHubConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUriOverride ?? redirectUri,
    scope: 'read:user user:email repo',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForToken(code: string, redirectUri?: string): Promise<string> {
  const { clientId, clientSecret } = getGitHubConfig();
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    }),
  });

  const data = (await response.json()) as TokenResponse;
  
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  return data.access_token!;
}

export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch GitHub user');
  }

  return (await response.json()) as GitHubUser;
}

function buildRepoSearchQuery(
  options: GetGitHubReposOptions,
  scope: { type: 'user' | 'org'; login: string },
): string {
  const searchTerm = options.q?.trim() || '';
  const queryParts = [
    searchTerm,
    // in:name,description only valid when paired with actual search keywords
    searchTerm ? 'in:name,description' : '',
    scope.login ? `${scope.type}:${scope.login}` : '',
  ];

  if (options.filter === 'private') queryParts.push('is:private');
  if (options.filter === 'public') queryParts.push('is:public');
  if (options.filter === 'no_forks') queryParts.push('fork:false');
  return queryParts.filter(Boolean).join(' ');
}

async function getGitHubOrgLogins(accessToken: string): Promise<string[]> {
  const now = Date.now();
  const cacheKey = getAccessTokenCacheKey(accessToken);
  const cached = githubOrgCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.orgLogins;

  const response = await fetch('https://api.github.com/user/orgs?per_page=100', {
    headers: getGitHubHeaders(accessToken),
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as GitHubOrg[];
  const orgLogins = data.map((org) => org.login).filter(Boolean);
  githubOrgCache.set(cacheKey, {
    expiresAt: now + GITHUB_ORG_CACHE_TTL_MS,
    orgLogins,
  });
  return orgLogins;
}

async function searchGitHubRepoScope(
  accessToken: string,
  options: GetGitHubReposOptions,
  scope: { type: 'user' | 'org'; login: string },
  requestedEnd: number,
): Promise<{ repos: GitHubRepo[]; totalCount: number }> {
  const MAX_SEARCH_PAGES = 3;
  const pagesNeeded = Math.min(MAX_SEARCH_PAGES, Math.max(1, Math.ceil(requestedEnd / 100)));

  const pagePromises = Array.from({ length: pagesNeeded }, (_, i) => {
    const page = i + 1;
    const params = new URLSearchParams({
      q: buildRepoSearchQuery(options, scope),
      page: String(page),
      per_page: '100',
    });

    if (options.sort === 'stars') {
      params.set('sort', 'stars');
      params.set('order', 'desc');
    } else if (options.sort === 'pushed') {
      params.set('sort', 'updated');
      params.set('order', 'desc');
    }

    return fetch(`https://api.github.com/search/repositories?${params.toString()}`, {
      headers: getGitHubHeaders(accessToken),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(await getGitHubErrorMessage(response, 'Failed to search repositories'));
      }
      return (await response.json()) as { items: GitHubRepo[]; total_count: number };
    });
  });

  const pageResults = await Promise.all(pagePromises);
  const repos: GitHubRepo[] = [];
  let totalCount = 0;
  for (const data of pageResults) {
    totalCount = data.total_count;
    repos.push(...data.items);
    if (data.items.length < 100) break;
  }

  return {
    repos: applyRepoFilter(repos, options.filter),
    totalCount,
  };
}

async function searchGitHubRepos(
  accessToken: string,
  options: GetGitHubReposOptions,
): Promise<GitHubReposResult> {
  const exactSlug = getExactRepoSlug(options.q);
  const exactRepo = exactSlug
    ? await fetchAccessibleRepo(accessToken, exactSlug.owner, exactSlug.repo)
    : null;
  const orgLogins = options.filter === 'owned'
    ? []
    : (await getGitHubOrgLogins(accessToken)).slice(0, MAX_ORG_SEARCH_SCOPES);
  const scopes: Array<{ type: 'user' | 'org'; login: string }> = [
    ...(options.username ? [{ type: 'user' as const, login: options.username }] : []),
    ...orgLogins.map((login) => ({ type: 'org' as const, login })),
  ];
  const requestedEnd = options.page * options.perPage;
  const scopeResults = await Promise.allSettled(
    scopes.map((scope) => searchGitHubRepoScope(accessToken, options, scope, requestedEnd)),
  ).then((results) =>
    results
      .filter((r): r is PromiseFulfilledResult<{ repos: GitHubRepo[]; totalCount: number }> => r.status === 'fulfilled')
      .map((r) => r.value),
  );
  const repoMap = new Map<number, GitHubRepo>();

  if (exactRepo && repoMatchesFilter(exactRepo, options)) {
    repoMap.set(exactRepo.id, exactRepo);
  }

  for (const result of scopeResults) {
    for (const repo of result.repos) {
      if (!repoMap.has(repo.id)) {
        repoMap.set(repo.id, repo);
      }
    }
  }

  const repos = sortRepos([...repoMap.values()], options.sort);
  const start = (options.page - 1) * options.perPage;
  const end = start + options.perPage;
  const totalCount = Math.max(
    repoMap.size,
    scopeResults.reduce((total, result) => total + result.totalCount, 0),
  );

  return {
    repos: repos.slice(start, end),
    hasMore: end < repos.length || requestedEnd < totalCount,
    totalCount,
  };
}

async function listGitHubRepos(
  accessToken: string,
  options: GetGitHubReposOptions,
): Promise<GitHubReposResult> {
  const params = new URLSearchParams({
    page: String(options.page),
    per_page: String(options.perPage),
    sort: options.sort === 'name' ? 'full_name' : 'pushed',
    direction: options.sort === 'name' ? 'asc' : 'desc',
    affiliation: options.filter === 'owned' ? 'owner' : 'owner,collaborator,organization_member',
  });

  if (options.filter === 'private') params.set('visibility', 'private');
  if (options.filter === 'public') params.set('visibility', 'public');

  const response = await fetch(`https://api.github.com/user/repos?${params.toString()}`, {
    headers: getGitHubHeaders(accessToken),
  });

  if (!response.ok) {
    throw new Error(await getGitHubErrorMessage(response, 'Failed to fetch repositories'));
  }

  const data = (await response.json()) as GitHubRepo[];
  const repos = sortRepos(applyRepoFilter(data, options.filter), options.sort);

  return {
    repos,
    hasMore: data.length === options.perPage,
    totalCount: (options.page - 1) * options.perPage + repos.length + (data.length === options.perPage ? 1 : 0),
  };
}

export async function searchPublicGitHubRepos(
  accessToken: string,
  options: GetGitHubReposOptions,
): Promise<GitHubReposResult> {
  const searchTerm = options.q?.trim();
  if (!searchTerm) {
    return { repos: [], hasMore: false, totalCount: 0 };
  }

  const query = `${searchTerm} in:name`;
  const params = new URLSearchParams({
    q: query,
    page: String(options.page),
    per_page: String(options.perPage),
  });

  if (options.sort === 'stars') {
    params.set('sort', 'stars');
    params.set('order', 'desc');
  } else if (options.sort === 'pushed') {
    params.set('sort', 'updated');
    params.set('order', 'desc');
  } else {
    params.set('sort', 'stars');
    params.set('order', 'desc');
  }

  const response = await fetch(`https://api.github.com/search/repositories?${params.toString()}`, {
    headers: getGitHubHeaders(accessToken),
  });

  if (!response.ok) {
    throw new Error(await getGitHubErrorMessage(response, 'Failed to search public repositories'));
  }

  const data = (await response.json()) as { items: GitHubRepo[]; total_count: number };
  const repos = sortRepos(applyRepoFilter(data.items, options.filter), options.sort);

  return {
    repos,
    hasMore: data.total_count > options.page * options.perPage,
    totalCount: data.total_count,
  };
}

export async function getGitHubRepos(
  accessToken: string,
  options: GetGitHubReposOptions,
): Promise<GitHubReposResult> {
  const cacheKey = getCacheKey(options);
  const cached = githubRepoCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const result = options.q?.trim()
    ? await searchGitHubRepos(accessToken, options)
    : await listGitHubRepos(accessToken, options);

  githubRepoCache.set(cacheKey, {
    expiresAt: now + GITHUB_REPO_CACHE_TTL_MS,
    result,
  });

  return result;
}

export async function createOrUpdateUser(
  githubUser: GitHubUser,
  accessToken: string
) {
  const githubId = String(githubUser.id);
  const encryptedToken = encryptToken(accessToken);

  const existingByGithubId = await prisma.user.findUnique({
    where: { githubId },
  });

  if (existingByGithubId) {
    return prisma.user.update({
      where: { id: existingByGithubId.id },
      data: {
        username: githubUser.login,
        email: githubUser.email,
        avatarUrl: githubUser.avatar_url,
        accessToken: encryptedToken,
      },
    });
  }

  return prisma.user.upsert({
    where: { username: githubUser.login },
    update: {
      githubId,
      username: githubUser.login,
      email: githubUser.email,
      avatarUrl: githubUser.avatar_url,
      accessToken: encryptedToken,
    },
    create: {
      githubId,
      username: githubUser.login,
      email: githubUser.email,
      avatarUrl: githubUser.avatar_url,
      accessToken: encryptedToken,
    },
  });
}

export async function getUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: { repositories: true },
  });
}

export async function getUserRepositories(userId: string) {
  return prisma.repository.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function addRepository(
  userId: string,
  repo: GitHubRepo,
  isActive = false
) {
  return prisma.repository.upsert({
    where: {
      userId_githubRepoId: { userId, githubRepoId: repo.id },
    },
    update: {
      name: repo.name,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      isActive,
    },
    create: {
      githubRepoId: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      userId,
      isActive,
    },
  });
}

export async function setActiveRepository(userId: string, projectId: string) {
  await prisma.repository.updateMany({
    where: { userId },
    data: { isActive: false },
  });

  return prisma.repository.update({
    where: { id: projectId },
    data: { isActive: true },
  });
}

export async function getActiveRepository(userId: string) {
  return prisma.repository.findFirst({
    where: { userId, isActive: true },
  });
}
