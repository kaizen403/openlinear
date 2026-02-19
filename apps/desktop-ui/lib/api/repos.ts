import { API_URL, getAuthHeader } from './client';
import type { GitHubRepo, PublicRepository, Repository } from './types';

export async function fetchUserRepositories(): Promise<Repository[]> {
  const res = await fetch(`${API_URL}/api/repos`, {
    headers: getAuthHeader(),
  });

  if (!res.ok) throw new Error('Failed to fetch projects');
  return res.json();
}

export async function fetchGitHubRepos(): Promise<GitHubRepo[]> {
  const res = await fetch(`${API_URL}/api/repos/github`, {
    headers: getAuthHeader(),
  });

  if (!res.ok) throw new Error('Failed to fetch GitHub repos');
  return res.json();
}

export async function importRepo(repo: GitHubRepo): Promise<Repository> {
  const res = await fetch(`${API_URL}/api/repos/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
    },
    body: JSON.stringify({ repo }),
  });

  if (!res.ok) throw new Error('Failed to import repository');
  return res.json();
}

export async function activateRepository(projectId: string): Promise<Repository> {
  const res = await fetch(`${API_URL}/api/repos/${projectId}/activate`, {
    method: 'POST',
    headers: getAuthHeader(),
  });

  if (!res.ok) throw new Error('Failed to activate project');
  return res.json();
}

export async function getActiveRepository(): Promise<Repository | null> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  if (!token) return null;
  
  const res = await fetch(`${API_URL}/api/repos/active`, {
    headers: getAuthHeader(),
  });

  if (!res.ok) return null;
  return res.json();
}

export async function setActiveRepositoryBaseBranch(baseBranch: string): Promise<Repository> {
  const res = await fetch(`${API_URL}/api/repos/active/base-branch`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
    },
    body: JSON.stringify({ baseBranch }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update base branch');
  }

  return res.json();
}

// Public repo functions (no auth required)

export async function addRepoByUrl(url: string): Promise<PublicRepository> {
  const res = await fetch(`${API_URL}/api/repos/url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to add repository' }));
    throw new Error(error.error || 'Failed to add repository');
  }
  return res.json();
}

export async function getActivePublicRepository(): Promise<PublicRepository | null> {
  const res = await fetch(`${API_URL}/api/repos/active/public`);
  if (!res.ok) return null;
  return res.json();
}

export async function activatePublicRepository(projectId: string): Promise<PublicRepository> {
  const res = await fetch(`${API_URL}/api/repos/${projectId}/activate/public`, {
    method: 'POST',
  });

  if (!res.ok) throw new Error('Failed to activate project');
  return res.json();
}
