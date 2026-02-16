import { API_URL, getAuthHeader } from './client';
import type { Project } from './types';

export async function fetchProjects(teamId?: string): Promise<Project[]> {
  const params = new URLSearchParams()
  if (teamId) params.set('teamId', teamId)
  const qs = params.toString()
  const res = await fetch(`${API_URL}/api/projects${qs ? `?${qs}` : ''}`, { headers: getAuthHeader() })
  if (!res.ok) throw new Error('Failed to fetch projects')
  return res.json()
}

export async function createProject(data: { name: string; description?: string; status?: string; color?: string; icon?: string; teamIds?: string[]; startDate?: string; targetDate?: string; leadId?: string; repoUrl?: string; localPath?: string }): Promise<Project> {
  const res = await fetch(`${API_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to create project')
  return res.json()
}

export async function updateProject(id: string, data: Partial<{ name: string; description: string | null; status: string; color: string; icon: string | null; teamIds: string[]; startDate: string | null; targetDate: string | null; leadId: string | null; repoUrl: string | null; localPath: string | null }>): Promise<Project> {
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
