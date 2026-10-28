"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  AlertCircle,
  Ban,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitMerge,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { cn, openExternal } from "@/lib/utils"
import type { OutcomeTone, RetainedWork, TaskExecutionOutcome } from "./execution-outcome"

export const OUTCOME_TONE_CLASSES: Record<OutcomeTone, { text: string; border: string; bg: string }> = {
  success: { text: "text-success", border: "border-success/30", bg: "bg-success/10" },
  info: { text: "text-info", border: "border-info/30", bg: "bg-info/10" },
  warning: { text: "text-warning", border: "border-warning/30", bg: "bg-warning/10" },
  danger: { text: "text-danger", border: "border-danger/30", bg: "bg-danger/10" },
  neutral: { text: "text-linear-text-secondary", border: "border-linear-border", bg: "bg-linear-bg-secondary" },
}

function OutcomeIcon({ outcome }: { outcome: TaskExecutionOutcome }) {
  const className = cn("w-4 h-4 flex-shrink-0", OUTCOME_TONE_CLASSES[outcome.tone].text)
  switch (outcome.kind) {
    case "pull_request":
      return <GitMerge className={className} aria-hidden="true" />
    case "branch_evidence":
      return <GitBranch className={className} aria-hidden="true" />
    case "ready_to_publish":
      return <GitCommit className={className} aria-hidden="true" />
    case "cancelled":
      return <Ban className={className} aria-hidden="true" />
    case "publication_failed":
    case "failed":
      return <AlertCircle className={className} aria-hidden="true" />
    default:
      return <Check className={className} aria-hidden="true" />
  }
}

export async function copyText(value: string, what: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable")
    await navigator.clipboard.writeText(value)
    toast.success(`Copied ${what}`)
  } catch {
    toast.error(`Couldn't copy the ${what}`, { description: value })
  }
}

export function RetainedWorkDetails({ retained, className }: { retained: RetainedWork; className?: string }) {
  return (
    <dl className={cn("space-y-1.5 text-xs", className)}>
      <div className="flex items-center gap-2 min-w-0">
        <dt className="w-14 flex-shrink-0 text-linear-text-tertiary">Branch</dt>
        <dd className="min-w-0 flex-1 truncate font-mono text-linear-text-secondary" title={retained.branch}>{retained.branch}</dd>
        <button
          type="button"
          onClick={() => void copyText(retained.branch, "branch name")}
          className="flex-shrink-0 rounded-sm p-1 text-linear-text-tertiary hover:bg-linear-bg-tertiary hover:text-linear-text"
          aria-label={`Copy branch name ${retained.branch}`}
        >
          <Copy className="w-3 h-3" aria-hidden="true" />
        </button>
      </div>
      {retained.path && (
        <div className="flex items-center gap-2 min-w-0">
          <dt className="w-14 flex-shrink-0 text-linear-text-tertiary">Path</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-linear-text-secondary" title={retained.path}>{retained.path}</dd>
          <button
            type="button"
            onClick={() => void copyText(retained.path!, "workspace path")}
            className="flex-shrink-0 rounded-sm p-1 text-linear-text-tertiary hover:bg-linear-bg-tertiary hover:text-linear-text"
            aria-label="Copy workspace path"
          >
            <Copy className="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      )}
    </dl>
  )
}

interface ExecutionOutcomePanelProps {
  outcome: TaskExecutionOutcome
  /** Ask the sidecar whether a PR now exists for a pushed branch (compare link). */
  onCheckPullRequest?: () => Promise<void>
  className?: string
}

/**
 * Publication state of a task's last run, kept visually distinct: a confirmed
 * pull request, branch evidence (compare link, no PR), local work waiting for
 * batch publication, and failed/cancelled runs with their retained branch.
 */
export function ExecutionOutcomePanel({ outcome, onCheckPullRequest, className }: ExecutionOutcomePanelProps) {
  const [checking, setChecking] = useState(false)
  const tone = OUTCOME_TONE_CLASSES[outcome.tone]

  return (
    <section
      aria-label="Execution outcome"
      data-outcome-kind={outcome.kind}
      className={cn("rounded-sm border p-3", tone.border, tone.bg, className)}
    >
      <div className="flex items-start gap-2">
        <OutcomeIcon outcome={outcome} />
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-medium", tone.text)}>{outcome.label}</p>
          {outcome.reason && (
            <p className="mt-1 text-xs text-linear-text-secondary break-words">{outcome.reason}</p>
          )}
        </div>
      </div>

      {(outcome.pullRequestUrl || outcome.branchUrl) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {outcome.pullRequestUrl && (
            <button
              type="button"
              onClick={() => void openExternal(outcome.pullRequestUrl!)}
              className="inline-flex items-center gap-1.5 rounded-sm bg-linear-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-linear-accent/90"
            >
              <GitMerge className="w-3.5 h-3.5" aria-hidden="true" />
              View pull request
              <ExternalLink className="w-3 h-3 opacity-70" aria-hidden="true" />
            </button>
          )}
          {outcome.branchUrl && (
            <button
              type="button"
              onClick={() => void openExternal(outcome.branchUrl!)}
              className="inline-flex items-center gap-1.5 rounded-sm border border-linear-border px-3 py-1.5 text-xs font-medium text-linear-text hover:bg-linear-bg-tertiary"
              title="A compare link shows the pushed branch; it is not a pull request"
            >
              <GitBranch className="w-3.5 h-3.5" aria-hidden="true" />
              Open branch comparison
              <ExternalLink className="w-3 h-3 opacity-70" aria-hidden="true" />
            </button>
          )}
          {outcome.branchUrl && onCheckPullRequest && (
            <button
              type="button"
              disabled={checking}
              onClick={async () => {
                setChecking(true)
                try {
                  await onCheckPullRequest()
                } finally {
                  setChecking(false)
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text disabled:opacity-60"
            >
              {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
              Check for pull request
            </button>
          )}
        </div>
      )}

      {outcome.retained && (
        <div className="mt-3 border-t border-linear-border pt-3">
          <p className="mb-1.5 text-[11px] uppercase tracking-wider text-linear-text-tertiary">Retained work</p>
          <RetainedWorkDetails retained={outcome.retained} />
        </div>
      )}
    </section>
  )
}
