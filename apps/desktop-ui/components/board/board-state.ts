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
