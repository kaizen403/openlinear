"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ExecutionLogEntry, ExecutionProgress } from "@/types/task"
import { useSSEStatus, useSSESubscription, type SSEEventData, type SSEEventMeta, type SSEEventType } from "@/providers/sse-provider"
import { hasExecutionLogs, replaceExecutionLogs, useExecutionLogs, useExecutionProgress } from "@/lib/execution-state-store"
import { fetchExecutionLogs } from "@/lib/api/tasks"
import { fetchTaskRunState } from "@/lib/api/review"
import { describeApiError } from "@/lib/api/errors"
import {
  RunModel,
  decodeExecutionEvent,
  eventBelongsToTask,
  isLegacyProgressStatus,
  isRunStateWire,
  isTerminalPhase,
  type RunModelOptions,
  type RunSnapshot,
  type RunTaskSnapshot,
} from "@/lib/run-model"

/**
 * Binds the pure run model to the app: the execution store (logs and progress
 * the board already collected, plus history over HTTP), the live SSE events
 * with their ids (dedupe and ordering), stream connectivity and the persisted
 * task row. Snapshots are batched to one per animation frame.
 */
export interface UseRunModelOptions {
  taskId: string | null | undefined
  /** Persisted task row, when the surface has one. */
  task?: RunTaskSnapshot | null
  /** Progress handed down by the caller (the board's live progress for this task). */
  progress?: ExecutionProgress | null
  /** Explicit log list (drawer callers); otherwise the execution store is used. */
  logs?: readonly ExecutionLogEntry[] | null
  /** The caller just asked to execute (e.g. the board's starting state). */
  startRequested?: boolean
  modelOptions?: Omit<RunModelOptions, "taskId">
}

export interface RunModelState {
  snapshot: RunSnapshot
  /** History is being fetched and the timeline has nothing to show yet. */
  loading: boolean
  /** History couldn't be fetched (mapped, user-facing). */
  error: { message: string; hint?: string } | null
  retry: () => void
}

function scheduleFrame(callback: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback)
    return
  }
  setTimeout(callback, 16)
}

/** Fold only the entries appended since the last call (the store replaces its array on every change). */
function foldIncrementally(
  model: RunModel,
  taskId: string,
  entries: readonly ExecutionLogEntry[],
  cursor: { last: ExecutionLogEntry | null },
): boolean {
  if (entries.length === 0) return false
  let start = 0
  if (cursor.last) {
    const index = entries.lastIndexOf(cursor.last)
    start = index === -1 ? 0 : index + 1
  }
  if (start >= entries.length) return false
  cursor.last = entries[entries.length - 1] ?? null
  const slice = start === 0 ? entries : entries.slice(start)
  return model.apply({ kind: "history", taskId, entries: slice })
}

function taskHasRun(task: RunTaskSnapshot | null | undefined): boolean {
  if (!task) return true
  return task.status !== "todo" || Boolean(task.executionStartedAt || task.outcome || task.prUrl || task.executionElapsedMs > 0)
}

export function useRunModel({ taskId, task, progress, logs, startRequested, modelOptions }: UseRunModelOptions): RunModelState {
  const id = taskId ?? null
  // One model per task. `modelOptions` is read once on purpose: callers pass
  // it inline, and a new object each render must not reset the run.
  const optionsRef = useRef(modelOptions)
  const model = useMemo(() => new RunModel({ taskId: id, ...optionsRef.current }), [id])
  const [snapshot, setSnapshot] = useState<RunSnapshot>(() => model.getSnapshot())
  const frameRef = useRef(false)
  const modelRef = useRef(model)
  modelRef.current = model

  const flushNow = useCallback(() => {
    frameRef.current = false
    setSnapshot((previous) => {
      const next = modelRef.current.getSnapshot()
      return previous === next ? previous : next
    })
  }, [])

  const scheduleFlush = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = true
    scheduleFrame(flushNow)
  }, [flushNow])

  // A new task gets a fresh model; show its snapshot immediately.
  useLayoutEffect(() => {
    setSnapshot(model.getSnapshot())
  }, [model])

  // ── Persisted row ──────────────────────────────────────────────────────────
  const snapshotKey = task
    ? [task.id, task.status, task.outcome ?? "", task.prUrl ?? "", task.batchId ?? "", task.executionStartedAt ?? "", task.executionElapsedMs, task.model ?? ""].join("|")
    : null
  const taskRef = useRef(task)
  taskRef.current = task
  useLayoutEffect(() => {
    const current = taskRef.current
    if (!current || !snapshotKey) return
    if (model.apply({ kind: "snapshot", task: current })) flushNow()
  }, [model, snapshotKey, flushNow])

  // ── Logs: explicit list or the execution store ─────────────────────────────
  const storeLogs = useExecutionLogs(logs ? null : id)
  const sourceLogs = logs ?? storeLogs
  const cursorRef = useRef<{ model: RunModel | null; last: ExecutionLogEntry | null }>({ model: null, last: null })
  useLayoutEffect(() => {
    if (!id) return
    if (cursorRef.current.model !== model) cursorRef.current = { model, last: null }
    if (foldIncrementally(model, id, sourceLogs, cursorRef.current)) flushNow()
  }, [model, id, sourceLogs, flushNow])

  // ── Progress the board already has (seeds a drawer opened mid-run) ─────────
  const storeProgress = useExecutionProgress(id)
  const liveProgress = progress ?? storeProgress
  useLayoutEffect(() => {
    if (!id || !liveProgress || liveProgress.taskId !== id) return
    // The store can hold a journal payload mis-cast as legacy progress; only fold real statuses.
    if (!isLegacyProgressStatus(liveProgress.status)) return
    const v2 = typeof liveProgress.runId === "string" && typeof liveProgress.runSeq === "number"
    const changed = model.apply({
      kind: "progress",
      taskId: id,
      status: liveProgress.status,
      message: liveProgress.message ?? "",
      prUrl: liveProgress.prUrl ?? null,
      isCompareLink: Boolean(liveProgress.isCompareLink),
      // v2 beats keep their identity, so the live copy of the same beat never folds twice.
      ...(v2 ? { runId: liveProgress.runId, runSeq: liveProgress.runSeq, runState: isRunStateWire(liveProgress.runState) ? liveProgress.runState : null } : {}),
    })
    if (changed) flushNow()
  }, [model, id, liveProgress, flushNow])

  // ── Live events with ids (dedupe, ordering, journal) ───────────────────────
  const onEvent = useCallback((type: SSEEventType, data: SSEEventData, meta?: SSEEventMeta) => {
    if (!id || (type !== "execution:progress" && type !== "execution:log")) return
    const current = modelRef.current
    const decoded = decodeExecutionEvent(type, data, meta ?? null, Date.now())
    if (!decoded || !eventBelongsToTask(decoded, id, (runId) => current.knowsRun(runId))) return
    if (current.apply(decoded)) scheduleFlush()
  }, [id, scheduleFlush])
  useSSESubscription(onEvent)

  // ── Connectivity ───────────────────────────────────────────────────────────
  const { isConnected, isReconnecting } = useSSEStatus()
  const lost = !isConnected && isReconnecting
  useLayoutEffect(() => {
    if (model.apply({ kind: "stream", state: lost ? "lost" : "open" })) flushNow()
  }, [model, lost, flushNow])

  // ── Durable run state (v2): re-seed on mount and after every reconnect ─────
  // The journal is the authority: a reload mid-verification shows "Verifying",
  // not whatever the task row or the last log line suggests. Legacy-engine
  // tasks have no v2 run (404) and keep folding from events and history.
  const [resyncs, setResyncs] = useState(0)
  const wasLostRef = useRef(lost)
  useEffect(() => {
    if (wasLostRef.current && !lost) setResyncs((value) => value + 1)
    wasLostRef.current = lost
  }, [lost])
  const wantsRunState = Boolean(id) && taskHasRun(task)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `resyncs` is the reconnect trigger.
  useEffect(() => {
    if (!id || !wantsRunState) return
    let cancelled = false
    fetchTaskRunState(id)
      .then((response) => {
        const run = response?.run
        if (cancelled || !run || typeof run.runId !== "string" || !isRunStateWire(run.state)) return
        const applied = modelRef.current.apply({
          kind: "run-state",
          taskId: id,
          runId: run.runId,
          lastSeq: typeof run.lastSeq === "number" ? run.lastSeq : 1,
          state: run.state,
          runner: typeof run.runner === "string" ? run.runner : null,
          budgets: run.budgets ?? null,
        })
        if (applied) scheduleFlush()
      })
      .catch(() => {
        // No v2 run on this device (legacy engine, web without a sidecar): events and history suffice.
      })
    return () => {
      cancelled = true
    }
  }, [id, wantsRunState, resyncs, scheduleFlush])

  // ── Start requested (transitions only, never on mount) ─────────────────────
  const previousStartRef = useRef<boolean | undefined>(startRequested)
  useLayoutEffect(() => {
    const was = Boolean(previousStartRef.current)
    previousStartRef.current = startRequested
    const now = Boolean(startRequested)
    if (now === was) return
    if (now) {
      const phase = model.getSnapshot().phase
      if ((phase === "idle" || isTerminalPhase(phase)) && model.apply({ kind: "start-requested" })) flushNow()
      return
    }
    // The start ended without any report (e.g. rejected): drop the queued overlay.
    if (model.apply({ kind: "start-abandoned" })) flushNow()
  }, [model, startRequested, flushNow])

  // ── History over HTTP ──────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<RunModelState["error"]>(null)
  const [attempt, setAttempt] = useState(0)
  const shouldFetch = Boolean(id) && !logs && taskHasRun(task)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger; the task row is read through `shouldFetch`.
  useEffect(() => {
    setError(null)
    if (!id || !shouldFetch || hasExecutionLogs(id)) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    fetchExecutionLogs(id)
      .then((response) => {
        if (cancelled) return
        const entries = Array.isArray(response?.logs) ? response.logs : []
        if (entries.length > 0) {
          if (modelRef.current.apply({ kind: "history", taskId: id, entries })) scheduleFlush()
          // Share with other surfaces, but never clobber live lines that arrived meanwhile.
          if (!hasExecutionLogs(id)) replaceExecutionLogs(id, entries)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const described = describeApiError(err, "Couldn't load this run's activity.")
        setError({ message: described.message, ...(described.hint ? { hint: described.hint } : {}) })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, shouldFetch, attempt, scheduleFlush])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  return { snapshot, loading: loading && snapshot.entries.length === 0, error, retry }
}
