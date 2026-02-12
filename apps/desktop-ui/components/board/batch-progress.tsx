"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { X, Loader2, ChevronDown, ChevronUp, Check, AlertCircle, SkipForward, Ban, Clock, ExternalLink, GitPullRequest } from "lucide-react"
import { cn, openExternal } from "@/lib/utils"

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

const statusConfig: Record<string, { color: string; bg: string; icon: typeof Check; label: string }> = {
  queued: { color: 'text-[#666]', bg: 'bg-[#2a2a2a]', icon: Clock, label: 'Queued' },
  running: { color: 'text-linear-accent', bg: 'bg-linear-accent', icon: Loader2, label: 'Running' },
  completed: { color: 'text-[#4a7c5c]', bg: 'bg-[#1f3a2a]', icon: Check, label: 'Done' },
  failed: { color: 'text-[#8b5a5a]', bg: 'bg-[#3d2626]', icon: AlertCircle, label: 'Failed' },
  skipped: { color: 'text-[#7c6a4a]', bg: 'bg-[#3d3526]', icon: SkipForward, label: 'Skipped' },
  cancelled: { color: 'text-[#666]', bg: 'bg-[#333]', icon: Ban, label: 'Cancelled' },
}

export function BatchProgress({ batchId, status, mode, tasks, prUrl, onCancel, onDismiss, onViewActivity }: BatchProgressProps) {
  const [expanded, setExpanded] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const total = tasks.length
  const completed = tasks.filter(t => t.status === 'completed').length
  const failed = tasks.filter(t => t.status === 'failed').length
  const isRunning = status === 'running' || status === 'merging'

  return (
    <div className="mx-3 sm:mx-6 mt-4 mb-3 bg-[#141414] border border-[#222] rounded-lg">
      <div className="p-3 bg-gradient-to-b from-[#1a1a1a] to-[#141414]">
        <div className="flex items-center justify-between mb-2">
          <button
            className="flex items-center gap-2 hover:opacity-80"
            onClick={() => setExpanded(!expanded)}
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin text-linear-accent" />
            ) : (
              <div className={cn("w-2 h-2 rounded-full", status === 'completed' ? 'bg-[#2d5a3d]' : status === 'failed' ? 'bg-[#5a2d2d]' : 'bg-[#444]')} />
            )}
            <span className="text-sm text-linear-text">
              {mode === 'queue' ? 'Queue' : 'Parallel'} Issues: {completed}/{total} complete
              {failed > 0 && <span className="text-[#8b5a5a] ml-1">({failed} failed)</span>}
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
              className="h-7 text-xs text-[#666] hover:text-[#8b5a5a]"
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
        <div className="border-t border-[#222] px-3 py-2 space-y-2">
          {tasks.map(task => {
            const cfg = statusConfig[task.status] || statusConfig.queued
            const Icon = cfg.icon
            return (
              <div
                key={task.taskId}
                className="bg-[#141414] border border-[#222] rounded-lg p-3 hover:border-[#333] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Icon className={cn("w-4 h-4 flex-shrink-0", cfg.color, task.status === 'running' && 'animate-spin')} />
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
