"use client"

import { Check, Loader2, RotateCcw, Square, TriangleAlert, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRing } from "@/components/ui/focus-ring"
import { isLivePhase, type RunPhase, type RunPhaseSource } from "@/lib/run-model"
import { KIT_TEXT, TONE_SURFACE, TONE_TEXT } from "./tokens"
import { STOP_COPY, type StopState } from "./use-stop-control"

interface StopButtonProps {
  phase: RunPhase
  /** Where the phase came from: a `queued` reported by the engine can be cancelled; a pending start request can't. */
  phaseSource?: RunPhaseSource
  stop: StopState
  onRequest: () => void
  canStop: boolean
  className?: string
  /** Icon-only label hidden below `sm` (header placement). */
  compactLabel?: boolean
}

/** Whether a stop can (still) be sent for this phase and stop state. */
export function stopAvailable(phase: RunPhase, stop: StopState, canStop: boolean, phaseSource: RunPhaseSource = "none"): boolean {
  if (!canStop) return false
  if (stop.status === "requested" || stop.status === "unconfirmed") return true
  // FE-06: the v2 engine cancels a run waiting in its queue; a start still in flight has nothing to cancel yet.
  if (phase === "queued") return phaseSource === "journal"
  return isLivePhase(phase)
}

/** The Stop button: "Stop" → "Stopping…" (disabled) → "Retry stop" when unconfirmed. */
export function StopButton({ phase, phaseSource, stop, onRequest, canStop, className, compactLabel }: StopButtonProps) {
  if (!stopAvailable(phase, stop, canStop, phaseSource)) return null
  const requested = stop.status === "requested"
  const retry = stop.status === "unconfirmed"
  const Icon = requested ? Loader2 : retry ? RotateCcw : Square
  return (
    <button
      type="button"
      onClick={onRequest}
      disabled={requested}
      aria-label={requested ? "Stopping" : retry ? "Retry stop" : "Stop run"}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-medium transition-colors disabled:cursor-progress disabled:opacity-70",
        retry ? cn(TONE_SURFACE.warning, TONE_TEXT.warning.className, "hover:bg-run-warning/20") : cn("border-white/15", KIT_TEXT.primary.className, "hover:bg-white/[0.06]"),
        focusRing,
        className,
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", requested && "motion-safe:animate-spin", !requested && !retry && "fill-current")} aria-hidden="true" />
      <span className={cn(compactLabel && "hidden sm:inline")}>{requested ? STOP_COPY.requested.label : retry ? STOP_COPY.unconfirmed.label : STOP_COPY.idle.label}</span>
    </button>
  )
}

/** Polite status line for the stop's real outcome. */
export function StopStatus({ stop, className }: { stop: StopState; className?: string }) {
  const tone = stop.status === "unconfirmed" ? "warning" : stop.status === "stopped" ? "success" : "neutral"
  const Icon = stop.status === "unconfirmed" ? TriangleAlert : stop.status === "stopped" ? Check : stop.status === "requested" ? Loader2 : Info
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className={cn(stop.status === "idle" && "sr-only", className)}>
      {stop.status !== "idle" && stop.message && (
        <p className={cn("flex items-start gap-1.5 text-xs", tone === "neutral" ? KIT_TEXT.secondary.className : TONE_TEXT[tone].className)}>
          <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", stop.status === "requested" && "motion-safe:animate-spin")} aria-hidden="true" />
          <span>
            {stop.message}
            {stop.hint && <span className={cn("block", KIT_TEXT.secondary.className)}>{stop.hint}</span>}
          </span>
        </p>
      )}
    </div>
  )
}

interface RunControlsProps extends StopButtonProps {
  showStatus?: boolean
}

/** Stop control plus its outcome line (stop requested / stopped / stop unconfirmed — retry). */
export function RunControls({ showStatus = true, className, ...button }: RunControlsProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <StopButton {...button} />
      {showStatus && <StopStatus stop={button.stop} />}
    </div>
  )
}
