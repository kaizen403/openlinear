import type { QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/fetch"
import type { Task } from "@/types/task"
import { STALE_TIME } from "./client"
import { queryKeys } from "./keys"

/**
 * Archived tasks (the Archived page). Archiving a task anywhere emits
 * `task:deleted` / `tasks:bulk-deleted` (the card leaves the boards), which
 * marks this list stale (page-caches.ts), so the page refetches when it opens
 * after an archive and shows the cached list otherwise.
 */

export async function fetchArchivedTasks(): Promise<Task[]> {
  const data = await apiFetch<{ items: Task[] } | Task[]>("/api/tasks/archived")
  return Array.isArray(data) ? data : data.items
}

export async function deleteArchivedTask(taskId: string): Promise<void> {
  await apiFetch(`/api/tasks/archived/${taskId}`, { method: "DELETE" })
}

export async function deleteAllArchivedTasks(): Promise<void> {
  await apiFetch("/api/tasks/archived", { method: "DELETE" })
}

export function archivedTasksQuery() {
  return {
    queryKey: queryKeys.archivedTasks(),
    queryFn: (): Promise<Task[]> => fetchArchivedTasks(),
    staleTime: STALE_TIME.archivedTasks,
  }
}

/** Remove tasks from the cached archive; returns the list before, for a rollback. */
export function removeArchivedTasks(client: QueryClient, ids: ReadonlySet<string> | "all"): Task[] | undefined {
  const key = queryKeys.archivedTasks()
  const before = client.getQueryData<Task[]>(key)
  if (!before) return before
  const next = ids === "all" ? [] : before.filter((task) => !ids.has(task.id))
  if (next.length !== before.length) client.setQueryData(key, next)
  return before
}

/**
 * Put back the tasks of a failed delete at their old positions, keeping
 * anything else that changed in the meantime (board-style per-item rollback).
 */
export function restoreArchivedTasks(client: QueryClient, before: readonly Task[], ids: ReadonlySet<string> | "all"): void {
  const key = queryKeys.archivedTasks()
  const current = client.getQueryData<Task[]>(key) ?? []
  const present = new Set(current.map((task) => task.id))
  const wanted = before.filter((task) => (ids === "all" || ids.has(task.id)) && !present.has(task.id))
  if (wanted.length === 0) return
  const restore = new Set(wanted.map((task) => task.id))
  // Rebuild in the old order: restored tasks at their positions, survivors after their predecessors.
  const next: Task[] = []
  const currentById = new Map(current.map((task) => [task.id, task]))
  for (const task of before) {
    if (restore.has(task.id)) next.push(task)
    else if (currentById.has(task.id)) {
      next.push(currentById.get(task.id)!)
      currentById.delete(task.id)
    }
  }
  for (const task of current) if (currentById.has(task.id)) next.push(task)
  client.setQueryData(key, next)
}
