"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2, GitBranch, Code, GitPullRequest, Check, X, ExternalLink, Play, ArrowRight, Trash2, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
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
}

const priorityColors = {
  low: "bg-emerald-500",
  medium: "bg-yellow-500",
  high: "bg-red-500",
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

export function TaskCard({ task, onExecute, onCancel, onDelete, onMoveToInProgress, onTaskClick, executionProgress, selected, onToggleSelect, selectionMode }: TaskCardProps) {
  const [liveElapsedMs, setLiveElapsedMs] = useState<number>(0)

  useEffect(() => {
    if (task.status === 'in_progress' && task.executionStartedAt) {
      const updateElapsed = () => {
        const started = new Date(task.executionStartedAt!).getTime()
        const elapsed = Date.now() - started
        setLiveElapsedMs(elapsed)
      }

      updateElapsed()
      const interval = setInterval(updateElapsed, 1000)
      return () => clearInterval(interval)
    }
  }, [task.status, task.executionStartedAt])

  const handleExecute = () => {
    if (onExecute) {
      onExecute(task.id)
    }
  }

  const handleCancel = () => {
    if (onCancel) {
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

  return (
    <Card 
      className={cn(
        "bg-linear-bg border-linear-border hover:border-linear-border-hover cursor-pointer group",
        selected && "border-linear-accent/50"
      )}
      onClick={handleCardClick}
    >
      <CardHeader className="p-3 pb-0">
        <div className="flex items-start gap-2">
          <div
            className={cn(
              "flex-shrink-0 mt-0.5",
              selectionMode || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
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
          <div className={cn(
            "w-2 h-2 rounded-full mt-1.5 flex-shrink-0",
            priorityColors[task.priority]
          )} />
          <h4 className="text-sm font-medium leading-tight line-clamp-2 flex-1">{task.title}</h4>
          {isActiveProgress && (
            <Loader2 className="w-3 h-3 animate-spin text-linear-accent flex-shrink-0 mt-0.5" />
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
          <div className="mb-3 p-2 bg-linear-bg-tertiary rounded-md">
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
            {executionProgress.prUrl && (
              <a
                href={executionProgress.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 mt-2 text-xs text-linear-accent hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
                View PR
              </a>
            )}
          </div>
        )}
        
        <div className="flex items-center justify-between mt-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] text-linear-text-tertiary font-mono">
              {task.id.slice(0, 8)}
            </span>
            {(task.status === 'in_progress' || task.status === 'done' || task.status === 'cancelled') && (task.executionStartedAt || task.executionElapsedMs) && (
              <span className="text-[11px] text-linear-text-tertiary flex items-center gap-1 whitespace-nowrap tabular-nums">
                <Clock className="w-3 h-3 flex-shrink-0" />
                {task.status === 'in_progress' && task.executionStartedAt
                  ? formatDuration(liveElapsedMs)
                  : formatDuration(task.executionElapsedMs)}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0">
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
                Start
              </Button>
            )}
            {task.status === 'in_progress' && onExecute && !isActiveProgress && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs text-linear-accent hover:text-linear-accent hover:bg-linear-accent/10"
                onClick={(e) => {
                  e.stopPropagation()
                  handleExecute()
                }}
              >
                <Play className="w-3 h-3 mr-1" />
                Execute
              </Button>
            )}
            {isActiveProgress && onCancel && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs text-red-400 hover:text-red-400 hover:bg-red-500/10"
                onClick={(e) => {
                  e.stopPropagation()
                  handleCancel()
                }}
              >
                Cancel
              </Button>
            )}
            {onDelete && !isActiveProgress && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-linear-text-tertiary hover:text-red-400 hover:bg-red-500/10"
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete()
                }}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
