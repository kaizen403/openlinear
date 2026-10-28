"use client"

import { memo, useEffect, useState } from "react"
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Circle,
  Clock,
  GitCommit,
  GitPullRequest,
  Hand,
  LifeBuoy,
  Loader2,
  Minimize2,
  ShieldCheck,
  Unplug,
  WifiOff,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  PHASE_INFO,
  formatElapsed,
  isLivePhase,
  phaseDescription,
  phaseLabel,
  runElapsedMs,
  runnerDisplayName,
  type RunCost,
  type RunPhase,
  type RunSnapshot,
  type RunTokens,
} from "@/lib/run-model"
import { KIT_TEXT, TONE_SURFACE, TONE_TEXT } from "./tokens"
import type { StopState } from "./use-stop-control"

const PHASE_ICON: Readonly<Record<RunPhase, LucideIcon>> = {
  idle: Circle,
  queued: Clock,
  preparing: Loader2,
  running: Loader2,
  awaiting_approval: Hand,
  compacting: Minimize2,
  verifying: ShieldCheck,
  committing: GitCommit,
  publishing: GitPullRequest,
  succeeded: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
  recovery_required: LifeBuoy,
  abandoned: Unplug,
  unknown: AlertTriangle,
}

const SPINNING = new Set<RunPhase>(["preparing", "running", "compacting", "verifying"])

/** Ticks once a second while `active`; static otherwise (no timers for finished runs). */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}

export function PhasePill({ snapshot, className }: { snapshot: Pick<RunSnapshot, "phase" | "recovery">; className?: string }) {
  const info = PHASE_INFO[snapshot.phase]
  const Icon = snapshot.phase === "unknown" && snapshot.recovery === "stream_lost" ? WifiOff : PHASE_ICON[snapshot.phase]
  const label = phaseLabel(snapshot)
  return (
    <span
      data-phase={snapshot.phase}
      title={phaseDescription(snapshot)}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium",
        TONE_SURFACE[info.tone],
        TONE_TEXT[info.tone].className,
        className,
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", SPINNING.has(snapshot.phase) && "motion-safe:animate-spin")} aria-hidden="true" />
      {label}
    </span>
  )
}

export function formatCost(cost: RunCost): { text: string; title: string } {
  if (cost.status === "unknown") {
    return { text: "Cost unknown", title: "The runner hasn't reported a cost for this run. Unknown is never shown as $0." }
  }
  const digits = cost.usd > 0 && cost.usd < 0.1 ? 4 : 2
  const text = `$${cost.usd.toFixed(digits)}`
  return { text, title: cost.basis ? `${text} (${cost.basis})` : text }
}

/**
 * FE-08: spend against the run's budget (W15a). Tokens count input + output,
 * as the budget does. Null without a budget.
 */
export function formatBudget(snapshot: Pick<RunSnapshot, "budget" | "cost" | "tokens">): { text: string; title: string } | null {
  const budget = snapshot.budget
  if (!budget) return null
  const parts: string[] = []
  if (budget.maxUsd !== null) {
    parts.push(snapshot.cost.status === "known"
      ? `$${snapshot.cost.usd.toFixed(2)} of $${budget.maxUsd.toFixed(2)}`
      : `budget $${budget.maxUsd.toFixed(2)} (cost unknown)`)
  }
  if (budget.maxTokens !== null) {
    const used = snapshot.tokens ? snapshot.tokens.input + snapshot.tokens.output : 0
    const k = (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value))
    parts.push(`${k(used)} of ${k(budget.maxTokens)} tokens`)
  }
  if (parts.length === 0) return null
  return { text: parts.join(" · "), title: "This run stops when it reaches its budget; its work is kept." }
}

function formatTokens(tokens: RunTokens | null): string | null {
  if (!tokens) return null
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
  if (total <= 0) return null
  return total >= 1000 ? `${(total / 1000).toFixed(total >= 100_000 ? 0 : 1)}k tokens` : `${total} tokens`
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

interface RunHeaderProps {
  snapshot: RunSnapshot
  stop?: StopState
  className?: string
  /** Extra controls (Stop) rendered at the end of the first line. */
  actions?: React.ReactNode
}

/**
 * Phase pill (announced politely when it changes), runner/model, elapsed time,
 * cost (never $0 when unknown) and the run's counters.
 */
export const RunHeader = memo(function RunHeader({ snapshot, stop, className, actions }: RunHeaderProps) {
  const live = isLivePhase(snapshot.phase)
  const now = useNow(live)
  const elapsed = runElapsedMs(snapshot, now)
  const cost = formatCost(snapshot.cost)
  const tokens = formatTokens(snapshot.tokens)
  const budget = formatBudget(snapshot)
  const who = [runnerDisplayName(snapshot.runner), snapshot.model].filter(Boolean).join(" · ")
  const { counters } = snapshot
  const stopWarning = stop?.status === "unconfirmed"

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* Only the phase is a live region; the ticking clock must not be announced. */}
        <span role="status" aria-live="polite" aria-atomic="true" className="inline-flex">
          <PhasePill snapshot={snapshot} />
          <span className="sr-only">{snapshot.attempt > 1 ? ` (run ${snapshot.attempt})` : ""}</span>
        </span>
        {stopWarning && (
          <span className={cn("inline-flex h-6 items-center gap-1 rounded-sm border px-2 text-xs font-medium", TONE_SURFACE.warning, TONE_TEXT.warning.className)}>
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Stop unconfirmed
          </span>
        )}
        <span className={cn("min-w-0 truncate text-xs", KIT_TEXT.secondary.className)} title={who || undefined}>
          {who || "Runner not reported"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3 text-xs tabular-nums">
          <span className={KIT_TEXT.secondary.className} title="Elapsed time">
            <span className="sr-only">Elapsed </span>
            {formatElapsed(elapsed)}
          </span>
          <span className={KIT_TEXT.muted.className} title={cost.title} data-testid="run-cost">
            {cost.text}
          </span>
          {actions}
        </span>
      </div>
      {snapshot.message && live && (
        <p className={cn("truncate text-xs", KIT_TEXT.secondary.className)} title={snapshot.message}>
          {snapshot.message}
        </p>
      )}
      {snapshot.hasActivity && (
        <p className={cn("flex flex-wrap gap-x-3 text-xs tabular-nums", KIT_TEXT.muted.className)}>
          <span>{plural(counters.tools, "tool call")}{counters.toolsRunning > 0 ? ` (${counters.toolsRunning} running)` : ""}</span>
          <span>{plural(counters.filesChanged, "file")} changed</span>
          {counters.errors + counters.toolErrors > 0 && (
            <span className={TONE_TEXT.danger.className}>{plural(counters.errors + counters.toolErrors, "error")}</span>
          )}
          {tokens && <span>{tokens}</span>}
          {budget && <span title={budget.title} data-testid="run-budget">{budget.text}</span>}
          {snapshot.branch && (
            <span className="min-w-0 truncate font-mono" title={snapshot.branch}>
              {snapshot.branch}
            </span>
          )}
        </p>
      )}
    </div>
  )
})
