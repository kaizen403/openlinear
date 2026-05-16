import { apiFetch } from './fetch';
import type { Project } from './types';

export async function fetchProjects(teamId?: string): Promise<Project[]> {
  const params = new URLSearchParams();
  if (teamId) params.set('teamId', teamId);
  const qs = params.toString();
  return apiFetch<Project[]>(`/api/projects${qs ? `?${qs}` : ''}`);
}

export async function createProject(data: {
  name: string;
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
