"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react"
import { toast } from "sonner"
import { GitBranch, Loader2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRing } from "@/components/ui/focus-ring"
import { isEditableTarget } from "@/components/board/keyboard-guards"
import { describeTaskExecution } from "@/components/board/execution-outcome"
import { isLivePhase, type RunPhase } from "@/lib/run-model"
import type { FollowUpResponse } from "@/lib/api/review"
import type { ExecutionProgress, Task } from "@/types/task"
import { buildDiffRows, lineTextAt, sameTarget, type CommentTarget, type ViewMode } from "./model/rows"
import { deriveReviewGate, type ReviewOverride } from "./model/checks"
import { browserDraftStorage, type DraftComment, type DraftStorage } from "./model/drafts"
import { planFollowUp, type FollowUpPlan } from "./model/follow-up"
import { describeReviewError, type ReviewErrorView } from "./review-errors"
import { forgetSentDrafts, useFollowUp, useReviewDrafts, useTaskDiff, useTaskRunState } from "./use-review-data"
import { DiffViewer, type DiffViewerHandle } from "./diff-viewer"
import { FileTree } from "./file-tree"
import { ChecksPanel } from "./checks-panel"
import { AgentReviewSection } from "./agent-review"
import { findingComment } from "./model/agent-review"
import type { AgentReviewFinding } from "@/lib/api/agent-reviews"
import { ReviewComposer } from "./review-composer"
import type { CommentActions } from "./comment-thread"
import { followUpIssueFrom, followUpIssueKey } from "./model/follow-up-issue"
import { bulkCreateTasks } from "@/lib/api/task-commands"
import { toastApiError } from "@/lib/api/errors"
import { ADDITIONS_TEXT, DELETIONS_TEXT, TEXT, TONE } from "./diff-colors"

export const VIEW_MODE_STORAGE_KEY = "openlinear:review-view-mode"

function readViewMode(storage: DraftStorage | null): ViewMode {
  try {
    return storage?.getItem(VIEW_MODE_STORAGE_KEY) === "split" ? "split" : "unified"
  } catch {
    return "unified"
  }
}

const SAFE_BASE = /^(?:[A-Za-z0-9._/-]+)$/
function validBase(value: string): boolean {
  return SAFE_BASE.test(value) && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") && !value.includes("..")
}

export interface TaskReviewPanelProps {
  task: Pick<Task, "id" | "status" | "outcome" | "prUrl" | "batchId"> & Partial<Pick<Task, "projectId" | "identifier">>
  /** The run model's phase for this task (from TaskRunSection's summary). */
  phase: RunPhase
  progress?: ExecutionProgress | null
  /** A follow-up was accepted: show its run. */
  onFollowUpStarted?: (response: FollowUpResponse) => void
  className?: string
  /** Test seams. */
  storage?: DraftStorage | null
  onOpenUrl?: (url: string) => void
}

/**
 * The review loop for one task: what the agent changed (file tree + virtualized
 * unified/split diff), inline draft comments sent back as a follow-up run, and
 * the checks that gate publishing. Keyboard: j/k files · n/p hunks · ↑/↓ lines ·
 * c comment · Enter collapses a file.
 */
export function TaskReviewPanel({ task, phase, progress = null, onFollowUpStarted, className, storage = browserDraftStorage(), onOpenUrl }: TaskReviewPanelProps) {
  const taskId = task.id
  const live = isLivePhase(phase)
  const [base, setBase] = useState<string | null>(null)
  const [mode, setModeState] = useState<ViewMode>(() => readViewMode(storage))
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [editing, setEditing] = useState<CommentTarget | null>(null)
  const [override, setOverride] = useState<ReviewOverride | null>(null)
  const [currentFileIndex, setCurrentFileIndex] = useState(0)
  const [localError, setLocalError] = useState<string | null>(null)
  const viewerRef = useRef<DiffViewerHandle>(null)

  const diffQuery = useTaskDiff({ taskId, base, live })
  const runStateQuery = useTaskRunState(taskId, live)
  const { drafts, dispatch, persisted } = useReviewDrafts(taskId, storage)
  const diff = diffQuery.data ?? null
  const files = useMemo(() => diff?.files ?? [], [diff])
  const revision = diff?.revision ?? null

  const setMode = useCallback(
    (next: ViewMode) => {
      setModeState(next)
      try {
        storage?.setItem(VIEW_MODE_STORAGE_KEY, next)
      } catch {
        // Preference only.
      }
    },
    [storage],
  )

  const model = useMemo(
    () => buildDiffRows({ files, mode, collapsed, comments: drafts.comments, editing }),
    [files, mode, collapsed, drafts.comments, editing],
  )
  const modelRef = useRef(model)
  modelRef.current = model

  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const comment of drafts.comments) counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1)
    return counts
  }, [drafts.comments])

  // After a comment is saved or cancelled, return focus to its line.
  const refocusTarget = useRef<CommentTarget | null>(null)
  useEffect(() => {
    const target = refocusTarget.current
    if (!target) return
    refocusTarget.current = null
    const index = model.rows.findIndex((row) =>
      (row.kind === "line" && sameTarget(row.anchor, target)) ||
      (row.kind === "pair" && (sameTarget(row.rightAnchor, target) || sameTarget(row.leftAnchor, target))) ||
      (row.kind === "file" && target.line === undefined && row.file.path === target.path))
    if (index >= 0) viewerRef.current?.focusRow(index)
  }, [model])

  const filesRef = useRef(files)
  filesRef.current = files
  const revisionRef = useRef(revision)
  revisionRef.current = revision
  const editingRef = useRef(editing)
  editingRef.current = editing

  // FE-12: one click turns a comment into a sub-issue (kept evidence: path, line, commit, code).
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const headShaRef = useRef<string | null>(null)
  headShaRef.current = diff?.head.sha ?? null
  const promoting = useRef(new Set<string>())
  const projectId = task.projectId ?? null
  const identifier = task.identifier ?? null
  const promote = useCallback(async (id: string) => {
    const comment = draftsRef.current.comments.find((candidate) => candidate.id === id)
    if (!comment || !projectId || promoting.current.has(id)) return
    promoting.current.add(id)
    try {
      const issue = followUpIssueFrom(comment, { identifier, headSha: headShaRef.current })
      const result = await bulkCreateTasks({ projectId, tasks: [{ title: issue.title, description: issue.description, parentId: taskId }] }, followUpIssueKey(comment))
      const created = result.created[0]
      if (!created) {
        toast.error("Couldn't create the issue", { description: result.failed[0]?.error })
        return
      }
      dispatch({ type: "remove", id })
      toast.success(`Created ${created.identifier ?? "an issue"}`, { description: "A sub-issue of this task, with the comment, file, line and commit." })
    } catch (error) {
      toastApiError(error, { fallbackMessage: "Couldn't create the issue" })
    } finally {
      promoting.current.delete(id)
    }
  }, [dispatch, identifier, projectId, taskId])

  const actions = useMemo<CommentActions>(
    () => ({
      start: (target) => {
        setCollapsed((previous) => {
          if (!previous.has(target.path)) return previous
          const next = new Set(previous)
          next.delete(target.path)
          return next
        })
        setEditing(target)
      },
      cancel: () => {
        refocusTarget.current = editingRef.current
        setEditing(null)
      },
      save: (target, body) => {
        const file = filesRef.current.find((candidate) => candidate.path === target.path)
        const excerpt = lineTextAt(file, target)
        dispatch({
          type: "add",
          comment: { path: target.path, line: target.line, side: target.side, body, revision: revisionRef.current, ...(excerpt !== undefined ? { excerpt } : {}) },
        })
        refocusTarget.current = target
        setEditing(null)
      },
      edit: (id, body) => dispatch({ type: "edit", id, body }),
      remove: (id) => dispatch({ type: "remove", id }),
      ...(projectId ? { promote: (id: string) => { void promote(id) } } : {}),
    }),
    [dispatch, projectId, promote],
  )

  const toggleFile = useCallback((path: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const onSent = useCallback(
    (plan: FollowUpPlan, response: FollowUpResponse) => {
      dispatch({ type: "sent", commentIds: plan.commentIds, clearMessage: true })
      forgetSentDrafts(taskId, plan.commentIds, storage)
      const count = plan.commentIds.length
      toast.success("Sent to the agent", {
        description: `${count > 0 ? `${count} comment${count === 1 ? "" : "s"}` : "Your message"} went to a new run${response.state === "queued" ? " (queued)" : ""}.`,
      })
      onFollowUpStarted?.(response)
    },
    [dispatch, onFollowUpStarted, storage, taskId],
  )
  const followUp = useFollowUp({ taskId, onSent })

  const send = useCallback(() => {
    const result = planFollowUp(drafts, revisionRef.current)
    if (!result.ok) {
      setLocalError(result.error)
      return
    }
    setLocalError(null)
    followUp.mutate(result.plan)
  }, [drafts, followUp])

  const outcome = describeTaskExecution(task, progress)
  const gate = deriveReviewGate({
    phase,
    runState: runStateQuery.data ?? null,
    revision,
    headSha: diff?.head.sha ?? null,
    headDirty: diff?.head.dirty ?? false,
    diffTruncated: diff?.truncated ?? false,
    draftCount: drafts.comments.length,
    outcome,
  })

  const composerError: ReviewErrorView | null = followUp.error
    ? describeReviewError(followUp.error, "follow-up")
    : localError ? { kind: "invalid", code: null, title: localError, retryable: false } : null

  const jumpToComment = useCallback((comment: DraftComment) => {
    if (!filesRef.current.some((file) => file.path === comment.path)) return
    setCollapsed((previous) => {
      if (!previous.has(comment.path)) return previous
      const next = new Set(previous)
      next.delete(comment.path)
      return next
    })
    // A collapsed file re-renders its rows first; the refocus effect then finds the line.
    refocusTarget.current = { path: comment.path, ...(comment.line !== undefined ? { line: comment.line, side: comment.side ?? "new" } : {}) }
    const index = modelRef.current.rows.findIndex((row) => row.kind === "thread" && row.comments.some((candidate) => candidate.id === comment.id))
    if (index >= 0) {
      refocusTarget.current = null
      viewerRef.current?.focusRow(index)
    }
  }, [])

  // W19a: an agent review finding becomes the user's own draft comment, or is shown in the diff.
  const addFindingComment = useCallback((finding: AgentReviewFinding) => {
    dispatch({ type: "add", comment: findingComment(finding, revisionRef.current) })
    toast.success("Added to your comments", { description: "It goes to the agent with your next follow-up." })
  }, [dispatch])
  const jumpToFinding = useCallback((finding: AgentReviewFinding) => {
    const fileIndex = filesRef.current.findIndex((file) => file.path === finding.file)
    if (fileIndex < 0) {
      toast.message(`${finding.file} isn't part of the change shown here`)
      return
    }
    setCollapsed((previous) => {
      if (!previous.has(finding.file)) return previous
      const next = new Set(previous)
      next.delete(finding.file)
      return next
    })
    const target: CommentTarget = { path: finding.file, line: finding.startLine, side: "new" }
    const index = modelRef.current.rows.findIndex((row) =>
      (row.kind === "line" && sameTarget(row.anchor, target)) || (row.kind === "pair" && sameTarget(row.rightAnchor, target)))
    if (index >= 0) viewerRef.current?.focusRow(index)
    else viewerRef.current?.focusFile(fileIndex)
  }, [])

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return
    if (event.key === "j" || event.key === "k" || event.key === "n" || event.key === "p") {
      if (viewerRef.current?.navigate(event.key)) event.preventDefault()
    }
  }

  // ── Base selection ────────────────────────────────────────────────────────
  const [editingBase, setEditingBase] = useState(false)
  const [baseDraft, setBaseDraft] = useState("")
  const baseInvalid = baseDraft.trim().length > 0 && !validBase(baseDraft.trim())
  const submitBase = (event: FormEvent) => {
    event.preventDefault()
    const value = baseDraft.trim()
    if (value && !validBase(value)) return
    setBase(value || null)
    setEditingBase(false)
  }

  const error = diffQuery.error ? describeReviewError(diffQuery.error, "diff") : null
  const neverRan = phase === "idle" && !diff
  const blockedReason = live ? "The agent is working on this task. Send your review when the run finishes, or stop it first." : null

  let body: ReactNode
  if (diffQuery.isPending && !error) {
    body = (
      <div className="space-y-2 p-4" role="status" aria-label="Loading the diff">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="h-4 rounded-sm bg-foreground/[0.04] motion-safe:animate-pulse" style={{ width: `${40 + ((index * 37) % 55)}%` }} />
        ))}
      </div>
    )
  } else if (error && !diff) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" role="alert">
        <p className="text-sm font-medium text-foreground">{neverRan && error.kind === "workspace_missing" ? "This task hasn't run yet" : error.title}</p>
        <p className={cn("max-w-md text-[13px] leading-5", TEXT.secondary)}>
          {neverRan && error.kind === "workspace_missing" ? "Run it, then review what the agent changed here." : error.hint}
        </p>
        {error.retryable && (
          <button type="button" onClick={() => void diffQuery.refetch()} className={cn("mt-1 h-7 rounded-sm border border-border px-3 text-xs text-foreground hover:bg-foreground/5", focusRing)}>
            Retry
          </button>
        )}
      </div>
    )
  } else if (files.length === 0) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center" role="status">
        <p className="text-sm font-medium text-foreground">{live ? "No changes yet" : "No changes"}</p>
        <p className={cn("text-[13px]", TEXT.secondary)}>
          {live ? "The agent hasn't changed any files yet. This view refreshes while it works." : "The agent didn't change any files against this base."}
        </p>
      </div>
    )
  } else {
    body = (
      <DiffViewer
        ref={viewerRef}
        model={model}
        files={files}
        mode={mode}
        revision={revision}
        actions={actions}
        onToggleFile={toggleFile}
        onCurrentFileChange={setCurrentFileIndex}
        className="h-full"
        label={`Changes in ${files.length} file${files.length === 1 ? "" : "s"}`}
      />
    )
  }

  return (
    <div data-review-panel="" onKeyDown={onPanelKeyDown} className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2">
        <h2 className="sr-only">Review changes</h2>
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[12px]">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-linear-text-secondary" aria-hidden="true" />
          {editingBase ? (
            <form onSubmit={submitBase} className="flex items-center gap-1" aria-label="Change base">
              <label htmlFor={`review-base-${taskId}`} className="sr-only">Base branch or commit</label>
              <input
                id={`review-base-${taskId}`}
                autoFocus
                value={baseDraft}
                onChange={(event) => setBaseDraft(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === "Escape") setEditingBase(false)
                }}
                aria-invalid={baseInvalid}
                placeholder={diff?.base.ref ?? "origin/main"}
                data-review-escape=""
                className={cn("h-6 w-36 rounded-sm border bg-background px-1.5 text-[12px] text-foreground", baseInvalid ? "border-destructive/60" : "border-border", focusRing)}
              />
              <button type="submit" disabled={baseInvalid} className={cn("h-6 rounded-sm px-1.5 text-[11px] text-foreground hover:bg-foreground/5 disabled:opacity-50", focusRing)}>Apply</button>
              {base && (
                <button type="button" onClick={() => { setBase(null); setEditingBase(false) }} className={cn("h-6 rounded-sm px-1.5 text-[11px] text-linear-text-secondary hover:bg-foreground/5", focusRing)}>
                  Reset
                </button>
              )}
            </form>
          ) : (
            <button
              type="button"
              onClick={() => { setBaseDraft(base ?? ""); setEditingBase(true) }}
              title="Change the base to compare against"
              aria-label={`Base ${diff?.base.ref ?? "default"}${diff?.base.sha ? ` at ${diff.base.sha.slice(0, 7)}` : ""}. Change base`}
              className={cn("truncate rounded-sm px-1 text-linear-text-secondary hover:bg-foreground/5 hover:text-foreground", focusRing)}
            >
              {diff?.base.ref ?? base ?? "base"}
            </button>
          )}
          <span className="text-linear-text-secondary" aria-hidden="true">←</span>
          <span className="truncate text-foreground" title={diff?.head.sha ?? undefined}>
            {diff ? (diff.head.ref ?? diff.head.sha?.slice(0, 7) ?? "workspace") : "…"}
          </span>
          {diff?.head.dirty && <span className={cn("shrink-0 font-sans text-[11px]", TONE.warning.text)}>+ uncommitted</span>}
        </div>
        {diff && (
          <p className="flex items-center gap-2 text-[12px]" aria-label={`${diff.stats.files} files changed, ${diff.stats.additions} added lines, ${diff.stats.deletions} removed lines`}>
            <span className="text-linear-text-secondary" aria-hidden="true">{diff.stats.files} file{diff.stats.files === 1 ? "" : "s"}</span>
            <span className={cn("font-mono", ADDITIONS_TEXT)} aria-hidden="true">+{diff.stats.additions}</span>
            <span className={cn("font-mono", DELETIONS_TEXT)} aria-hidden="true">−{diff.stats.deletions}</span>
            {diff.truncated && <span className={TONE.warning.text}>· partially shown</span>}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className={cn("hidden text-[11px] lg:inline", TEXT.muted)} aria-hidden="true">j/k files · n/p changes · c comment</span>
          <div role="group" aria-label="Diff layout" className="flex rounded-sm border border-border p-0.5">
            {(["unified", "split"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  "h-6 rounded-[3px] px-2 text-[12px] capitalize",
                  mode === value ? "bg-foreground/10 text-foreground" : "text-linear-text-secondary hover:text-foreground",
                  focusRing,
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void diffQuery.refetch()}
            aria-label={diffQuery.isFetching ? "Refreshing the diff" : "Refresh the diff"}
            className={cn("rounded-sm p-1 text-linear-text-secondary hover:bg-foreground/5 hover:text-foreground", focusRing)}
          >
            {diffQuery.isFetching ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        </div>
        {error && diff && (
          <p role="alert" className={cn("w-full text-[12px]", TONE.warning.text)}>
            Showing the last loaded diff. {error.title}.{error.hint ? ` ${error.hint}` : ""}
          </p>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside aria-label="Checks and files" className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border bg-card md:max-h-none md:w-64 md:border-b-0 md:border-r">
          <ChecksPanel
            gate={gate}
            outcome={outcome}
            override={override}
            onOverrideChange={setOverride}
            onOpenUrl={onOpenUrl}
            runStateError={runStateQuery.error ? describeReviewError(runStateQuery.error, "run").title : null}
          />
          {(diff || !neverRan) && (
            <AgentReviewSection
              taskId={taskId}
              projectId={projectId}
              identifier={identifier}
              live={live}
              onComment={addFindingComment}
              onJump={jumpToFinding}
            />
          )}
          {files.length > 0 && (
            <div className="border-t border-border pb-2">
              <h3 className="px-3 pb-1 pt-3 text-[12px] font-medium uppercase tracking-wide text-linear-text-secondary">
                Files <span className={TEXT.muted}>({diff?.stats.files ?? files.length})</span>
              </h3>
              <FileTree
                files={files}
                currentFileIndex={currentFileIndex}
                commentCounts={commentCounts}
                onSelectFile={(fileIndex) => viewerRef.current?.focusFile(fileIndex)}
              />
              {diff && diff.stats.files > files.length && (
                <p className={cn("px-3 pt-1 text-[11px]", TEXT.muted)}>
                  {diff.stats.files - files.length} more file{diff.stats.files - files.length === 1 ? "" : "s"} not shown (size limit).
                </p>
              )}
            </div>
          )}
        </aside>
        <div className="min-h-0 min-w-0 flex-1">{body}</div>
      </div>

      <ReviewComposer
        message={drafts.message}
        comments={drafts.comments}
        revision={revision}
        sending={followUp.isPending}
        blockedReason={blockedReason}
        error={composerError}
        persisted={persisted}
        onMessageChange={(message) => {
          if (localError) setLocalError(null)
          if (followUp.error) followUp.reset()
          dispatch({ type: "message", message })
        }}
        onRemoveComment={(id) => dispatch({ type: "remove", id })}
        onJumpToComment={jumpToComment}
        onSend={send}
      />
    </div>
  )
}
