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
          className={`border border-dashed border-linear-border rounded-sm p-2 mb-3 bg-linear-bg-secondary/50 ${snapshot.isDragging ? 'shadow-2xl shadow-black/50 ring-1 ring-linear-border scale-[1.02] rotate-1' : ''}`}
        >
          <div className="flex items-center gap-1.5 px-1 mb-1.5" {...provided.dragHandleProps}>
            <GripVertical className="w-3 h-3 text-linear-text-tertiary/60 cursor-grab active:cursor-grabbing" />
            <Loader2 className="w-3 h-3 animate-spin text-linear-text-tertiary" />
            <div className="min-w-0">
              <div className="text-[11px] text-linear-text-tertiary font-medium uppercase tracking-wider">
                {formatBatchExecutionMode(activeBatch.mode)}
              </div>
              <div className="text-[11px] text-linear-text-tertiary truncate">
                {subtitle}
              </div>
            </div>
          </div>
          <div className="space-y-2">
            {orderedBatch.map((task, i) => {
              const meta = batchMeta.get(task.id)
              const status = meta?.status ?? 'queued'
              const stepLabel =
                activeBatch.mode === 'queue'
                  ? `Step ${(meta?.index ?? i) + 1}`
                  : activeBatch.mode === 'parallel'
                    ? `Lane ${(meta?.index ?? i) + 1}`
                    : `Issue ${(meta?.index ?? i) + 1}`
              const statusLabel = status === 'running'
                ? 'Running'
                : status === 'completed'
                  ? 'Done'
                  : status === 'failed'
                    ? 'Failed'
                    : status === 'cancelled'
                      ? 'Cancelled'
                      : status === 'skipped'
                        ? 'Skipped'
                        : 'Queued'
              return (
              <div key={`batch-connector-${task.id}`} className="grid grid-cols-[52px_minmax(0,1fr)] gap-2">
                {i > 0 && (
                  <div className="col-span-2 flex justify-center">
                    <div className="w-px h-2 bg-linear-border" />
                  </div>
                )}
                <div className="pt-3 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-linear-text-tertiary">
                    {stepLabel}
                  </div>
                  <div className={cn(
                    "mt-1 inline-flex items-center gap-1 rounded-sm border border-linear-border px-1.5 py-0.5 text-[10px]",
                    status === 'running' && "text-linear-accent",
                    status === 'completed' && "text-green-400",
                    status === 'failed' && "text-red-400",
                    status === 'queued' && "text-linear-text-tertiary",
                  )}>
                    {status === 'running' ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    ) : status === 'completed' ? (
                      <Check className="w-2.5 h-2.5" />
                    ) : (
                      <Clock className="w-2.5 h-2.5" />
                    )}
                    {statusLabel}
                  </div>
                </div>
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
              )
            })}
          </div>
        </div>
      )}
    </Draggable>
  )
}
