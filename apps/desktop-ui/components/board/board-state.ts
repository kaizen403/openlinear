import type { Task } from "../../types/task"

interface BatchTaskLockState {
  status: string
  tasks: Array<{ taskId: string }>
}

const LOCKED_BATCH_STATUSES = new Set(["starting", "pending", "running", "merging"])

export function upsertBoardTask(tasks: Task[], task: Task): Task[] {
  const existingIndex = tasks.findIndex((candidate) => candidate.id === task.id)
  if (existingIndex === -1) {
    return [task, ...tasks]
  }

  return tasks.map((candidate, index) => (index === existingIndex ? task : candidate))
}

export function replaceOptimisticTask(tasks: Task[], tempId: string, task: Task): Task[] {
  let replaced = false
  const next: Task[] = []

  for (const candidate of tasks) {
    if (candidate.id === task.id) {
      continue
    }

    if (candidate.id === tempId) {
      next.push(task)
      replaced = true
      continue
    }

    next.push(candidate)
  }

  return replaced ? next : upsertBoardTask(next, task)
}

export function applyBoardStatusChange(task: Task, status: Task["status"]): Task {
  const next: Task = { ...task, status }

  if (status !== "in_progress") {
    next.sessionId = null
    next.executionStartedAt = null
    next.executionPausedAt = null
    next.executionElapsedMs = 0
    next.executionProgress = null
    next.batchId = null
  }

  return next
}

export function moveBoardTask(
  tasks: Task[],
  taskId: string,
  status: Task["status"],
  destinationIndex: number,
): Task[] {
  const movingTask = tasks.find((task) => task.id === taskId)
  if (!movingTask) return tasks

  const withoutMovingTask = tasks.filter((task) => task.id !== taskId)
  const movedTask = applyBoardStatusChange(movingTask, status)
  const destinationTasks = withoutMovingTask.filter((task) => task.status === status)
  const beforeTask = destinationTasks[Math.max(0, destinationIndex)]

  if (beforeTask) {
    const insertAt = withoutMovingTask.findIndex((task) => task.id === beforeTask.id)
    return [
      ...withoutMovingTask.slice(0, insertAt),
      movedTask,
      ...withoutMovingTask.slice(insertAt),
    ]
  }

  let lastDestinationIndex = -1
  for (let index = withoutMovingTask.length - 1; index >= 0; index -= 1) {
    if (withoutMovingTask[index]?.status === status) {
      lastDestinationIndex = index
      break
    }
  }

  if (lastDestinationIndex === -1) {
    return [...withoutMovingTask, movedTask]
  }

  return [
    ...withoutMovingTask.slice(0, lastDestinationIndex + 1),
    movedTask,
    ...withoutMovingTask.slice(lastDestinationIndex + 1),
  ]
}

export function getLockedBatchTaskIds(batch: BatchTaskLockState | null): Set<string> {
  if (!batch || !LOCKED_BATCH_STATUSES.has(batch.status)) {
    return new Set()
  }

  return new Set(batch.tasks.map((task) => task.taskId))
}

/**
 * Replace tasks that are still on the board with server copies (one pass).
 * Unlike upsertBoardTask this never re-adds a task that was removed meanwhile
 * (e.g. archived by another client while a bulk request was in flight).
 */
export function replaceBoardTasks(tasks: Task[], updates: readonly Task[]): Task[] {
  if (updates.length === 0) return tasks
  const byId = new Map(updates.map((task) => [task.id, task]))
  let changed = false
  const next = tasks.map((task) => {
    const update = byId.get(task.id)
    if (!update || update === task) return task
    changed = true
    return update
  })
  return changed ? next : tasks
}

/**
 * Remove tasks by id. Returns the same array when none of them is on the
 * board, so a repeated delete event (bulk + per-task) writes nothing.
 */
export function removeBoardTasks(tasks: Task[], ids: ReadonlySet<string>): Task[] {
  if (ids.size === 0 || !tasks.some((task) => ids.has(task.id))) return tasks
  return tasks.filter((task) => !ids.has(task.id))
}

/**
 * Put optimistically removed tasks back near their previous position: each
 * restored task is inserted before the next task that followed it in
 * `previous` and is still present, otherwise appended. Tasks that reappeared
 * meanwhile are not duplicated.
 */
export function restoreRemovedTasks(current: Task[], previous: readonly Task[], ids: ReadonlySet<string>): Task[] {
  const present = new Set(current.map((task) => task.id))
  const anchorOf = new Map<string, string | null>()
  let nextPresent: string | null = null
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const task = previous[index]!
    if (ids.has(task.id) && !present.has(task.id)) anchorOf.set(task.id, nextPresent)
    else if (present.has(task.id)) nextPresent = task.id
  }
  if (anchorOf.size === 0) return current

  const before = new Map<string, Task[]>()
  const tail: Task[] = []
  for (const task of previous) {
    if (!anchorOf.has(task.id)) continue
    const anchor = anchorOf.get(task.id)
    if (!anchor) {
      tail.push(task)
      continue
    }
    const list = before.get(anchor)
    if (list) list.push(task)
    else before.set(anchor, [task])
  }

  const result: Task[] = []
  for (const task of current) {
    const inserted = before.get(task.id)
    if (inserted) result.push(...inserted)
    result.push(task)
  }
  result.push(...tail)
  return result
}

export type TaskBuckets = Record<Task["status"], Task[]>

export const BOARD_STATUSES: readonly Task["status"][] = ["todo", "in_progress", "done", "cancelled"]

/** All four status columns in one pass, preserving board order. */
export function bucketTasksByStatus(tasks: readonly Task[]): TaskBuckets {
  const buckets: TaskBuckets = { todo: [], in_progress: [], done: [], cancelled: [] }
  for (const task of tasks) {
    const bucket = buckets[task.status]
    if (bucket) bucket.push(task)
  }
  return buckets
}

function sameTasks(left: readonly Task[], right: readonly Task[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Keep the previous array for every column whose tasks are unchanged (same
 * objects, same order), so memoized columns skip re-rendering when an SSE
 * update touches a task in another column.
 */
export function stabilizeBuckets(previous: TaskBuckets | null, next: TaskBuckets): TaskBuckets {
  if (!previous) return next
  let reused = 0
  const result = { ...next }
  for (const status of BOARD_STATUSES) {
    if (sameTasks(previous[status], next[status])) {
      result[status] = previous[status]
      reused += 1
    }
  }
  return reused === BOARD_STATUSES.length ? previous : result
}
