import type { ActiveBatch, ActiveBatchTask } from "./use-kanban-board"
import type { BatchStatusResponse } from "./execution-outcome"

const TERMINAL_BATCH_STATUSES = new Set(["completed", "failed", "cancelled"])

const BATCH_RANK: Record<string, number> = {
  starting: 0,
  pending: 1,
  running: 2,
  merging: 3,
  completed: 4,
  failed: 4,
  cancelled: 4,
}

const MEMBER_RANK: Record<ActiveBatchTask["status"], number> = {
  queued: 0,
  running: 1,
  completed: 2,
  failed: 2,
  skipped: 2,
  cancelled: 2,
}

export function isTerminalBatchStatus(status: string): boolean {
  return TERMINAL_BATCH_STATUSES.has(status)
}

export function isBatchStatusResponse(value: unknown): value is BatchStatusResponse {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<BatchStatusResponse>
  return typeof candidate.id === "string" && typeof candidate.status === "string" && Array.isArray(candidate.tasks)
}

/** GET /api/batches/:id → board batch state, keeping W01 publication/retention fields. */
export function toActiveBatch(detail: BatchStatusResponse): ActiveBatch {
  return {
    id: detail.id,
    status: detail.status,
    mode: detail.mode,
    tasks: detail.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      branch: task.branch,
      error: task.error,
      ...(task.cancelUnconfirmed ? { cancelUnconfirmed: true } : {}),
    })),
    prUrl: detail.prUrl ?? null,
    publication: detail.publication ?? null,
  }
}

/**
 * Merge a fetched batch detail into the SSE-driven state without moving any
 * status backwards: an event that arrived while the detail request was in
 * flight is newer than the detail snapshot.
 */
export function mergeBatchDetail(local: ActiveBatch, detail: ActiveBatch): ActiveBatch {
  if (local.id !== detail.id) return local
  const status = (BATCH_RANK[local.status] ?? 0) > (BATCH_RANK[detail.status] ?? 0) ? local.status : detail.status
  const localById = new Map(local.tasks.map((task) => [task.taskId, task]))
  const tasks = detail.tasks.map((remote) => {
    const mine = localById.get(remote.taskId)
    if (mine && MEMBER_RANK[mine.status] > MEMBER_RANK[remote.status]) return { ...remote, status: mine.status }
    return remote
  })
  return {
    ...local,
    status,
    tasks,
    prUrl: detail.prUrl ?? local.prUrl,
    publication: detail.publication ?? local.publication ?? null,
  }
}

/**
 * Keep fields that only the detail endpoint provides (branch, error,
 * cancelUnconfirmed, publication) when an SSE update replaces the batch.
 */
export function carryBatchDetail(previous: ActiveBatch | null, next: ActiveBatch): ActiveBatch {
  if (!previous || previous.id !== next.id) return next
  const previousById = new Map(previous.tasks.map((task) => [task.taskId, task]))
  return {
    ...next,
    tasks: next.tasks.map((task) => {
      const known = previousById.get(task.taskId)
      if (!known) return task
      return {
        ...task,
        ...(task.branch === undefined && known.branch !== undefined ? { branch: known.branch } : {}),
        ...(task.error === undefined && known.error !== undefined ? { error: known.error } : {}),
        ...(task.cancelUnconfirmed === undefined && known.cancelUnconfirmed ? { cancelUnconfirmed: true } : {}),
      }
    }),
    publication: next.publication ?? previous.publication ?? null,
    prUrl: next.prUrl ?? previous.prUrl,
  }
}

/** A finished batch that still needs the user: unconfirmed stops or a publication error. */
export function batchNeedsAttention(batch: Pick<ActiveBatch, "status" | "tasks" | "publication">): boolean {
  return batch.tasks.some((task) => task.cancelUnconfirmed) || Boolean(batch.publication?.error)
}
