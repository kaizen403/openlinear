import type { Task } from "@/types/task"
import { apiFetch } from "@/lib/api/fetch"
import { getApiErrorCode } from "@/lib/api/errors"
import {
  BULK_TASK_LIMIT,
  bulkArchiveTasks,
  bulkDeleteTasks,
  bulkUpdateTaskStatus,
  type BulkTaskScope,
} from "@/lib/api/task-commands"

/**
 * Board bulk actions on top of the bulk endpoints:
 * PATCH /api/tasks/bulk-status, POST /api/tasks/bulk-archive and
 * POST /api/tasks/bulk-delete. Every request carries exactly one scope:
 * `projectId` for project tasks, `teamId` for a team's project-less
 * ("team-only") tasks. A selection inside one scope of at most 100 tasks is
 * exactly one request; larger or mixed selections are one request per scope
 * per 100 ids. Only persisted tasks with neither a project nor a team (none
 * of the bulk scopes can address them) fall back to their single-task
 * endpoint.
 */
export type BulkAction =
  | { kind: "status"; status: Task["status"] }
  | { kind: "archive" }
  | { kind: "delete" }

export type BulkRequestBatch =
  | { scope: "project"; projectId: string; taskIds: string[] }
  | { scope: "team"; teamId: string; taskIds: string[] }

export interface BulkRequestPlan {
  /** One entry per request: grouped by scope (project first, then team), chunked at the limit. */
  batches: BulkRequestBatch[]
  /** Persisted tasks with neither a project nor a team: single-task endpoints. */
  unscoped: string[]
  /** Optimistic placeholders (`temp-…`) and unknown ids: nothing to send. */
  skipped: string[]
}

type BulkTaskRef = Pick<Task, "id" | "projectId" | "teamId">

function batchScope(batch: BulkRequestBatch): BulkTaskScope {
  return batch.scope === "project" ? { projectId: batch.projectId } : { teamId: batch.teamId }
}

export interface BulkItemFailure {
  id: string
  reason: string
  code: string | null
  /** "item": the server rejected this task; "request": the whole request failed. */
  source: "item" | "request"
}

export interface BulkActionOutcome {
  /** Applied by the server, or already in the requested state. */
  succeeded: string[]
  failed: BulkItemFailure[]
  /** Server copies of tasks whose status changed (status action only). */
  updatedTasks: Task[]
  requestCount: number
  /** First whole-request error, kept for error-code mapping in toasts. */
  requestError: unknown
}

export function isPersistedTaskId(id: string): boolean {
  return !id.startsWith("temp-")
}

function pushTo(groups: Map<string, string[]>, key: string, id: string): void {
  const group = groups.get(key)
  if (group) group.push(id)
  else groups.set(key, [id])
}

function chunk(taskIds: readonly string[], limit: number): string[][] {
  const chunks: string[][] = []
  for (let start = 0; start < taskIds.length; start += limit) chunks.push(taskIds.slice(start, start + limit))
  return chunks
}

/**
 * Group a selection into bulk requests, one scope each: a task with a
 * project goes to its project; a project-less task with a team goes to its
 * team (the API's team scope covers exactly those tasks).
 */
export function planBulkRequests(
  ids: readonly string[],
  tasksById: ReadonlyMap<string, BulkTaskRef>,
  limit: number = BULK_TASK_LIMIT,
): BulkRequestPlan {
  const byProject = new Map<string, string[]>()
  const byTeam = new Map<string, string[]>()
  const unscoped: string[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const task = tasksById.get(id)
    if (!task || !isPersistedTaskId(id)) {
      skipped.push(id)
      continue
    }
    if (task.projectId) pushTo(byProject, task.projectId, id)
    else if (task.teamId) pushTo(byTeam, task.teamId, id)
    else unscoped.push(id)
  }
  const batches: BulkRequestBatch[] = []
  for (const [projectId, taskIds] of byProject) {
    for (const part of chunk(taskIds, limit)) batches.push({ scope: "project", projectId, taskIds: part })
  }
  for (const [teamId, taskIds] of byTeam) {
    for (const part of chunk(taskIds, limit)) batches.push({ scope: "team", teamId, taskIds: part })
  }
  return { batches, unscoped, skipped }
}

const NO_RESULT_REASON = "The server did not report a result for this task"

function errorReason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Request failed"
}

interface BatchResult {
  succeeded: string[]
  failed: BulkItemFailure[]
  updatedTasks: Task[]
}

async function sendBatch(action: BulkAction, batch: BulkRequestBatch): Promise<BatchResult> {
  const { taskIds } = batch
  const scope = batchScope(batch)
  const requested = new Set(taskIds)
  const succeeded = new Set<string>()
  const failed: BulkItemFailure[] = []
  let updatedTasks: Task[] = []

  if (action.kind === "status") {
    const response = await bulkUpdateTaskStatus({ ...scope, status: action.status, taskIds })
    updatedTasks = response.updated.filter((task) => requested.has(task.id))
    for (const task of updatedTasks) succeeded.add(task.id)
    for (const task of response.already) if (requested.has(task.id)) succeeded.add(task.id)
    for (const item of response.failed) failed.push({ id: item.id, reason: item.error, code: null, source: "item" })
  } else if (action.kind === "archive") {
    const response = await bulkArchiveTasks({ ...scope, taskIds })
    for (const task of response.archived) if (requested.has(task.id)) succeeded.add(task.id)
    for (const item of response.failed) {
      if (item.id) failed.push({ id: item.id, reason: item.error, code: null, source: "item" })
    }
  } else {
    const response = await bulkDeleteTasks({ ...scope, taskIds, permanent: true })
    for (const id of response.deleted) if (requested.has(id)) succeeded.add(id)
    for (const item of response.failed) failed.push({ id: item.id, reason: item.error, code: null, source: "item" })
  }

  const reported = new Set([...succeeded, ...failed.map((item) => item.id)])
  for (const id of taskIds) {
    if (!reported.has(id)) failed.push({ id, reason: NO_RESULT_REASON, code: null, source: "item" })
  }
  return { succeeded: [...succeeded], failed, updatedTasks }
}

function sendSingle(action: BulkAction, taskId: string): Promise<Task | undefined> {
  if (action.kind === "status") {
    return apiFetch<Task>(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status: action.status }) })
  }
  const query = action.kind === "delete" ? "?permanent=true" : ""
  return apiFetch<undefined>(`/api/tasks/${taskId}${query}`, { method: "DELETE" })
}

export async function runBulkAction(
  action: BulkAction,
  ids: readonly string[],
  tasksById: ReadonlyMap<string, BulkTaskRef>,
): Promise<BulkActionOutcome> {
  const plan = planBulkRequests(ids, tasksById)
  const outcome: BulkActionOutcome = {
    succeeded: [],
    failed: [],
    updatedTasks: [],
    requestCount: plan.batches.length + plan.unscoped.length,
    requestError: null,
  }

  const batchResults = await Promise.all(plan.batches.map(async (batch) => {
    try {
      return await sendBatch(action, batch)
    } catch (error) {
      if (outcome.requestError === null) outcome.requestError = error
      const code = getApiErrorCode(error)
      return {
        succeeded: [],
        failed: batch.taskIds.map((id) => ({ id, reason: errorReason(error), code, source: "request" as const })),
        updatedTasks: [],
      } satisfies BatchResult
    }
  }))
  for (const result of batchResults) {
    outcome.succeeded.push(...result.succeeded)
    outcome.failed.push(...result.failed)
    outcome.updatedTasks.push(...result.updatedTasks)
  }

  const singleResults = await Promise.allSettled(plan.unscoped.map((id) => sendSingle(action, id)))
  singleResults.forEach((result, index) => {
    const id = plan.unscoped[index]!
    if (result.status === "fulfilled") {
      outcome.succeeded.push(id)
      if (action.kind === "status" && result.value) outcome.updatedTasks.push(result.value)
    } else {
      if (outcome.requestError === null) outcome.requestError = result.reason
      outcome.failed.push({ id, reason: errorReason(result.reason), code: getApiErrorCode(result.reason), source: "request" })
    }
  })

  return outcome
}

const STATUS_LABELS: Record<Task["status"], string> = {
  todo: "Todo",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Cancelled",
}

export function describeBulkAction(action: BulkAction): { verb: string; past: string } {
  if (action.kind === "status") {
    return { verb: `move to ${STATUS_LABELS[action.status]}`, past: `Moved to ${STATUS_LABELS[action.status]}` }
  }
  if (action.kind === "archive") return { verb: "archive", past: "Archived" }
  return { verb: "delete", past: "Deleted" }
}

export function pluralTasks(count: number): string {
  return `${count} task${count === 1 ? "" : "s"}`
}

/** "Couldn't move 1 of 3 tasks to Done", "Couldn't archive 2 tasks". */
export function bulkFailureTitle(action: BulkAction, failed: number, total: number): string {
  const amount = failed === total ? pluralTasks(total) : `${failed} of ${pluralTasks(total)}`
  if (action.kind === "status") return `Couldn't move ${amount} to ${STATUS_LABELS[action.status]}`
  return `Couldn't ${action.kind} ${amount}`
}

/**
 * Per-item failure lines for a toast description, e.g.
 * "BEN-12: Issue was not found in the selected project". Identical reasons
 * are grouped and long lists truncated.
 */
export function summarizeBulkFailures(
  failed: readonly BulkItemFailure[],
  labelFor: (id: string) => string,
  maxItems = 3,
): string {
  const byReason = new Map<string, string[]>()
  for (const item of failed) {
    const labels = byReason.get(item.reason)
    if (labels) labels.push(labelFor(item.id))
    else byReason.set(item.reason, [labelFor(item.id)])
  }
  const lines: string[] = []
  let shown = 0
  for (const [reason, labels] of byReason) {
    if (shown >= maxItems) break
    const visible = labels.slice(0, Math.max(1, maxItems - shown))
    shown += visible.length
    const extra = labels.length - visible.length
    lines.push(`${visible.join(", ")}${extra > 0 ? ` +${extra} more` : ""}: ${reason}`)
  }
  const remainingGroups = byReason.size - lines.length
  if (remainingGroups > 0) lines.push(`…and ${remainingGroups} other reason${remainingGroups === 1 ? "" : "s"}`)
  return lines.join(" · ")
}
