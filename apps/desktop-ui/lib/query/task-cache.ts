import type { MyIssueTask } from "@/lib/api/types"
import type { Label, Task } from "@/types/task"
import { upsertBoardTask } from "@/components/board/board-state"
import type { BoardTaskScope, MyIssuesScope, ProjectIssuesScope } from "./keys"

/**
 * Pure task-list updaters shared by the SSE → cache bridge and the board's
 * own event handler (hooks/use-task-sse.ts). They never fetch; when an event
 * can't be applied precisely (a task enters a list and the event lacks the
 * fields the list needs) they report `stale` and the caller invalidates.
 */

/** Loose SSE payload shape; every field is optional. */
export interface TaskEventData {
  id?: string
  title?: string
  description?: string | null
  priority?: Task["priority"]
  status?: Task["status"]
  sessionId?: string | null
  createdAt?: string
  updatedAt?: string
  labels?: Label[]
  executionStartedAt?: string | null
  executionPausedAt?: string | null
  executionElapsedMs?: number
  executionProgress?: number | null
  prUrl?: string | null
  outcome?: string | null
  batchId?: string | null
  inboxRead?: boolean
  identifier?: string | null
  number?: number | null
  dueDate?: string | null
  teamId?: string | null
  projectId?: string | null
  assigneeId?: string | null
  creatorId?: string | null
  assignee?: Task["assignee"]
  creator?: Task["creator"]
  model?: string | null
  archived?: boolean
}

export interface ListUpdate<T> {
  /** The new list, or the same reference when nothing changed. */
  next: T[]
  /** The list may now be missing a task: refetch it. */
  stale: boolean
}

const unchanged = <T,>(list: T[]): ListUpdate<T> => ({ next: list, stale: false })

/** A full board task from a `task:created` payload, or null when it is incomplete. */
export function taskFromCreatedEvent(data: TaskEventData): Task | null {
  if (!data.id || !data.title || !data.status) return null
  const now = new Date().toISOString()
  return {
    id: data.id,
    title: data.title,
    description: data.description ?? null,
    priority: data.priority ?? "medium",
    status: data.status,
    sessionId: data.sessionId ?? null,
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now,
    labels: data.labels ?? [],
    executionStartedAt: data.executionStartedAt ?? null,
    executionPausedAt: data.executionPausedAt ?? null,
    executionElapsedMs: data.executionElapsedMs ?? 0,
    executionProgress: data.executionProgress ?? null,
    prUrl: data.prUrl ?? null,
    outcome: data.outcome ?? null,
    batchId: data.batchId ?? null,
    inboxRead: data.inboxRead ?? false,
    identifier: data.identifier ?? null,
    number: data.number ?? null,
    dueDate: data.dueDate ?? null,
    teamId: data.teamId ?? null,
    projectId: data.projectId ?? null,
    assigneeId: data.assigneeId ?? null,
    creatorId: data.creatorId ?? null,
    assignee: data.assignee ?? null,
    creator: data.creator ?? null,
    model: data.model ?? null,
    archived: data.archived ?? false,
  }
}

const BOARD_TASK_FIELDS = [
  "title", "description", "priority", "status", "sessionId", "updatedAt", "labels",
  "executionStartedAt", "executionPausedAt", "executionElapsedMs", "executionProgress",
  "prUrl", "outcome", "batchId", "dueDate", "inboxRead", "identifier", "number",
  "teamId", "projectId", "assigneeId", "creatorId", "assignee", "creator", "model", "archived",
] as const satisfies ReadonlyArray<keyof Task & keyof TaskEventData>

const ISSUE_TASK_FIELDS = [
  "title", "description", "priority", "status", "updatedAt", "labels", "prUrl",
  "executionElapsedMs", "executionProgress", "identifier", "dueDate",
  "assigneeId", "creatorId", "assignee", "creator",
] as const satisfies ReadonlyArray<keyof MyIssueTask & keyof TaskEventData>

function mergeFields<T extends object, K extends keyof T & keyof TaskEventData>(
  existing: T,
  data: TaskEventData,
  fields: readonly K[],
): T {
  let next: T | null = null
  for (const field of fields) {
    const value = data[field]
    if (value === undefined) continue
    if (!next) next = { ...existing }
    ;(next as Record<K, unknown>)[field] = value
  }
  return next ?? existing
}

/** `task:updated` merge: only the fields the event carries. */
export function mergeTaskUpdate(existing: Task, data: TaskEventData): Task {
  return mergeFields(existing, data, BOARD_TASK_FIELDS)
}

export function mergeIssueTaskUpdate(existing: MyIssueTask, data: TaskEventData): MyIssueTask {
  return mergeFields(existing, data, ISSUE_TASK_FIELDS)
}

/** Whether a task event's project/team places it outside a board scope. */
export function isOutsideBoardScope(scope: Pick<BoardTaskScope, "projectId" | "teamId">, data: TaskEventData): boolean {
  return (
    data.archived === true ||
    (scope.projectId !== null && data.projectId !== undefined && data.projectId !== scope.projectId) ||
    (scope.teamId !== null && data.teamId !== undefined && data.teamId !== scope.teamId)
  )
}

export function applyTaskCreatedToBoard(list: Task[], scope: BoardTaskScope, data: TaskEventData): ListUpdate<Task> {
  const task = taskFromCreatedEvent(data)
  if (!task) return unchanged(list)
  if (scope.projectId && task.projectId !== scope.projectId) return unchanged(list)
  if (scope.teamId && task.teamId !== scope.teamId) return unchanged(list)
  return { next: upsertBoardTask(list, task), stale: false }
}

export function applyTaskUpdatedToBoard(list: Task[], scope: BoardTaskScope, data: TaskEventData): ListUpdate<Task> {
  const id = data.id
  if (!id) return unchanged(list)
  const index = list.findIndex((task) => task.id === id)
  if (isOutsideBoardScope(scope, data)) {
    return index === -1 ? unchanged(list) : { next: list.filter((task) => task.id !== id), stale: false }
  }
  if (index === -1) {
    // The task may have just moved into this scope; the payload alone can't
    // place it reliably in a list fetched with server-side filters.
    const entersScope =
      (scope.projectId !== null && data.projectId === scope.projectId) ||
      (scope.teamId !== null && data.teamId === scope.teamId)
    return { next: list, stale: entersScope }
  }
  const existing = list[index]!
  const merged = mergeTaskUpdate(existing, data)
  return merged === existing ? unchanged(list) : { next: upsertBoardTask(list, merged), stale: false }
}

export function removeTasks<T extends { id: string }>(list: T[], ids: ReadonlySet<string>): ListUpdate<T> {
  if (ids.size === 0 || !list.some((task) => ids.has(task.id))) return unchanged(list)
  return { next: list.filter((task) => !ids.has(task.id)), stale: false }
}

/** Whether a "my issues" / project issues list can contain the task, as far as the event tells. */
function issueMembership(
  scope: MyIssuesScope | ProjectIssuesScope,
  data: TaskEventData,
  currentUserId: string | null,
): boolean | "unknown" {
  if (data.archived === true) return false
  if (scope.kind === "project-issues") {
    return data.projectId === undefined ? "unknown" : data.projectId === scope.projectId
  }
  if (scope.filter === "assigned") {
    if (data.assigneeId === undefined || !currentUserId) return "unknown"
    return data.assigneeId === currentUserId
  }
  if (scope.filter === "created") {
    if (data.creatorId === undefined || !currentUserId) return "unknown"
    return data.creatorId === currentUserId
  }
  return "unknown"
}

/**
 * Issue lists hold `MyIssueTask` rows with joined `project`/`team` objects
 * the SSE payload doesn't carry: a task entering a list (or changing project
 * or team) makes the list stale; everything else is merged in place.
 */
export function applyTaskEventToIssueList(
  list: MyIssueTask[],
  scope: MyIssuesScope | ProjectIssuesScope,
  eventType: "task:created" | "task:updated",
  data: TaskEventData,
  currentUserId: string | null,
): ListUpdate<MyIssueTask> {
  const id = data.id
  if (!id) return unchanged(list)
  const index = list.findIndex((task) => task.id === id)
  const member = issueMembership(scope, data, currentUserId)
  if (index === -1) {
    if (member === false) return unchanged(list)
    if (eventType === "task:created" || member === true) return { next: list, stale: true }
    return unchanged(list)
  }
  if (member === false) return { next: list.filter((task) => task.id !== id), stale: false }
  const existing = list[index]!
  const relationChanged =
    (data.projectId !== undefined && (existing.project?.id ?? null) !== data.projectId) ||
    (data.teamId !== undefined && (existing.team?.id ?? null) !== data.teamId)
  const merged = mergeIssueTaskUpdate(existing, data)
  if (merged === existing) return { next: list, stale: relationChanged }
  const next = list.slice()
  next[index] = merged
  return { next, stale: relationChanged }
}

/**
 * W17a `task:dependencies` on a task list: keep the blocked task's
 * `blockedByIds` / `openBlockerCount` current. A blocker on the same list is
 * judged by its status; one that isn't counts as open. Already-applied
 * changes (the client's own mutation patched the row) are a no-op.
 */
export function applyDependencyChange<T extends { id: string; status: string; blockedByIds?: string[]; openBlockerCount?: number }>(
  list: T[],
  change: { taskId: string; dependsOnTaskId: string; kind: "added" | "removed" },
): ListUpdate<T> {
  const index = list.findIndex((task) => task.id === change.taskId)
  const task = index >= 0 ? list[index] : undefined
  if (!task) return { next: list, stale: false }
  const ids = task.blockedByIds ?? []
  if ((change.kind === "added") === ids.includes(change.dependsOnTaskId)) return { next: list, stale: false }
  const blocker = list.find((candidate) => candidate.id === change.dependsOnTaskId)
  const open = blocker ? blocker.status !== "done" : true
  const count = task.openBlockerCount ?? 0
  const updated: T = change.kind === "added"
    ? { ...task, blockedByIds: [...ids, change.dependsOnTaskId], openBlockerCount: count + (open ? 1 : 0) }
    : { ...task, blockedByIds: ids.filter((id) => id !== change.dependsOnTaskId), openBlockerCount: Math.max(0, count - (open ? 1 : 0)) }
  const next = list.slice()
  next[index] = updated
  return { next, stale: false }
}

/** `task:label:assigned` / `task:label:removed` on any task list. */
export function applyTaskLabelChange<T extends { id: string; labels: Label[] }>(
  list: T[],
  taskId: string,
  change: { add: Label } | { removeId: string },
): ListUpdate<T> {
  const index = list.findIndex((task) => task.id === taskId)
  if (index === -1) return unchanged(list)
  const task = list[index]!
  const labels = "add" in change
    ? (task.labels.some((label) => label.id === change.add.id)
      ? task.labels.map((label) => (label.id === change.add.id ? change.add : label))
      : [...task.labels, change.add])
    : task.labels.filter((label) => label.id !== change.removeId)
  if (labels.length === task.labels.length && labels.every((label, i) => label === task.labels[i])) return unchanged(list)
  const next = list.slice()
  next[index] = { ...task, labels }
  return { next, stale: false }
}

/** `label:updated` / `label:deleted`: patch the label embedded in every task that carries it. */
export function applyLabelToTasks<T extends { labels: Label[] }>(
  list: T[],
  change: { update: Label } | { removeId: string },
): ListUpdate<T> {
  const targetId = "update" in change ? change.update.id : change.removeId
  let next: T[] | null = null
  list.forEach((task, index) => {
    if (!task.labels.some((label) => label.id === targetId)) return
    const labels = "update" in change
      ? task.labels.map((label) => (label.id === targetId ? { ...label, ...change.update } : label))
      : task.labels.filter((label) => label.id !== targetId)
    if (!next) next = list.slice()
    next[index] = { ...task, labels }
  })
  return next ? { next, stale: false } : unchanged(list)
}
