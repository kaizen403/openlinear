import { apiFetch } from './fetch';
import type { Workspace, WorkspaceMember } from './types';

export async function fetchWorkspaces(): Promise<Workspace[]> {
  return apiFetch<Workspace[]>('/api/workspaces');
}

export async function fetchWorkspace(id: string): Promise<Workspace> {
  return apiFetch<Workspace>(`/api/workspaces/${id}`);
}

export async function fetchWorkspaceMembers(id: string): Promise<WorkspaceMember[]> {
  return apiFetch<WorkspaceMember[]>(`/api/workspaces/${id}/members`);
}

export async function createWorkspace(data: { name: string }): Promise<Workspace> {
  return apiFetch<Workspace>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateWorkspace(id: string, data: { name?: string }): Promise<Workspace> {
  return apiFetch<Workspace>(`/api/workspaces/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}
