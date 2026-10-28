import type { Task } from "@/types/task"
import { apiFetch } from "./fetch"
import { idempotencyHeaders } from "./idempotency"

/**
 * Task write commands with the request/response shapes of
 * apps/api/src/routes/tasks.ts and apps/api/src/services/tasks.ts.
 *
 * - Creates carry an `Idempotency-Key` (W04a); pair them with
 *   `sendWithIdempotencyKey` so automatic retries reuse the key.
 * - The bulk endpoints take exactly one scope per request — `projectId`, or
 *   `teamId` for that team's project-less issues (400 `BULK_SCOPE_INVALID`
 *   otherwise) — and 1–BULK_TASK_LIMIT explicit ids (400 `TASK_IDS_REQUIRED`
 *   for none). Callers group by scope and chunk (see
 *   components/board/bulk-actions.ts).
 */
export const BULK_TASK_LIMIT = 100

type TaskStatus = Task["status"]
type TaskPriority = Task["priority"]

export interface CreateTaskRequest {
  title: string
  description?: string
  priority?: TaskPriority
  status?: TaskStatus
  labelIds?: string[]
  /** Members of the task's team; the first is the primary assignee unless `assigneeId` is set. */
  assigneeIds?: string[]
  assigneeId?: string
  teamId?: string
  projectId?: string
  dueDate?: string
  model?: string
}

export function createTaskWithKey(
  body: CreateTaskRequest,
  idempotencyKey: string,
  init: { signal?: AbortSignal } = {},
): Promise<Task> {
  return apiFetch<Task>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(body),
    headers: idempotencyHeaders(idempotencyKey),
    ...(init.signal ? { signal: init.signal } : {}),
  })
}

export interface BulkCreateTaskItem {
  title: string
  description?: string
  priority?: TaskPriority
  status?: TaskStatus
  labelIds?: string[]
  parentId?: string
  dueDate?: string
  assigneeIds?: string[]
}

export interface BulkCreateTasksResponse {
  created: Task[]
  /** Items the server rejected (bad labels/parent); the rest were created. */
  failed: Array<{ index: number; error: string }>
}

export function bulkCreateTasks(
  body: { projectId: string; tasks: BulkCreateTaskItem[] },
  idempotencyKey: string,
): Promise<BulkCreateTasksResponse> {
  if (body.tasks.length === 0 || body.tasks.length > BULK_TASK_LIMIT) {
    return Promise.reject(new RangeError(`bulkCreateTasks takes 1-${BULK_TASK_LIMIT} tasks`))
  }
  return apiFetch<BulkCreateTasksResponse>("/api/tasks/bulk", {
    method: "POST",
    body: JSON.stringify(body),
    headers: idempotencyHeaders(idempotencyKey),
  })
}

export interface BulkTaskSummary {
  id: string
  identifier: string | null
  title: string
  status: TaskStatus
}

export interface BulkStatusResponse {
  updated: Task[]
  /** Already had the requested status; nothing was written. */
  already: BulkTaskSummary[]
  failed: Array<{ id: string; error: string }>
  status: TaskStatus
}

export interface BulkArchiveResponse {
  archived: BulkTaskSummary[]
  failed: Array<{ id?: string; identifier?: string; error: string }>
  count: number
}

export interface BulkDeleteResponse {
  deleted: string[]
  failed: Array<{ id: string; error: string }>
  permanent: boolean
}

/**
 * The scope of one bulk request: a project, or a team's project-less issues
 * ("team-only" tasks). Exactly one; the API answers 400 `BULK_SCOPE_INVALID`
 * for neither or both.
 */
export type BulkTaskScope =
  | { projectId: string; teamId?: undefined }
  | { teamId: string; projectId?: undefined }

function scopeBody(scope: BulkTaskScope, name: string): { projectId: string } | { teamId: string } {
  const projectId = typeof scope.projectId === "string" && scope.projectId.length > 0 ? scope.projectId : null
  const teamId = typeof scope.teamId === "string" && scope.teamId.length > 0 ? scope.teamId : null
  if (projectId && !teamId) return { projectId }
  if (teamId && !projectId) return { teamId }
  throw new RangeError(`${name} needs exactly one of projectId or teamId`)
}

function assertBulkIds(taskIds: readonly string[], name: string): void {
  // Never send an empty selection: the API refuses it (TASK_IDS_REQUIRED);
  // bulk-status once read it as "every task in the project".
  if (taskIds.length === 0) throw new RangeError(`${name} needs at least one task id`)
  if (taskIds.length > BULK_TASK_LIMIT) throw new RangeError(`${name} takes at most ${BULK_TASK_LIMIT} task ids`)
}

export async function bulkUpdateTaskStatus(body: BulkTaskScope & {
  status: TaskStatus
  taskIds: string[]
}): Promise<BulkStatusResponse> {
  const scope = scopeBody(body, "bulkUpdateTaskStatus")
  assertBulkIds(body.taskIds, "bulkUpdateTaskStatus")
  return apiFetch<BulkStatusResponse>("/api/tasks/bulk-status", {
    method: "PATCH",
    body: JSON.stringify({ ...scope, status: body.status, taskIds: body.taskIds }),
  })
}

export async function bulkArchiveTasks(body: BulkTaskScope & { taskIds: string[] }): Promise<BulkArchiveResponse> {
  const scope = scopeBody(body, "bulkArchiveTasks")
  assertBulkIds(body.taskIds, "bulkArchiveTasks")
  return apiFetch<BulkArchiveResponse>("/api/tasks/bulk-archive", {
    method: "POST",
    body: JSON.stringify({ ...scope, taskIds: body.taskIds }),
  })
}

export async function bulkDeleteTasks(body: BulkTaskScope & {
  taskIds: string[]
  permanent: boolean
}): Promise<BulkDeleteResponse> {
  const scope = scopeBody(body, "bulkDeleteTasks")
  assertBulkIds(body.taskIds, "bulkDeleteTasks")
  return apiFetch<BulkDeleteResponse>("/api/tasks/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ...scope, taskIds: body.taskIds, permanent: body.permanent }),
  })
}
