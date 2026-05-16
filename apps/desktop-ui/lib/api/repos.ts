import { apiFetch, AuthExpiredError } from './fetch';
import type {
  GitHubRepo,
  GitHubRepoFilter,
  GitHubReposResponse,
  GitHubRepoSort,
  PublicRepository,
  Repository,
} from './types';

export async function fetchUserRepositories(): Promise<Repository[]> {
  return apiFetch<Repository[]>('/api/repos');
}

export async function fetchGitHubRepos(options: {
  page?: number;
  perPage?: number;
  sort?: GitHubRepoSort;
  filter?: GitHubRepoFilter;
  q?: string;
} = {}): Promise<GitHubReposResponse> {
  const params = new URLSearchParams();
  params.set('page', String(options.page ?? 1));
  params.set('per_page', String(options.perPage ?? 30));
  if (options.sort) params.set('sort', options.sort);
  if (options.filter) params.set('filter', options.filter);
  if (options.q?.trim()) params.set('q', options.q.trim());
  return apiFetch<GitHubReposResponse>(`/api/repos/github?${params.toString()}`);
}

export async function importRepo(repo: GitHubRepo): Promise<Repository> {
  return apiFetch<Repository>('/api/repos/import', {
    method: 'POST',
    body: JSON.stringify({ repo }),
  });
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
