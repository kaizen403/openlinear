"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { X, Loader2, ChevronDown, ChevronUp, Check, AlertCircle, SkipForward, Ban, Clock, ExternalLink, GitPullRequest } from "lucide-react"
import { cn } from "@/lib/utils"

interface BatchProgressTask {
  taskId: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
}

interface BatchProgressProps {
  batchId: string
  status: string
  mode: string
  tasks: BatchProgressTask[]
  prUrl: string | null
  onCancel: (batchId: string) => void
  onDismiss?: () => void
}

const statusConfig: Record<string, { color: string; bg: string; icon: typeof Check; label: string }> = {
  queued: { color: 'text-linear-text-tertiary', bg: 'bg-linear-text-tertiary', icon: Clock, label: 'Queued' },
  running: { color: 'text-linear-accent', bg: 'bg-linear-accent', icon: Loader2, label: 'Running' },
  completed: { color: 'text-green-400', bg: 'bg-green-500', icon: Check, label: 'Done' },
  failed: { color: 'text-red-400', bg: 'bg-red-500', icon: AlertCircle, label: 'Failed' },
  skipped: { color: 'text-yellow-400', bg: 'bg-yellow-500', icon: SkipForward, label: 'Skipped' },
  cancelled: { color: 'text-gray-400', bg: 'bg-gray-500', icon: Ban, label: 'Cancelled' },
}

export function BatchProgress({ batchId, status, mode, tasks, prUrl, onCancel, onDismiss }: BatchProgressProps) {
  const [expanded, setExpanded] = useState(false)
  const total = tasks.length
  const completed = tasks.filter(t => t.status === 'completed').length
  const failed = tasks.filter(t => t.status === 'failed').length
  const done = tasks.filter(t => !['queued', 'running'].includes(t.status)).length
  const percentage = total > 0 ? Math.round((done / total) * 100) : 0
  const isRunning = status === 'running' || status === 'merging'

  return (
    <div className="mx-6 mt-4 mb-0 bg-linear-bg-secondary border border-linear-border rounded-lg">
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <button
            className="flex items-center gap-2 hover:opacity-80"
            onClick={() => setExpanded(!expanded)}
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin text-linear-accent" />
            ) : (
              <div className={cn("w-2 h-2 rounded-full", status === 'completed' ? 'bg-green-500' : status === 'failed' ? 'bg-red-500' : 'bg-gray-500')} />
            )}
            <span className="text-sm text-linear-text">
              {mode === 'queue' ? 'Queue' : 'Parallel'} Execution: {completed}/{total} complete
              {failed > 0 && <span className="text-red-400 ml-1">({failed} failed)</span>}
            </span>
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-linear-text-tertiary" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-linear-text-tertiary" />
            )}
          </button>
          {isRunning && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onCancel(batchId)}
              className="h-7 text-xs text-linear-text-tertiary hover:text-red-400"
            >
              <X className="w-3 h-3 mr-1" />
              Cancel
            </Button>
          )}
          {prUrl && !isRunning && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => window.open(prUrl, '_blank')}
                className="h-7 text-xs text-linear-accent hover:text-linear-accent-hover gap-1.5"
              >
                <GitPullRequest className="w-3.5 h-3.5" />
                Open PR
                <ExternalLink className="w-3 h-3" />
              </Button>
              {onDismiss && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onDismiss}
                  className="h-7 w-7 p-0 text-linear-text-tertiary hover:text-linear-text"
                >
                  <X className="w-3 h-3" />
                </Button>
              )}
            </div>
          )}
          {!isRunning && !prUrl && onDismiss && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onDismiss}
              className="h-7 w-7 p-0 text-linear-text-tertiary hover:text-linear-text"
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>

        <div className="flex gap-0.5">
          {tasks.map(task => {
            const cfg = statusConfig[task.status] || statusConfig.queued
            return (
              <div
                key={task.taskId}
                className={cn("h-1.5 flex-1 rounded-full", cfg.bg)}
              />
            )
          })}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-linear-border px-3 py-2 space-y-1">
          {tasks.map(task => {
            const cfg = statusConfig[task.status] || statusConfig.queued
            const Icon = cfg.icon
            return (
              <div key={task.taskId} className="flex items-center gap-2 py-1">
                <Icon className={cn("w-3.5 h-3.5 flex-shrink-0", cfg.color, task.status === 'running' && 'animate-spin')} />
                <span className="text-sm text-linear-text truncate flex-1">{task.title}</span>
                <span className={cn("text-[11px] font-mono", cfg.color)}>{cfg.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
