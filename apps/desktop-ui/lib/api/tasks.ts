import { apiFetch } from './fetch';
import type { InboxCount, InboxTask, MyIssueTask } from './types';

interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

function unwrap<T>(data: Paginated<T> | T[]): T[] {
  return Array.isArray(data) ? data : data.items;
}

export async function fetchMyIssues(
  filter: 'assigned' | 'created' | 'all' = 'assigned',
): Promise<MyIssueTask[]> {
  const qs =
    filter === 'assigned'
      ? '?assignee=me'
      : filter === 'created'
      ? '?creator=me'
      : '';
  const data = await apiFetch<Paginated<MyIssueTask> | MyIssueTask[]>(`/api/tasks${qs}`);
  return unwrap(data);
}

export async function fetchProjectIssues(projectId: string): Promise<MyIssueTask[]> {
  const data = await apiFetch<Paginated<MyIssueTask> | MyIssueTask[]>(`/api/tasks?projectId=${projectId}`);
  return unwrap(data);
}

export async function createTask(data: {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';
  status?: 'todo' | 'in_progress' | 'done' | 'cancelled';
  teamId?: string;
  projectId?: string;
}): Promise<MyIssueTask> {
  return apiFetch<MyIssueTask>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function executeTaskPublic(taskId: string): Promise<void> {
  await apiFetch<void>(`/api/tasks/${taskId}/execute`, {
    method: 'POST',
    sidecar: true,
  });
}

export async function fetchInboxTasks(): Promise<InboxTask[]> {
  const data = await apiFetch<Paginated<InboxTask> | InboxTask[]>('/api/inbox');
  return unwrap(data);
}

export async function fetchInboxCount(): Promise<InboxCount> {
  try {
    return await apiFetch<InboxCount>('/api/inbox/count');
  } catch {
    return { total: 0, unread: 0 };
  }
}

export async function markInboxRead(taskId: string): Promise<void> {
  await apiFetch<void>(`/api/inbox/read/${taskId}`, { method: 'PATCH' });
}

export async function markAllInboxRead(): Promise<void> {
  await apiFetch<void>('/api/inbox/read-all', { method: 'PATCH' });
}

export async function refreshTaskPr(
  taskId: string,
): Promise<{ prUrl: string | null; refreshed: boolean; message?: string }> {
  return apiFetch<{ prUrl: string | null; refreshed: boolean; message?: string }>(
    `/api/tasks/${taskId}/refresh-pr`,
    { method: 'POST', sidecar: true },
  );
}
