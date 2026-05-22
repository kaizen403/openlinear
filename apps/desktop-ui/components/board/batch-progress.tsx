"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { X, Loader2, ChevronDown, ChevronUp, Check, AlertCircle, SkipForward, Ban, Clock, ExternalLink, GitPullRequest, ArrowRight } from "lucide-react"
import { cn, openExternal } from "@/lib/utils"
import { BATCH_STATUS_COLORS } from "@/lib/design-tokens"
import { useExecutionProgress } from "@/lib/execution-state-store"
import { formatBatchMode } from "./batch-mode"

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
  onApproveNext?: (batchId: string) => void
}

const statusConfig: Record<string, { color: string; bg: string; icon: typeof Check; label: string; dot?: string }> = {
  queued: { color: BATCH_STATUS_COLORS.queued.text, bg: BATCH_STATUS_COLORS.queued.bg, icon: Clock, label: 'Queued' },
  running: { color: BATCH_STATUS_COLORS.running.text, bg: BATCH_STATUS_COLORS.running.bg, icon: Loader2, label: 'Running' },
  completed: { color: BATCH_STATUS_COLORS.completed.text, bg: BATCH_STATUS_COLORS.completed.bg, icon: Check, label: 'Done', dot: BATCH_STATUS_COLORS.completed.dot },
  failed: { color: BATCH_STATUS_COLORS.failed.text, bg: BATCH_STATUS_COLORS.failed.bg, icon: AlertCircle, label: 'Failed', dot: BATCH_STATUS_COLORS.failed.dot },
  skipped: { color: BATCH_STATUS_COLORS.skipped.text, bg: BATCH_STATUS_COLORS.skipped.bg, icon: SkipForward, label: 'Skipped' },
  cancelled: { color: BATCH_STATUS_COLORS.cancelled.text, bg: BATCH_STATUS_COLORS.cancelled.bg, icon: Ban, label: 'Cancelled' },
}

function BatchTaskActivityPreview({ task }: { task: BatchProgressTask }) {
  const progress = useExecutionProgress(task.taskId)
  const message = progress?.message || (task.status === 'running' ? 'Agent session is starting' : null)

  if (!message) return null

  return (
    <div className="flex items-center gap-2 text-xs text-linear-text-secondary min-w-0">
      <span className="truncate text-linear-text-tertiary">{task.title}</span>
      <span className="text-linear-text-tertiary">/</span>
      <span className="truncate">{message}</span>
    </div>
  )
}

function BatchTaskRow({
  task,
  onViewActivity,
}: {
  task: BatchProgressTask
  onViewActivity?: (taskId: string) => void
}) {
  const cfg = statusConfig[task.status] || statusConfig.queued
  const Icon = cfg.icon
  const progress = useExecutionProgress(task.taskId)
  const activity = progress?.message || (task.status === 'running' ? 'Agent session is starting' : null)

  return (
    <div className="bg-linear-bg-secondary border border-linear-border rounded-sm p-3">
      <div className="flex items-center gap-3">
        <Icon
          className={cn("w-4 h-4 flex-shrink-0", cfg.color, task.status === 'running' && 'animate-spin')}
        />
        <span className="text-sm text-linear-text truncate flex-1">{task.title}</span>
        <span className={cn("text-xs flex-shrink-0", cfg.color)}>{cfg.label}</span>
        <button
          onClick={() => onViewActivity?.(task.taskId)}
          className="text-sm text-linear-text-tertiary hover:text-linear-accent flex-shrink-0"
        >
          View Full activity
        </button>
      </div>
      {activity && (
        <p className="mt-2 pl-7 text-xs text-linear-text-secondary truncate">
          {activity}
        </p>
      )}
    </div>
  )
}

export function BatchProgress({ batchId, status, mode, tasks, prUrl, onCancel, onDismiss, onViewActivity, onApproveNext }: BatchProgressProps) {
  const [expanded, setExpanded] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [approving, setApproving] = useState(false)
  const total = tasks.length
  const completed = tasks.filter(t => t.status === 'completed').length
  const failed = tasks.filter(t => t.status === 'failed').length
  const queued = tasks.filter(t => t.status === 'queued').length
  const running = tasks.filter(t => t.status === 'running').length
  const isStarting = status === 'starting' || status === 'pending'
  const isRunning = isStarting || status === 'running' || status === 'merging'
  const previewTasks = tasks.filter(task => task.status === 'running').slice(0, 3)
  // Queue mode without auto-approve: when nothing is running but tasks are
  // still queued, the batch is waiting for the user to release the next task.
  const showApproveNext = !!onApproveNext
    && mode === 'queue'
    && status === 'running'
    && running === 0
    && queued > 0

  return (
    <div className="mx-3 sm:mx-6 mt-4 mb-3 bg-linear-bg-secondary border border-linear-border rounded-sm">
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
              {isStarting
                ? `Starting ${formatBatchMode(mode)} execution`
                : `${formatBatchMode(mode)} Issues: ${completed}/${total} complete`}
              {failed > 0 && <span className={cn("ml-1", BATCH_STATUS_COLORS.failed.text)}>({failed} failed)</span>}
            </span>
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-linear-text-tertiary" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-linear-text-tertiary" />
            )}
          </button>
          {!isStarting && isRunning && (
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
          {showApproveNext && (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                setApproving(true)
                try {
                  await onApproveNext!(batchId)
                } finally {
                  setApproving(false)
                }
              }}
              disabled={approving}
              className="h-7 text-xs border-linear-accent/40 text-linear-accent hover:bg-linear-accent/10 gap-1"
            >
              {approving ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <ArrowRight className="w-3 h-3" />
              )}
              Approve next
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

        {isStarting && (
          <p className="mt-2 text-xs text-linear-text-secondary">
            Preparing the repository and agent session for the selected issues.
          </p>
        )}

        {!expanded && previewTasks.length > 0 && (
          <div className="mt-2 space-y-1">
            {previewTasks.map(task => (
              <BatchTaskActivityPreview key={task.taskId} task={task} />
            ))}
            {running > previewTasks.length && (
              <p className="text-xs text-linear-text-tertiary">
                {running - previewTasks.length} more running issue{running - previewTasks.length === 1 ? '' : 's'}
              </p>
            )}
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-linear-border px-3 py-2 space-y-2">
          {tasks.map(task => (
            <BatchTaskRow key={task.taskId} task={task} onViewActivity={onViewActivity} />
          ))}
        </div>
      )}
    </div>
  )
}
