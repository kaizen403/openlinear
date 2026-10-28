"use client"

import { Draggable } from "@hello-pangea/dnd"
import { AlertCircle, Ban, Check, Clock, GitCommit, Loader2, SkipForward } from "lucide-react"
import { TaskCard } from "./task-card"
import { ActiveBatch } from "./use-kanban-board"
import { formatBatchExecutionMode } from "./batch-mode"
import { BATCH_MEMBER_PHASE_LABEL, deriveBatchMemberPhase, type BatchMemberPhase } from "./execution-outcome"
import { Task } from "@/types/task"
import { cn } from "@/lib/utils"

interface InProgressBatchGroupProps {
  batch: Task[]
  activeBatch: ActiveBatch
  canExecute: boolean
  selectedTaskIds: ReadonlySet<string>
  onExecute?: (taskId: string) => void
  /** May resolve false when the stop wasn't accepted. */
  onCancel: (taskId: string) => unknown
  onDelete: (taskId: string) => void
  deletionMode?: "archive" | "delete"
  onTaskClick: (taskId: string) => void
  onToggleSelect: (taskId: string) => void
}

const PHASE_PILL: Record<BatchMemberPhase, { className: string; icon: typeof Check; spin?: boolean }> = {
  queued: { className: "text-linear-text-tertiary border-linear-border bg-surface-hover", icon: Clock },
  running: { className: "text-run-active border-run-active/20 bg-run-active/10", icon: Loader2, spin: true },
  ready_to_publish: { className: "text-run-info border-run-info/20 bg-run-info/10", icon: GitCommit },
  publishing: { className: "text-run-info border-run-info/20 bg-run-info/10", icon: Loader2, spin: true },
  published: { className: "text-run-success border-run-success/20 bg-run-success/10", icon: Check },
  not_published: { className: "text-run-warning border-run-warning/20 bg-run-warning/10", icon: AlertCircle },
  failed: { className: "text-run-danger border-run-danger/20 bg-run-danger/10", icon: AlertCircle },
  skipped: { className: "text-run-warning border-run-warning/20 bg-run-warning/10", icon: SkipForward },
  cancelled: { className: "text-linear-text-tertiary border-linear-border bg-surface-hover", icon: Ban },
}

export function InProgressBatchGroup({
  batch,
  activeBatch,
  canExecute,
  selectedTaskIds,
  onExecute,
  onCancel,
  onDelete,
  deletionMode,
  onTaskClick,
  onToggleSelect,
}: InProgressBatchGroupProps) {
  const batchMeta = new Map(activeBatch.tasks.map((task, index) => [task.taskId, { ...task, index }]))
  const taskById = new Map(batch.map((task) => [task.id, task]))
  const orderedBatch = [...batch].sort((a, b) => {
    const left = batchMeta.get(a.id)?.index ?? Number.MAX_SAFE_INTEGER
    const right = batchMeta.get(b.id)?.index ?? Number.MAX_SAFE_INTEGER
    return left - right
  })
  const phaseOf = (member: ActiveBatch['tasks'][number]) =>
    deriveBatchMemberPhase(member, activeBatch.status, taskById.get(member.taskId))
  const running = activeBatch.tasks.filter(task => phaseOf(task) === 'running').length
  const ready = activeBatch.tasks.filter(task => {
    const phase = phaseOf(task)
    return phase === 'ready_to_publish' || phase === 'publishing'
  }).length
  const currentQueueIndex = activeBatch.tasks.findIndex(task => task.status === 'running')
  const subtitle =
    activeBatch.status === 'merging'
      ? `Publishing ${ready} committed issue${ready === 1 ? '' : 's'}`
      : activeBatch.mode === 'parallel'
        ? `${running} running in parallel${ready > 0 ? ` · ${ready} ready to publish` : ''}`
        : activeBatch.mode === 'queue'
          ? currentQueueIndex >= 0
            ? `Working on step ${currentQueueIndex + 1} of ${activeBatch.tasks.length}`
            : `Waiting to start step ${Math.min(ready + 1, activeBatch.tasks.length)} of ${activeBatch.tasks.length}`
          : `One shared agent session for ${activeBatch.tasks.length} issues`

  return (
    // A running batch owns its members: moving them by drag would change task
    // rows under the batch (W01 fences publication on that status), so the
    // group keeps its slot in the list but can't be dragged. Cancel instead.
    <Draggable draggableId={`batch-group-${activeBatch.id}`} index={0} isDragDisabled>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className="border border-linear-border rounded-sm p-3 mb-3 bg-linear-bg-secondary"
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-1 mb-3">
            <Loader2 className="w-3 h-3 animate-spin text-linear-text-tertiary" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[11px] text-linear-text-tertiary font-medium uppercase tracking-wider">
                {formatBatchExecutionMode(activeBatch.mode)}
              </div>
              <div className="text-[11px] text-linear-text-tertiary truncate">
                {subtitle}
              </div>
            </div>
          </div>

          {/* Lane rows */}
          <div className="space-y-0">
            {orderedBatch.map((task, i) => {
              const meta = batchMeta.get(task.id)
              const phase: BatchMemberPhase = meta ? phaseOf(meta) : 'queued'
              const pill = PHASE_PILL[phase]
              const PillIcon = pill.icon
              const stepLabel =
                activeBatch.mode === 'queue'
                  ? `Step ${(meta?.index ?? i) + 1}`
                  : activeBatch.mode === 'parallel'
                    ? `Lane ${(meta?.index ?? i) + 1}`
                    : `Issue ${(meta?.index ?? i) + 1}`

              const isLast = i === orderedBatch.length - 1

              return (
                <div key={`batch-connector-${task.id}`} className="flex gap-3">
                  {/* Left rail */}
                  <div className="w-16 shrink-0 flex flex-col items-center pt-2 relative">
                    {/* Connector line */}
                    {!isLast && (
                      <div className="absolute top-7 left-1/2 -translate-x-1/2 w-px h-[calc(100%+12px)] bg-linear-border" />
                    )}

                    <div className="text-[9px] uppercase tracking-wider text-linear-text-tertiary text-center leading-tight">
                      {stepLabel}
                    </div>

                    {/* Status pill */}
                    <div className={cn(
                      "mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium border text-center",
                      pill.className,
                    )}>
                      <PillIcon className={cn("w-2 h-2 flex-shrink-0", pill.spin && "animate-spin")} aria-hidden="true" />
                      {BATCH_MEMBER_PHASE_LABEL[phase]}
                    </div>
                  </div>

                  {/* Card */}
                  <div className="flex-1 min-w-0 pb-3">
                    <TaskCard
                      task={task}
                      onMoveToInProgress={undefined}
                      onExecute={canExecute ? onExecute : undefined}
                      onCancel={onCancel}
                      onDelete={onDelete}
                      deletionMode={deletionMode}
                      onTaskClick={onTaskClick}
                      selected={selectedTaskIds.has(task.id)}
                      onToggleSelect={onToggleSelect}
                      selectionMode={false}
                      isBatchTask={true}
                      isCompletedBatchTask={false}
                      isDragging={false}
                      suppressExecutionProgress={activeBatch.mode === 'combined' || (activeBatch.mode === 'queue' && phase !== 'running')}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Draggable>
  )
}
