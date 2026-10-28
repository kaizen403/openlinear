"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { X, Loader2, ChevronDown, ChevronUp, Check, AlertCircle, AlertTriangle, SkipForward, Ban, Clock, ExternalLink, GitPullRequest, GitBranch, GitCommit, ArrowRight, Eye, Copy } from "lucide-react"
import { cn, openExternal } from "@/lib/utils"
import { useExecutionLogs, useExecutionProgress } from "@/lib/execution-state-store"
import { formatBatchExecutionMode, getBatchActivityId } from "./batch-mode"
import {
  BATCH_MEMBER_PHASE_LABEL,
  deriveBatchMemberPhase,
  describeBatchOutcome,
  type BatchMemberPhase,
  type BatchPublication,
} from "./execution-outcome"
import { OUTCOME_TONE_CLASSES, copyText } from "./execution-outcome-panel"
import { isTerminalBatchStatus } from "./batch-state"

interface BatchProgressTask {
  taskId: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
  branch?: string
  error?: string | null
  cancelUnconfirmed?: boolean
}

interface BatchProgressProps {
  batchId: string
  status: string
  mode: string
  tasks: BatchProgressTask[]
  prUrl: string | null
  publication?: BatchPublication | null
  /** Members whose task row already records a persisted local commit (W01 "ready to publish"). */
  readyTaskIds?: ReadonlySet<string>
  /** Resolves false when the sidecar rejected or couldn't confirm the cancellation. */
  onCancel: (batchId: string) => unknown
  onDismiss?: () => void
  onViewActivity?: (taskId: string) => void
  onApproveNext?: (batchId: string) => Promise<void> | void
}

const EMPTY_IDS: ReadonlySet<string> = new Set()

const phaseConfig: Record<BatchMemberPhase, { color: string; bar: string; icon: typeof Check; spin?: boolean }> = {
  queued: { color: 'text-linear-text-tertiary', bar: 'bg-linear-border', icon: Clock },
  running: { color: 'text-run-active', bar: 'bg-brand-solid/60', icon: Loader2, spin: true },
  ready_to_publish: { color: 'text-run-info', bar: 'bg-run-info/30', icon: GitCommit },
  publishing: { color: 'text-run-info', bar: 'bg-run-info/40', icon: Loader2, spin: true },
  published: { color: 'text-run-success', bar: 'bg-run-success/30', icon: Check },
  not_published: { color: 'text-run-warning', bar: 'bg-run-warning/20', icon: AlertTriangle },
  failed: { color: 'text-run-danger', bar: 'bg-destructive/50', icon: AlertCircle },
  skipped: { color: 'text-run-warning', bar: 'bg-run-warning/20', icon: SkipForward },
  cancelled: { color: 'text-linear-text-tertiary', bar: 'bg-linear-border-hover', icon: Ban },
}

function memberPhase(task: BatchProgressTask, batchStatus: string, readyTaskIds: ReadonlySet<string>): BatchMemberPhase {
  if (task.status === 'running' && readyTaskIds.has(task.taskId)) {
    return batchStatus === 'merging' ? 'publishing' : 'ready_to_publish'
  }
  return deriveBatchMemberPhase(task, batchStatus)
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
        <span className="text-linear-text-tertiary">/</span>
        <span className="truncate text-linear-text-secondary">{message}</span>
      </div>
      {onViewActivity && (
        <button
          type="button"
          onClick={() => onViewActivity(task.taskId)}
          className="shrink-0 inline-flex items-center gap-1 text-[10px] text-linear-text-tertiary hover:text-linear-accent transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
  phase,
  onViewActivity,
}: {
  task: BatchProgressTask
  index: number
  mode: string
  phase: BatchMemberPhase
  onViewActivity?: (taskId: string) => void
}) {
  const cfg = phaseConfig[phase]
  const Icon = cfg.icon
  const liveProgress = useExecutionProgress(task.taskId)
  const progress = mode === 'combined' ? undefined : liveProgress
  const activity = phase === 'ready_to_publish'
    ? 'Local commit ready; waiting for the batch pull request'
    : progress?.message || (task.status === 'running' ? 'Agent session is starting' : null)
  const stepLabel =
    mode === 'queue'
      ? `Step ${index + 1}`
      : mode === 'parallel'
        ? `Lane ${index + 1}`
        : `Issue ${index + 1}`
  const showRetained = Boolean(task.branch) && (phase === 'failed' || phase === 'skipped' || phase === 'cancelled' || phase === 'not_published')

  return (
    <div className="bg-linear-bg-secondary border border-linear-border rounded-sm p-3">
      <div className="flex items-center gap-3">
        <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-linear-text-tertiary">
          {stepLabel}
        </span>
        <Icon
          className={cn("w-4 h-4 flex-shrink-0", cfg.color, cfg.spin && 'animate-spin')}
          aria-hidden="true"
        />
        <span className="text-sm text-linear-text truncate flex-1">{task.title}</span>
        <span className={cn("text-xs flex-shrink-0", cfg.color)}>
          {BATCH_MEMBER_PHASE_LABEL[phase]}
          {task.cancelUnconfirmed && <span className="ml-1 text-warning">· stop unconfirmed</span>}
        </span>
        {mode !== 'combined' && (
          <button
            type="button"
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
      {task.error && phase !== 'published' && (
        <p className="mt-1 pl-[4.75rem] text-xs text-danger break-words">{task.error}</p>
      )}
      {showRetained && task.branch && (
        <div className="mt-1.5 pl-[4.75rem] flex items-center gap-2 text-xs min-w-0">
          <GitBranch className="w-3 h-3 flex-shrink-0 text-linear-text-tertiary" aria-hidden="true" />
          <span className="text-linear-text-tertiary flex-shrink-0">Work retained on</span>
          <span className="font-mono text-linear-text-secondary truncate" title={task.branch}>{task.branch}</span>
          <button
            type="button"
            onClick={() => void copyText(task.branch!, "branch name")}
            className="flex-shrink-0 rounded-sm p-1 text-linear-text-tertiary hover:bg-linear-bg-tertiary hover:text-linear-text"
            aria-label={`Copy branch name ${task.branch}`}
          >
            <Copy className="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

export function BatchProgress({ batchId, status, mode, tasks, prUrl, publication, readyTaskIds = EMPTY_IDS, onCancel, onDismiss, onViewActivity, onApproveNext }: BatchProgressProps) {
  const [expanded, setExpanded] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [retryingStop, setRetryingStop] = useState(false)
  const [approving, setApproving] = useState(false)
  const isCombined = mode === 'combined'
  const combinedActivityId = getBatchActivityId(batchId)
  const combinedProgress = useExecutionProgress(isCombined ? combinedActivityId : null)
  const combinedLogs = useExecutionLogs(isCombined ? combinedActivityId : null)
  const latestCombinedLog = combinedLogs.at(-1)
  const total = tasks.length
  const phases = tasks.map((task) => memberPhase(task, status, readyTaskIds))
  const count = (phase: BatchMemberPhase) => phases.filter((candidate) => candidate === phase).length
  const failed = count('failed')
  const queued = tasks.filter(t => t.status === 'queued').length
  const running = tasks.filter(t => t.status === 'running').length
  const readyToPublish = count('ready_to_publish') + count('publishing')
  const published = count('published')
  const isStarting = status === 'starting' || status === 'pending'
  const isRunning = isStarting || status === 'running' || status === 'merging'
  const isTerminal = isTerminalBatchStatus(status)
  const previewTasks = tasks.filter((task, index) => task.status === 'running' && phases[index] === 'running').slice(0, 3)
  const currentQueueIndex = tasks.findIndex(task => task.status === 'running')
  const currentQueueTask = currentQueueIndex >= 0 ? tasks[currentQueueIndex] : null
  const modeLabel = formatBatchExecutionMode(mode)
  const outcome = describeBatchOutcome({ status, prUrl, publication, tasks })
  const tone = OUTCOME_TONE_CLASSES[outcome.tone]
  const headerText = (() => {
    if (isStarting) return `Starting ${modeLabel}`
    if (isTerminal) return `${modeLabel}: ${outcome.label}`
    if (status === 'merging') return `${modeLabel}: publishing ${readyToPublish} issue${readyToPublish === 1 ? '' : 's'}`
    if (mode === 'queue') {
      const finished = tasks.filter(t => t.status !== 'queued' && t.status !== 'running').length
      const step = currentQueueIndex >= 0 ? currentQueueIndex + 1 : Math.min(finished + 1, total)
      return `${modeLabel}: step ${step}/${total}`
    }
    if (isCombined) return `${modeLabel}: ${total} issue${total === 1 ? '' : 's'} together`
    return `${modeLabel}: ${readyToPublish}/${total} ready to publish`
  })()
  const showApproveNext = !!onApproveNext
    && mode === 'queue'
    && status === 'running'
    && running === 0
    && queued > 0
  const showOutcome = isTerminal || Boolean(outcome.publicationError) || outcome.unconfirmedStops.length > 0

  const requestStop = async (setBusy: (busy: boolean) => void) => {
    setBusy(true)
    try {
      const accepted = await onCancel(batchId)
      // Only the HTTP result acknowledges a stop; re-enable on failure.
      if (accepted === false) setBusy(false)
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="mx-3 sm:mx-6 mt-4 mb-3 bg-linear-bg-secondary border border-linear-border rounded-sm">
      <div className="p-3">
        {/* Header row */}
        <div className="flex items-center justify-between mb-2.5">
          <button
            type="button"
            className="flex items-center gap-2 hover:opacity-80 transition-opacity min-w-0"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin text-linear-accent" aria-hidden="true" />
            ) : (
              <div
                className={cn(
                  "w-2 h-2 rounded-full flex-shrink-0",
                  outcome.tone === 'success' ? 'bg-success'
                    : outcome.tone === 'danger' ? 'bg-danger'
                    : outcome.tone === 'warning' ? 'bg-warning'
                    : 'bg-linear-border-hover'
                )}
              />
            )}
            <span className="text-sm text-linear-text font-medium truncate">
              {headerText}
              {!isTerminal && failed > 0 && <span className="ml-1.5 text-danger">({failed} failed)</span>}
              {isTerminal && published > 0 && total > 1 && (
                <span className="ml-1.5 text-linear-text-tertiary">({published}/{total} published)</span>
              )}
            </span>
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-linear-text-tertiary" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-linear-text-tertiary" aria-hidden="true" />
            )}
          </button>

          <div className="flex items-center gap-1">
            {!isStarting && isRunning && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { void requestStop(setCancelling) }}
                disabled={cancelling}
                className="h-7 text-xs text-linear-text-tertiary hover:text-danger"
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
                className="h-7 text-xs border-linear-border text-linear-text hover:bg-surface-pressed hover:border-linear-border-hover gap-1"
              >
                {approving ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <ArrowRight className="w-3 h-3" />
                )}
                Approve next
              </Button>
            )}
            {outcome.pullRequestUrl && !isRunning && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openExternal(outcome.pullRequestUrl!)}
                className="h-7 text-xs text-linear-accent hover:text-brand/80 gap-1.5"
              >
                <GitPullRequest className="w-3.5 h-3.5" />
                Open PR
                <ExternalLink className="w-3 h-3" />
              </Button>
            )}
            {!isRunning && onDismiss && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onDismiss}
                className="h-7 w-7 p-0 text-linear-text-tertiary hover:text-linear-text"
                aria-label="Dismiss batch summary"
              >
                <X className="w-3 h-3" />
              </Button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="flex gap-0.5 h-1.5" aria-hidden="true">
          {tasks.map((task, index) => (
            <div
              key={task.taskId}
              className={cn("flex-1 rounded-full first:rounded-l-full last:rounded-r-full transition-colors", phaseConfig[phases[index]!].bar)}
            />
          ))}
        </div>

        {showOutcome && (
          <div
            role="status"
            className={cn("mt-2.5 rounded-sm border p-2.5 text-xs space-y-2", tone.border, tone.bg)}
          >
            <p className={cn("font-medium", tone.text)}>{outcome.label}</p>
            {outcome.publicationError && (
              <p className="text-linear-text-secondary break-words">{outcome.publicationError}</p>
            )}
            {outcome.unconfirmedStops.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0" aria-hidden="true" />
                <span className="text-linear-text-secondary flex-1 min-w-0">
                  The agent stop wasn&apos;t confirmed for {outcome.unconfirmedStops.length === 1 ? '1 task' : `${outcome.unconfirmedStops.length} tasks`}.
                  {' '}{outcome.unconfirmedStops.length === 1 ? 'Its workspace stays' : 'Their workspaces stay'} reserved and nothing is published until the stop is confirmed.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={retryingStop}
                  onClick={() => { void requestStop(setRetryingStop).finally(() => setRetryingStop(false)) }}
                  className="h-7 text-xs border-linear-border text-linear-text hover:bg-surface-pressed gap-1"
                >
                  {retryingStop ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
                  Retry stop
                </Button>
              </div>
            )}
            {outcome.branchUrl && (
              <button
                type="button"
                onClick={() => openExternal(outcome.branchUrl!)}
                className="inline-flex items-center gap-1.5 text-linear-text hover:underline"
                title="A compare link shows the pushed branch; it is not a pull request"
              >
                <GitBranch className="w-3.5 h-3.5" aria-hidden="true" />
                Open pushed branch (no pull request)
                <ExternalLink className="w-3 h-3 opacity-70" aria-hidden="true" />
              </button>
            )}
            {outcome.retained.length > 0 && (
              <p className="text-linear-text-secondary">
                Work retained for {outcome.retained.length === 1 ? '1 task' : `${outcome.retained.length} tasks`}
                {expanded ? ' (branches below).' : ' — expand to see the branches.'}
              </p>
            )}
            {outcome.receiptPath && (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-linear-text-tertiary flex-shrink-0">Receipt</span>
                <span className="font-mono text-linear-text-secondary truncate" title={outcome.receiptPath}>{outcome.receiptPath}</span>
                <button
                  type="button"
                  onClick={() => void copyText(outcome.receiptPath!, "receipt path")}
                  className="flex-shrink-0 rounded-sm p-1 text-linear-text-tertiary hover:bg-linear-bg-tertiary hover:text-linear-text"
                  aria-label="Copy receipt path"
                >
                  <Copy className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Compact preview rows */}
        {isStarting && (
          <p className="mt-2.5 text-xs text-linear-text-secondary">
            Preparing the repository and agent session for the selected issues.
          </p>
        )}

        {!expanded && isCombined && isRunning && (
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
        <div className="border-t border-linear-border px-3 py-2.5 space-y-2">
          {isCombined && (
            <div className="rounded-sm border border-linear-border bg-linear-bg-secondary px-3 py-2.5 text-xs text-linear-text-secondary">
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
              phase={phases[index]!}
              onViewActivity={onViewActivity}
            />
          ))}
        </div>
      )}
    </div>
  )
}
