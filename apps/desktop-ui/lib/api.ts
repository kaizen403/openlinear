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

export interface Team {
  id: string
  name: string
  key: string
  description: string | null
  color: string
  icon: string | null
  private: boolean
  nextIssueNumber: number
  createdAt: string
  updatedAt: string
  _count?: { members: number }
  members?: TeamMember[]
  projectTeams?: { project: { id: string; name: string; status: string; color: string; icon: string | null } }[]
}

export interface TeamMember {
  id: string
  teamId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
  sortOrder: number
  createdAt: string
  user?: {
    id: string
    username: string
    email: string | null
    avatarUrl: string | null
  }
}

export interface Project {
  id: string
  name: string
  description: string | null
  status: 'planned' | 'in_progress' | 'paused' | 'completed' | 'cancelled'
  color: string
  icon: string | null
  startDate: string | null
  targetDate: string | null
  leadId: string | null
  createdAt: string
  updatedAt: string
  teams?: Team[]
  _count?: { tasks: number }
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

export async function fetchTeams(): Promise<Team[]> {
  const res = await fetch(`${API_URL}/api/teams`)
  if (!res.ok) throw new Error('Failed to fetch teams')
  return res.json()
}

export async function fetchTeam(id: string): Promise<Team> {
  const res = await fetch(`${API_URL}/api/teams/${id}`)
  if (!res.ok) throw new Error('Failed to fetch team')
  return res.json()
}

export async function createTeam(data: { name: string; key: string; description?: string; color?: string; icon?: string; private?: boolean }): Promise<Team> {
  const res = await fetch(`${API_URL}/api/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to create team')
  return res.json()
}

export async function updateTeam(id: string, data: Partial<{ name: string; description: string | null; color: string; icon: string | null; private: boolean }>): Promise<Team> {
  const res = await fetch(`${API_URL}/api/teams/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update team')
  return res.json()
}

export async function deleteTeam(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/teams/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(),
  })
  if (!res.ok) throw new Error('Failed to delete team')
}

export async function addTeamMember(teamId: string, data: { email?: string; userId?: string; role?: string }): Promise<TeamMember> {
  const res = await fetch(`${API_URL}/api/teams/${teamId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to add team member')
  return res.json()
}

export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/teams/${teamId}/members/${userId}`, {
    method: 'DELETE',
    headers: getAuthHeader(),
  })
  if (!res.ok) throw new Error('Failed to remove team member')
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API_URL}/api/projects`)
  if (!res.ok) throw new Error('Failed to fetch projects')
  return res.json()
}

export async function createProject(data: { name: string; description?: string; status?: string; color?: string; icon?: string; teamIds?: string[]; startDate?: string; targetDate?: string; leadId?: string }): Promise<Project> {
  const res = await fetch(`${API_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to create project')
  return res.json()
}

export async function updateProject(id: string, data: Partial<{ name: string; description: string | null; status: string; color: string; icon: string | null; teamIds: string[]; startDate: string | null; targetDate: string | null; leadId: string | null }>): Promise<Project> {
  const res = await fetch(`${API_URL}/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update project')
  return res.json()
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/projects/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(),
  })
  if (!res.ok) throw new Error('Failed to delete project')
}

export async function fetchInboxTasks(): Promise<InboxTask[]> {
  const res = await fetch(`${API_URL}/api/inbox`)
  if (!res.ok) throw new Error('Failed to fetch inbox')
  return res.json()
}

export async function fetchInboxCount(): Promise<number> {
  const res = await fetch(`${API_URL}/api/inbox/count`)
  if (!res.ok) return 0
  const data = await res.json()
  return data.count
}

export async function markInboxRead(taskId: string): Promise<void> {
  await fetch(`${API_URL}/api/inbox/read/${taskId}`, { method: 'PATCH' })
}

export async function markAllInboxRead(): Promise<void> {
  await fetch(`${API_URL}/api/inbox/read-all`, { method: 'PATCH' })
}

export async function refreshTaskPr(taskId: string): Promise<{ prUrl: string | null; refreshed: boolean; message?: string }> {
  const res = await fetch(`${API_URL}/api/tasks/${taskId}/refresh-pr`, {
    method: 'POST',
    headers: getAuthHeader(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to refresh PR' }))
    throw new Error(err.error || 'Failed to refresh PR')
  }
  return res.json()
}

export interface InboxTask {
  id: string
  title: string
  description: string | null
  priority: 'low' | 'medium' | 'high'
  status: 'done'
  createdAt: string
  updatedAt: string
  prUrl: string | null
  outcome: string | null
  batchId: string | null
  inboxRead: boolean
  executionElapsedMs: number
  labels: Array<{ id: string; name: string; color: string; priority: number }>
  team?: { id: string; name: string; key: string; color: string } | null
  project?: { id: string; name: string; status: string; color: string } | null
  identifier?: string | null
}
