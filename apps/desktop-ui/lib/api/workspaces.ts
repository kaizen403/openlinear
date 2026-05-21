import { apiFetch } from './fetch';
import type { Workspace, WorkspaceMember, WorkspaceRole } from './types';

export async function fetchWorkspaces(): Promise<Workspace[]> {
  return apiFetch<Workspace[]>('/api/workspaces');
}

export async function fetchWorkspace(id: string): Promise<Workspace> {
  const res = await apiFetch<Workspace & { currentMember?: { role: string; invitedAt: string; joinedAt: string | null } }>(`/api/workspaces/${id}`);
  if (res.currentMember && !res.role) {
    res.role = res.currentMember.role as Workspace['role'];
    res.invitedAt = res.currentMember.invitedAt;
    res.joinedAt = res.currentMember.joinedAt;
  }
  return res;
}

export async function fetchWorkspaceMembers(id: string): Promise<WorkspaceMember[]> {
  const res = await apiFetch<{ data: WorkspaceMember[]; nextCursor: string | null }>(`/api/workspaces/${id}/members?limit=200`);
  return res.data;
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

export async function deleteWorkspace(id: string): Promise<void> {
  await apiFetch<void>(`/api/workspaces/${id}`, { method: 'DELETE' });
}

export async function inviteWorkspaceMember(
  id: string,
  data: { username: string; role: WorkspaceRole },
): Promise<WorkspaceMember> {
  return apiFetch<WorkspaceMember>(`/api/workspaces/${id}/members`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateWorkspaceMember(
  workspaceId: string,
  userId: string,
  data: { role: WorkspaceRole },
): Promise<WorkspaceMember> {
  return apiFetch<WorkspaceMember>(`/api/workspaces/${workspaceId}/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function removeWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
  await apiFetch<void>(`/api/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' });
}
