import { apiFetch } from './fetch';
import type { Project, Team, TeamMember, Workspace, WorkspaceMember, WorkspaceRole } from './types';

export interface WorkspaceStructureTeam extends Omit<Team, 'members' | '_count'> {
  members: TeamMember[];
  _count?: { members: number; tasks: number };
}

export interface WorkspaceStructureProject extends Project {
  teams: WorkspaceStructureTeam[];
}

export interface WorkspaceStructure extends Workspace {
  members: WorkspaceMember[];
  projects: WorkspaceStructureProject[];
  currentMember?: WorkspaceMember | null;
}

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

export async function fetchWorkspaceStructure(id: string): Promise<WorkspaceStructure> {
  const res = await apiFetch<
    WorkspaceStructure & {
      currentMember?: WorkspaceMember | null;
    }
  >(`/api/workspaces/${id}/structure`);
  if (res.currentMember) {
    res.role = res.currentMember.role as Workspace['role'];
    res.invitedAt = res.currentMember.invitedAt;
    res.joinedAt = res.currentMember.joinedAt;
  }
  return res;
}

/**
 * `view=summary`: the workspace → projects → teams tree with member counts
 * (`_count.members` on the workspace and on each team) instead of member
 * lists, about 5 % of the full payload at scale. Older APIs ignore the
 * parameter and send the full tree, so readers fall back to
 * `members.length` (see `structureMemberCount`).
 */
export interface WorkspaceStructureSummaryTeam {
  id: string;
  name: string;
  key: string;
  color: string;
  projectId: string;
  _count?: { members: number; tasks?: number };
  members?: TeamMember[];
}

export interface WorkspaceStructureSummaryProject {
  id: string;
  workspaceId: string | null;
  key: string | null;
  name: string;
  status: Project['status'];
  color: string;
  icon: string | null;
  teams: WorkspaceStructureSummaryTeam[];
  _count?: { tasks: number };
}

export interface WorkspaceStructureSummary {
  id: string;
  name: string;
  slug: string;
  role?: WorkspaceRole;
  _count?: { members: number; projects?: number };
  members?: WorkspaceMember[];
  projects: WorkspaceStructureSummaryProject[];
  currentMember?: WorkspaceMember | null;
}

export async function fetchWorkspaceStructureSummary(id: string): Promise<WorkspaceStructureSummary> {
  return apiFetch<WorkspaceStructureSummary>(`/api/workspaces/${id}/structure?view=summary`);
}

/** Member count of a summary workspace or team, from `_count` or (older APIs) the member list. */
export function structureMemberCount(node: { _count?: { members: number }; members?: readonly unknown[] }): number {
  return node._count?.members ?? node.members?.length ?? 0;
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
