import type { ExecutionProgress, Task } from "@/types/task"

/**
 * W01 execution outcomes for the board, task detail and batch views.
 *
 * Wire shapes mirror packages/execution-core/src/batch/types.ts
 * (BatchStatusResponse, BatchPublication) and the outcome strings written by
 * apps/sidecar/src/services/{execution/events.ts,batch/completion.ts,
 * batch/orchestrator.ts}. Until W05 introduces a structured run result, the
 * retained branch/path of a failed or cancelled run exists only inside the
 * task's `outcome` text, so it is parsed here in one place.
 *
 * Publication rules (W01):
 * - Only a GitHub `/pull/<n>` URL is a confirmed pull request.
 * - A `/compare/` URL is evidence that a branch was pushed, never a PR.
 * - A batch member `completed` while the batch is still pending/running is a
 *   local commit that is ready to publish, not done; task rows stay
 *   in_progress (95%) until the batch PR is confirmed.
 */

export type BatchStatus = "starting" | "pending" | "running" | "merging" | "completed" | "failed" | "cancelled"
export type BatchMemberStatus = "queued" | "running" | "completed" | "failed" | "skipped" | "cancelled"
export type BatchPublicationPhase =
  | "prepared"
  | "committed"
  | "merging"
  | "pushed"
  | "pr_created"
  | "completed"
  | "failed"
  | "cancelled"

export interface BatchPublication {
  phase: BatchPublicationPhase
  /** Compare URL recorded after the batch branch was pushed. */
  branchUrl?: string
  error?: string
  /** Sidecar-local JSON receipt for manual inspection. */
  receiptPath?: string
}

export interface BatchStatusMember {
  taskId: string
  title: string
  status: BatchMemberStatus
  branch: string
  error: string | null
  startedAt: string | null
  completedAt: string | null
  cancelUnconfirmed?: boolean
}

export interface BatchStatusResponse {
  id: string
  status: Exclude<BatchStatus, "starting">
  mode: "parallel" | "queue" | "combined"
  tasks: BatchStatusMember[]
  prUrl: string | null
  createdAt: string
  completedAt: string | null
  publication?: BatchPublication
}

export type OutcomeTone = "success" | "info" | "warning" | "danger" | "neutral"

// ─── URLs ────────────────────────────────────────────────────────────────────

export type PublicationUrlKind = "pull_request" | "compare" | "other"

export function classifyPublicationUrl(url: string | null | undefined): PublicationUrlKind | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "other"
  }
  if (parsed.protocol !== "https:") return "other"
  const segments = parsed.pathname.split("/").filter(Boolean)
  if (segments.length >= 4 && segments[2] === "pull" && /^\d+$/.test(segments[3] ?? "")) return "pull_request"
  if (segments.length >= 4 && segments[2] === "compare") return "compare"
  return "other"
}

export function isConfirmedPullRequestUrl(url: string | null | undefined): url is string {
  return classifyPublicationUrl(url) === "pull_request"
}

// ─── Outcome text ────────────────────────────────────────────────────────────

export interface RetainedWork {
  branch: string
  /** Worktree or checkout path on the machine that ran the agent. */
  path: string | null
}

const RETAINED_MARKER = "work retained on "
const LOCAL_COMMIT_READY = "local commit ready"

/** "…Work retained on [branch ]<branch>[ at <path>][; pull request <url>]" */
export function parseRetainedWork(outcome: string | null | undefined): RetainedWork | null {
  if (!outcome) return null
  const start = outcome.toLowerCase().lastIndexOf(RETAINED_MARKER)
  if (start === -1) return null
  let rest = outcome.slice(start + RETAINED_MARKER.length)
  const prIndex = rest.indexOf("; pull request ")
  if (prIndex !== -1) rest = rest.slice(0, prIndex)
  rest = rest.replace(/^branch /, "")
  const match = /^(\S+)(?: at (.+))?$/.exec(rest.trim())
  if (!match) return null
  return { branch: match[1]!, path: match[2]?.trim() || null }
}

/** A PR URL recorded inside the outcome text ("…; pull request <url>"). */
export function parseOutcomePullRequest(outcome: string | null | undefined): string | null {
  if (!outcome) return null
  const match = /pull request (https:\/\/\S+)/.exec(outcome)
  return match ? match[1]!.replace(/[.;,]+$/, "") : null
}

/** The outcome text without the retained-work/PR suffix, e.g. "Failed: Merge conflict". */
export function outcomeReason(outcome: string | null | undefined): string | null {
  if (!outcome) return null
  const lower = outcome.toLowerCase()
  const start = lower.lastIndexOf(RETAINED_MARKER)
  let reason = start === -1 ? outcome : outcome.slice(0, start)
  reason = reason.replace(/[\s.;]+$/, "").replace(/^failed:\s*/i, "")
  if (/^sidecar_recovery_/.test(reason)) {
    return "The execution service restarted during this run"
  }
  return reason.trim() || null
}

export function isLocalCommitReadyOutcome(outcome: string | null | undefined): boolean {
  return Boolean(outcome?.toLowerCase().startsWith(LOCAL_COMMIT_READY))
}

/** In-flight batch member whose local commit is persisted and waiting for the batch PR. */
export function isReadyToPublishTask(task: Pick<Task, "status" | "outcome" | "batchId"> | null | undefined): boolean {
  return Boolean(task && task.status === "in_progress" && task.batchId && isLocalCommitReadyOutcome(task.outcome))
}

// ─── Single task ─────────────────────────────────────────────────────────────

export type TaskOutcomeKind =
  | "pull_request"
  | "branch_evidence"
  | "ready_to_publish"
  | "publication_failed"
  | "failed"
  | "cancelled"
  | "none"

export interface TaskExecutionOutcome {
  kind: TaskOutcomeKind
  label: string
  tone: OutcomeTone
  /** Confirmed pull request (also kept when a run was cancelled after GitHub accepted it). */
  pullRequestUrl: string | null
  /** Compare link: proof of a pushed branch, not a PR. */
  branchUrl: string | null
  retained: RetainedWork | null
  reason: string | null
}

const PUBLICATION_FAILURE = /pull request|publication|push|\bPR\b/i
// Success texts written on done: "3 files changed, 5 tools executed" and
// "Completed via Parallel Execution; pull request …". A single user-cancel
// does not overwrite `outcome`, so a later cancelled run can still carry one.
const SUCCESS_OUTCOME = /^(?:\d+ files? changed, \d+ tools? executed|completed via\b)/i

export function isSuccessOutcome(outcome: string | null | undefined): boolean {
  return Boolean(outcome && SUCCESS_OUTCOME.test(outcome.trim()))
}

export function describeTaskExecution(
  task: Pick<Task, "status" | "outcome" | "prUrl" | "batchId">,
  progress?: Pick<ExecutionProgress, "status" | "prUrl" | "isCompareLink"> | null,
): TaskExecutionOutcome {
  const outcome = task.outcome
  const retained = parseRetainedWork(outcome)
  const reason = outcomeReason(outcome)
  const candidates = [task.prUrl, progress?.prUrl, parseOutcomePullRequest(outcome)]
  const pullRequestUrl = candidates.find((url): url is string => isConfirmedPullRequestUrl(url)) ?? null
  const compareUrl =
    candidates.find((url): url is string => classifyPublicationUrl(url) === "compare") ??
    (progress?.isCompareLink && progress.prUrl ? progress.prUrl : null)

  const base = { pullRequestUrl, branchUrl: pullRequestUrl ? null : compareUrl, retained, reason }

  if (task.status === "done") {
    if (pullRequestUrl) return { ...base, kind: "pull_request", label: "Pull request opened", tone: "success", reason: null }
    if (compareUrl) {
      return { ...base, kind: "branch_evidence", label: "Branch pushed — no pull request confirmed", tone: "warning", reason: null }
    }
    return { ...base, kind: "none", label: "Done", tone: "neutral", reason: null }
  }

  if (isReadyToPublishTask(task)) {
    return { ...base, kind: "ready_to_publish", label: "Local commit ready — waiting for batch publication", tone: "info", reason: null }
  }

  if (task.status === "in_progress") {
    if (compareUrl && !pullRequestUrl) {
      return { ...base, kind: "branch_evidence", label: "Branch pushed — no pull request confirmed", tone: "warning" }
    }
    return { ...base, kind: "none", label: "In progress", tone: "neutral", reason: null }
  }

  // cancelled, or todo after a failed batch member (W01 returns failed members to todo).
  const cancelled = Boolean(outcome && /^cancelled\b/i.test(outcome.trim()))
  const staleSuccess = isSuccessOutcome(outcome)
  if (cancelled || (task.status === "cancelled" && (!outcome || staleSuccess))) {
    // A stale success outcome belongs to an earlier run; don't attribute its PR to this cancellation.
    const acceptedDuringCancel = Boolean(pullRequestUrl) && !staleSuccess
    return {
      ...base,
      kind: "cancelled",
      label: acceptedDuringCancel
        ? "Cancelled — the pull request was still opened"
        : retained ? "Cancelled — work retained" : "Cancelled",
      tone: acceptedDuringCancel ? "warning" : "neutral",
      reason: null,
    }
  }

  if (!outcome || staleSuccess || (task.status === "todo" && !retained && !pullRequestUrl)) {
    if (compareUrl) {
      return { ...base, kind: "branch_evidence", label: "Branch pushed — no pull request confirmed", tone: "warning" }
    }
    return { ...base, kind: "none", label: task.status === "todo" ? "Todo" : "Cancelled", tone: "neutral" }
  }

  const publication = Boolean(reason && PUBLICATION_FAILURE.test(reason))
  const kind: TaskOutcomeKind = publication ? "publication_failed" : "failed"
  const label = pullRequestUrl
    ? "Failed after the pull request was opened"
    : publication
      ? retained ? "Publication failed — work retained" : "Publication failed"
      : retained ? "Run failed — work retained" : "Run failed"
  return { ...base, kind, label, tone: pullRequestUrl ? "warning" : "danger" }
}

// ─── Batch ───────────────────────────────────────────────────────────────────

export type BatchMemberPhase =
  | "queued"
  | "running"
  | "ready_to_publish"
  | "publishing"
  | "published"
  | "not_published"
  | "failed"
  | "skipped"
  | "cancelled"

export const BATCH_MEMBER_PHASE_LABEL: Record<BatchMemberPhase, string> = {
  queued: "Queued",
  running: "Running",
  ready_to_publish: "Ready to publish",
  publishing: "Publishing",
  published: "Published",
  not_published: "Not published",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
}

const IN_FLIGHT_BATCH = new Set<string>(["starting", "pending", "running"])

export function deriveBatchMemberPhase(
  member: { status: BatchMemberStatus },
  batchStatus: string,
  task?: Pick<Task, "status" | "outcome" | "batchId"> | null,
): BatchMemberPhase {
  switch (member.status) {
    case "completed":
      if (batchStatus === "completed") return "published"
      if (batchStatus === "merging") return "publishing"
      if (batchStatus === "cancelled") return "cancelled"
      if (batchStatus === "failed") return "not_published"
      return "ready_to_publish"
    case "running":
      // The committed-phase event isn't delivered to the board; the persisted
      // task row (in_progress, "Local commit ready…") is the durable signal.
      if (isReadyToPublishTask(task)) return batchStatus === "merging" ? "publishing" : "ready_to_publish"
      return "running"
    default:
      return member.status
  }
}

export function isBatchInFlight(status: string): boolean {
  return IN_FLIGHT_BATCH.has(status) || status === "merging"
}

export interface BatchOutcomeMember {
  taskId: string
  title: string
  status: BatchMemberStatus
  branch?: string
  error?: string | null
  cancelUnconfirmed?: boolean
}

export interface BatchOutcomeInput {
  status: string
  prUrl: string | null
  publication?: BatchPublication | null
  tasks: BatchOutcomeMember[]
}

export interface BatchOutcomeView {
  label: string
  tone: OutcomeTone
  pullRequestUrl: string | null
  /** Pushed batch branch (compare URL) when no PR is confirmed. */
  branchUrl: string | null
  publicationError: string | null
  receiptPath: string | null
  /** Members whose provider stop was never confirmed; their workspaces stay reserved. */
  unconfirmedStops: BatchOutcomeMember[]
  /** Members whose work is retained for inspection instead of being published. */
  retained: BatchOutcomeMember[]
}

export function describeBatchOutcome(batch: BatchOutcomeInput): BatchOutcomeView {
  const publication = batch.publication ?? null
  const pullRequestUrl = isConfirmedPullRequestUrl(batch.prUrl) ? batch.prUrl : null
  const branchUrl = !pullRequestUrl && classifyPublicationUrl(publication?.branchUrl) === "compare" ? publication!.branchUrl! : null
  const unconfirmedStops = batch.tasks.filter((task) => task.cancelUnconfirmed)
  const retained = batch.tasks.filter((task) =>
    task.branch && (task.status === "failed" || task.status === "skipped" || task.status === "cancelled"
      || (task.status === "completed" && (batch.status === "failed" || batch.status === "cancelled"))))
  const common = {
    pullRequestUrl,
    branchUrl,
    publicationError: publication?.error ?? null,
    receiptPath: publication?.receiptPath ?? null,
    unconfirmedStops,
    retained,
  }

  switch (batch.status) {
    case "completed":
      return {
        ...common,
        label: pullRequestUrl ? "Pull request opened" : "Completed — no pull request confirmed",
        tone: pullRequestUrl ? (retained.length > 0 ? "warning" : "success") : "warning",
      }
    case "failed":
      return {
        ...common,
        label: pullRequestUrl
          ? "Failed after the pull request was opened"
          : branchUrl ? "Publication failed — branch pushed" : "Batch failed — work retained",
        tone: "danger",
      }
    case "cancelled":
      return {
        ...common,
        label: pullRequestUrl ? "Cancelled — the pull request was still opened" : "Cancelled — work retained",
        tone: unconfirmedStops.length > 0 || pullRequestUrl ? "warning" : "neutral",
      }
    case "merging":
      return { ...common, label: "Publishing", tone: "info" }
    default:
      return { ...common, label: "Running", tone: "info" }
  }
}
