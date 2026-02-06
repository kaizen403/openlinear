const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface User {
  id: string;
  githubId: number;
  username: string;
  email: string | null;
  avatarUrl: string | null;
  projects: Project[];
}

export interface Project {
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

export async function fetchUserProjects(): Promise<Project[]> {
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

export async function importRepo(repo: GitHubRepo): Promise<Project> {
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

export async function activateProject(projectId: string): Promise<Project> {
  const res = await fetch(`${API_URL}/api/repos/${projectId}/activate`, {
    method: 'POST',
    headers: getAuthHeader(),
  });

  if (!res.ok) throw new Error('Failed to activate project');
  return res.json();
}

export async function getActiveProject(): Promise<Project | null> {
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
