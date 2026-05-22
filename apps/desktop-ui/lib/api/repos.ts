import { apiFetch, AuthExpiredError } from './fetch';
import { getAuthToken } from './client';
import type {
  GitHubBranchesResponse,
  GitHubRepo,
  GitHubRepoFilter,
  GitHubReposResponse,
  GitHubRepoSort,
  PublicRepository,
  Repository,
} from './types';

const GITHUB_BRANCH_CACHE_TTL_MS = 60_000;
const githubBranchCache = new Map<string, { expiresAt: number; result: GitHubBranchesResponse }>();

function getBranchCacheKey(owner: string, repo: string): string {
  return `${getAuthToken() ?? 'anonymous'}:${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

export async function fetchUserRepositories(): Promise<Repository[]> {
  return apiFetch<Repository[]>('/api/repos');
}

export async function fetchGitHubRepos(options: {
  page?: number;
  perPage?: number;
  sort?: GitHubRepoSort;
  filter?: GitHubRepoFilter;
  q?: string;
  signal?: AbortSignal;
} = {}): Promise<GitHubReposResponse> {
  const params = new URLSearchParams();
  params.set('page', String(options.page ?? 1));
  params.set('per_page', String(options.perPage ?? 30));
  if (options.sort) params.set('sort', options.sort);
  if (options.filter) params.set('filter', options.filter);
  if (options.q?.trim()) params.set('q', options.q.trim());

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutId = window.setTimeout(() => controller.abort(), 20_000);
  const t0 = performance.now();
  try {
    const result = await apiFetch<GitHubReposResponse>(
      `/api/repos/github?${params.toString()}`,
      { signal: controller.signal },
    );
    console.log(
      `[fetchGitHubRepos] ${params.toString()} -> ${result.repos.length} repos (total=${result.totalCount}, hasMore=${result.hasMore}) in ${Math.round(performance.now() - t0)}ms`,
    );
    return result;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.error(`[fetchGitHubRepos] timeout after 20s: ${params.toString()}`);
      throw new Error('GitHub took too long to respond. Try a narrower search or fewer filters.');
    }
    console.error(`[fetchGitHubRepos] error after ${Math.round(performance.now() - t0)}ms:`, err);
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function importRepo(repo: GitHubRepo): Promise<Repository> {
  return apiFetch<Repository>('/api/repos/import', {
    method: 'POST',
    body: JSON.stringify({ repo }),
  });
}

export async function fetchGitHubBranches(
  owner: string,
  repo: string,
  options: { signal?: AbortSignal } = {},
): Promise<GitHubBranchesResponse> {
  const cacheKey = getBranchCacheKey(owner, repo);
  const cached = githubBranchCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.result;

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutId = window.setTimeout(() => controller.abort(), 10_000);

  try {
    const result = await apiFetch<GitHubBranchesResponse>(
      `/api/repos/github/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      { signal: controller.signal },
    );
    githubBranchCache.set(cacheKey, {
      expiresAt: now + GITHUB_BRANCH_CACHE_TTL_MS,
      result,
    });
    return result;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function activateRepository(projectId: string): Promise<Repository> {
  return apiFetch<Repository>(`/api/repos/${projectId}/activate`, { method: 'POST' });
}

export async function getActiveRepository(): Promise<Repository | null> {
  if (typeof window === 'undefined') return null;
  const token = localStorage.getItem('token');
  if (!token) return null;
  try {
    return await apiFetch<Repository>('/api/repos/active', { allowUnauthenticated: true });
  } catch (err) {
    if (err instanceof AuthExpiredError) return null;
    return null;
  }
}

export async function setActiveRepositoryBaseBranch(baseBranch: string): Promise<Repository> {
  return apiFetch<Repository>('/api/repos/active/base-branch', {
    method: 'PATCH',
    body: JSON.stringify({ baseBranch }),
  });
}

export async function addRepoByUrl(url: string): Promise<PublicRepository> {
  return apiFetch<PublicRepository>('/api/repos/url', {
    method: 'POST',
    body: JSON.stringify({ url }),
    allowUnauthenticated: true,
  });
}

export async function getActivePublicRepository(): Promise<PublicRepository | null> {
  try {
    return await apiFetch<PublicRepository>('/api/repos/active/public', {
      allowUnauthenticated: true,
    });
  } catch {
    return null;
  }
}

export async function activatePublicRepository(projectId: string): Promise<PublicRepository> {
  return apiFetch<PublicRepository>(`/api/repos/${projectId}/activate/public`, {
    method: 'POST',
    allowUnauthenticated: true,
  });
}
