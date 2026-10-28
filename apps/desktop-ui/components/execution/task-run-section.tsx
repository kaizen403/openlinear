"use client"

import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react"
import type { ExecutionProgress } from "@/types/task"
import type { TaskRunState } from "@/lib/api/review"
import type { RunPhase, RunRecoveryReason, RunSnapshot, RunTaskSnapshot } from "@/lib/run-model"
import { RunView } from "./run-view"
import { useRunModel } from "./use-run-model"
import { useTaskRunState } from "@/components/review/use-review-data"
import { isTerminalPhase } from "@/lib/run-model"
import type { StopState } from "./use-stop-control"

/** The few run facts the surrounding page needs; changes rarely compared to the timeline. */
export interface RunSummary {
  phase: RunPhase
  recovery: RunRecoveryReason | null
  attempt: number
  /** Last thing the agent said (the task's "Conclusion"). */
  conclusion: string | null
}

export const EMPTY_RUN_SUMMARY: RunSummary = { phase: "idle", recovery: null, attempt: 0, conclusion: null }

function lastAssistantText(snapshot: RunSnapshot): string | null {
  const entries = snapshot.entries
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.kind === "assistant" && entry.text.trim()) return entry.text
  }
  return null
}

function isInterrupted(state: string): boolean {
  return state === "recovery_required" || state === "abandoned"
}

/**
 * W12: "Continue where it stopped" resumes this device's latest run of the
 * task (the sidecar journal's, `GET /api/tasks/:id/run`). It is offered only
 * when that run is the one on screen — not a teammate's run or one from
 * another device that arrived through live updates — was interrupted, and
 * still has its worktree. Returns the run id to continue, else null.
 */
export function continuableRunId(onScreen: Pick<RunSnapshot, "phase" | "runId">, localRun: TaskRunState | null | undefined): string | null {
  if (!localRun || !onScreen.runId || localRun.runId !== onScreen.runId) return null
  if (!isInterrupted(onScreen.phase) || !isInterrupted(localRun.state)) return null
  return localRun.workspaceExpired ? null : localRun.runId
}

interface TaskRunSectionProps {
  task: RunTaskSnapshot
  progress: ExecutionProgress | null
  startRequested: boolean
  stop: StopState
  onSummaryChange: (summary: RunSummary) => void
  timelineClassName?: string
  onInspectWork?: () => void
  onRunAgain?: () => void
  /** W12: continue the interrupted run with this id (only ever this device's run on screen). */
  onContinue?: (runId: string) => void
  continuing?: boolean
}

/**
 * Owns the run model for a task detail page. The timeline re-renders every
 * frame while a run streams; isolating it here keeps the rest of the page
 * (description markdown, comments, properties) from re-rendering with it.
 * Only the coarse {@link RunSummary} is reported upward, when it changes.
 */
export const TaskRunSection = memo(function TaskRunSection({ task, progress, startRequested, stop, onSummaryChange, timelineClassName, onInspectWork, onRunAgain, onContinue, continuing }: TaskRunSectionProps) {
  const run = useRunModel({ taskId: task.id, task, progress, startRequested })
  const { snapshot } = run
  // W15: phase timings of a finished run (local sidecar; absent elsewhere).
  const finished = isTerminalPhase(snapshot.phase)
  const runState = useTaskRunState(task.id, false, finished)
  const conclusion = lastAssistantText(snapshot)
  const localRun = finished ? runState.data : undefined
  const continueRunId = continuableRunId(snapshot, localRun)
  // Phase timings and the knowledge note describe this device's run: only when it is the run on screen.
  const onScreenLocalRun = localRun && (!snapshot.runId || localRun.runId === snapshot.runId) ? localRun : null
  const continueOnScreenRun = useCallback(() => {
    if (continueRunId) onContinue?.(continueRunId)
  }, [continueRunId, onContinue])
  // The cached local run can predate the interrupted run on screen: re-read it once per run before ruling Continue out.
  const { refetch: refetchRunState, isFetching: runStateFetching } = runState
  const recheckedRunRef = useRef<string | null>(null)
  useEffect(() => {
    const onScreen = snapshot.runId
    if (!onScreen || !isInterrupted(snapshot.phase) || localRun === undefined || runStateFetching) return
    if (localRun?.runId === onScreen || recheckedRunRef.current === onScreen) return
    recheckedRunRef.current = onScreen
    void refetchRunState()
  }, [snapshot.runId, snapshot.phase, localRun, runStateFetching, refetchRunState])

  // Layout effect: the page's phase pill and stop control update in the same paint.
  useLayoutEffect(() => {
    onSummaryChange({ phase: snapshot.phase, recovery: snapshot.recovery, attempt: snapshot.attempt, conclusion })
  }, [snapshot.phase, snapshot.recovery, snapshot.attempt, conclusion, onSummaryChange])

  return (
    <RunView
      snapshot={snapshot}
      loading={run.loading}
      error={run.error}
      onRetryLoad={run.retry}
      stop={stop}
      timelineClassName={timelineClassName}
      onInspectWork={onInspectWork}
      onRunAgain={onRunAgain}
      // Only this device's interrupted run on screen, with its worktree kept (see continuableRunId).
      onContinue={onContinue && continueRunId ? continueOnScreenRun : undefined}
      continuing={continuing}
      phases={onScreenLocalRun?.phases ?? null}
      knowledge={onScreenLocalRun?.knowledge ?? []}
    />
  )
})
