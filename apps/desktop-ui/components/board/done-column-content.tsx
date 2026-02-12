"use client"

import type { ReactNode } from "react"
import { Draggable } from "@hello-pangea/dnd"
import { Check, ExternalLink, GitPullRequest, GripVertical } from "lucide-react"
import { TaskCard } from "./task-card"
import { openExternal } from "@/lib/utils"
import { ExecutionProgress, Task } from "@/types/task"

interface DoneColumnContentProps {
  columnTasks: Task[]
  completedBatch: { taskIds: string[]; prUrl: string | null; mode: string } | null
  executionProgress: Record<string, ExecutionProgress>
  selectedTaskIds: Set<string>
  onDelete: (taskId: string) => Promise<void>
  onTaskClick: (taskId: string) => Promise<void>
  onToggleSelect: (taskId: string) => void
  renderTask: (task: Task, index: number, completedBatch?: boolean) => ReactNode
}

export function DoneColumnContent({
  columnTasks,
  completedBatch,
  executionProgress,
  selectedTaskIds,
  onDelete,
  onTaskClick,
  onToggleSelect,
  renderTask,
}: DoneColumnContentProps) {
  const batchGroups = new Map<string, Task[]>()
  const orderedItems: Array<
    { type: 'group'; batchId: string; tasks: Task[] }
    | { type: 'task'; task: Task }
  > = []

  for (const t of columnTasks) {
    if (t.batchId) {
      if (!batchGroups.has(t.batchId)) {
        const group: Task[] = []
        batchGroups.set(t.batchId, group)
        orderedItems.push({ type: 'group', batchId: t.batchId, tasks: group })
      }
      batchGroups.get(t.batchId)!.push(t)
    } else {
      orderedItems.push({ type: 'task', task: t })
    }
  }

  if (batchGroups.size > 0) {
    return (
      <>
        {orderedItems.map((item, index) => {
          if (item.type === 'task') {
            return renderTask(item.task, index)
          }

          const batchTasks = item.tasks
          const groupPrUrl = batchTasks.find(t => t.prUrl)?.prUrl || null
          const groupMode = completedBatch?.taskIds.some(id => batchTasks.some(t => t.id === id))
            ? completedBatch.mode
            : null

          return (
            <Draggable key={`batch-group-${item.batchId}`} draggableId={`batch-group-${item.batchId}`} index={index}>
              {(provided, snapshot) => (
                <div
                  ref={provided.innerRef}
                  {...provided.draggableProps}
                  className={`border border-dashed border-purple-500/20 rounded-lg p-2 space-y-3 mb-3 hover:border-purple-500/40 transition-all duration-200 ${snapshot.isDragging ? 'shadow-2xl shadow-black/50 ring-1 ring-purple-500/20 scale-[1.02] rotate-1' : ''}`}
                >
                  <div className="flex items-center justify-between gap-3 px-1" {...provided.dragHandleProps}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <GripVertical className="w-3 h-3 text-purple-400/60 cursor-grab active:cursor-grabbing flex-shrink-0" />
                      <Check className="w-3 h-3 text-purple-400 flex-shrink-0" />
                      <span className="text-[11px] text-purple-400/80 font-medium uppercase tracking-wider truncate">
                        {groupMode === 'queue' ? 'Queue' : 'Parallel'} Issues
                      </span>
                    </div>
                    {groupPrUrl && (
                      <button
                        onClick={() => openExternal(groupPrUrl)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/30 hover:border-purple-500/50 text-[11px] text-purple-300 font-medium transition-all duration-200 flex-shrink-0"
                      >
                        <GitPullRequest className="w-3 h-3" />
                        Open PR
                        <ExternalLink className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                  {batchTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onMoveToInProgress={undefined}
                      onExecute={undefined}
                      onCancel={undefined}
                      onDelete={onDelete}
                      onTaskClick={onTaskClick}
                      executionProgress={executionProgress[task.id]}
                      selected={selectedTaskIds.has(task.id)}
                      onToggleSelect={onToggleSelect}
                      selectionMode={false}
                      isBatchTask={false}
                      isCompletedBatchTask={true}
                      isDragging={false}
                    />
                  ))}
                </div>
              )}
            </Draggable>
          )
        })}
      </>
    )
  }

  return columnTasks.map((task, index) => renderTask(task, index))
}
