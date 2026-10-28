import type { RunPhase } from "@/lib/run-model"
import type { RunVerification, TaskRunState, VerificationStatus } from "@/lib/api/review"
import type { TaskExecutionOutcome } from "@/components/board/execution-outcome"

/**
 * Review checks and the publish gate.
 *
 * Required checks (all must pass for "Create PR" / "Merge" to be enabled):
 * - **Agent run** finished successfully;
 * - **Verification** passed for the commit on screen (W11; until a run reports
 *   it, the check is "not reported" and the gate needs an explicit override);
 * - **Review comments**: no unsent drafts (they'd be lost on publish).
 *
 * Informational: publication progress, uncommitted workspace changes, a
 * truncated diff. An override is explicit, bound to the diff revision on
 * screen (a changed diff needs a new decision) and never available while
 * the agent is still working.
 */

export type CheckStatus = "passed" | "failed" | "running" | "pending" | "missing" | "warning" | "stale"
export type CheckId = "run" | "verification" | "comments" | "publication" | "workspace" | "diff"

export interface ReviewCheckItem {
  name: string
  status: CheckStatus
  summary?: string
  url?: string
}

export interface ReviewCheck {
  id: CheckId
  label: string
  status: CheckStatus
  detail: string
  required: boolean
  items?: ReviewCheckItem[]
}

export type GateStatus = "open" | "pending" | "blocked"

export interface ReviewGate {
  status: GateStatus
  checks: ReviewCheck[]
  /** Required checks that are not passing. */
  blocking: ReviewCheck[]
  /** The diff revision the gate (and any override) is bound to. */
  revision: string | null
  /** The agent is still working: nothing may be published, not even with an override. */
  agentBusy: boolean
  summary: string
}

export interface GateInput {
  phase: RunPhase
  runState: TaskRunState | null
  revision: string | null
  headSha: string | null
  headDirty: boolean
  diffTruncated: boolean
  draftCount: number
  outcome: Pick<TaskExecutionOutcome, "kind" | "pullRequestUrl" | "branchUrl">
}

export const CHECK_STATUS_LABEL: Readonly<Record<CheckStatus, string>> = {
  passed: "Passed",
  failed: "Failed",
  running: "Running",
  pending: "Pending",
  missing: "Not reported",
  warning: "Needs attention",
  stale: "Out of date",
}

const LIVE_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  "queued", "preparing", "running", "awaiting_approval", "compacting", "verifying", "committing", "publishing",
])

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function runCheck(phase: RunPhase, runState: TaskRunState | null): ReviewCheck {
  const base = { id: "run" as const, label: "Agent run", required: true }
  // A live phase comes from the event stream and is fresher than a fetched run state.
  if (LIVE_PHASES.has(phase)) return { ...base, status: "running", detail: "The agent is still working on this task." }
  const terminal = runState?.terminal
  if (terminal) {
    switch (terminal.state) {
      case "succeeded":
        return { ...base, status: "passed", detail: "The agent's run finished successfully." }
      case "cancelled":
        return { ...base, status: "failed", detail: "The run was cancelled before it finished." }
      case "recovery_required":
        return { ...base, status: "failed", detail: "The run's outcome is unknown after a restart. Inspect the work before publishing it." }
      case "abandoned":
        return { ...base, status: "failed", detail: "This device lost authority over the run; its result wasn't confirmed." }
      case "failed":
        return { ...base, status: "failed", detail: terminal.reason ? `The run failed: ${terminal.reason}` : "The run failed." }
    }
  }
  switch (phase) {
    case "succeeded":
      return { ...base, status: "passed", detail: "The agent's run finished successfully." }
    case "failed":
      return { ...base, status: "failed", detail: "The run failed." }
    case "cancelled":
      return { ...base, status: "failed", detail: "The run was cancelled before it finished." }
    case "recovery_required":
      return { ...base, status: "failed", detail: "The run's outcome is unknown after a restart. Inspect the work before publishing it." }
    case "abandoned":
      return { ...base, status: "failed", detail: "This device lost authority over the run; its result wasn't confirmed." }
    case "unknown":
      return { ...base, status: "warning", detail: "The run's state can't be confirmed right now." }
    default:
      return { ...base, status: "pending", detail: "The task hasn't run yet." }
  }
}

function verificationStatus(status: VerificationStatus): CheckStatus {
  switch (status) {
    case "passed":
      return "passed"
    case "failed":
    case "error":
      return "failed"
    case "running":
      return "running"
    case "pending":
      return "pending"
    case "skipped":
      return "missing"
  }
}

function verificationCheck(phase: RunPhase, verification: RunVerification | null | undefined, headSha: string | null, headDirty: boolean): ReviewCheck {
  const base = { id: "verification" as const, label: "Verification", required: true }
  if (phase === "verifying") return { ...base, status: "running", detail: "Checks are running against the agent's work." }
  if (!verification) {
    return { ...base, status: "missing", detail: "This run didn't report verification checks. Review the diff yourself, or override to publish anyway." }
  }
  const items: ReviewCheckItem[] = verification.checks.map((check) => {
    const itemStatus = verificationStatus(check.status)
    return {
      name: check.name,
      // An informational check's failure is worth a look, not a blocker.
      status: check.required === false && itemStatus === "failed" ? "warning" : itemStatus,
      ...(check.summary ? { summary: check.summary } : {}),
      ...(check.url ? { url: check.url } : {}),
    }
  })
  const status = verificationStatus(verification.status)
  const commit = verification.commit ?? null
  const notes = verificationNotes(verification)
  if (status === "passed" && commit && headSha && !headSha.startsWith(commit) && !commit.startsWith(headSha)) {
    return { ...base, status: "stale", items, detail: `Checks passed on ${shortSha(commit)}, but the diff shows ${shortSha(headSha)}. Run them again for this commit.` }
  }
  if (status === "passed" && headDirty) {
    return { ...base, status: "stale", items, detail: "The workspace changed after the checks ran (uncommitted changes aren't covered)." }
  }
  const failed = items.filter((item) => item.status === "failed").length
  const passed = items.filter((item) => item.status === "passed").length
  const on = commit ? ` on ${shortSha(commit)}` : ""
  const detail =
    status === "passed" ? (items.length > 0 ? `${plural(passed, "check")} passed${on}.` : `Verification passed${on}.`)
      : verification.status === "error" ? `Verification couldn't be completed${on}${verification.detail ? `: ${verification.detail}` : "."}`
        : status === "failed" ? (failed > 0 ? `${plural(failed, "check")} failed${on}.` : `Verification failed${on}.`)
          : status === "running" ? "Checks are running."
            : status === "pending" ? "Checks are queued."
              : verification.detail ? `Verification was skipped: ${verification.detail}.` : "Verification was skipped for this run."
  return { ...base, status, items, detail: notes.length > 0 ? `${detail} ${notes.join(" ")}` : detail }
}

/** Integrity notes a reviewer must see: unsandboxed checks, a blocked publication, the agent editing the check file. */
function verificationNotes(verification: RunVerification): string[] {
  const notes: string[] = []
  if (verification.environment?.sandboxMode === "trusted-host") notes.push("The checks ran without OS isolation (trusted-host grant).")
  if (verification.publication === "blocked") notes.push("The project requires passing checks, so nothing was published.")
  for (const warning of verification.warnings ?? []) {
    if (/checks\.json/.test(warning)) notes.push("The agent changed the repository's check file; the original checks were used.")
  }
  return notes
}

function commentsCheck(draftCount: number): ReviewCheck {
  const base = { id: "comments" as const, label: "Review comments", required: true }
  if (draftCount === 0) return { ...base, status: "passed", detail: "No unsent review comments." }
  return { ...base, status: "warning", detail: `${plural(draftCount, "draft comment")} ${draftCount === 1 ? "hasn't" : "haven't"} been sent to the agent.` }
}

function publicationCheck(outcome: GateInput["outcome"], runState: TaskRunState | null): ReviewCheck {
  const base = { id: "publication" as const, label: "Branch & pull request", required: false }
  const effects = runState?.effects ?? []
  const effect = (kind: string) => effects.find((item) => item.kind === kind)
  if (outcome.pullRequestUrl || effect("pr.create")?.status === "confirmed") {
    return { ...base, status: "passed", detail: "A pull request is open." }
  }
  if (outcome.kind === "publication_failed" || effects.some((item) => item.status === "failed")) {
    return { ...base, status: "failed", detail: "Publishing failed; the work is retained locally." }
  }
  if (effects.some((item) => item.status === "pending")) return { ...base, status: "running", detail: "Publishing the branch…" }
  if (outcome.branchUrl || effect("git.push")?.status === "confirmed") {
    return { ...base, status: "warning", detail: "The branch is pushed, but no pull request was confirmed." }
  }
  return { ...base, status: "pending", detail: "Nothing has been published yet." }
}

export function deriveReviewGate(input: GateInput): ReviewGate {
  const checks: ReviewCheck[] = [
    runCheck(input.phase, input.runState),
    verificationCheck(input.phase, input.runState?.verification, input.headSha, input.headDirty),
    commentsCheck(input.draftCount),
    publicationCheck(input.outcome, input.runState),
  ]
  const agentBusy = checks[0]!.status === "running"
  if (input.headDirty && !agentBusy) {
    checks.push({
      id: "workspace",
      label: "Uncommitted changes",
      status: "warning",
      required: false,
      detail: "The workspace has changes that aren't committed to the branch yet; a pull request won't include them.",
    })
  }
  if (input.diffTruncated) {
    checks.push({ id: "diff", label: "Diff size", status: "warning", required: false, detail: "Part of the diff isn't shown because it reached the size limit." })
  }

  const required = checks.filter((check) => check.required)
  const blocking = required.filter((check) => check.status !== "passed")
  const hardBlocked = blocking.some((check) => check.status !== "running" && check.status !== "pending")
  const status: GateStatus = blocking.length === 0 ? "open" : hardBlocked ? "blocked" : "pending"
  const names = blocking.map((check) => `${check.label} (${CHECK_STATUS_LABEL[check.status].toLowerCase()})`).join(", ")
  const summary =
    status === "open" ? "All required checks passed."
      : status === "pending" ? `Waiting for ${names}.`
        : `Blocked by ${names}.`
  return { status, checks, blocking, revision: input.revision, agentBusy, summary }
}

export interface ReviewOverride {
  revision: string
}

/** An override counts only for the revision it was given on, and never while the agent works. */
export function overrideApplies(gate: ReviewGate, override: ReviewOverride | null): boolean {
  return Boolean(override && gate.revision && override.revision === gate.revision && !gate.agentBusy && gate.status !== "open")
}

export function canOverride(gate: ReviewGate): boolean {
  return gate.status !== "open" && !gate.agentBusy && gate.revision !== null
}

export interface PublishActionState {
  action: "create_pr" | "merge"
  label: string
  url: string | null
  enabled: boolean
  /** Enabled only because of the override. */
  overridden: boolean
  /** Why it's disabled (or null when enabled). */
  reason: string | null
}

export function publishActions(gate: ReviewGate, outcome: GateInput["outcome"], override: ReviewOverride | null): PublishActionState[] {
  const overridden = overrideApplies(gate, override)
  const gateOpen = gate.status === "open" || overridden
  const gateReason = gate.agentBusy
    ? "Wait for the agent to finish before publishing."
    : gate.status === "open" ? null
      : gate.status === "pending" ? "Waiting for the required checks above. Override below to continue anyway."
        : "Needs the required checks above to pass. Override below to continue anyway."

  const state = (action: PublishActionState["action"], label: string, url: string | null, missing: string): PublishActionState => {
    if (!url) return { action, label, url, enabled: false, overridden: false, reason: missing }
    return {
      action,
      label: gateOpen && gate.status !== "open" ? `${label} anyway` : label,
      url,
      enabled: gateOpen && !gate.agentBusy,
      overridden: overridden && gate.status !== "open",
      reason: gateOpen && !gate.agentBusy ? null : gateReason,
    }
  }

  if (outcome.pullRequestUrl) {
    return [state("merge", "Merge on GitHub", outcome.pullRequestUrl, "")]
  }
  return [state("create_pr", "Create PR on GitHub", outcome.branchUrl, "No branch has been pushed yet. The agent publishes it when the run finishes.")]
}
