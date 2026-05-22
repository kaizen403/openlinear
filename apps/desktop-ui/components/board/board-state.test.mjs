import { describe, expect, it } from "vitest"
import {
  applyBoardStatusChange,
  getLockedBatchTaskIds,
  moveBoardTask,
  replaceOptimisticTask,
  upsertBoardTask,
} from "./board-state"

function task(id, status = "todo") {
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

function batch(status) {
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

  it("moves a dragged task into the requested column position", () => {
    const todoOne = task("todo-1", "todo")
    const todoTwo = task("todo-2", "todo")
    const doneOne = task("done-1", "done")

    const next = moveBoardTask([todoOne, todoTwo, doneOne], doneOne.id, "todo", 1)

    expect(next.map((candidate) => candidate.id)).toEqual(["todo-1", "done-1", "todo-2"])
    expect(next[1].status).toBe("todo")
  })

  it("reorders a task inside its current column", () => {
    const first = task("task-1", "todo")
    const second = task("task-2", "todo")
    const third = task("task-3", "todo")

    const next = moveBoardTask([first, second, third], third.id, "todo", 0)

    expect(next.map((candidate) => candidate.id)).toEqual(["task-3", "task-1", "task-2"])
  })

  it("clears runtime execution state when a task is manually moved out of in progress", () => {
    const runningTask = {
      ...task("task-1", "in_progress"),
      sessionId: "session-1",
      executionStartedAt: "2026-05-22T00:00:00.000Z",
      executionPausedAt: null,
      executionElapsedMs: 12_000,
      executionProgress: 50,
      batchId: "batch-1",
    }

    expect(applyBoardStatusChange(runningTask, "todo")).toMatchObject({
      status: "todo",
      sessionId: null,
      executionStartedAt: null,
      executionPausedAt: null,
      executionElapsedMs: 0,
      executionProgress: null,
      batchId: null,
    })
  })
})
