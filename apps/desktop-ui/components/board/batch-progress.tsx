"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { X, Loader2, ChevronDown, ChevronUp, Check, AlertCircle, SkipForward, Ban, Clock, ExternalLink, GitPullRequest, ArrowRight, Eye } from "lucide-react"
import { cn, openExternal } from "@/lib/utils"
import { useExecutionLogs, useExecutionProgress } from "@/lib/execution-state-store"
import { formatBatchExecutionMode, getBatchActivityId } from "./batch-mode"

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

const statusConfig: Record<string, { color: string; bg: string; bar: string; icon: typeof Check; label: string }> = {
  queued: { color: 'text-linear-text-tertiary', bg: 'bg-linear-bg-tertiary', bar: 'bg-[#252525]', icon: Clock, label: 'Queued' },
  running: { color: 'text-linear-accent', bg: 'bg-linear-accent/10', bar: 'bg-[#064e3b]', icon: Loader2, label: 'Running' },
  completed: { color: 'text-green-400', bg: 'bg-green-500/10', bar: 'bg-[#14532d]', icon: Check, label: 'Done' },
  failed: { color: 'text-red-400', bg: 'bg-red-500/10', bar: 'bg-[#7f1d1d]', icon: AlertCircle, label: 'Failed' },
  skipped: { color: 'text-amber-400', bg: 'bg-amber-500/10', bar: 'bg-[#451a03]', icon: SkipForward, label: 'Skipped' },
  cancelled: { color: 'text-linear-text-tertiary', bg: 'bg-linear-bg-tertiary', bar: 'bg-[#333]', icon: Ban, label: 'Cancelled' },
}

function BatchTaskActivityPreview({
  task,
  prefix,
  onViewActivity,
}: {
  task: BatchProgressTask
  prefix?: string
  onViewActivity?: (taskId: string) => void
}) {
  const progress = useExecutionProgress(task.taskId)
  const message = progress?.message || (task.status === 'running' ? 'Agent session is starting' : null)

  if (!message) return null

  return (
    <div className="flex items-center gap-2 text-xs min-w-0 group">
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-linear-text-tertiary w-16">
        {prefix}
      </span>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="truncate text-linear-text-tertiary">{task.title}</span>
        <span className="text-linear-text-tertiary/50">/</span>
        <span className="truncate text-linear-text-secondary">{message}</span>
      </div>
      {onViewActivity && (
        <button
          onClick={() => onViewActivity(task.taskId)}
          className="shrink-0 inline-flex items-center gap-1 text-[10px] text-linear-text-tertiary hover:text-linear-accent transition-colors opacity-0 group-hover:opacity-100"
        >
          <Eye className="w-3 h-3" />
          View
        </button>
      )}
    </div>
  )
}

function BatchTaskRow({
  task,
  index,
  mode,
  onViewActivity,
}: {
  task: BatchProgressTask
  index: number
  mode: string
  onViewActivity?: (taskId: string) => void
}) {
  const cfg = statusConfig[task.status] || statusConfig.queued
  const Icon = cfg.icon
  const liveProgress = useExecutionProgress(task.taskId)
  const progress = mode === 'combined' ? undefined : liveProgress
  const activity = progress?.message || (task.status === 'running' ? 'Agent session is starting' : null)
  const stepLabel =
    mode === 'queue'
      ? `Step ${index + 1}`
      : mode === 'parallel'
        ? `Lane ${index + 1}`
        : `Issue ${index + 1}`

  return (
    <div className="bg-[#161616] border border-[#2a2a2a] rounded-sm p-3">
      <div className="flex items-center gap-3">
        <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-linear-text-tertiary">
          {stepLabel}
        </span>
        <Icon
          className={cn("w-4 h-4 flex-shrink-0", cfg.color, task.status === 'running' && 'animate-spin')}
        />
        <span className="text-sm text-linear-text truncate flex-1">{task.title}</span>
        <span className={cn("text-xs flex-shrink-0", cfg.color)}>{cfg.label}</span>
        {mode !== 'combined' && (
          <button
            onClick={() => onViewActivity?.(task.taskId)}
            className="text-sm text-linear-text-tertiary hover:text-linear-accent flex-shrink-0 inline-flex items-center gap-1 transition-colors"
          >
            <Eye className="w-3.5 h-3.5" />
            View activity
          </button>
        )}
      </div>
      {activity && (
        <p className="mt-2 pl-[4.75rem] text-xs text-linear-text-secondary truncate">
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
  const isCombined = mode === 'combined'
  const combinedActivityId = getBatchActivityId(batchId)
  const combinedProgress = useExecutionProgress(isCombined ? combinedActivityId : null)
  const combinedLogs = useExecutionLogs(isCombined ? combinedActivityId : null)
  const latestCombinedLog = combinedLogs.at(-1)
  const total = tasks.length
  const completed = tasks.filter(t => t.status === 'completed').length
  const failed = tasks.filter(t => t.status === 'failed').length
  const queued = tasks.filter(t => t.status === 'queued').length
  const running = tasks.filter(t => t.status === 'running').length
  const isStarting = status === 'starting' || status === 'pending'
  const isRunning = isStarting || status === 'running' || status === 'merging'
  const previewTasks = tasks.filter(task => task.status === 'running').slice(0, 3)
  const currentQueueIndex = tasks.findIndex(task => task.status === 'running')
  const currentQueueTask = currentQueueIndex >= 0 ? tasks[currentQueueIndex] : null
  const modeLabel = formatBatchExecutionMode(mode)
  const headerText = (() => {
    if (isStarting) return `Starting ${modeLabel}`
    if (mode === 'queue') {
      const step = currentQueueIndex >= 0 ? currentQueueIndex + 1 : Math.min(completed + 1, total)
      return `${modeLabel}: step ${step}/${total}`
    }
    if (isCombined) return `${modeLabel}: ${total} issue${total === 1 ? '' : 's'} together`
    return `${modeLabel}: ${completed}/${total} complete`
  })()
  const showApproveNext = !!onApproveNext
    && mode === 'queue'
    && status === 'running'
    && running === 0
    && queued > 0

  return (
    <div className="mx-3 sm:mx-6 mt-4 mb-3 bg-[#141414] border border-[#252525] rounded-sm">
      <div className="p-3">
        {/* Header row */}
        <div className="flex items-center justify-between mb-2.5">
          <button
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            onClick={() => setExpanded(!expanded)}
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin text-linear-accent" />
            ) : (
              <div
                className={cn(
                  "w-2 h-2 rounded-full",
                  status === 'completed' ? 'bg-green-500'
                    : status === 'failed' ? 'bg-red-500'
                    : 'bg-[#333]'
                )}
              />
            )}
            <span className="text-sm text-linear-text font-medium">
              {headerText}
              {failed > 0 && <span className="ml-1.5 text-red-400">({failed} failed)</span>}
            </span>
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-linear-text-tertiary" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-linear-text-tertiary" />
            )}
          </button>

          <div className="flex items-center gap-1">
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
                className="h-7 text-xs border-[#2a2a2a] text-linear-text hover:bg-[#1f1f1f] hover:border-[#333] gap-1"
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
        </div>

        {/* Progress bar */}
        <div className="flex gap-0.5 h-1.5">
          {tasks.map(task => {
            const cfg = statusConfig[task.status] || statusConfig.queued
            return (
              <div
                key={task.taskId}
                className={cn("flex-1 rounded-full first:rounded-l-full last:rounded-r-full transition-colors", cfg.bar)}
              />
            )
          })}
        </div>

        {/* Compact preview rows */}
        {isStarting && (
          <p className="mt-2.5 text-xs text-linear-text-secondary">
            Preparing the repository and agent session for the selected issues.
          </p>
        )}

        {!expanded && isCombined && (
          <div className="mt-2.5 text-xs text-linear-text-secondary truncate">
            {combinedProgress?.message || latestCombinedLog?.message || 'One agent session is working across all selected issues.'}
          </div>
        )}

        {!expanded && mode === 'queue' && currentQueueTask && (
          <div className="mt-2.5">
            <BatchTaskActivityPreview
              task={currentQueueTask}
              prefix={`Step ${currentQueueIndex + 1}/${total}`}
              onViewActivity={onViewActivity}
            />
          </div>
        )}

        {!expanded && mode === 'parallel' && previewTasks.length > 0 && (
          <div className="mt-2.5 space-y-1.5">
            {previewTasks.map(task => (
              <BatchTaskActivityPreview
                key={task.taskId}
                task={task}
                prefix={`Lane ${tasks.findIndex(t => t.taskId === task.taskId) + 1}`}
                onViewActivity={onViewActivity}
              />
            ))}
            {running > previewTasks.length && (
              <p className="text-xs text-linear-text-tertiary pl-[4.5rem]">
                {running - previewTasks.length} more running issue{running - previewTasks.length === 1 ? '' : 's'}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Expanded detail view */}
      {expanded && (
        <div className="border-t border-[#252525] px-3 py-2.5 space-y-2">
          {isCombined && (
            <div className="rounded-sm border border-[#2a2a2a] bg-[#161616] px-3 py-2.5 text-xs text-linear-text-secondary">
              <div className="font-medium text-linear-text-secondary">
                {combinedProgress?.message || 'Combined activity'}
              </div>
              {combinedLogs.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {combinedLogs.slice(-5).map((entry) => (
                    <div key={`${entry.timestamp}-${entry.message}`} className="truncate">
                      <span className="text-linear-text-tertiary">{entry.type}</span>
                      <span className="mx-1 text-linear-text-tertiary">/</span>
                      <span>{entry.message}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-linear-text-tertiary">
                  Combined logs will appear here while the shared agent session runs.
                </div>
              )}
            </div>
          )}
          {tasks.map((task, index) => (
            <BatchTaskRow
              key={task.taskId}
              task={task}
              index={index}
              mode={mode}
              onViewActivity={onViewActivity}
            />
          ))}
        </div>
      )}
    </div>
  )
}
