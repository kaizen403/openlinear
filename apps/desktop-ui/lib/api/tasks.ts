import { API_URL, getAuthHeader } from './client';
import type { InboxCount, InboxTask, MyIssueTask } from './types';

export async function fetchMyIssues(): Promise<MyIssueTask[]> {
  const res = await fetch(`${API_URL}/api/tasks`, { headers: getAuthHeader() })
  if (!res.ok) throw new Error('Failed to fetch tasks')
  return res.json()
}

export async function executeTaskPublic(taskId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/tasks/${taskId}/execute`, {
    method: 'POST',
    headers: getAuthHeader(),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to execute task' }));
    throw new Error(error.error || 'Failed to execute task');
  }
}

export async function fetchInboxTasks(): Promise<InboxTask[]> {
  const res = await fetch(`${API_URL}/api/inbox`, { headers: getAuthHeader() })
  if (!res.ok) throw new Error('Failed to fetch inbox')
  return res.json()
}

export async function fetchInboxCount(): Promise<InboxCount> {
  const res = await fetch(`${API_URL}/api/inbox/count`, { headers: getAuthHeader() })
  if (!res.ok) return { total: 0, unread: 0 }
  return res.json()
}

export async function markInboxRead(taskId: string): Promise<void> {
  await fetch(`${API_URL}/api/inbox/read/${taskId}`, { method: 'PATCH', headers: getAuthHeader() })
}

export async function markAllInboxRead(): Promise<void> {
  await fetch(`${API_URL}/api/inbox/read-all`, { method: 'PATCH', headers: getAuthHeader() })
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
