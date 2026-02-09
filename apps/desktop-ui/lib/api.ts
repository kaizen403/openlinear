const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface User {
  id: string;
  githubId: number;
  username: string;
  email: string | null;
  avatarUrl: string | null;
  repositories: Repository[];
}

export interface Repository {
  id: string;
  githubRepoId: number;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  isActive: boolean;
  userId: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  description: string | null;
}

function getAuthHeader(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchCurrentUser(): Promise<User | null> {
  const token = localStorage.getItem('token');
  if (!token) return null;

  const res = await fetch(`${API_URL}/api/auth/me`, {
    headers: getAuthHeader(),
  });

  if (!res.ok) {
    localStorage.removeItem('token');
    return null;
  }

  return res.json();
}

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

export function getLoginUrl(): string {
  return `${API_URL}/api/auth/github`;
}

export function logout(): void {
  localStorage.removeItem('token');
  window.location.href = '/';
}

// Public repo functions (no auth required)

export interface PublicRepository {
  id: string;
  githubRepoId: number;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  isActive: boolean;
  userId: string | null;
}

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

export async function executeTaskPublic(taskId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/tasks/${taskId}/execute`, {
    method: 'POST',
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to execute task' }));
    throw new Error(error.error || 'Failed to execute task');
  }
}
