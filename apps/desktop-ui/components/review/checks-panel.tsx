"use client"

import { memo, useId } from "react"
import { AlertTriangle, CheckCircle2, Circle, CircleDashed, ExternalLink, GitMerge, GitPullRequestCreate, Loader2, XCircle } from "lucide-react"
import { cn, openExternal } from "@/lib/utils"
import { focusRing } from "@/components/ui/focus-ring"
import {
  CHECK_STATUS_LABEL,
  canOverride,
  overrideApplies,
  publishActions,
  type CheckStatus,
  type GateInput,
  type ReviewGate,
  type ReviewOverride,
} from "./model/checks"
import { BUTTON, CHECK_TONE, TEXT, TONE } from "./diff-colors"

function StatusIcon({ status, className }: { status: CheckStatus; className?: string }) {
  const tone = CHECK_TONE[status]
  const props = { className: cn("h-3.5 w-3.5 shrink-0", tone, className), "aria-hidden": true as const }
  switch (status) {
    case "passed":
      return <CheckCircle2 {...props} />
    case "failed":
      return <XCircle {...props} />
    case "running":
      return <Loader2 {...props} className={cn(props.className, "motion-safe:animate-spin")} />
    case "pending":
      return <Circle {...props} />
    case "missing":
      return <CircleDashed {...props} />
    case "warning":
    case "stale":
      return <AlertTriangle {...props} />
  }
}

const GATE_COPY = {
  open: { title: "Ready to publish", status: "passed" as const },
  pending: { title: "Waiting on checks", status: "running" as const },
  blocked: { title: "Publishing is blocked", status: "failed" as const },
}

interface ChecksPanelProps {
  gate: ReviewGate
  outcome: GateInput["outcome"]
  override: ReviewOverride | null
  onOverrideChange: (override: ReviewOverride | null) => void
  /** Opens an external URL (injectable for tests). */
  onOpenUrl?: (url: string) => void
  runStateError?: string | null
}

/**
 * Required checks gate "Create PR" / "Merge". An override is an explicit,
 * per-revision decision (a changed diff clears it) and is unavailable while
 * the agent works. Status is never colour-only: icon + label + detail.
 */
export const ChecksPanel = memo(function ChecksPanel({ gate, outcome, override, onOverrideChange, onOpenUrl = openExternal, runStateError }: ChecksPanelProps) {
  const overrideId = useId()
  const gateCopy = GATE_COPY[gate.status]
  const actions = publishActions(gate, outcome, override)
  const overridden = overrideApplies(gate, override)
  const showOverride = canOverride(gate) && actions.some((action) => action.url)

  return (
    <section aria-labelledby={`${overrideId}-title`} className="space-y-2 px-3 py-3">
      <div className="flex items-center gap-1.5">
        <StatusIcon status={gateCopy.status} />
        <h3 id={`${overrideId}-title`} className="text-[12px] font-medium uppercase tracking-wide text-linear-text-secondary">
          Checks
        </h3>
      </div>
      <div role="status" aria-live="polite" className="rounded-sm border border-border bg-background px-2 py-1.5">
        <p className="text-[13px] font-medium text-foreground">{overridden ? "Override active for this revision" : gateCopy.title}</p>
        <p className={cn("mt-0.5 text-[12px] leading-4", TEXT.secondary)}>{gate.summary}</p>
      </div>

      {(["required", "info"] as const).map((group) => {
        const checks = gate.checks.filter((check) => (group === "required") === check.required)
        if (checks.length === 0) return null
        return (
          <div key={group}>
            {group === "info" && <p className={cn("mb-1 border-t border-border pt-2 text-[10px] uppercase tracking-wide", TEXT.muted)}>Info</p>}
            <ul className="space-y-1" aria-label={group === "required" ? "Required checks" : "Other checks"}>
              {checks.map((check) => (
                <li key={check.id} className="text-[12px]" title={check.status === "passed" ? check.detail : undefined}>
                  <div className="flex items-center gap-1.5">
                    <StatusIcon status={check.status} />
                    <span className="min-w-0 truncate font-medium text-foreground">{check.label}</span>
                    <span className={cn("ml-auto shrink-0", CHECK_TONE[check.status])}>{CHECK_STATUS_LABEL[check.status]}</span>
                  </div>
                  {/* Passing checks keep their detail in the tooltip and for screen readers. */}
                  <p className={cn("ml-5 leading-4", TEXT.secondary, check.status === "passed" && "sr-only")}>{check.detail}</p>
                  {check.items && check.items.length > 0 && (
                    <ul className="ml-5 mt-1 space-y-0.5">
                      {check.items.map((item, index) => (
                        <li key={`${item.name}:${index}`} className="flex items-center gap-1.5">
                          <StatusIcon status={item.status} />
                          <span className={cn("min-w-0 truncate", TEXT.secondary)}>{item.name}</span>
                          <span className="sr-only">{CHECK_STATUS_LABEL[item.status]}</span>
                          {item.url && (
                            <button
                              type="button"
                              onClick={() => onOpenUrl(item.url!)}
                              aria-label={`Open ${item.name} details`}
                              className={cn("ml-auto rounded-sm p-0.5", BUTTON.ghost, focusRing)}
                            >
                              <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      {runStateError && <p className={cn("text-[11px]", TONE.warning.text)}>Run checks unavailable: {runStateError}</p>}

      <div className="space-y-1.5 pt-1">
        {actions.map((action) => (
          <div key={action.action}>
            <button
              type="button"
              disabled={!action.enabled}
              aria-describedby={action.reason ? `${overrideId}-${action.action}-reason` : undefined}
              onClick={() => action.url && onOpenUrl(action.url)}
              className={cn(
                "inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-sm text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50",
                action.overridden ? BUTTON.overridden : BUTTON.primary,
                focusRing,
              )}
            >
              {action.action === "merge" ? <GitMerge className="h-3.5 w-3.5" aria-hidden="true" /> : <GitPullRequestCreate className="h-3.5 w-3.5" aria-hidden="true" />}
              {action.label}
              <ExternalLink className="h-3 w-3 opacity-70" aria-hidden="true" />
            </button>
            {action.reason && (
              <p id={`${overrideId}-${action.action}-reason`} className={cn("mt-1 text-[11px] leading-4", TEXT.secondary)}>
                {action.reason}
              </p>
            )}
          </div>
        ))}
        {showOverride && (
          <label htmlFor={`${overrideId}-override`} className={cn("flex cursor-pointer items-start gap-2 rounded-sm border px-2 py-1.5 text-[12px] leading-4", TONE.warning.surface, TONE.warning.text)}>
            <input
              id={`${overrideId}-override`}
              type="checkbox"
              checked={overridden}
              onChange={(event) => onOverrideChange(event.target.checked && gate.revision ? { revision: gate.revision } : null)}
              className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary", focusRing)}
            />
            <span>Override: I reviewed this diff and want to publish without passing checks. Applies to this revision only.</span>
          </label>
        )}
      </div>
    </section>
  )
})
