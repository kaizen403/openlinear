import type { LegacyProgressStatus, RunPhase, RunRecoveryReason, RunSnapshot, RunStateWire } from "./types"

export type PhaseTone = "neutral" | "info" | "active" | "warning" | "success" | "danger"

export interface PhaseInfo {
  label: string
  /** Longer sentence for screen readers and tooltips. */
  description: string
  tone: PhaseTone
  /** Ordering inside one attempt; terminal phases share the top rank. */
  rank: number
  terminal: boolean
  /** The agent or the publication step is doing work right now. */
  live: boolean
}

export const PHASE_INFO: Readonly<Record<RunPhase, PhaseInfo>> = {
  idle: { label: "Not run", description: "This task has not been run yet.", tone: "neutral", rank: 0, terminal: false, live: false },
  queued: { label: "Queued", description: "Waiting for the execution service to start the run.", tone: "info", rank: 1, terminal: false, live: true },
  preparing: { label: "Preparing", description: "Preparing the repository and starting the agent.", tone: "info", rank: 2, terminal: false, live: true },
  running: { label: "Running", description: "The agent is working.", tone: "active", rank: 3, terminal: false, live: true },
  awaiting_approval: { label: "Awaiting approval", description: "The agent is waiting for a permission decision.", tone: "warning", rank: 3, terminal: false, live: true },
  compacting: { label: "Compacting", description: "The agent is summarizing its context so it can keep going.", tone: "info", rank: 3, terminal: false, live: true },
  verifying: { label: "Verifying", description: "Checking the agent's work before publishing.", tone: "info", rank: 4, terminal: false, live: true },
  committing: { label: "Committing", description: "Committing the agent's changes.", tone: "info", rank: 5, terminal: false, live: true },
  publishing: { label: "Publishing", description: "Pushing the branch and opening a pull request.", tone: "info", rank: 6, terminal: false, live: true },
  succeeded: { label: "Succeeded", description: "The run finished and its result was published.", tone: "success", rank: 9, terminal: true, live: false },
  failed: { label: "Failed", description: "The run failed.", tone: "danger", rank: 9, terminal: true, live: false },
  cancelled: { label: "Cancelled", description: "The run was cancelled.", tone: "neutral", rank: 9, terminal: true, live: false },
  recovery_required: {
    label: "Recovery required",
    description: "The execution service restarted and couldn't prove how the run ended. Its work was kept; inspect it before running again.",
    tone: "warning", rank: 9, terminal: true, live: false,
  },
  abandoned: {
    label: "Abandoned",
    description: "This device lost authority over the run before its result was confirmed. Its work was kept locally.",
    tone: "warning", rank: 9, terminal: true, live: false,
  },
  unknown: { label: "Unknown", description: "The run's state can't be confirmed right now.", tone: "warning", rank: 3, terminal: false, live: false },
}

export const RECOVERY_COPY: Readonly<Record<RunRecoveryReason, { label: string; description: string }>> = {
  stream_lost: {
    label: "Connection lost",
    description: "Live updates stopped. The run may still be going; its state is unknown until the connection recovers.",
  },
  service_restarted: {
    label: "Recovery required",
    description: "The execution service restarted during this run. Its work was kept; inspect the retained branch before running again.",
  },
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return PHASE_INFO[phase].terminal
}

export function isLivePhase(phase: RunPhase): boolean {
  return PHASE_INFO[phase].live
}

/** Phases from today's `execution:progress.status`. */
export const LEGACY_STATUS_PHASE: Readonly<Record<LegacyProgressStatus, RunPhase>> = {
  queued: "queued",
  cloning: "preparing",
  executing: "running",
  committing: "committing",
  creating_pr: "publishing",
  done: "succeeded",
  cancelled: "cancelled",
  error: "failed",
}

/**
 * Phases from the v2 engine's `runState`. `finishing` (commit → push → PR)
 * has no single phase: the beat's legacy `status` says which step it is on.
 */
export const RUN_STATE_PHASE: Readonly<Record<RunStateWire, RunPhase | null>> = {
  queued: "queued",
  preparing: "preparing",
  running: "running",
  awaiting_approval: "awaiting_approval",
  compacting: "compacting",
  verifying: "verifying",
  finishing: null,
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  recovery_required: "recovery_required",
  abandoned: "abandoned",
}

/** The legacy `status` the v2 engine sends with each state (execution-core LEGACY_PROGRESS_STATUS). */
export const RUN_STATE_STATUS: Readonly<Record<RunStateWire, LegacyProgressStatus>> = {
  queued: "queued",
  preparing: "cloning",
  running: "executing",
  awaiting_approval: "executing",
  compacting: "executing",
  verifying: "committing",
  finishing: "committing",
  succeeded: "done",
  failed: "error",
  cancelled: "cancelled",
  recovery_required: "error",
  abandoned: "error",
}

const RUN_STATES = new Set<string>(Object.keys(RUN_STATE_PHASE))

export function isRunStateWire(value: unknown): value is RunStateWire {
  return typeof value === "string" && RUN_STATES.has(value)
}

/** The phase a v2 beat implies: its `runState`, or for `finishing` the publication step its `status` names. */
export function phaseForRunState(runState: RunStateWire, status: LegacyProgressStatus): RunPhase {
  const phase = RUN_STATE_PHASE[runState]
  if (phase) return phase
  return status === "creating_pr" ? "publishing" : "committing"
}

const LEGACY_STATUSES = new Set<string>(Object.keys(LEGACY_STATUS_PHASE))

export function isLegacyProgressStatus(value: unknown): value is LegacyProgressStatus {
  return typeof value === "string" && LEGACY_STATUSES.has(value)
}

const RUN_PHASES = new Set<string>(Object.keys(PHASE_INFO))

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === "string" && RUN_PHASES.has(value)
}

/** Label shown in the phase pill, including the recovery reason when the phase is unknown. */
export function phaseLabel(snapshot: Pick<RunSnapshot, "phase" | "recovery">): string {
  if (snapshot.phase === "unknown" && snapshot.recovery) return RECOVERY_COPY[snapshot.recovery].label
  return PHASE_INFO[snapshot.phase].label
}

export function phaseDescription(snapshot: Pick<RunSnapshot, "phase" | "recovery">): string {
  if (snapshot.phase === "unknown" && snapshot.recovery) return RECOVERY_COPY[snapshot.recovery].description
  return PHASE_INFO[snapshot.phase].description
}

/**
 * Elapsed time of the current attempt. Live attempts tick against `now`;
 * finished ones prefer the persisted elapsed time (it excludes paused time).
 */
export function runElapsedMs(
  snapshot: Pick<RunSnapshot, "phase" | "startedAt" | "endedAt" | "persistedElapsedMs">,
  now: number,
): number | null {
  if (isTerminalPhase(snapshot.phase) && snapshot.persistedElapsedMs !== null && snapshot.persistedElapsedMs > 0) {
    return snapshot.persistedElapsedMs
  }
  if (snapshot.startedAt === null) return snapshot.persistedElapsedMs
  const end = snapshot.endedAt ?? (isTerminalPhase(snapshot.phase) || snapshot.phase === "unknown" ? null : now)
  if (end === null) return snapshot.persistedElapsedMs ?? null
  return Math.max(0, end - snapshot.startedAt)
}

/** "4s", "2m 05s", "1h 02m". */
export function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—"
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

/** "820ms", "1.4s", "2m 05s". */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return formatElapsed(ms)
}
