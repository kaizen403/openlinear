"use client"

import { useState, useEffect, memo } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Loader2, GitBranch, Code, GitPullRequest, Check, X, ExternalLink, Play, ArrowRight, Archive, Clock, CalendarDays } from "lucide-react"
import { cn, openExternal } from "@/lib/utils"
import { Task, ExecutionProgress, formatDuration } from "@/types/task"
import { STATUS_COLORS } from "@/lib/design-tokens"
import { useExecutionProgress } from "@/lib/execution-state-store"

interface TaskCardProps {
  task: Task
  onExecute?: (taskId: string) => void
  onCancel?: (taskId: string) => void
  onDelete?: (taskId: string) => void
  onMoveToInProgress?: (taskId: string) => void
  onTaskClick?: (taskId: string) => void
  executionProgress?: ExecutionProgress
  selected?: boolean
  onToggleSelect?: (taskId: string, modifiers?: { shift?: boolean; meta?: boolean }) => void
  selectionMode?: boolean
  isBatchTask?: boolean
  isCompletedBatchTask?: boolean
  isDragging?: boolean
}

function formatDueDate(dateStr: string): { text: string; isOverdue: boolean } {
  const due = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate())
  const diffMs = dueDay.getTime() - today.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 0) return { text: "Overdue", isOverdue: true }
  if (diffDays === 0) return { text: "Today", isOverdue: false }
  if (diffDays === 1) return { text: "Tomorrow", isOverdue: false }
  return { text: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), isOverdue: false }
}

const progressConfig = {
  cloning: { icon: GitBranch, label: 'Cloning', color: STATUS_COLORS.cloning.text },
  executing: { icon: Code, label: 'Executing', color: STATUS_COLORS.executing.text },
  committing: { icon: GitBranch, label: 'Committing', color: STATUS_COLORS.committing.text },
  creating_pr: { icon: GitPullRequest, label: 'Creating PR', color: STATUS_COLORS.creating_pr.text },
  done: { icon: Check, label: 'Done', color: STATUS_COLORS.done.text },
  cancelled: { icon: X, label: 'Cancelled', color: STATUS_COLORS.cancelled.text },
  error: { icon: X, label: 'Error', color: STATUS_COLORS.error.text },
}

/** Isolated live timer — only this tiny sub-tree re-renders every second */
const LiveDuration = memo(function LiveDuration({ startedAt }: { startedAt: string }) {
  const [ms, setMs] = useState(() => Date.now() - new Date(startedAt).getTime())
  useEffect(() => {
    const interval = setInterval(() => {
      setMs(Date.now() - new Date(startedAt).getTime())
    }, 1000)
    return () => clearInterval(interval)
  }, [startedAt])
  return <>{formatDuration(ms)}</>
})

function TaskCardComponent({ task, onExecute, onCancel, onDelete, onMoveToInProgress, onTaskClick, executionProgress, selected, onToggleSelect, selectionMode, isBatchTask, isCompletedBatchTask, isDragging }: TaskCardProps) {
  const [cancelling, setCancelling] = useState(false)
  const liveProgress = useExecutionProgress(task.id)
  const currentProgress = executionProgress ?? liveProgress

  useEffect(() => {
    if (task.status !== 'in_progress') {
      setCancelling(false)
    }
  }, [task.status])

  const handleExecute = () => {
    if (onExecute) {
      onExecute(task.id)
    }
  }

  const handleCancel = () => {
    if (onCancel) {
      setCancelling(true)
      onCancel(task.id)
    }
  }

  const handleDelete = () => {
    if (onDelete) {
      onDelete(task.id)
    }
  }

  const handleMoveToInProgress = () => {
    if (onMoveToInProgress) {
      onMoveToInProgress(task.id)
    }
  }

  const handleCardClick = (e: React.MouseEvent) => {
    if (onToggleSelect && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      onToggleSelect(task.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })
      return
    }
    if (selectionMode && !isBatchTask && onToggleSelect) {
      e.preventDefault()
      e.stopPropagation()
      onToggleSelect(task.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })
      return
    }
    if (onTaskClick) {
      onTaskClick(task.id)
    }
  }

  const cardProgress = currentProgress?.taskId === task.id ? currentProgress : undefined
  const isActiveProgress = cardProgress ? ['cloning', 'executing', 'committing', 'creating_pr'].includes(cardProgress.status) : false
  const prLink = !isActiveProgress ? (cardProgress?.prUrl || task.prUrl) : null

  return (
    <Card
      role={selectionMode ? 'checkbox' : undefined}
      aria-checked={selectionMode ? selected : undefined}
      aria-label={selectionMode ? `Select task ${task.title}` : undefined}
      className={cn(
        isDragging
          ? "bg-linear-bg-secondary border border-linear-border shadow-2xl"
          : "bg-linear-bg-secondary/50 backdrop-blur-md border border-linear-border shadow-card",
        "cursor-pointer group rounded-sm",
        selected && !isDragging && "bg-linear-bg-tertiary border-linear-border-hover ring-1 ring-linear-accent/40",
        isBatchTask && "border-linear-border",
        isCompletedBatchTask && ""
      )}
      onClick={handleCardClick}
    >
      <CardHeader className="p-3 pb-0">
        <div className="flex items-start gap-2">
          {selectionMode && !isBatchTask && (
            <div
              className={cn(
                "flex-shrink-0 mt-0.5",
                "opacity-100"
              )}
              onClick={(e) => { e.stopPropagation(); onToggleSelect?.(task.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }) }}
            >
              <div className={cn(
                "w-4 h-4 rounded border flex items-center justify-center cursor-pointer",
                selected 
                  ? "bg-linear-accent border-linear-accent" 
                  : "border-linear-border-hover hover:border-linear-accent/50 bg-linear-bg"
              )}>
                {selected && <Check className="w-3 h-3 text-white" />}
              </div>
            </div>
          )}
          <h4 className="text-sm font-light leading-tight line-clamp-2 flex-1">{task.title}</h4>
          {(isBatchTask || isActiveProgress) && (
            task.status === 'done' ? (
              <Check className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-linear-accent" />
            ) : (
              <Loader2 className={cn(
                "w-3 h-3 animate-spin flex-shrink-0 mt-0.5",
                isActiveProgress ? "text-linear-accent" : "text-linear-text-tertiary"
              )} />
            )
          )}
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-2">
        {task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {task.labels.map((label) => (
              <span
                key={label.id}
                className={cn(
                  "text-[11px] px-2 py-0.5 h-5 font-medium rounded-[4px] inline-flex items-center border border-linear-border",
                  !isDragging && "backdrop-blur-sm"
                )}
                style={{
                  backgroundColor: `${label.color}20`,
                  color: label.color
                }}
              >
                {label.name}
              </span>
            ))}
          </div>
        )}

        {cardProgress && (
          <div className="mb-3 p-2 bg-linear-bg-tertiary rounded-sm">
            <div className="flex items-center gap-2">
              {isActiveProgress ? (
                <Loader2 className={cn('w-3 h-3 animate-spin', progressConfig[cardProgress.status].color)} />
              ) : (
                (() => {
                  const Icon = progressConfig[cardProgress.status].icon
                  return <Icon className={cn('w-3 h-3', progressConfig[cardProgress.status].color)} />
                })()
              )}
              <span className="text-xs text-linear-text-secondary">
                {cardProgress.message || progressConfig[cardProgress.status].label}
              </span>
            </div>
            {prLink && (
              <button
                className="flex items-center gap-1 mt-2 text-xs text-linear-accent hover:underline"
                onClick={(e) => { e.stopPropagation(); openExternal(prLink) }}
              >
                <ExternalLink className="w-3 h-3" />
                View PR
              </button>
            )}
          </div>
        )}

        {!cardProgress && task.status === 'done' && task.prUrl && !isCompletedBatchTask && (
          <button
            className="flex items-center gap-1 mb-2 text-xs text-linear-accent hover:underline"
            onClick={(e) => { e.stopPropagation(); openExternal(task.prUrl!) }}
          >
            <GitPullRequest className="w-3 h-3" />
            View PR
          </button>
        )}
        
        <div className="flex items-center justify-between mt-1">
          <div className="flex items-center gap-2 min-w-0">
            {(task.assignee || task.creator) && (
              <Avatar className="h-4 w-4 rounded-full shrink-0" title={(task.assignee || task.creator)!.username}>
                <AvatarImage src={(task.assignee || task.creator)!.avatarUrl || undefined} alt={(task.assignee || task.creator)!.username} />
                <AvatarFallback className="text-[8px] h-4 w-4 bg-linear-bg-tertiary text-linear-text-tertiary border border-linear-border">
                  {(task.assignee || task.creator)!.username.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            )}
            <span className="text-[11px] text-linear-text-tertiary font-mono opacity-60">
              {task.identifier || (task.number ? `#${task.number}` : task.id.slice(0, 6))}
            </span>
            {task.dueDate && (() => {
              const { text, isOverdue } = formatDueDate(task.dueDate)
              return (
                <span className={cn(
                  "text-[11px] flex items-center gap-0.5 whitespace-nowrap",
                  isOverdue ? "text-red-400" : "text-linear-text-tertiary"
                )}>
                  <CalendarDays className="w-3 h-3 flex-shrink-0" />
                  {text}
                </span>
              )
            })()}
            {((task.status === 'in_progress' && task.executionStartedAt && !task.executionPausedAt) ||
              (task.status === 'in_progress' && task.executionPausedAt && (task.executionElapsedMs ?? 0) > 0) ||
              ((task.status === 'done' || task.status === 'cancelled') && (task.executionElapsedMs ?? 0) > 0)
            ) && (
              <span className="text-[11px] text-linear-text-tertiary flex items-center gap-1 whitespace-nowrap tabular-nums">
                <Clock className="w-3 h-3 flex-shrink-0" />
                {task.status === 'in_progress' && task.executionStartedAt && !task.executionPausedAt ? (
                  <LiveDuration startedAt={task.executionStartedAt} />
                ) : (
                  formatDuration(task.executionElapsedMs)
                )}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {task.status === 'todo' && onMoveToInProgress && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary"
                onClick={(e) => {
                  e.stopPropagation()
                  handleMoveToInProgress()
                }}
              >
                <ArrowRight className="w-3 h-3 mr-1" />
                Move
              </Button>
            )}
            {task.status === 'in_progress' && onExecute && !isActiveProgress && !isBatchTask && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 rounded-sm p-0 text-linear-accent bg-linear-accent/10 border border-linear-accent/30 hover:bg-linear-accent/20"
                onClick={(e) => {
                  e.stopPropagation()
                  handleExecute()
                }}
                aria-label="Execute task"
              >
                <Play className="w-3 h-3 fill-current" />
              </Button>
            )}
            {isActiveProgress && onCancel && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs text-red-400 hover:text-red-400 hover:bg-red-500/10"
                disabled={cancelling}
                onClick={(e) => {
                  e.stopPropagation()
                  handleCancel()
                }}
              >
                {cancelling ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                    Cancelling
                  </>
                ) : (
                  'Cancel'
                )}
              </Button>
            )}
            {onDelete && !isActiveProgress && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-linear-text-tertiary hover:text-linear-accent hover:bg-linear-accent/10"
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete()
                }}
                aria-label="Archive task"
              >
                <Archive className="w-3 h-3" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** Memoized wrapper — ignores function props because parent callbacks aren't stable references */
export const TaskCard = memo(TaskCardComponent, (prev, next) => {
  return (
    prev.task === next.task &&
    prev.executionProgress === next.executionProgress &&
    prev.selected === next.selected &&
    prev.selectionMode === next.selectionMode &&
    prev.isDragging === next.isDragging &&
    prev.isBatchTask === next.isBatchTask &&
    prev.isCompletedBatchTask === next.isCompletedBatchTask
  )
})
