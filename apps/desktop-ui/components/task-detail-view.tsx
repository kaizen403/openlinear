"use client"

import { useCallback, useState, useEffect, useRef, type KeyboardEvent } from "react"
import { X, ArrowLeft, Bot, Clock, AlertTriangle, Flag, Tag, Folder, Square, Archive, Trash2, GitMerge, ExternalLink, Play, Check, Loader2, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { focusRing } from "@/components/ui/focus-ring"
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { MarkdownView } from "@/components/markdown-view"
import { CommentsThread } from "@/components/comments-thread"
import { cn, openExternal } from "@/lib/utils"
import { Task, ExecutionProgress, formatDuration, isActiveProgressStatus } from "@/types/task"
import { STATUS_COLORS, PRIORITY_COLORS } from "@/lib/design-tokens"
import { useExecutionProgress } from "@/lib/execution-state-store"
import { classifyPublicationUrl, describeTaskExecution } from "@/components/board/execution-outcome"
import { ExecutionOutcomePanel } from "@/components/board/execution-outcome-panel"
import { PhasePill } from "@/components/execution/run-header"
import { timelineConsumesEscape } from "@/components/execution/run-timeline"
import { EMPTY_RUN_SUMMARY, TaskRunSection, type RunSummary } from "@/components/execution/task-run-section"
import { RunnerSelect } from "@/components/execution/runner-select"
import { isRunnerId, RUNNER_LABELS } from "@/lib/api/runners"
import { useStopControl } from "@/components/execution/use-stop-control"
import { isLivePhase, isTerminalPhase } from "@/lib/run-model"
import { TaskReviewPanel, reviewConsumesEscape } from "@/components/review"
import { TaskDependenciesSection } from "@/components/board/task-dependencies"
import { RedirectControl } from "@/components/execution/redirect-control"
import { ApprovalRequests } from "@/components/execution/approval-requests"
import { TaskPlanLink } from "@/components/plans/task-plan-link"
import { RelatedFilesSection } from "@/components/related-files"
import { CONTINUE_INTERRUPTED_MESSAGE, sendTaskFollowUp } from "@/lib/api/review"
import { toastApiError } from "@/lib/api/errors"

interface TaskDetailViewProps {
  task: Task | null
  progress?: ExecutionProgress
  open: boolean
  onClose: () => void
  onDelete?: (taskId: string) => void
  deletionMode?: "archive" | "delete"
  /** May resolve false when the stop wasn't accepted, which re-enables Stop. */
  onCancel?: (taskId: string) => unknown
  onExecute?: (taskId: string) => void
  /** FE-10: run this task together with its unfinished blockers. */
  onRunWithBlockers?: (taskId: string) => void
  onUpdate?: (taskId: string, data: { title?: string; description?: string | null; agent?: string | null }) => void
  /** Ask the sidecar whether a PR now exists for a pushed branch (compare link). */
  onCheckPullRequest?: (taskId: string) => Promise<void>
  isExecuting?: boolean
  project?: { id: string; name: string; defaultAgent?: string | null } | null
}

const statusConfig = {
  todo: { label: 'Todo', color: STATUS_COLORS.todo.dot },
  in_progress: { label: 'In Progress', color: STATUS_COLORS.in_progress.dot },
  done: { label: 'Done', color: STATUS_COLORS.done.dot },
  cancelled: { label: 'Cancelled', color: STATUS_COLORS.cancelled.dot },
}

const priorityConfig = {
  low: { label: 'Low', color: PRIORITY_COLORS.low.text, dot: PRIORITY_COLORS.low.dot, icon: Flag },
  medium: { label: 'Medium', color: PRIORITY_COLORS.medium.text, dot: PRIORITY_COLORS.medium.dot, icon: Flag },
  high: { label: 'High', color: PRIORITY_COLORS.high.text, dot: PRIORITY_COLORS.high.dot, icon: AlertTriangle },
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function TaskDetailView({ task, progress, open, onClose, onDelete, deletionMode, onCancel, onExecute, onRunWithBlockers, onUpdate, onCheckPullRequest, isExecuting, project }: TaskDetailViewProps) {
  const titleInputRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const liveProgress = useExecutionProgress(task?.id)
  const currentProgress = progress ?? liveProgress
  const detailIsExecuting = !!isExecuting || (
    currentProgress ? isActiveProgressStatus(currentProgress.status) : false
  )
  // Execution: TaskRunSection owns the run model (store logs/progress, live
  // SSE events with ids, history, this task row) and reports a coarse summary,
  // so a streaming run doesn't re-render the rest of this page every frame.
  const [runSummary, setRunSummary] = useState<RunSummary>(EMPTY_RUN_SUMMARY)
  const runSummaryRef = useRef(runSummary)
  runSummaryRef.current = runSummary
  const taskIdRef = useRef(task?.id)
  taskIdRef.current = task?.id
  const stop = useStopControl({
    onStop: onCancel ? () => (taskIdRef.current ? onCancel(taskIdRef.current) : false) : null,
    wasRunFinished: () => isTerminalPhase(runSummaryRef.current.phase),
    resetKey: `${task?.id ?? ""}:${runSummary.attempt}`,
  })
  const latestAgentMessage = runSummary.conclusion
  // Review tab: mounted on first open, then kept (diff scroll, drafts editor).
  const [view, setView] = useState<"details" | "review">("details")
  const [reviewMounted, setReviewMounted] = useState(false)
  const [followUpPending, setFollowUpPending] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const activityRef = useRef<HTMLDivElement>(null)
  const followUpBaseline = useRef<{ attempt: number } | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDescription, setEditingDescription] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const [descriptionDraft, setDescriptionDraft] = useState("")
  // Tracks whether a save already fired this edit cycle so blur+Enter don't double-fire onUpdate.
  const titleSavedRef = useRef(false)
  const descriptionSavedRef = useRef(false)

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
      titleSavedRef.current = false
    }
  }, [editingTitle])

  useEffect(() => {
    if (editingDescription && descriptionRef.current) {
      descriptionRef.current.focus()
      descriptionSavedRef.current = false
    }
  }, [editingDescription])

  useEffect(() => {
    setEditingTitle(false)
    setEditingDescription(false)
    setView("details")
    setReviewMounted(false)
    setFollowUpPending(false)
    setContinuing(false)
  }, [task?.id])

  // A sent follow-up shows as "Queued" until its run reports in.
  useEffect(() => {
    const baseline = followUpBaseline.current
    if (!followUpPending || !baseline) return
    if (runSummary.attempt !== baseline.attempt || (isLivePhase(runSummary.phase) && runSummary.phase !== "queued")) {
      followUpBaseline.current = null
      setFollowUpPending(false)
    }
  }, [followUpPending, runSummary.attempt, runSummary.phase])

  const openView = (next: "details" | "review") => {
    if (next === "review") setReviewMounted(true)
    setView(next)
  }
  // FE-06 recovery actions (stable: TaskRunSection is memoized).
  const inspectWork = useCallback(() => {
    setReviewMounted(true)
    setView("review")
  }, [])
  const onExecuteRef = useRef(onExecute)
  onExecuteRef.current = onExecute
  const runAgain = useCallback(() => {
    const id = taskIdRef.current
    if (id) onExecuteRef.current?.(id)
  }, [])
  // W12: an interrupted run continues as a follow-up turn on the agent's saved session (user-initiated, never automatic).
  // `runId` is the run on screen: the sidecar refuses (FOLLOW_UP_RUN_MISMATCH) when it isn't its latest local run.
  // The detail view stays open while j/k moves to another task: only the task that was continued is updated.
  const continueRun = useCallback((runId: string) => {
    const id = taskIdRef.current
    if (!id) return
    const stillOpen = () => taskIdRef.current === id
    setContinuing(true)
    sendTaskFollowUp(id, { message: CONTINUE_INTERRUPTED_MESSAGE, comments: [], parentRunId: runId })
      .then(() => {
        if (!stillOpen()) return
        followUpBaseline.current = { attempt: runSummaryRef.current.attempt }
        setFollowUpPending(true)
      })
      .catch((error: unknown) => toastApiError(error, { fallbackMessage: "Couldn't continue the run" }))
      .finally(() => {
        if (stillOpen()) setContinuing(false)
      })
  }, [])
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const next = view === "details" ? "review" : "details"
    openView(next)
    document.getElementById(`task-detail-tab-${next}`)?.focus()
  }

  const saveTitle = () => {
    if (titleSavedRef.current) {
      setEditingTitle(false)
      return
    }
    titleSavedRef.current = true
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== task?.title && onUpdate && task) {
      onUpdate(task.id, { title: trimmed })
    }
    setEditingTitle(false)
  }

  const saveDescription = () => {
    if (descriptionSavedRef.current) {
      setEditingDescription(false)
      return
    }
    descriptionSavedRef.current = true
    if (!task || !onUpdate) { setEditingDescription(false); return }
    const value = descriptionDraft.trim() || null
    if (value !== (task.description || null)) {
      onUpdate(task.id, { description: value })
    }
    setEditingDescription(false)
  }

  // Esc inside an inline editor should cancel the edit, not close the Sheet.
  // Stop propagation so Radix's outer Esc handler doesn't also fire.
  const cancelTitleEdit = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    titleSavedRef.current = true
    setEditingTitle(false)
  }
  const cancelDescriptionEdit = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    descriptionSavedRef.current = true
    setEditingDescription(false)
  }

  if (!task) {
    return null
  }

  const statusInfo = statusConfig[task.status]
  const priorityInfo = priorityConfig[task.priority]
  const PriorityIcon = priorityInfo.icon
  const projectName = project?.name ?? 'No project'
  const executionOutcome = describeTaskExecution(task, currentProgress)
  const showOutcomePanel = task.status === 'done'
    ? executionOutcome.kind === 'branch_evidence'
    : executionOutcome.kind !== 'none'
  const progressLinkKind = classifyPublicationUrl(currentProgress?.prUrl)
  const stopping = stop.state.status === 'requested'
  const stopUnconfirmed = stop.state.status === 'unconfirmed'
  // A stop that wasn't confirmed keeps the Stop control (as "Retry stop") even
  // after the task row moved on: the agent may still be running.
  const showStopControl = Boolean(onCancel) && (detailIsExecuting || stopping || stopUnconfirmed)
  // W12: redirect once the agent is actually working (a queued or preparing run has no worktree to continue).
  const canRedirect = !stopping && !stopUnconfirmed && isLivePhase(runSummary.phase) && runSummary.phase !== "queued" && runSummary.phase !== "preparing"

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent
        side="right"
        // Override default narrow width; this is a full task detail panel, not a settings drawer.
        className="w-full sm:max-w-none md:w-[860px] lg:w-[960px] xl:w-[1100px] p-0 bg-linear-bg border-linear-border flex flex-col"
        // Escape on an expanded timeline row collapses the row, not the sheet.
        onEscapeKeyDown={(event) => { if (timelineConsumesEscape(event) || reviewConsumesEscape(event)) event.preventDefault() }}
        // Let Radix's default focus-on-open behavior run (don't preventDefault
        // here): previously focus was left on whatever was focused before the
        // sheet opened (usually the board behind it), so keydown events never
        // entered the sheet's DOM subtree and the board's global keyboard
        // shortcuts (e.g. 'd'/Backspace to delete) fired instead of whatever
        // the user meant to type inside the sheet.
      >
        <SheetTitle className="sr-only">{task.title}</SheetTitle>
        <SheetDescription className="sr-only">Task detail view for {task.identifier || task.id}</SheetDescription>

        <header className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-linear-border">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-linear-text-secondary hover:text-linear-text"
              onClick={onClose}
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
            <span className="text-sm text-linear-text-tertiary font-mono">
              {task.identifier || task.id.slice(0, 8)}
            </span>
            <div role="tablist" aria-label="Task views" className="ml-1 flex rounded-sm border border-border p-0.5">
              {(["details", "review"] as const).map((value) => (
                <button
                  key={value}
                  id={`task-detail-tab-${value}`}
                  type="button"
                  role="tab"
                  aria-selected={view === value}
                  aria-controls={`task-detail-panel-${value}`}
                  tabIndex={view === value ? 0 : -1}
                  onClick={() => openView(value)}
                  onKeyDown={onTabKeyDown}
                  className={cn(
                    "h-6 rounded-[3px] px-2 text-xs",
                    focusRing,
                    view === value ? "bg-foreground/10 text-foreground" : "text-linear-text-secondary hover:text-foreground",
                  )}
                >
                  {value === "details" ? "Details" : "Review changes"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            {showStopControl && canRedirect && (
              <RedirectControl
                taskId={task.id}
                disabled={stopping}
                onRedirected={() => {
                  followUpBaseline.current = { attempt: runSummaryRef.current.attempt }
                  setFollowUpPending(true)
                }}
              />
            )}
            {showStopControl ? (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 px-2 sm:px-3 hover:text-warning hover:bg-warning/10",
                  stopUnconfirmed ? "text-warning" : "text-linear-text-secondary",
                )}
                disabled={stopping}
                onClick={stop.request}
                aria-label={stopping ? "Stopping" : stopUnconfirmed ? "Retry stop" : "Stop run"}
              >
                {stopping ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 motion-safe:animate-spin" />
                    <span className="hidden sm:inline">Stopping</span>
                  </>
                ) : stopUnconfirmed ? (
                  <>
                    <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                    <span className="hidden sm:inline">Retry stop</span>
                  </>
                ) : (
                  <>
                    <Square className="h-3.5 w-3.5 mr-1.5 fill-current" />
                    <span className="hidden sm:inline">Stop</span>
                  </>
                )}
              </Button>
            ) : detailIsExecuting ? null : (
              task.status !== 'done' && onExecute && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 sm:px-3 text-linear-text-secondary hover:text-success hover:bg-success/10"
                  onClick={() => onExecute(task.id)}
                >
                  <Play className="h-3.5 w-3.5 mr-1.5 fill-current" />
                  <span className="hidden sm:inline">Execute</span>
                </Button>
              )
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 sm:px-3 text-linear-text-secondary hover:text-linear-accent hover:bg-linear-accent/10"
                onClick={() => onDelete(task.id)}
              >
                {deletionMode === "delete" ? (
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                ) : (
                  <Archive className="h-3.5 w-3.5 mr-1.5" />
                )}
                <span className="hidden sm:inline">
                  {deletionMode === "delete" ? "Delete" : "Archive"}
                </span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-linear-text-secondary hover:text-linear-text"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {reviewMounted && (
          <div id="task-detail-panel-review" role="tabpanel" aria-labelledby="task-detail-tab-review" hidden={view !== "review"} className="flex-1 min-h-0 overflow-hidden">
            <TaskReviewPanel
              key={task.id}
              task={task}
              phase={runSummary.phase}
              progress={currentProgress ?? null}
              onFollowUpStarted={() => {
                followUpBaseline.current = { attempt: runSummary.attempt }
                setFollowUpPending(true)
                setView("details")
                requestAnimationFrame(() => activityRef.current?.scrollIntoView?.({ block: "start" }))
              }}
            />
          </div>
        )}

        <div id="task-detail-panel-details" role="tabpanel" aria-labelledby="task-detail-tab-details" hidden={view !== "details"} className="flex-1 overflow-hidden">
            <div className="flex flex-col md:flex-row h-full">
            <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-start gap-3 mb-6">
                  <div className={cn("w-2.5 h-2.5 rounded-full mt-2 flex-shrink-0", priorityConfig[task.priority].dot)} />
                  {editingTitle ? (
                    <input
                      ref={titleInputRef}
                      className="flex-1 text-2xl font-medium text-linear-text leading-tight bg-transparent border-b border-linear-accent outline-none"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={saveTitle}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          saveTitle()
                        }
                        if (e.key === 'Escape') cancelTitleEdit(e)
                      }}
                    />
                  ) : (
                    <h1
                      className="text-2xl font-medium text-linear-text leading-tight flex-1 cursor-text hover:text-linear-text-secondary"
                      onClick={() => {
                        setTitleDraft(task.title)
                        setEditingTitle(true)
                      }}
                    >
                      {task.title}
                    </h1>
                  )}
                </div>

                {task.status === 'done' && (
                  <div className="mb-6 p-4 bg-linear-bg-secondary border border-linear-border rounded-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-6 h-6 rounded-full bg-success/20 flex items-center justify-center">
                        <Check className="w-4 h-4 text-success" />
                      </div>
                      <span className="text-sm font-medium text-linear-text">Task Completed</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-linear-text-secondary">
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        Total time: {formatDuration(task.executionElapsedMs)}
                      </span>
                    </div>
                    {executionOutcome.pullRequestUrl && (
                      <button
                        type="button"
                        onClick={() => openExternal(executionOutcome.pullRequestUrl!)}
                        className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-sm text-xs font-medium text-white bg-linear-accent hover:bg-linear-accent/90 transition-colors"
                      >
                        <GitMerge className="w-3.5 h-3.5" />
                        View Pull Request
                        <ExternalLink className="w-3 h-3 opacity-70" />
                      </button>
                    )}
                    {task.outcome && (
                      <div className="mt-3 pt-3 border-t border-linear-border">
                        <p className="text-sm text-linear-text-secondary">{task.outcome}</p>
                      </div>
                    )}
                    {latestAgentMessage && (
                      <div className="mt-3 pt-3 border-t border-linear-border">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Bot className="w-3.5 h-3.5 text-linear-accent" />
                          <span className="text-xs font-medium text-linear-text-tertiary uppercase tracking-wide">Conclusion</span>
                        </div>
                        <p className="text-sm text-linear-text-secondary leading-relaxed whitespace-pre-wrap">{latestAgentMessage}</p>
                      </div>
                    )}
                  </div>
                )}

                {showOutcomePanel && (
                  <ExecutionOutcomePanel
                    className="mb-6"
                    outcome={executionOutcome}
                    onCheckPullRequest={onCheckPullRequest ? () => onCheckPullRequest(task.id) : undefined}
                  />
                )}

                <div className="mb-8">
                  {editingDescription ? (
                    <textarea
                      ref={descriptionRef}
                      className="w-full text-sm text-linear-text-secondary leading-relaxed bg-transparent border border-linear-border rounded-sm p-2 outline-none focus:border-linear-border-hover resize-y min-h-[80px]"
                      value={descriptionDraft}
                      onChange={(e) => setDescriptionDraft(e.target.value)}
                      onBlur={saveDescription}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') cancelDescriptionEdit(e)
                        // ⌘+Enter (or Ctrl+Enter) saves description, mirroring task-form behavior.
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          saveDescription()
                        }
                      }}
                      rows={4}
                    />
                  ) : task.description ? (
                    <div
                      className="cursor-text rounded-sm -mx-2 px-2 py-1 hover:bg-linear-bg-secondary/40"
                      onClick={(e) => {
                        // Don't enter edit mode when clicking embedded markdown links.
                        const target = e.target as HTMLElement
                        if (target.tagName === 'A' || target.closest('a')) return
                        setDescriptionDraft(task.description || "")
                        setEditingDescription(true)
                      }}
                    >
                      <MarkdownView body={task.description} />
                    </div>
                  ) : (
                    <button
                      className="text-sm text-linear-text-tertiary hover:text-linear-text-secondary"
                      onClick={() => {
                        setDescriptionDraft("")
                        setEditingDescription(true)
                      }}
                    >
                      Add description...
                    </button>
                  )}
                </div>

                <CommentsThread taskId={task.id} />

                <div ref={activityRef} className="border-t border-linear-border pt-6">
                  <h2 className="text-sm font-medium text-linear-text-secondary mb-4 flex items-center gap-2">
                    <span className="w-1 h-1 rounded-full bg-linear-text-secondary" aria-hidden="true" />
                    Activity
                  </h2>

                  <ApprovalRequests taskId={task.id} active={detailIsExecuting} />
                  <TaskRunSection
                    key={task.id}
                    task={task}
                    progress={currentProgress ?? null}
                    startRequested={!!isExecuting || followUpPending}
                    stop={stop.state}
                    onSummaryChange={setRunSummary}
                    timelineClassName="max-h-[300px] sm:max-h-[400px]"
                    onInspectWork={inspectWork}
                    onRunAgain={runAgain}
                    onContinue={continueRun}
                    continuing={continuing}
                  />
                </div>
              </div>
            </main>

            <aside className="w-full md:w-72 flex-shrink-0 border-t md:border-t-0 md:border-l border-linear-border bg-linear-bg-secondary overflow-y-auto">
              <div className="p-4 space-y-6">
                <div>
                  <h3 className="text-xs font-medium text-linear-text-tertiary uppercase tracking-wider mb-3">
                    Properties
                  </h3>
                  
                  <div className="space-y-3">
                    <div className="flex items-center justify-between py-2 border-b border-linear-border">
                      <span className="text-sm text-linear-text-secondary">Status</span>
                      <div className="flex items-center gap-2">
                        <div className={cn("w-2 h-2 rounded-full", statusInfo.color)} />
                        <span className="text-sm text-linear-text">{statusInfo.label}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between py-2 border-b border-linear-border">
                      <span className="text-sm text-linear-text-secondary">Priority</span>
                      <div className="flex items-center gap-2">
                        <PriorityIcon className={cn("w-3.5 h-3.5", priorityInfo.color)} />
                        <span className="text-sm text-linear-text">{priorityInfo.label}</span>
                      </div>
                    </div>

                    <div className="py-2 border-b border-linear-border">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-linear-text-secondary">Labels</span>
                        <button className="text-linear-text-tertiary hover:text-linear-text transition-colors">
                          <Tag className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {task.labels.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {task.labels.map((label) => (
                            <span
                              key={label.id}
                              className="text-[11px] px-2 py-0.5 h-5 font-medium rounded-[4px] inline-flex items-center backdrop-blur-sm border border-linear-border"
                              style={{ 
                                backgroundColor: `${label.color}20`,
                                color: label.color
                              }}
                            >
                              {label.name}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-linear-text-tertiary">No labels</span>
                      )}
                    </div>

                    <div className="py-2 border-b border-linear-border">
                      <span className="text-sm text-linear-text-secondary block mb-2">Agent</span>
                      <RunnerSelect
                        aria-label="Agent for this task"
                        value={task.agent ?? null}
                        inheritLabel={`Project default (${isRunnerId(project?.defaultAgent) ? RUNNER_LABELS[project.defaultAgent] : "OpenCode"})`}
                        disabled={!onUpdate || detailIsExecuting}
                        onChange={(agent) => onUpdate?.(task.id, { agent })}
                      />
                    </div>

                    <div className="py-2 border-b border-linear-border">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-linear-text-secondary">Project</span>
                        <Folder className="w-3.5 h-3.5 text-linear-text-tertiary" />
                      </div>
                      <span className="text-sm text-linear-text">{projectName}</span>
                    </div>

                    <TaskPlanLink taskId={task.id} projectId={task.projectId ?? project?.id ?? null} />

                    <div className="py-2">
                      <span className="text-sm text-linear-text-secondary block mb-1">Created</span>
                      <span className="text-xs text-linear-text-tertiary">
                        {formatDate(task.createdAt)} at {formatTime(task.createdAt)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-linear-border">
                  <TaskDependenciesSection
                    taskId={task.id}
                    projectId={task.projectId ?? project?.id ?? null}
                    onRunWithBlockers={onRunWithBlockers && !detailIsExecuting && task.status !== 'done' ? () => onRunWithBlockers(task.id) : undefined}
                  />
                </div>

                <RelatedFilesSection taskId={task.id} task={task} />

                {currentProgress && (
                  <div className="pt-4 border-t border-linear-border">
                    <h3 className="text-xs font-medium text-linear-text-secondary uppercase tracking-wider mb-3">
                      Execution
                    </h3>
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <PhasePill snapshot={runSummary} />
                        <span className="min-w-0 text-sm text-linear-text">{currentProgress.message}</span>
                      </div>
                      {currentProgress.prUrl && (
                        <button
                          type="button"
                          onClick={() => openExternal(currentProgress.prUrl!)}
                          className="inline-flex items-center gap-1 text-xs text-linear-accent hover:underline mt-2"
                          title={progressLinkKind === 'compare' || currentProgress.isCompareLink ? 'Branch comparison — no pull request was confirmed' : undefined}
                        >
                          {progressLinkKind === 'compare' || currentProgress.isCompareLink
                            ? 'Compare branch (no pull request yet) →'
                            : progressLinkKind === 'pull_request' ? 'View Pull Request →' : 'Open link →'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
