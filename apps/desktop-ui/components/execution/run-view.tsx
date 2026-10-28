"use client"

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { ExecutionOutcomePanel } from "@/components/board/execution-outcome-panel"
import { isLivePhase, isTerminalPhase, type RunSnapshot } from "@/lib/run-model"
import { FileChangesList } from "./file-changes-list"
import { RunHeader } from "./run-header"
import { StopButton, StopStatus } from "./run-controls"
import { RunEmptyState, RunErrorState, RunLoadingState, RunRecoveryActions, RunRecoveryBanner } from "./run-states"
import { RunTimeline } from "./run-timeline"
import type { StopState } from "./use-stop-control"
import { RunKnowledgeNote, RunPhaseBreakdown } from "./run-phases"
import type { RunPhaseTimings } from "@/lib/api/review"

export interface RunViewProps {
  snapshot: RunSnapshot
  loading?: boolean
  error?: { message: string; hint?: string } | null
  onRetryLoad?: () => void
  stop?: StopState
  onStop?: () => void
  canStop?: boolean
  /** Show the run's publication outcome (the drawer; the detail view has its own panel). */
  showOutcome?: boolean
  onCheckPullRequest?: () => Promise<void>
  /** Classes for the timeline box (give it a height). */
  timelineClassName?: string
  className?: string
  /** Rendered between the header and the timeline. */
  children?: ReactNode
  /** FE-06 recovery: open the retained work (the Review tab). */
  onInspectWork?: () => void
  /** FE-06 recovery: start a new attempt (prior evidence stays above a divider). */
  onRunAgain?: () => void
  /** W12 recovery: continue the agent's saved session in the kept worktree. */
  onContinue?: () => void
  continuing?: boolean
  /** W15: where a finished run spent its time (null = unknown or still running). */
  phases?: RunPhaseTimings | null
  /** W19b: the project knowledge revisions the run was given. */
  knowledge?: ReadonlyArray<{ id: string; version: number; title: string }>
}

/**
 * The agent-run surface: header (phase, runner/model, elapsed, cost), stop
 * control with its real outcome, recovery banner, the virtualized timeline,
 * and the files the run touched. Used by the task detail view and the
 * execution drawer.
 */
export function RunView({
  snapshot,
  loading = false,
  error = null,
  onRetryLoad,
  stop,
  onStop,
  canStop = false,
  showOutcome = false,
  onCheckPullRequest,
  timelineClassName,
  className,
  children,
  onInspectWork,
  onRunAgain,
  onContinue,
  continuing = false,
  phases = null,
  knowledge = [],
}: RunViewProps) {
  const live = isLivePhase(snapshot.phase)
  const outcome = snapshot.outcome
  const showOutcomePanel = showOutcome && outcome && isTerminalPhase(snapshot.phase) && outcome.kind !== "none"
  const stopState: StopState = stop ?? { status: "idle", message: null, hint: null }

  return (
    <section aria-label="Agent run" className={cn("flex min-h-0 flex-col gap-3", className)}>
      {snapshot.hasActivity && (
        <RunHeader
          snapshot={snapshot}
          stop={stopState}
          actions={onStop ? <StopButton phase={snapshot.phase} phaseSource={snapshot.phaseSource} stop={stopState} onRequest={onStop} canStop={canStop} /> : undefined}
        />
      )}
      {stop && <StopStatus stop={stopState} />}
      {snapshot.phase === "unknown" && snapshot.recovery && <RunRecoveryBanner reason={snapshot.recovery} />}
      {(snapshot.phase === "recovery_required" || snapshot.phase === "abandoned") && (
        <RunRecoveryActions phase={snapshot.phase} onInspect={onInspectWork} onContinue={onContinue} continuing={continuing} onRunAgain={onRunAgain} />
      )}
      {showOutcomePanel && outcome && <ExecutionOutcomePanel outcome={outcome} onCheckPullRequest={onCheckPullRequest} />}
      {phases && !phases.live && <RunPhaseBreakdown phases={phases} />}
      <RunKnowledgeNote entries={knowledge} />
      {error && <RunErrorState message={error.message} hint={error.hint} onRetry={onRetryLoad} />}
      {children}
      <RunTimeline
        entries={snapshot.entries}
        droppedEntries={snapshot.droppedEntries}
        live={live}
        className={timelineClassName}
        empty={loading ? <RunLoadingState /> : error ? null : <RunEmptyState />}
      />
      {snapshot.hasActivity && (snapshot.files.length > 0 || snapshot.filesOverflow > 0 || isTerminalPhase(snapshot.phase)) && (
        <FileChangesList
          files={snapshot.files}
          overflow={snapshot.filesOverflow}
          emptyText={isTerminalPhase(snapshot.phase) ? "This run reported no file changes." : undefined}
        />
      )}
    </section>
  )
}
