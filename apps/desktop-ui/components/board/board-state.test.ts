import { describe, expect, it } from "vitest"
import type { Task } from "../../types/task"
import type { ActiveBatch } from "./use-kanban-board"
import {
  getLockedBatchTaskIds,
  replaceOptimisticTask,
  upsertBoardTask,
} from "./board-state"

function task(id: string, status: Task["status"] = "todo"): Task {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    priority: "medium",
    status,
    sessionId: null,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
    labels: [],
    executionStartedAt: null,
    executionPausedAt: null,
    executionElapsedMs: 0,
    executionProgress: null,
    prUrl: null,
    outcome: null,
    batchId: null,
    inboxRead: false,
    identifier: null,
    number: null,
    dueDate: null,
  }
}

function batch(status: string): ActiveBatch {
  return {
    id: "batch-1",
    status,
    mode: "parallel",
    tasks: [
      { taskId: "task-1", title: "Task 1", status: "completed" },
      { taskId: "task-2", title: "Task 2", status: "running" },
    ],
    prUrl: null,
  }
}

describe("board task state", () => {
  it("upserts a created task instead of duplicating the SSE copy", () => {
    const first = task("task-1", "in_progress")
    const fromSse = { ...first, title: "Server task", identifier: "ENG-1" }

    const next = upsertBoardTask([first], fromSse)

    expect(next).toEqual([fromSse])
  })

  it("replaces an optimistic task and removes a server copy that arrived first", () => {
    const optimistic = task("temp-1", "in_progress")
    const created = { ...task("task-1", "in_progress"), identifier: "ENG-1" }

    const next = replaceOptimisticTask([optimistic, created], optimistic.id, created)

    expect(next).toEqual([created])
  })

  it("locks only batches that are still running", () => {
    expect(getLockedBatchTaskIds(batch("running"))).toEqual(new Set(["task-1", "task-2"]))
    expect(getLockedBatchTaskIds(batch("completed"))).toEqual(new Set())
    expect(getLockedBatchTaskIds(null)).toEqual(new Set())
  })
})
