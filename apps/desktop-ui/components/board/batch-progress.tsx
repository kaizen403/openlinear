"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { X, Loader2, ChevronDown, ChevronUp, Check, AlertCircle, SkipForward, Ban, Clock, ExternalLink, GitPullRequest } from "lucide-react"
import { cn, openExternal } from "@/lib/utils"
import { BATCH_STATUS_COLORS } from "@/lib/design-tokens"

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
  onViewActivity?: (taskId: string) => void
}

const statusConfig: Record<string, { color: string; bg: string; icon: typeof Check; label: string; dot?: string }> = {
  queued: { color: BATCH_STATUS_COLORS.queued.text, bg: BATCH_STATUS_COLORS.queued.bg, icon: Clock, label: 'Queued' },
  running: { color: BATCH_STATUS_COLORS.running.text, bg: BATCH_STATUS_COLORS.running.bg, icon: Loader2, label: 'Running' },
  completed: { color: BATCH_STATUS_COLORS.completed.text, bg: BATCH_STATUS_COLORS.completed.bg, icon: Check, label: 'Done', dot: BATCH_STATUS_COLORS.completed.dot },
  failed: { color: BATCH_STATUS_COLORS.failed.text, bg: BATCH_STATUS_COLORS.failed.bg, icon: AlertCircle, label: 'Failed', dot: BATCH_STATUS_COLORS.failed.dot },
  skipped: { color: BATCH_STATUS_COLORS.skipped.text, bg: BATCH_STATUS_COLORS.skipped.bg, icon: SkipForward, label: 'Skipped' },
  cancelled: { color: BATCH_STATUS_COLORS.cancelled.text, bg: BATCH_STATUS_COLORS.cancelled.bg, icon: Ban, label: 'Cancelled' },
}

export function BatchProgress({ batchId, status, mode, tasks, prUrl, onCancel, onDismiss, onViewActivity }: BatchProgressProps) {
  const [expanded, setExpanded] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const total = tasks.length
  const completed = tasks.filter(t => t.status === 'completed').length
  const failed = tasks.filter(t => t.status === 'failed').length
  const isRunning = status === 'running' || status === 'merging'

  return (
    <div className="mx-3 sm:mx-6 mt-4 mb-3 bg-linear-bg-secondary border border-linear-border rounded-lg">
      <div className="p-3 bg-gradient-to-b from-linear-bg-secondary to-linear-bg-secondary">
        <div className="flex items-center justify-between mb-2">
          <button
            className="flex items-center gap-2 hover:opacity-80"
            onClick={() => setExpanded(!expanded)}
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin text-linear-accent" />
            ) : (
              <div
                className={cn(
                  "w-2 h-2 rounded-full",
                  status === 'completed' ? statusConfig.completed.dot
                    : status === 'failed' ? statusConfig.failed.dot
                    : 'bg-linear-border-hover'
                )}
              />
            )}
            <span className="text-sm text-linear-text">
              {mode === 'queue' ? 'Queue' : 'Parallel'} Issues: {completed}/{total} complete
              {failed > 0 && <span className={cn("ml-1", BATCH_STATUS_COLORS.failed.text)}>({failed} failed)</span>}
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
              onClick={() => { setCancelling(true); onCancel(batchId) }}
              disabled={cancelling}
              className="h-7 text-xs text-linear-text-tertiary hover:text-red-400"
            >
              {cancelling ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  Cancelling
                </>
              ) : (
                <>
                  <X className="w-3 h-3 mr-1" />
                  Cancel
                </>
              )}
            </Button>
          )}
          {prUrl && !isRunning && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openExternal(prUrl)}
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
        <div className="border-t border-linear-border px-3 py-2 space-y-2">
          {tasks.map(task => {
            const cfg = statusConfig[task.status] || statusConfig.queued
            const Icon = cfg.icon
            return (
              <div
                key={task.taskId}
                className="bg-linear-bg-secondary border border-linear-border rounded-lg p-3 hover:border-linear-border-hover transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Icon
                    className={cn("w-4 h-4 flex-shrink-0", cfg.color, task.status === 'running' && 'animate-spin')}
                  />
                  <span className="text-sm text-linear-text truncate flex-1">{task.title}</span>
                  <button
                    onClick={() => onViewActivity?.(task.taskId)}
                    className="text-sm text-linear-text-tertiary hover:text-linear-accent transition-colors flex-shrink-0"
                  >
                    View activity
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
