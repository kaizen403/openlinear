"use client"

import { Draggable } from "@hello-pangea/dnd"
import { Loader2, GripVertical } from "lucide-react"
import { TaskCard } from "./task-card"
import { ActiveBatch } from "./use-kanban-board"
import { formatBatchMode } from "./batch-mode"
import { Task } from "@/types/task"

interface InProgressBatchGroupProps {
  batch: Task[]
  activeBatch: ActiveBatch
  canExecute: boolean
  selectedTaskIds: Set<string>
  onExecute?: (taskId: string) => Promise<void>
  onCancel: (taskId: string) => Promise<void>
  onDelete: (taskId: string) => Promise<void>
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
  onTaskClick,
  onToggleSelect,
}: InProgressBatchGroupProps) {
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
            <span className="text-[11px] text-linear-text-tertiary font-medium uppercase tracking-wider">
              {formatBatchMode(activeBatch.mode)} Issues
            </span>
          </div>
          <div className="space-y-0">
            {batch.map((task, i) => (
              <div key={`batch-connector-${task.id}`}>
                {i > 0 && (
                  <div className="flex justify-center">
                    <div className="w-px h-2 bg-linear-border" />
                  </div>
                )}
                <TaskCard
                  task={task}
                  onMoveToInProgress={undefined}
                  onExecute={canExecute ? onExecute : undefined}
                  onCancel={onCancel}
                  onDelete={onDelete}
                  onTaskClick={onTaskClick}
                  selected={selectedTaskIds.has(task.id)}
                  onToggleSelect={onToggleSelect}
                  selectionMode={false}
                  isBatchTask={true}
                  isCompletedBatchTask={false}
                  isDragging={false}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </Draggable>
  )
}
