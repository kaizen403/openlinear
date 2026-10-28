"use client"

import type { RunPhaseTimings } from "@/lib/api/review"
import { formatDuration } from "@/types/task"
import { cn } from "@/lib/utils"

/**
 * W15: where a finished run spent its time — a proportional bar plus the
 * same numbers as text (the bar is never the only signal).
 */

export interface PhaseSegment {
  key: "queued" | "preparing" | "agent" | "verifying" | "finishing"
  label: string
  ms: number
  /** The part of this phase worth calling out (setup, waiting for approval). */
  detail: string | null
}

const COLORS: Record<PhaseSegment["key"], string> = {
  queued: "bg-foreground/20",
  preparing: "bg-info/60",
  agent: "bg-linear-accent/70",
  verifying: "bg-success/60",
  finishing: "bg-warning/60",
}

/** The phases that took any time, in run order. */
export function phaseSegments(phases: RunPhaseTimings): PhaseSegment[] {
  const segments: PhaseSegment[] = [
    { key: "queued", label: "Queued", ms: phases.queuedMs, detail: null },
    { key: "preparing", label: "Preparing", ms: phases.preparingMs, detail: phases.setupMs > 0 ? `setup ${formatDuration(phases.setupMs)}` : null },
    { key: "agent", label: "Agent", ms: phases.agentMs, detail: phases.approvalWaitMs > 0 ? `waiting for you ${formatDuration(phases.approvalWaitMs)}` : null },
    { key: "verifying", label: "Verifying", ms: phases.verifyingMs, detail: null },
    { key: "finishing", label: "Publishing", ms: phases.finishingMs, detail: null },
  ]
  return segments.filter((segment) => segment.ms >= 1_000)
}

/** W19b: the project knowledge a run was given, by revision. */
export function RunKnowledgeNote({ entries, className }: { entries: ReadonlyArray<{ id: string; version: number; title: string }>; className?: string }) {
  if (entries.length === 0) return null
  return (
    <p className={cn("text-[11px] text-linear-text-secondary", className)}>
      Given {entries.length} project knowledge {entries.length === 1 ? "entry" : "entries"}:{" "}
      <span className="text-linear-text">{entries.map((entry) => `${entry.title} (v${entry.version})`).join(", ")}</span>
    </p>
  )
}

export function RunPhaseBreakdown({ phases, className }: { phases: RunPhaseTimings; className?: string }) {
  const segments = phaseSegments(phases)
  const total = segments.reduce((sum, segment) => sum + segment.ms, 0)
  if (segments.length === 0 || total <= 0) return null
  return (
    <div className={cn("space-y-1.5", className)} aria-label={`Run took ${formatDuration(phases.totalMs)}`}>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-foreground/5" aria-hidden="true">
        {segments.map((segment) => (
          <div key={segment.key} className={COLORS[segment.key]} style={{ width: `${(segment.ms / total) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-linear-text-secondary">
        <li className="text-linear-text">{formatDuration(phases.totalMs)} total</li>
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1">
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", COLORS[segment.key])} aria-hidden="true" />
            {segment.label} {formatDuration(segment.ms)}
            {segment.detail && <span className="text-linear-text-tertiary">({segment.detail})</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
