"use client"

import { AlertCircle, Clock, FileSearch, LifeBuoy, Loader2, Play, RefreshCw, StepForward, Unplug, WifiOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRing } from "@/components/ui/focus-ring"
import { PHASE_INFO, RECOVERY_COPY, type RunPhase, type RunRecoveryReason } from "@/lib/run-model"
import { KIT_TEXT, TONE_SURFACE, TONE_TEXT } from "./tokens"

/** Nothing has run yet. */
export function RunEmptyState({ className, title = "No activity yet", description = "When this task runs, the agent's steps, tool calls and file changes appear here." }: { className?: string; title?: string; description?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1 px-4 py-10 text-center", className)}>
      <Clock className={cn("mb-1 h-6 w-6", KIT_TEXT.muted.className)} aria-hidden="true" />
      <p className={cn("text-sm font-medium", KIT_TEXT.secondary.className)}>{title}</p>
      <p className={cn("max-w-xs text-xs", KIT_TEXT.muted.className)}>{description}</p>
    </div>
  )
}

function skeletonRows(count: number): Array<{ id: string; width: number }> {
  return Array.from({ length: count }, (_, position) => ({ id: `skeleton-${position}`, width: 40 + ((position * 23) % 45) }))
}

/** History is loading: placeholder rows sized like real ones (no layout jump), announced once. */
export function RunLoadingState({ className, rows = 6 }: { className?: string; rows?: number }) {
  return (
    <div className={cn("px-1 py-2", className)} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading activity…</span>
      <div className="space-y-2" aria-hidden="true">
        {skeletonRows(rows).map((row) => (
          <div key={row.id} className="flex h-6 items-center gap-2">
            <span className="h-3.5 w-3.5 rounded-full bg-white/10" />
            <span className="h-2.5 rounded-sm bg-white/10 motion-safe:animate-pulse" style={{ width: `${row.width}%` }} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** History couldn't be loaded (mapped error copy); live events still render. */
export function RunErrorState({ message, hint, onRetry, className }: { message: string; hint?: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-sm border px-3 py-2", TONE_SURFACE.danger, className)}>
      <AlertCircle className={cn("mt-0.5 h-4 w-4 shrink-0", TONE_TEXT.danger.className)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs font-medium", TONE_TEXT.danger.className)}>Couldn&apos;t load earlier activity. {message}</p>
        {hint && <p className={cn("mt-0.5 text-xs", KIT_TEXT.secondary.className)}>{hint}</p>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-xs hover:bg-white/[0.06]", KIT_TEXT.primary.className, focusRing)}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  )
}

/** The run's state can't be confirmed: the stream dropped, or the service restarted mid-run. */
export function RunRecoveryBanner({ reason, className }: { reason: RunRecoveryReason; className?: string }) {
  const copy = RECOVERY_COPY[reason]
  const Icon = reason === "stream_lost" ? WifiOff : LifeBuoy
  return (
    <div className={cn("flex items-start gap-2 rounded-sm border px-3 py-2", TONE_SURFACE.warning, className)}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONE_TEXT.warning.className)} aria-hidden="true" />
      <div className="min-w-0">
        <p className={cn("text-xs font-medium", TONE_TEXT.warning.className)}>{copy.label}</p>
        <p className={cn("text-xs", KIT_TEXT.secondary.className)}>{copy.description}</p>
      </div>
    </div>
  )
}

/**
 * FE-06: a run whose outcome couldn't be proven (`recovery_required`) or that
 * this device lost authority over (`abandoned`). Its work was kept, so the
 * actions are "inspect it" before "run again" — never a silent retry.
 */
export function RunRecoveryActions({
  phase,
  onInspect,
  onContinue,
  continuing = false,
  onRunAgain,
  className,
}: {
  phase: Extract<RunPhase, "recovery_required" | "abandoned">
  onInspect?: () => void
  /** W12: resume the agent's saved session in the kept worktree (a follow-up turn). */
  onContinue?: () => void
  continuing?: boolean
  onRunAgain?: () => void
  className?: string
}) {
  const info = PHASE_INFO[phase]
  const Icon = phase === "abandoned" ? Unplug : LifeBuoy
  const button = cn(
    "inline-flex h-7 items-center gap-1.5 rounded-sm border border-white/15 px-2.5 text-xs font-medium transition-colors hover:bg-white/[0.06]",
    KIT_TEXT.primary.className,
    focusRing,
  )
  return (
    <div role="status" className={cn("flex flex-col gap-2 rounded-sm border px-3 py-2", TONE_SURFACE.warning, className)}>
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONE_TEXT.warning.className)} aria-hidden="true" />
        <div className="min-w-0">
          <p className={cn("text-xs font-medium", TONE_TEXT.warning.className)}>{info.label}</p>
          <p className={cn("text-xs", KIT_TEXT.secondary.className)}>{info.description}</p>
        </div>
      </div>
      {(onInspect || onContinue || onRunAgain) && (
        <div className="flex flex-wrap gap-2 pl-6">
          {onInspect && (
            <button type="button" onClick={onInspect} className={button}>
              <FileSearch className="h-3.5 w-3.5" aria-hidden="true" />
              Inspect the work
            </button>
          )}
          {onContinue && (
            <button type="button" onClick={onContinue} disabled={continuing} className={cn(button, "disabled:opacity-50")} title="Continue the agent's saved session in the kept worktree; it checks what is already done first">
              {continuing ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" /> : <StepForward className="h-3.5 w-3.5" aria-hidden="true" />}
              Continue where it stopped
            </button>
          )}
          {onRunAgain && (
            <button type="button" onClick={onRunAgain} className={button}>
              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              Run again
            </button>
          )}
        </div>
      )}
    </div>
  )
}
