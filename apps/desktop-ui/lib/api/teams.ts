import { API_URL, getAuthHeader } from './client';
import type { Team, TeamMember } from './types';

export async function fetchTeams(): Promise<Team[]> {
  const res = await fetch(`${API_URL}/api/teams`, { headers: getAuthHeader() })
  if (!res.ok) throw new Error('Failed to fetch teams')
  return res.json()
}

export async function fetchTeam(id: string): Promise<Team> {
  const res = await fetch(`${API_URL}/api/teams/${id}`, { headers: getAuthHeader() })
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

export async function joinTeam(inviteCode: string): Promise<Team> {
  const res = await fetch(`${API_URL}/api/teams/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
    body: JSON.stringify({ inviteCode }),
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to join team' }))
    throw new Error(error.error || 'Failed to join team')
  }
  return res.json()
}
