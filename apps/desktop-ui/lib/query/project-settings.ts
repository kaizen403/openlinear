import type { QueryClient } from "@tanstack/react-query"
import { fetchProjectAccess } from "@/lib/api"
import { apiFetch } from "@/lib/api/fetch"
import type { Project, ProjectAccess } from "@/lib/api/types"
import { STALE_TIME } from "./client"
import { queryKeys } from "./keys"

/**
 * Project settings in the query cache: the project row and its explicit
 * access rules. Labels use the shared `projectLabelsQuery` (the label picker's
 * entry) and members the shared workspace-members entry.
 */

export function projectDetailQuery(projectId: string) {
  return {
    queryKey: queryKeys.projects.detail(projectId),
    queryFn: (): Promise<Project> => apiFetch<Project>(`/api/projects/${projectId}`),
    staleTime: STALE_TIME.projectDetail,
  }
}

export function projectAccessQuery(projectId: string) {
  return {
    queryKey: queryKeys.projects.access(projectId),
    queryFn: (): Promise<ProjectAccess[]> => fetchProjectAccess(projectId),
    staleTime: STALE_TIME.projectDetail,
  }
}

function isAccess(value: unknown): value is ProjectAccess {
  return typeof value === "object" && value !== null &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { permission?: unknown }).permission === "string"
}

/** Insert or replace access rules (by user), keeping list order; a no-op when nothing changes. */
export function upsertAccess(client: QueryClient, projectId: string, entries: readonly ProjectAccess[]): void {
  const key = queryKeys.projects.access(projectId)
  const list = client.getQueryData<ProjectAccess[]>(key)
  if (!list || entries.length === 0) return
  let next = list
  for (const entry of entries) {
    const index = next.findIndex((existing) => existing.userId === entry.userId)
    if (index < 0) {
      next = [...next, entry]
    } else if (next[index]!.permission !== entry.permission || next[index]!.id !== entry.id) {
      next = next.map((existing, i) => (i === index ? { ...existing, ...entry } : existing))
    }
  }
  if (next !== list) client.setQueryData(key, next)
}

/** Set one user's permission in the cached rules; false when the user has no rule yet. */
export function setAccessPermission(client: QueryClient, projectId: string, userId: string, permission: ProjectAccess["permission"]): boolean {
  const key = queryKeys.projects.access(projectId)
  const list = client.getQueryData<ProjectAccess[]>(key)
  if (!list) return true
  const existing = list.find((entry) => entry.userId === userId)
  if (!existing) return false
  if (existing.permission !== permission) {
    client.setQueryData(key, list.map((entry) => (entry.userId === userId ? { ...entry, permission } : entry)))
  }
  return true
}

/**
 * `project:access-changed`: `{ projectId, access }` (one grant), `{ projectId,
 * access: [...] }` (bulk) or `{ projectId, userId, permission }` (revoke).
 * Returns false when the cached rules could not be patched (refetch them).
 */
export function applyAccessChanged(client: QueryClient, data: Record<string, unknown>): boolean {
  const projectId = typeof data.projectId === "string" ? data.projectId : null
  if (!projectId || !client.getQueryData(queryKeys.projects.access(projectId))) return true
  const access = data.access
  if (Array.isArray(access)) {
    upsertAccess(client, projectId, access.filter(isAccess))
    return true
  }
  if (isAccess(access)) {
    upsertAccess(client, projectId, [access])
    return true
  }
  if (typeof data.userId === "string" && typeof data.permission === "string" &&
    (data.permission === "full" || data.permission === "view" || data.permission === "deny")) {
    return setAccessPermission(client, projectId, data.userId, data.permission)
  }
  return false
}
