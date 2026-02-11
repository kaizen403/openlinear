"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2, GitBranch, Code, GitPullRequest, Check, X, ExternalLink, Play, ArrowRight, Archive, Clock } from "lucide-react"
import { cn, openExternal } from "@/lib/utils"
import { Task, ExecutionProgress, formatDuration } from "@/types/task"

interface TaskCardProps {
  task: Task
  onExecute?: (taskId: string) => void
  onCancel?: (taskId: string) => void
  onDelete?: (taskId: string) => void
  onMoveToInProgress?: (taskId: string) => void
  onTaskClick?: (taskId: string) => void
  executionProgress?: ExecutionProgress
  selected?: boolean
  onToggleSelect?: (taskId: string) => void
  selectionMode?: boolean
  isBatchTask?: boolean
  isCompletedBatchTask?: boolean
  isDragging?: boolean
}

const priorityColors = {
  low: "bg-emerald-700",
  medium: "bg-yellow-700",
  high: "bg-red-700",
}

const progressConfig = {
  cloning: { icon: GitBranch, label: 'Cloning', color: 'text-blue-400' },
  executing: { icon: Code, label: 'Executing', color: 'text-linear-accent' },
  committing: { icon: GitBranch, label: 'Committing', color: 'text-yellow-400' },
  creating_pr: { icon: GitPullRequest, label: 'Creating PR', color: 'text-purple-400' },
  done: { icon: Check, label: 'Done', color: 'text-green-400' },
  cancelled: { icon: X, label: 'Cancelled', color: 'text-gray-400' },
  error: { icon: X, label: 'Error', color: 'text-red-400' },
}

export function TaskCard({ task, onExecute, onCancel, onDelete, onMoveToInProgress, onTaskClick, executionProgress, selected, onToggleSelect, selectionMode, isBatchTask, isCompletedBatchTask, isDragging }: TaskCardProps) {
  const [liveElapsedMs, setLiveElapsedMs] = useState<number>(0)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    if (task.status === 'in_progress' && task.executionStartedAt && !task.executionPausedAt) {
      const updateElapsed = () => {
        const started = new Date(task.executionStartedAt!).getTime()
        const elapsed = Date.now() - started
        setLiveElapsedMs(elapsed)
      }

      updateElapsed()
      const interval = setInterval(updateElapsed, 1000)
      return () => clearInterval(interval)
    }
  }, [task.status, task.executionStartedAt, task.executionPausedAt])

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

  const handleCardClick = () => {
    if (onTaskClick) {
      onTaskClick(task.id)
    }
  }

  const showProgress = executionProgress && executionProgress.taskId === task.id
  const isActiveProgress = showProgress && ['cloning', 'executing', 'committing', 'creating_pr'].includes(executionProgress.status)
  const prLink = !isActiveProgress ? (executionProgress?.prUrl || task.prUrl) : null

  return (
    <div>
    <Card 
      className={cn(
        isDragging
          ? "bg-[#1a1a1a] border border-white/[0.12] shadow-2xl"
          : "bg-white/[0.03] backdrop-blur-md border border-white/[0.08] shadow-[0_4px_24px_-8px_rgba(0,0,0,0.4),0_1px_3px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.05)]",
        "cursor-pointer group rounded-xl",
        selected && !isDragging && "bg-white/[0.06] border-white/[0.15]",
        isBatchTask && "border-white/[0.10]",
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
              onClick={(e) => { e.stopPropagation(); onToggleSelect?.(task.id) }}
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
          <div className={cn(
            "w-2 h-2 rounded-full mt-1.5 flex-shrink-0",
            priorityColors[task.priority]
          )} />
          <h4 className="text-sm font-light leading-tight line-clamp-2 flex-1">{task.title}</h4>
          {(isBatchTask || isActiveProgress) && (
            task.status === 'done' ? (
              <Check className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-linear-accent" />
            ) : (
              <Loader2 className={cn(
                "w-3 h-3 animate-spin flex-shrink-0 mt-0.5",
                isActiveProgress ? "text-linear-accent" : "text-zinc-500"
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
                className="text-[11px] px-2 py-0.5 h-5 font-medium rounded-[4px] inline-flex items-center backdrop-blur-sm border border-white/10"
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

        {showProgress && (
          <div className="mb-3 p-2 bg-white/[0.03] rounded-md">
            <div className="flex items-center gap-2">
              {isActiveProgress ? (
                <Loader2 className={cn('w-3 h-3 animate-spin', progressConfig[executionProgress.status].color)} />
              ) : (
                (() => {
                  const Icon = progressConfig[executionProgress.status].icon
                  return <Icon className={cn('w-3 h-3', progressConfig[executionProgress.status].color)} />
                })()
              )}
              <span className="text-xs text-linear-text-secondary">
                {executionProgress.message || progressConfig[executionProgress.status].label}
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

        {!showProgress && task.status === 'done' && task.prUrl && !isCompletedBatchTask && (
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
            <span className="text-[11px] text-linear-text-tertiary font-mono opacity-60">
              {task.identifier || (task.number ? `#${task.number}` : task.id.slice(0, 6))}
            </span>
            {(task.status === 'in_progress' || task.status === 'done' || task.status === 'cancelled') && (
              (task.status === 'in_progress' && task.executionStartedAt && !task.executionPausedAt && liveElapsedMs >= 1000) ||
              ((task.status === 'in_progress' && task.executionPausedAt && (task.executionElapsedMs ?? 0) > 0)) ||
              ((task.status === 'done' || task.status === 'cancelled') && (task.executionElapsedMs ?? 0) > 0)
            ) && (
              <span className="text-[11px] text-linear-text-tertiary flex items-center gap-1 whitespace-nowrap tabular-nums">
                <Clock className="w-3 h-3 flex-shrink-0" />
                {task.status === 'in_progress' && task.executionStartedAt && !task.executionPausedAt
                  ? formatDuration(liveElapsedMs)
                  : formatDuration(task.executionElapsedMs)}
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
                className="h-6 w-6 rounded-md p-0 text-linear-accent bg-linear-accent/10 border border-linear-accent/30 hover:bg-linear-accent/20"
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
    </div>
  )
}
