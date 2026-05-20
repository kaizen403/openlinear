import { apiFetch } from './fetch';
import type { Team, TeamMember } from './types';

export async function fetchTeams(): Promise<Team[]> {
  return apiFetch<Team[]>('/api/teams');
}

export async function fetchTeam(id: string): Promise<Team> {
  return apiFetch<Team>(`/api/teams/${id}`);
}

export async function createTeam(data: {
  name: string;
  key: string;
  description?: string;
  color?: string;
  icon?: string;
  private?: boolean;
}): Promise<Team> {
  return apiFetch<Team>('/api/teams', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateTeam(
  id: string,
  data: Partial<{
    name: string;
    key: string;
    description: string | null;
    color: string;
    icon: string | null;
    private: boolean;
  }>,
): Promise<Team> {
  return apiFetch<Team>(`/api/teams/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteTeam(id: string): Promise<void> {
  await apiFetch<void>(`/api/teams/${id}`, { method: 'DELETE' });
}

export async function addTeamMember(
  teamId: string,
  data: { email?: string; userId?: string; role?: string },
): Promise<TeamMember> {
  return apiFetch<TeamMember>(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  await apiFetch<void>(`/api/teams/${teamId}/members/${userId}`, { method: 'DELETE' });
}

export async function updateTeamMember(
  teamId: string,
  userId: string,
  data: { role: 'owner' | 'admin' | 'member' },
): Promise<TeamMember> {
  return apiFetch<TeamMember>(`/api/teams/${teamId}/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function joinTeam(inviteCode: string): Promise<Team> {
  return apiFetch<Team>('/api/teams/join', {
    method: 'POST',
    body: JSON.stringify({ inviteCode }),
  });
}
