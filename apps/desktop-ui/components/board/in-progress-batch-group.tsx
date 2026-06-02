"use client"

import { Draggable } from "@hello-pangea/dnd"
import { Check, Clock, GripVertical, Loader2 } from "lucide-react"
import { TaskCard } from "./task-card"
import { ActiveBatch } from "./use-kanban-board"
import { formatBatchExecutionMode } from "./batch-mode"
import { Task } from "@/types/task"
import { cn } from "@/lib/utils"

interface InProgressBatchGroupProps {
  batch: Task[]
  activeBatch: ActiveBatch
  canExecute: boolean
  selectedTaskIds: Set<string>
  onExecute?: (taskId: string) => Promise<void>
  onCancel: (taskId: string) => Promise<void>
  onDelete: (taskId: string) => Promise<void>
  deletionMode?: "archive" | "delete"
  onTaskClick: (taskId: string) => Promise<void>
  onToggleSelect: (taskId: string) => void
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
  const orderedBatch = [...batch].sort((a, b) => {
    const left = batchMeta.get(a.id)?.index ?? Number.MAX_SAFE_INTEGER
    const right = batchMeta.get(b.id)?.index ?? Number.MAX_SAFE_INTEGER
    return left - right
  })
  const running = activeBatch.tasks.filter(task => task.status === 'running').length
  const completed = activeBatch.tasks.filter(task => task.status === 'completed').length
  const currentQueueIndex = activeBatch.tasks.findIndex(task => task.status === 'running')
  const subtitle =
    activeBatch.mode === 'parallel'
      ? `${running} running in parallel`
      : activeBatch.mode === 'queue'
        ? currentQueueIndex >= 0
          ? `Working on step ${currentQueueIndex + 1} of ${activeBatch.tasks.length}`
          : `Waiting to start step ${Math.min(completed + 1, activeBatch.tasks.length)} of ${activeBatch.tasks.length}`
        : `One shared agent session for ${activeBatch.tasks.length} issues`

  return (
    <Draggable draggableId={`batch-group-${activeBatch.id}`} index={0}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className={cn(
            "border border-[#252525] rounded-sm p-3 mb-3 bg-[#141414]",
            snapshot.isDragging && "shadow-2xl shadow-black/50 ring-1 ring-[#333] scale-[1.02] rotate-1"
          )}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-1 mb-3" {...provided.dragHandleProps}>
            <GripVertical className="w-3 h-3 text-linear-text-tertiary/40 cursor-grab active:cursor-grabbing" />
            <Loader2 className="w-3 h-3 animate-spin text-linear-text-tertiary" />
            <div className="min-w-0">
              <div className="text-[11px] text-linear-text-tertiary font-medium uppercase tracking-wider">
                {formatBatchExecutionMode(activeBatch.mode)}
              </div>
              <div className="text-[11px] text-linear-text-tertiary/70 truncate">
                {subtitle}
              </div>
            </div>
          </div>

          {/* Lane rows */}
          <div className="space-y-0">
            {orderedBatch.map((task, i) => {
              const meta = batchMeta.get(task.id)
              const status = meta?.status ?? 'queued'
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
                      <div className="absolute top-7 left-1/2 -translate-x-1/2 w-px h-[calc(100%+12px)] bg-[#2a2a2a]" />
                    )}

                    <div className="text-[9px] uppercase tracking-wider text-linear-text-tertiary/60 text-center leading-tight">
                      {stepLabel}
                    </div>

                    {/* Status pill */}
                    <div className={cn(
                      "mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium border",
                      status === 'running' && "text-emerald-400 border-emerald-500/20 bg-emerald-500/10",
                      status === 'completed' && "text-green-400 border-green-500/20 bg-green-500/10",
                      status === 'failed' && "text-red-400 border-red-500/20 bg-red-500/10",
                      status === 'queued' && "text-linear-text-tertiary/60 border-[#2a2a2a] bg-[#1a1a1a]",
                      status === 'skipped' && "text-amber-400 border-amber-500/20 bg-amber-500/10",
                      status === 'cancelled' && "text-linear-text-tertiary/60 border-[#2a2a2a] bg-[#1a1a1a]",
                    )}>
                      {status === 'running' ? (
                        <Loader2 className="w-2 h-2 animate-spin" />
                      ) : status === 'completed' ? (
                        <Check className="w-2 h-2" />
                      ) : (
                        <Clock className="w-2 h-2" />
                      )}
                      {status === 'running' ? 'Running'
                        : status === 'completed' ? 'Done'
                        : status === 'failed' ? 'Failed'
                        : status === 'skipped' ? 'Skipped'
                        : status === 'cancelled' ? 'Cancelled'
                        : 'Queued'}
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
                      suppressExecutionProgress={activeBatch.mode === 'combined' || (activeBatch.mode === 'queue' && status !== 'running')}
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
