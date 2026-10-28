import type { ExecutionLogEntry, Task } from "@/types/task"
import type { TaskExecutionOutcome } from "@/components/board/execution-outcome"

/**
 * Normalized run model for the agent-execution UI kit.
 *
 * Everything here is plain data: the model is folded from today's execution
 * events (legacy `execution:progress` / `execution:log`, the persisted task
 * row) and from the run journal (`execution:progress {runId, seq, type,
 * payload}`) that the W05 run/attempt state machine will emit. Components only
 * ever read a {@link RunSnapshot}; they never look at wire events.
 */

/**
 * Lifecycle phase of the current attempt.
 *
 * The v2 run engine reports every state of its machine (`runState` on
 * `execution:progress`): queued, preparing, running, awaiting_approval,
 * compacting, verifying, finishing (shown as committing/publishing),
 * succeeded, failed, cancelled, recovery_required and abandoned. The legacy
 * engine reports a subset through `status`. `unknown` is the client's own
 * phase: the stream was lost and the state can't be proven.
 */
export type RunPhase =
  | "idle"
  | "queued"
  | "preparing"
  | "running"
  | "awaiting_approval"
  | "compacting"
  | "verifying"
  | "committing"
  | "publishing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "recovery_required"
  | "abandoned"
  | "unknown"

/** Why the phase is `unknown`: the client can't currently prove what the run is doing. */
export type RunRecoveryReason = "stream_lost" | "service_restarted"

/** Where the current phase came from (most to least authoritative for live runs). */
export type RunPhaseSource = "none" | "journal" | "progress" | "snapshot" | "log" | "stream" | "request"

/** `unfinished`: the attempt ended (or a new one started) before the tool reported a result. */
export type ToolStatus = "running" | "completed" | "error" | "unfinished"

export type FileChangeKind = "added" | "modified" | "deleted"

interface EntryBase {
  /** Stable React key; never reused for another entry. */
  id: string
  /** Wall-clock time the entry happened (ms since epoch), when known. */
  at: number | null
  /** 1-based attempt the entry belongs to. */
  attempt: number
}

export interface AssistantEntry extends EntryBase {
  kind: "assistant"
  text: string
  /** True when the text was cut at the per-entry character budget. */
  truncated: boolean
}

export interface ReasoningEntry extends EntryBase {
  kind: "reasoning"
  text: string
  truncated: boolean
}

export interface ToolEntry extends EntryBase {
  kind: "tool"
  /** Raw tool name when known ("bash", "read", "mcp__x__y"); null while only a title was seen. */
  name: string | null
  /** Most identifying argument: a path, a command, a pattern or the tool's own title. */
  summary: string | null
  status: ToolStatus
  /** Shell tools render as commands. */
  isCommand: boolean
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  /** Arguments as shown in the expanded row (bounded). */
  args: string | null
  /** Output preview (bounded; collapsed further once the entry is old). */
  output: string | null
  outputTruncated: boolean
  /** Journal call id, when the runner reports one. */
  callId: string | null
}

export interface FileEditEntry extends EntryBase {
  kind: "file"
  path: string
  change: FileChangeKind
}

export interface SystemEntry extends EntryBase {
  kind: "system"
  text: string
  details: string | null
  tone: "neutral" | "success" | "warning"
}

export interface ErrorEntry extends EntryBase {
  kind: "error"
  text: string
  details: string | null
}

/** Separates a new attempt from the previous one's evidence (FE-06: retry keeps prior evidence). */
export interface AttemptEntry extends EntryBase {
  kind: "attempt"
  text: string
}

export type TimelineEntry =
  | AssistantEntry
  | ReasoningEntry
  | ToolEntry
  | FileEditEntry
  | SystemEntry
  | ErrorEntry
  | AttemptEntry

export type TimelineEntryKind = TimelineEntry["kind"]

export interface FileChange {
  path: string
  change: FileChangeKind
  /** How many edit events touched the path in this attempt. */
  edits: number
  lastAt: number | null
}

export type RunCost =
  | { status: "unknown" }
  | { status: "known"; usd: number; basis: string | null }

export interface RunTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface RunCounters {
  /** Tool calls seen in this attempt (including ones dropped from the window). */
  tools: number
  toolsRunning: number
  toolErrors: number
  /** Distinct paths changed in this attempt. */
  filesChanged: number
  /** Error entries in this attempt. */
  errors: number
  /** Timeline entries ever created (all attempts), including dropped ones. */
  entriesTotal: number
}

export interface RunSnapshot {
  taskId: string | null
  /** Journal run id once the W05 journal reports one. */
  runId: string | null
  /** 0 until a run is observed, then 1-based. */
  attempt: number
  phase: RunPhase
  phaseSource: RunPhaseSource
  recovery: RunRecoveryReason | null
  /** Latest activity line ("Running: bash", "Committing changes..."). */
  message: string | null
  runner: string | null
  model: string | null
  branch: string | null
  startedAt: number | null
  endedAt: number | null
  /** Persisted elapsed time for a finished run (task row), when known. */
  persistedElapsedMs: number | null
  cost: RunCost
  tokens: RunTokens | null
  /** FE-08/W15a: the run's budgets (null = none known). */
  budget: { maxUsd: number | null; maxTokens: number | null } | null
  counters: RunCounters
  files: readonly FileChange[]
  /** Paths changed beyond the file-list cap (counted, not listed). */
  filesOverflow: number
  entries: readonly TimelineEntry[]
  /** Oldest entries dropped to keep memory bounded. */
  droppedEntries: number
  outcome: TaskExecutionOutcome | null
  /** True once anything at all was folded in (events, history or a run-bearing snapshot). */
  hasActivity: boolean
  lastEventAt: number | null
  /** Monotonic; bumps whenever the snapshot changes. */
  version: number
}

/** The persisted task row fields the model reads. */
export type RunTaskSnapshot = Pick<
  Task,
  "id" | "status" | "outcome" | "prUrl" | "batchId" | "executionStartedAt" | "executionElapsedMs"
> & { model?: string | null }

export type LegacyProgressStatus =
  | "queued"
  | "cloning"
  | "executing"
  | "committing"
  | "creating_pr"
  | "done"
  | "cancelled"
  | "error"

/** The v2 run engine's state machine (execution-core `RUN_STATES`), as it rides on `execution:progress`. */
export type RunStateWire =
  | "queued"
  | "preparing"
  | "running"
  | "awaiting_approval"
  | "compacting"
  | "verifying"
  | "finishing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "recovery_required"
  | "abandoned"

/**
 * `execution:progress` payload: legacy `broadcastProgress`, or the v2 run
 * engine's beat, which adds `runId` + `runSeq` (journal sequence: identifies
 * the event across reconnects and replays) and, on state changes and the
 * beats of non-agent states, `runState`.
 */
export interface LegacyProgressInput {
  kind: "progress"
  /** SSE id (numeric outbox id on the cloud stream), when the event had one. */
  id?: string | null
  taskId: string
  status: LegacyProgressStatus
  message: string
  prUrl?: string | null
  isCompareLink?: boolean
  runId?: string | null
  runSeq?: number | null
  runState?: RunStateWire | null
  receivedAt?: number
}

/** Today's `execution:log` payload (sidecar `addLogEntry`). */
export interface LegacyLogInput {
  kind: "log"
  id?: string | null
  taskId: string
  entry: ExecutionLogEntry
  receivedAt?: number
}

/** Run-journal event (`execution:progress {runId, seq, type, payload}`), the W05 path. */
export interface JournalInput {
  kind: "journal"
  id?: string | null
  runId: string
  seq: number
  taskId?: string | null
  type: string
  payload: unknown
  /** ISO time or epoch ms when the server recorded it. */
  at?: string | number | null
  receivedAt?: number
}

/** Logs fetched from `GET /api/tasks/:id/logs` (no ids; may overlap live events). */
export interface HistoryInput {
  kind: "history"
  taskId: string
  entries: readonly ExecutionLogEntry[]
}

export interface SnapshotInput {
  kind: "snapshot"
  task: RunTaskSnapshot
}

/** Event-stream connectivity, from the SSE provider. */
export interface StreamInput {
  kind: "stream"
  state: "open" | "lost"
  at?: number
}

/** The user asked to execute; nothing has been reported yet. */
export interface StartRequestedInput {
  kind: "start-requested"
  at?: number
}

/** The start request ended without a run (rejected or failed before admission). */
export interface StartAbandonedInput {
  kind: "start-abandoned"
}

/**
 * The sidecar's durable run state (`GET /api/tasks/:id/run`): re-seeds the
 * model after a reload or reconnect so it shows the same state the journal
 * holds, even when the live beats that set it were missed.
 */
export interface RunStateInput {
  kind: "run-state"
  taskId: string
  runId: string
  /** Journal sequence the state is current as of. */
  lastSeq: number
  state: RunStateWire
  runner: string | null
  /** W15a: the run's sealed budgets (absent = none). */
  budgets?: { maxUsd?: number; maxTokens?: number } | null
}

export type RunInput =
  | RunStateInput
  | LegacyProgressInput
  | LegacyLogInput
  | JournalInput
  | HistoryInput
  | SnapshotInput
  | StreamInput
  | StartRequestedInput
  | StartAbandonedInput

export interface RunModelOptions {
  taskId?: string | null
  /** Timeline window; older entries are dropped (and counted). Default 1500. */
  maxEntries?: number
  /** Per-entry character budget for text, args and output. Default 4000. */
  maxTextChars?: number
  /** Entries older than the newest N have their output collapsed. Default 300. */
  keepFullOutputFor?: number
  /** Output preview kept for collapsed entries. Default 240. */
  collapsedOutputChars?: number
  /** Distinct paths listed in `files`. Default 500. */
  maxFiles?: number
  /** Dedupe memory (ids and content keys). Default 8192. */
  maxSeenKeys?: number
  /** Clock for receivedAt defaults (tests inject one). */
  now?: () => number
}
