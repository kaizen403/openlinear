"use client"

import { useRef } from "react"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import type { ExecutionLogEntry, ExecutionProgress, Task } from "@/types/task"
import { RunView } from "@/components/execution/run-view"
import { timelineConsumesEscape } from "@/components/execution/run-timeline"
import { useRunModel } from "@/components/execution/use-run-model"
import { useStopControl } from "@/components/execution/use-stop-control"
import { isTerminalPhase, type RunTaskSnapshot } from "@/lib/run-model"

// The wire types live in types/task.ts; re-exported for existing importers.
export type { ExecutionLogEntry, ExecutionProgress } from "@/types/task"

type DrawerTask = Pick<Task, "id" | "title"> & Partial<Omit<Task, "id" | "title">>

interface ExecutionDrawerProps {
  task: DrawerTask | null
  /** Logs the caller already holds; when omitted the execution store (and history) is used. */
  logs?: ExecutionLogEntry[]
  progress?: ExecutionProgress
  open: boolean
  onClose: () => void
  /** Stop the run. Resolve `false` (or reject with the API error) when the stop wasn't confirmed. */
  onCancel?: (taskId: string) => unknown
  onCheckPullRequest?: (taskId: string) => Promise<void>
}

function asRunTask(task: DrawerTask | null): RunTaskSnapshot | null {
  if (!task?.status) return null
  return {
    id: task.id,
    status: task.status,
    outcome: task.outcome ?? null,
    prUrl: task.prUrl ?? null,
    batchId: task.batchId ?? null,
    executionStartedAt: task.executionStartedAt ?? null,
    executionElapsedMs: task.executionElapsedMs ?? 0,
    model: task.model ?? null,
  }
}

/**
 * Right-hand run drawer built on the agent-execution kit: a Radix sheet (focus
 * trap, focus restore, `aria-modal`, Escape) instead of the old hand-rolled
 * overlay, and the run view instead of a flat log dump.
 */
export function ExecutionDrawer({ task, logs, progress, open, onClose, onCancel, onCheckPullRequest }: ExecutionDrawerProps) {
  const run = useRunModel({ taskId: task?.id, task: asRunTask(task), progress: progress ?? null, logs: logs ?? null })
  const snapshotRef = useRef(run.snapshot)
  snapshotRef.current = run.snapshot
  const taskId = task?.id ?? null
  const stop = useStopControl({
    onStop: onCancel && taskId ? () => onCancel(taskId) : null,
    wasRunFinished: () => isTerminalPhase(snapshotRef.current.phase),
    resetKey: `${taskId ?? ""}:${run.snapshot.attempt}`,
  })

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 border-linear-border bg-linear-bg p-0 sm:w-[420px] sm:max-w-[420px]"
        onEscapeKeyDown={(event) => { if (timelineConsumesEscape(event)) event.preventDefault() }}
      >
        <div className="border-b border-linear-border px-4 py-3 pr-14">
          <SheetTitle className="truncate text-sm font-semibold text-linear-text">
            {task?.title || "Execution details"}
          </SheetTitle>
          <SheetDescription className="mt-1 text-xs text-linear-text-secondary">
            {task ? `Task ${task.identifier || task.id.slice(0, 8)}` : "Agent run"}
          </SheetDescription>
        </div>
        <RunView
          className="min-h-0 flex-1 p-4"
          snapshot={run.snapshot}
          loading={run.loading}
          error={run.error}
          onRetryLoad={run.retry}
          stop={stop.state}
          onStop={stop.request}
          canStop={stop.canStop}
          showOutcome
          onCheckPullRequest={onCheckPullRequest && taskId ? () => onCheckPullRequest(taskId) : undefined}
          timelineClassName="min-h-0 flex-1"
        />
      </SheetContent>
    </Sheet>
  )
}
