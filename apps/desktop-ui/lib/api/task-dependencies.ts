import type { Task } from '@/types/task';
import { ApiError, apiFetch } from './fetch';

/**
 * W17a "blocked by" relations (apps/api `/api/tasks/:id/dependencies`).
 * A task is blocked by another until that task is done; both live in the
 * same project. The run gate answers 409 TASK_BLOCKED (with the open
 * blockers) unless the run is started anyway.
 */

export interface DependencyTaskRef {
  id: string;
  identifier: string | null;
  title: string;
  status: Task['status'];
  archived: boolean;
  /** Done: no longer blocks. */
  resolved: boolean;
}

export interface TaskDependencies {
  blockedBy: DependencyTaskRef[];
  blocking: DependencyTaskRef[];
}

export interface BlockerCandidate {
  id: string;
  identifier: string | null;
  title: string;
  status: Task['status'];
}

const path = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/dependencies`;

export function fetchTaskDependencies(taskId: string): Promise<TaskDependencies> {
  return apiFetch<TaskDependencies>(path(taskId));
}

/** Mark `taskId` as blocked by `dependsOnTaskId` (idempotent). */
export function addTaskBlocker(taskId: string, dependsOnTaskId: string): Promise<TaskDependencies & { created: boolean }> {
  return apiFetch<TaskDependencies & { created: boolean }>(path(taskId), {
    method: 'POST',
    body: JSON.stringify({ dependsOnTaskId }),
  });
}

export async function removeTaskBlocker(taskId: string, dependsOnTaskId: string): Promise<void> {
  await apiFetch<void>(`${path(taskId)}/${encodeURIComponent(dependsOnTaskId)}`, { method: 'DELETE' });
}

/** FE-10: every unfinished task `taskId` waits on, transitively (what "run with blockers" runs first). */
export function fetchBlockerClosure(taskId: string): Promise<{ tasks: DependencyTaskRef[]; truncated: boolean }> {
  return apiFetch<{ tasks: DependencyTaskRef[]; truncated: boolean }>(`${path(taskId)}/closure`);
}

/**
 * FE-10: why a task can't run together with its blockers, or null when it
 * can. Running blockers (held by another execution) and archived ones can't
 * be started by the batch.
 */
export function runWithBlockersProblem(
  closure: { tasks: readonly DependencyTaskRef[]; truncated: boolean },
  isRunning: (taskId: string) => boolean,
  /** The user's maximum batch size (Settings → AI Execution). */
  maxBatchSize: number,
): string | null {
  if (closure.truncated || closure.tasks.length + 1 > maxBatchSize) {
    const needed = closure.truncated ? `more than ${closure.tasks.length + 1}` : `${closure.tasks.length + 1}`;
    return `It needs ${needed} tasks in one batch and your maximum batch size is ${maxBatchSize}. Raise it in Settings → AI Execution, or run some blockers first.`;
  }
  const archived = closure.tasks.filter((task) => task.archived);
  if (archived.length > 0) return `${archived.map(dependencyLabel).join(', ')} ${archived.length === 1 ? 'is' : 'are'} archived. Restore ${archived.length === 1 ? 'it' : 'them'} or remove the dependency.`;
  const running = closure.tasks.filter((task) => isRunning(task.id));
  if (running.length > 0) return `${running.map(dependencyLabel).join(', ')} ${running.length === 1 ? 'is' : 'are'} running now. Run this task when ${running.length === 1 ? 'it finishes' : 'they finish'}.`;
  return null;
}

/** Tasks in the project that could block `taskId` (title/identifier search). */
export async function searchBlockerCandidates(input: { projectId: string; taskId: string; query: string; exclude: readonly string[] }): Promise<BlockerCandidate[]> {
  const params = new URLSearchParams({ projectId: input.projectId, view: 'compact', pageSize: '20' });
  const query = input.query.trim();
  if (query) params.set('q', query);
  const data = await apiFetch<{ items: BlockerCandidate[] } | BlockerCandidate[]>(`/api/tasks?${params.toString()}`);
  const items = Array.isArray(data) ? data : data.items;
  const excluded = new Set([input.taskId, ...input.exclude]);
  return items
    .filter((task) => !excluded.has(task.id))
    .map(({ id, identifier, title, status }) => ({ id, identifier, title, status }));
}

/** The open blockers a TASK_BLOCKED refusal carries, or null for any other error. */
export function blockedByFromError(error: unknown): Array<{ id: string; identifier: string | null; title: string }> | null {
  if (!(error instanceof ApiError) || error.code !== 'TASK_BLOCKED') return null;
  const details = error.details;
  if (!details || typeof details !== 'object' || !('blockers' in details) || !Array.isArray(details.blockers)) return [];
  return details.blockers.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string') return [];
    return [{
      id: record.id,
      identifier: typeof record.identifier === 'string' ? record.identifier : null,
      title: typeof record.title === 'string' ? record.title : '',
    }];
  });
}

export function dependencyLabel(task: { identifier: string | null; title: string }): string {
  return task.identifier ?? task.title;
}

export interface SimilarTask {
  id: string;
  identifier: string | null;
  title: string;
  status: Task['status'];
  /** pg_trgm similarity, 0–1. */
  score: number;
}

/** FE-11: open issues in the project with a similar title (duplicate hints; never writes). */
export async function fetchSimilarTasks(projectId: string, title: string, limit = 3): Promise<SimilarTask[]> {
  const params = new URLSearchParams({ projectId, title: title.trim(), limit: String(limit) });
  const data = await apiFetch<{ items: SimilarTask[] }>(`/api/tasks/similar?${params.toString()}`);
  return data.items;
}
