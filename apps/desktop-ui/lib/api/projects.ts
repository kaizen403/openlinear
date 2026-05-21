import { apiFetch } from './fetch';
import type { Project, ProjectAccess, ProjectPermission } from './types';

export async function fetchProjects(filters?: { teamId?: string; workspaceId?: string; fields?: string[] }): Promise<Project[]> {
  const params = new URLSearchParams();
  if (filters?.teamId) params.set('teamId', filters.teamId);
  if (filters?.workspaceId) params.set('workspaceId', filters.workspaceId);
  if (filters?.fields?.length) params.set('fields', filters.fields.join(','));
  const qs = params.toString();
  return apiFetch<Project[]>(`/api/projects${qs ? `?${qs}` : ''}`);
}

export async function createProject(data: {
  name: string;
  workspaceId?: string;
  description?: string;
  status?: string;
  color?: string;
  icon?: string;
  teamIds?: string[];
  startDate?: string;
  targetDate?: string;
  leadId?: string;
  repoUrl?: string;
  repositoryId?: string;
  defaultBranch?: string;
  localPath?: string;
}): Promise<Project> {
  return apiFetch<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateProject(
  id: string,
  data: Partial<{
    name: string;
    description: string | null;
    status: string;
    color: string;
    icon: string | null;
    teamIds: string[];
    startDate: string | null;
    targetDate: string | null;
    leadId: string | null;
    repoUrl: string | null;
    localPath: string | null;
  }>,
): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteProject(id: string): Promise<void> {
  await apiFetch<void>(`/api/projects/${id}`, { method: 'DELETE' });
}

export async function fetchProjectAccess(projectId: string): Promise<ProjectAccess[]> {
  return apiFetch<ProjectAccess[]>(`/api/projects/${projectId}/access`);
}

export async function grantProjectAccess(
  projectId: string,
  userId: string,
  permission: ProjectPermission,
): Promise<ProjectAccess> {
  return apiFetch<ProjectAccess>(`/api/projects/${projectId}/access`, {
    method: 'POST',
    body: JSON.stringify({ userId, permission }),
  });
}

export async function revokeProjectAccess(projectId: string, userId: string): Promise<void> {
  await apiFetch<void>(`/api/projects/${projectId}/access/${userId}`, { method: 'DELETE' });
}
