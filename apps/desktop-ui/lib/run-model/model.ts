import type { ExecutionLogEntry, Task } from "@/types/task"
import {
  describeTaskExecution,
  isReadyToPublishTask,
  type TaskExecutionOutcome,
} from "@/components/board/execution-outcome"
import { BoundedSet, clampTail, clampText } from "./bounded"
import { classifyLegacyLog, type LegacyLogMeaning } from "./legacy"
import { LEGACY_STATUS_PHASE, PHASE_INFO, RUN_STATE_STATUS, isRunPhase, isTerminalPhase, phaseForRunState } from "./phase"
import { formatToolArgs, isKnownToolName, isShellTool, summarizeToolInput } from "./tool-summary"
import type {
  AssistantEntry,
  FileChange,
  FileChangeKind,
  JournalInput,
  LegacyLogInput,
  LegacyProgressInput,
  LegacyProgressStatus,
  ReasoningEntry,
  RunCost,
  RunCounters,
  RunInput,
  RunStateInput,
  RunModelOptions,
  RunPhase,
  RunPhaseSource,
  RunRecoveryReason,
  RunSnapshot,
  RunTaskSnapshot,
  RunTokens,
  TimelineEntry,
  ToolEntry,
} from "./types"

/**
 * Folds execution events into a {@link RunSnapshot}.
 *
 * The model is plain TypeScript (no React, no I/O, injectable clock), so it
 * can be driven from recorded event fixtures. It is mutable internally for
 * O(1) amortized `apply()`; `getSnapshot()` returns an immutable view that is
 * rebuilt at most once per change (callers batch to animation frames).
 *
 * Guarantees:
 * - **Dedupe.** By SSE id, by journal (runId, seq), and by log content
 *   (timestamp|type|message|details, the same key the execution store uses) so
 *   history fetched over HTTP and the live copy of the same line fold once.
 * - **Ordering.** Entries are kept in (journal seq | timestamp, id) order;
 *   out-of-order arrivals are inserted in place. A phase change backed by an
 *   older numeric outbox id than the current phase is ignored, so a replayed
 *   or late event can't move a finished run backwards.
 * - **Bounded memory.** At most `maxEntries` timeline entries (oldest dropped
 *   and counted), per-entry text/output budgets, old output collapsed to a
 *   short preview, bounded dedupe memory and file list. Totals keep counting.
 */

const DEFAULTS = {
  maxEntries: 1500,
  maxTextChars: 4000,
  keepFullOutputFor: 300,
  collapsedOutputChars: 240,
  maxFiles: 500,
  maxSeenKeys: 8192,
} as const

/** Legacy text chunks closer than this merge into one block. */
const MERGE_WINDOW_MS = 15_000
/** A start line can be attached to a completion seen this long after it. */
const ATTACH_WINDOW_MS = 120_000
const ACTIVITY_THINKING = "Agent is thinking…"

interface SortMeta {
  at: number
  tie: number
  run: string | null
  seq: number | null
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function emptyCounters(entriesTotal: number): RunCounters {
  return { tools: 0, toolsRunning: 0, toolErrors: 0, filesChanged: 0, errors: 0, entriesTotal }
}

function parseTime(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value !== "string" || !value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/** Numeric outbox ids are monotonic per database sequence, so they order events. */
function numericOrder(id: string | null | undefined): number | null {
  if (!id || !/^\d{1,15}$/.test(id)) return null
  return Number(id)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function str(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === "string" ? value : null
}

function num(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function logKey(entry: ExecutionLogEntry): string {
  return `l:${entry.timestamp}|${entry.type}|${entry.message}|${entry.details ?? ""}`
}

/** Ended without the requested result; the outcome carries the reason. */
const FAILURE_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>(["failed", "recovery_required", "abandoned"])

/** The v2 `finishing` state's steps. */
const PUBLICATION_STEPS: ReadonlySet<RunPhase> = new Set<RunPhase>(["committing", "publishing"])

function phaseToTaskStatus(phase: RunPhase): Task["status"] {
  if (phase === "succeeded") return "done"
  // The control plane releases a task whose run failed, was cancelled, or whose outcome couldn't be proven.
  if (phase === "failed" || phase === "cancelled" || phase === "recovery_required" || phase === "abandoned") return "cancelled"
  if (phase === "idle") return "todo"
  return "in_progress"
}

const FILE_KIND: Readonly<Record<string, FileChangeKind>> = {
  create: "added",
  add: "added",
  added: "added",
  edit: "modified",
  modify: "modified",
  modified: "modified",
  delete: "deleted",
  remove: "deleted",
  deleted: "deleted",
}

export class RunModel {
  private readonly opts: Required<Omit<RunModelOptions, "taskId" | "now">>
  private readonly now: () => number
  private taskId: string | null

  private entries: TimelineEntry[] = []
  private sortMeta: SortMeta[] = []
  private dropped = 0
  private collapseCursor = 0
  private entrySeq = 0
  private arrival = 0
  private readonly seen: BoundedSet<string>

  private attempt = 0
  private phase: RunPhase = "idle"
  private phaseSource: RunPhaseSource = "none"
  private phaseOrder: number | null = null
  /** Highest numeric outbox id folded in this attempt (logs and progress). */
  private maxOrder: number | null = null
  private phaseBeforeLoss: RunPhase | null = null
  private recovery: RunRecoveryReason | null = null
  private message: string | null = null
  private runner: string | null = null
  private model: string | null = null
  private branch: string | null = null
  private startedAt: number | null = null
  private endedAt: number | null = null
  private persistedElapsedMs: number | null = null
  private usageByMessage = new Map<string, { cost: number | null; basis: string | null; tokens: RunTokens }>()
  private counters: RunCounters = emptyCounters(0)
  private files = new Map<string, FileChange>()
  private filesOverflow = 0
  /** Open tool rows, oldest first, keyed by entry id. */
  private openTools = new Map<string, ToolEntry>()
  private toolsByCallId = new Map<string, string>()
  private lastProgress: { status: LegacyProgressStatus; message: string; prUrl: string | null; isCompareLink: boolean } | null = null
  private logPrUrl: string | null = null
  private journalOutcome: { status: Task["status"]; outcome: string | null; prUrl: string | null } | null = null
  private task: RunTaskSnapshot | null = null
  private snapshotStatus: Task["status"] | null = null
  private snapshotOutcome: string | null = null
  private currentRunId: string | null = null
  private budget: RunSnapshot["budget"] = null
  /** v2 run engine: journal sequence of the beat that set the current phase (later beats of the run only). */
  private runSeqPhase: number | null = null
  private readonly knownRuns: BoundedSet<string>
  private hasActivity = false
  private lastEventAt: number | null = null
  /** A start was requested and nothing has reported yet: shown as `queued` over the last phase. */
  private pendingStart: number | null = null

  private version = 0
  private dirty = true
  private entriesDirty = true
  private filesDirty = true
  private cached: RunSnapshot | null = null
  private cachedEntries: readonly TimelineEntry[] = []
  private cachedFiles: readonly FileChange[] = []

  constructor(options: RunModelOptions = {}) {
    this.opts = {
      maxEntries: options.maxEntries ?? DEFAULTS.maxEntries,
      maxTextChars: options.maxTextChars ?? DEFAULTS.maxTextChars,
      keepFullOutputFor: options.keepFullOutputFor ?? DEFAULTS.keepFullOutputFor,
      collapsedOutputChars: options.collapsedOutputChars ?? DEFAULTS.collapsedOutputChars,
      maxFiles: options.maxFiles ?? DEFAULTS.maxFiles,
      maxSeenKeys: options.maxSeenKeys ?? DEFAULTS.maxSeenKeys,
    }
    this.now = options.now ?? Date.now
    this.taskId = options.taskId ?? null
    this.seen = new BoundedSet(this.opts.maxSeenKeys)
    this.knownRuns = new BoundedSet(64)
  }

  /** Run ids this model has folded (lets callers route journal events that carry no taskId). */
  knowsRun(runId: string): boolean {
    return this.knownRuns.has(runId)
  }

  applyMany(inputs: Iterable<RunInput>): boolean {
    let changed = false
    for (const input of inputs) changed = this.apply(input) || changed
    return changed
  }

  /** Folds one input. Returns true when the snapshot changed. */
  apply(input: RunInput): boolean {
    const before = this.version
    switch (input.kind) {
      case "run-state":
        this.applyRunState(input)
        break
      case "progress":
        this.applyProgress(input)
        break
      case "log":
        this.applyLog(input)
        break
      case "history":
        for (const entry of input.entries) this.applyLog({ kind: "log", taskId: input.taskId, entry })
        break
      case "journal":
        this.applyJournal(input)
        break
      case "snapshot":
        this.applySnapshot(input.task)
        break
      case "stream":
        this.applyStream(input.state)
        break
      case "start-requested":
        this.applyStartRequested(input.at ?? this.now())
        break
      case "start-abandoned":
        if (this.pendingStart !== null) {
          this.pendingStart = null
          this.touch()
        }
        break
    }
    return this.version !== before
  }

  getSnapshot(): RunSnapshot {
    if (!this.dirty && this.cached) return this.cached
    if (this.entriesDirty) {
      this.cachedEntries = Object.freeze(this.entries.slice())
      this.entriesDirty = false
    }
    if (this.filesDirty) {
      this.cachedFiles = Object.freeze(Array.from(this.files.values()))
      this.filesDirty = false
    }
    const queued = this.pendingStart !== null
    const snapshot: RunSnapshot = {
      taskId: this.taskId,
      runId: this.currentRunId,
      attempt: this.attempt,
      phase: queued ? "queued" : this.phase,
      phaseSource: queued ? "request" : this.phaseSource,
      recovery: queued ? null : this.recovery,
      message: queued ? "Waiting for the execution service…" : this.message,
      runner: this.runner,
      model: this.model,
      branch: this.branch,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      persistedElapsedMs: this.persistedElapsedMs,
      cost: this.cost(),
      tokens: this.tokens(),
      budget: this.budget,
      counters: { ...this.counters, filesChanged: this.files.size + this.filesOverflow },
      files: this.cachedFiles,
      filesOverflow: this.filesOverflow,
      entries: this.cachedEntries,
      droppedEntries: this.dropped,
      outcome: this.outcome(),
      hasActivity: this.hasActivity || queued,
      lastEventAt: this.lastEventAt,
      version: this.version,
    }
    this.cached = snapshot
    this.dirty = false
    return snapshot
  }

  // ─── change tracking ──────────────────────────────────────────────────────

  private touch(entries = false, files = false): void {
    this.version += 1
    this.dirty = true
    if (entries) this.entriesDirty = true
    if (files) this.filesDirty = true
  }

  private noteEvent(at: number | null): void {
    this.hasActivity = true
    if (at !== null && (this.lastEventAt === null || at > this.lastEventAt)) this.lastEventAt = at
  }

  // ─── attempts and phases ──────────────────────────────────────────────────

  private startAttempt(at: number | null, runId: string | null = null): void {
    // Close whatever the previous attempt left open: its tools never reported a result.
    if (this.openTools.size > 0) {
      for (const tool of Array.from(this.openTools.values())) {
        this.replaceEntry(tool, { ...tool, status: "unfinished" })
      }
      this.openTools.clear()
    }
    this.attempt += 1
    if (this.attempt > 1 && this.entries.length > 0) {
      this.insertEntry(
        { kind: "attempt", id: this.nextId("attempt"), at, attempt: this.attempt, text: `Run ${this.attempt} started` },
        { at: at ?? this.lastSortAt(), tie: this.nextTie(null), run: null, seq: null },
      )
    }
    this.phase = "idle"
    this.phaseSource = "none"
    this.phaseOrder = null
    this.maxOrder = null
    this.phaseBeforeLoss = null
    this.recovery = null
    this.message = null
    this.branch = null
    this.startedAt = null
    this.endedAt = null
    this.persistedElapsedMs = null
    this.usageByMessage = new Map()
    this.counters = emptyCounters(this.counters.entriesTotal)
    this.files = new Map()
    this.filesOverflow = 0
    this.toolsByCallId = new Map()
    this.lastProgress = null
    this.logPrUrl = null
    this.journalOutcome = null
    this.currentRunId = runId
    this.runSeqPhase = null
    this.budget = null
    this.hasActivity = true
    this.touch(true, true)
  }

  private setPhase(phase: RunPhase, source: RunPhaseSource, at: number | null, order: number | null = null): void {
    const wasTerminal = isTerminalPhase(this.phase)
    if (this.attempt === 0) this.attempt = 1
    if (this.phase !== phase || this.phaseSource !== source) {
      this.phase = phase
      this.phaseSource = source
      this.touch()
    }
    if (order !== null) this.phaseOrder = order
    if (phase !== "unknown") this.recovery = null
    if (PHASE_INFO[phase].live && phase !== "queued" && this.startedAt === null && at !== null) {
      this.startedAt = at
      this.touch()
    }
    if (isTerminalPhase(phase) && !wasTerminal) {
      this.endedAt = at
      for (const tool of Array.from(this.openTools.values())) {
        this.replaceEntry(tool, { ...tool, status: "unfinished" })
      }
      this.openTools.clear()
      this.counters.toolsRunning = 0
      this.touch(true)
    }
  }

  /** Forward-only phase implied by a log line (history without progress events). */
  private advancePhase(phase: RunPhase, at: number | null): void {
    if (isTerminalPhase(this.phase)) return
    if (this.phase === "unknown" && this.recovery === "stream_lost") {
      if (PHASE_INFO[phase].rank > PHASE_INFO[this.phaseBeforeLoss ?? "idle"].rank) this.phaseBeforeLoss = phase
      return
    }
    if (PHASE_INFO[phase].rank <= PHASE_INFO[this.phase].rank && this.phase !== "idle" && this.phase !== "queued") return
    this.setPhase(phase, "log", at)
  }

  private applyStartRequested(at: number): void {
    if (this.phase !== "idle" && !isTerminalPhase(this.phase)) return
    // An overlay, not a new attempt: if the start is rejected the last run's
    // state comes back untouched; the first real report opens the attempt.
    this.pendingStart = at
    this.touch()
  }

  private clearPendingStart(): void {
    if (this.pendingStart === null) return
    this.pendingStart = null
    this.touch()
  }

  private applyStream(state: "open" | "lost"): void {
    if (state === "lost") {
      if (!PHASE_INFO[this.phase].live || this.phase === "unknown") return
      this.phaseBeforeLoss = this.phase
      this.phase = "unknown"
      this.phaseSource = "stream"
      this.recovery = "stream_lost"
      this.touch()
      return
    }
    if (this.recovery !== "stream_lost") return
    // The stream resumes from its cursor and replays what was missed, so the
    // last known phase is restored; replayed events correct it from there.
    this.phase = this.phaseBeforeLoss ?? "running"
    this.phaseSource = "stream"
    this.phaseBeforeLoss = null
    this.recovery = null
    this.touch()
  }

  // ─── legacy progress ──────────────────────────────────────────────────────

  private applyProgress(input: LegacyProgressInput): void {
    if (input.runId && typeof input.runSeq === "number") {
      this.applyRunProgress({ ...input, runId: input.runId, runSeq: input.runSeq })
      return
    }
    if (input.id) {
      if (!this.seen.add(`id:${input.id}`)) return
    }
    const order = numericOrder(input.id)
    const at = input.receivedAt ?? this.now()
    const next = LEGACY_STATUS_PHASE[input.status]
    this.noteEvent(at)

    if (this.attempt === 0) {
      this.startAttempt(at)
    } else if (isTerminalPhase(this.phase) || this.phase === "idle") {
      const stale = order !== null && this.phaseOrder !== null && order < this.phaseOrder
      if (stale) return
      if (!isTerminalPhase(next) && this.phase !== "idle") {
        // Only a fresh start (the sidecar always reports `cloning` first) that is
        // provably newer than the finished run opens a new attempt; other late
        // non-terminal beats belong to the finished run. Without ordering
        // evidence (history-only run), the new run's first log line splits it.
        if (next !== "preparing") return
        const reference = this.phaseOrder ?? this.maxOrder
        // An id-less beat is the execution store's latest progress (always
        // current). A terminal phase that only the task row reported belongs to
        // a run this session never saw live, so any live start is newer.
        const fresh =
          order === null ||
          this.pendingStart !== null ||
          (reference !== null ? order > reference : this.phaseSource === "snapshot")
        if (!fresh) return
        this.startAttempt(at)
      }
    } else {
      const stale = order !== null && this.phaseOrder !== null && order < this.phaseOrder
      if (stale) return
      if (next === "preparing" && PHASE_INFO[this.phase].rank >= PHASE_INFO.running.rank && this.phaseSource !== "stream") {
        this.startAttempt(at)
      }
    }

    if (this.recovery === "stream_lost") {
      this.phaseBeforeLoss = null
    }
    this.clearPendingStart()
    if (order !== null && (this.maxOrder === null || order > this.maxOrder)) this.maxOrder = order
    this.lastProgress = {
      status: input.status,
      message: input.message,
      prUrl: input.prUrl ?? null,
      isCompareLink: Boolean(input.isCompareLink),
    }
    this.message = input.message || this.message
    this.setPhase(next, "progress", at, order)
    this.touch()
  }

  // ─── legacy logs ──────────────────────────────────────────────────────────

  private applyLog(input: LegacyLogInput): void {
    const entry = input.entry
    if (!entry || typeof entry.message !== "string") return
    if (input.id && this.seen.has(`id:${input.id}`)) return
    const key = logKey(entry)
    if (!this.seen.add(key)) {
      if (input.id) this.seen.add(`id:${input.id}`)
      return
    }
    if (input.id) this.seen.add(`id:${input.id}`)

    const at = parseTime(entry.timestamp) ?? input.receivedAt ?? this.now()
    const meta: SortMeta = { at, tie: this.nextTie(input.id ?? null), run: null, seq: null }
    const meaning = classifyLegacyLog(entry)

    if (this.attempt === 0) {
      this.startAttempt(at)
    } else if (
      meaning.t === "system" &&
      meaning.phase === "preparing" &&
      isTerminalPhase(this.phase) &&
      this.endedAt !== null &&
      at > this.endedAt
    ) {
      this.startAttempt(at)
    }
    this.noteEvent(at)
    this.clearPendingStart()
    const order = numericOrder(input.id)
    if (order !== null && (this.maxOrder === null || order > this.maxOrder)) this.maxOrder = order
    this.foldLegacy(meaning, at, meta)
  }

  private foldLegacy(meaning: LegacyLogMeaning, at: number, meta: SortMeta): void {
    switch (meaning.t) {
      case "thinking":
        if (!isTerminalPhase(this.phase)) {
          this.message = ACTIVITY_THINKING
          this.advancePhase("running", at)
          this.touch()
        }
        return
      case "assistant":
      case "reasoning":
        if (!meaning.text) return
        this.appendText(meaning.t, meaning.text, at, meta, true)
        if (meaning.t === "assistant") this.advancePhase("running", at)
        return
      case "tool-start":
        this.legacyToolStart(meaning.label, at, meta)
        this.advancePhase("running", at)
        return
      case "tool-end":
        this.legacyToolEnd(meaning.name, meaning.ok, meaning.output, at, meta)
        return
      case "file":
        this.recordFile(meaning.path, "modified", at, meta)
        return
      case "error":
        this.counters.errors += 1
        this.insertEntry(
          { kind: "error", id: this.nextId("err"), at, attempt: this.attempt, text: meaning.text, details: this.clampDetails(meaning.details) },
          meta,
        )
        return
      case "system":
        if (meaning.branch) this.branch = meaning.branch
        if (meaning.model) this.model = meaning.model
        if (meaning.runner) this.runner = meaning.runner
        if (meaning.prUrl) this.logPrUrl = meaning.prUrl
        this.insertEntry(
          {
            kind: "system",
            id: this.nextId("sys"),
            at,
            attempt: this.attempt,
            text: meaning.text,
            details: this.clampDetails(meaning.details),
            tone: meaning.tone,
          },
          meta,
        )
        if (meaning.phase) this.advancePhase(meaning.phase, at)
        return
    }
  }

  private legacyToolStart(label: string, at: number, meta: SortMeta): void {
    const known = isKnownToolName(label)
    const open = Array.from(this.openTools.values())
    // Same call reported again (OpenCode re-sends `running` as metadata changes).
    const same = open.find((tool) => tool.summary === label || (known && tool.name === label && tool.summary === null))
    if (same) return
    // A bare tool name followed by its title: the same call gained a title.
    const newest = open[open.length - 1]
    if (newest && !known && newest.name !== null && newest.summary === null) {
      this.replaceEntry(newest, { ...newest, summary: label })
      return
    }
    // The call already finished (its completion arrived first, out of order):
    // attach this start to it instead of opening a row that never closes.
    for (let i = this.entries.length - 1; i >= 0 && i >= this.entries.length - 50; i--) {
      const candidate = this.entries[i]
      if (
        candidate?.kind === "tool" &&
        candidate.callId === null &&
        candidate.endedAt !== null &&
        candidate.endedAt >= at &&
        candidate.endedAt - at <= ATTACH_WINDOW_MS &&
        (candidate.startedAt === null || at <= candidate.startedAt) &&
        (known ? candidate.name === label : candidate.summary === null || candidate.summary === label)
      ) {
        this.replaceEntry(candidate, {
          ...candidate,
          summary: known ? candidate.summary : label,
          startedAt: at,
          durationMs: candidate.endedAt - at,
        })
        return
      }
    }
    this.openTool({ name: known ? label : null, summary: known ? null : label, at, meta, callId: null, args: null })
  }

  private legacyToolEnd(name: string, ok: boolean, output: string | null, at: number, meta: SortMeta): void {
    const open = Array.from(this.openTools.values())
    const match =
      open.find((tool) => tool.name === name) ??
      open.find((tool) => tool.name === null) ??
      this.recentUnfinishedTool(name)
    if (match) {
      this.closeTool(match, { name, ok, output, at })
      return
    }
    const tool = this.openTool({ name, summary: null, at: null, meta: { ...meta, at }, callId: null, args: null })
    this.closeTool(tool, { name, ok, output, at })
  }

  /** A row the terminal event closed as unfinished; its completion can still arrive late. */
  private recentUnfinishedTool(name: string): ToolEntry | null {
    for (let i = this.entries.length - 1; i >= 0 && i >= this.entries.length - 50; i--) {
      const entry = this.entries[i]
      if (entry?.kind === "tool" && entry.status === "unfinished" && entry.attempt === this.attempt && (entry.name === name || entry.name === null)) {
        return entry
      }
    }
    return null
  }

  // ─── journal (W05) ────────────────────────────────────────────────────────

  /**
   * Make `runId` the current run: a new run opens a new attempt (prior
   * evidence stays above a divider); a live attempt that had no run id yet
   * adopts it. False for a late event of an earlier run.
   */
  private enterRun(runId: string, at: number | null): boolean {
    if (runId === this.currentRunId) return true
    if (this.knownRuns.has(runId)) return false
    if (this.currentRunId !== null || (this.attempt > 0 && isTerminalPhase(this.phase))) {
      this.startAttempt(at, runId)
    } else {
      if (this.attempt === 0) this.startAttempt(at, runId)
      this.currentRunId = runId
    }
    this.knownRuns.add(runId)
    return true
  }

  /**
   * v2 run engine beat. De-duplicated by (runId, runSeq) — the same key as
   * journal events, so a replay or a second delivery path never folds twice.
   * Within the run, only a `runState` moves the phase, and never backwards in
   * sequence; beats without one update the activity line.
   */
  private applyRunProgress(input: LegacyProgressInput & { runId: string; runSeq: number }): void {
    if (!this.seen.add(`j:${input.runId}:${input.runSeq}`)) return
    if (input.id) this.seen.add(`id:${input.id}`)
    const at = input.receivedAt ?? this.now()
    if (!this.enterRun(input.runId, at)) return
    this.noteEvent(at)
    this.clearPendingStart()
    if (this.recovery === "stream_lost") this.phaseBeforeLoss = null
    const stale = this.runSeqPhase !== null && input.runSeq < this.runSeqPhase
    if (stale) {
      this.touch()
      return
    }
    this.lastProgress = {
      status: input.status,
      message: input.message,
      prUrl: input.prUrl ?? null,
      isCompareLink: Boolean(input.isCompareLink),
    }
    this.message = input.message || this.message
    if (input.runState) {
      this.setPhase(phaseForRunState(input.runState, input.status), "journal", at)
      this.runSeqPhase = input.runSeq
    } else {
      const implied = LEGACY_STATUS_PHASE[input.status]
      // `finishing` steps (commit → push → PR) are named only by the beat's status.
      const finishingStep = PUBLICATION_STEPS.has(this.phase) && PUBLICATION_STEPS.has(implied)
      if (finishingStep || this.phaseSource !== "journal" || this.phase === "idle" || this.phase === "queued") {
        // Otherwise a run seen only from its beats so far (e.g. after a reload): the status is the best evidence.
        this.setPhase(implied, finishingStep ? "journal" : "progress", at)
        this.runSeqPhase = input.runSeq
      }
    }
    this.touch()
  }

  private applyRunState(input: RunStateInput): void {
    const seq = Math.max(1, Math.floor(input.lastSeq))
    const at = this.now()
    if (!this.enterRun(input.runId, at)) return
    if (input.runner && this.runner !== input.runner) {
      this.runner = input.runner
      this.touch()
    }
    const budget = input.budgets && (input.budgets.maxUsd !== undefined || input.budgets.maxTokens !== undefined)
      ? { maxUsd: input.budgets.maxUsd ?? null, maxTokens: input.budgets.maxTokens ?? null }
      : null
    if (JSON.stringify(budget) !== JSON.stringify(this.budget)) {
      this.budget = budget
      this.touch()
    }
    this.applyRunProgress({
      kind: "progress",
      taskId: input.taskId,
      status: RUN_STATE_STATUS[input.state],
      message: "",
      runId: input.runId,
      runSeq: seq,
      runState: input.state,
      receivedAt: at,
    })
  }

  private applyJournal(input: JournalInput): void {
    if (!input.runId || !Number.isFinite(input.seq)) return
    if (!this.seen.add(`j:${input.runId}:${input.seq}`)) return
    if (input.id) this.seen.add(`id:${input.id}`)
    const at = parseTime(input.at ?? null) ?? input.receivedAt ?? this.now()

    if (!this.enterRun(input.runId, at)) return

    this.noteEvent(at)
    this.clearPendingStart()
    const payload = asRecord(input.payload)
    const type = str(payload, "t") ?? input.type
    const meta: SortMeta = { at, tie: this.nextTie(null), run: input.runId, seq: input.seq }
    const order = input.seq

    switch (type) {
      case "run.phase":
      case "phase": {
        const phase = str(payload, "phase")
        if (!isRunPhase(phase)) return
        if (this.phaseOrder !== null && order < this.phaseOrder && this.phaseSource === "journal") return
        const message = str(payload, "message")
        if (message) this.message = message
        this.setPhase(phase, "journal", at, order)
        if (phase === "unknown") {
          this.recovery = "service_restarted"
          this.touch()
        }
        return
      }
      case "run.started":
      case "session.started": {
        const model = asRecord(payload?.model)
        this.model = str(model, "id") ?? str(payload, "model") ?? this.model
        this.runner = str(payload, "runner") ?? this.runner
        if (!PHASE_INFO[this.phase].live) this.setPhase("running", "journal", at, order)
        this.touch()
        return
      }
      case "run.outcome": {
        const status = str(payload, "status")
        const phase: RunPhase = status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed"
        const retained = asRecord(payload?.retained)
        const branch = str(retained, "branch")
        const path = str(retained, "path")
        const reason = str(payload, "reason")
        const parts = [
          status === "cancelled" ? `Cancelled${reason ? `: ${reason}` : ""}` : reason,
          branch ? `Work retained on ${branch}${path ? ` at ${path}` : ""}` : null,
        ].filter((part): part is string => Boolean(part))
        this.journalOutcome = {
          status: phaseToTaskStatus(phase),
          outcome: phase === "succeeded" ? null : parts.join(". ") || null,
          prUrl: str(payload, "prUrl") ?? str(payload, "branchUrl"),
        }
        this.setPhase(phase, "journal", at, order)
        this.touch()
        return
      }
      case "message.delta":
      case "reasoning.delta": {
        const text = str(payload, "text")
        if (!text) return
        this.appendText(type === "message.delta" ? "assistant" : "reasoning", text, at, meta, false)
        return
      }
      case "turn.started":
        this.message = ACTIVITY_THINKING
        this.touch()
        return
      case "tool.started": {
        const name = str(payload, "name")
        const callId = str(payload, "callId")
        const input = payload?.input
        if (callId && this.toolsByCallId.has(callId)) return
        this.openTool({
          name,
          summary: summarizeToolInput(name, input),
          at,
          meta,
          callId,
          args: formatToolArgs(input, this.opts.maxTextChars),
        })
        this.message = `Running ${name ?? "tool"}`
        if (!PHASE_INFO[this.phase].live || this.phase === "queued" || this.phase === "preparing") {
          this.setPhase("running", "journal", at, order)
        }
        return
      }
      case "tool.output": {
        const callId = str(payload, "callId")
        const chunk = str(payload, "chunk")
        const tool = callId ? this.toolById(this.toolsByCallId.get(callId)) : null
        if (!tool || chunk === null) return
        const combined = payload?.cumulative === true ? chunk : `${tool.output ?? ""}${chunk}`
        const clamped = clampTail(combined, this.opts.maxTextChars)
        this.replaceEntry(tool, { ...tool, output: clamped.text, outputTruncated: tool.outputTruncated || clamped.truncated })
        return
      }
      case "tool.finished": {
        const callId = str(payload, "callId")
        const name = str(payload, "name")
        const ok = payload?.ok !== false
        const summary = str(payload, "summary")
        let tool = callId ? this.toolById(this.toolsByCallId.get(callId)) : null
        if (!tool) tool = this.openTool({ name, summary: null, at: null, meta, callId, args: null })
        this.closeTool(tool, { name: name ?? tool.name ?? "tool", ok, output: tool.output ?? summary, at, keepOutput: tool.output !== null })
        return
      }
      case "file.changed": {
        const path = str(payload, "path")
        if (!path) return
        this.recordFile(path, FILE_KIND[str(payload, "kind") ?? "edit"] ?? "modified", at, meta)
        return
      }
      case "permission.requested": {
        const tool = str(payload, "tool") ?? "tool"
        const detail = str(payload, "detail")
        this.insertEntry(
          { kind: "system", id: this.nextId("sys"), at, attempt: this.attempt, text: `Permission requested: ${tool}`, details: this.clampDetails(detail), tone: "warning" },
          meta,
        )
        this.setPhase("awaiting_approval", "journal", at, order)
        return
      }
      case "compaction": {
        const phase = str(payload, "phase")
        this.insertEntry(
          { kind: "system", id: this.nextId("sys"), at, attempt: this.attempt, text: phase === "end" ? "Context compaction finished" : "Context compaction started", details: null, tone: "neutral" },
          meta,
        )
        return
      }
      case "usage": {
        const usage = asRecord(payload?.usage)
        const cost = asRecord(payload?.cost)
        const messageId = str(payload, "messageId") ?? `seq-${input.seq}`
        this.usageByMessage.set(messageId, {
          cost: num(cost, "usd"),
          basis: str(cost, "basis"),
          tokens: {
            input: num(usage, "input") ?? 0,
            output: num(usage, "output") ?? 0,
            reasoning: num(usage, "reasoning") ?? 0,
            cacheRead: num(usage, "cacheRead") ?? 0,
            cacheWrite: num(usage, "cacheWrite") ?? 0,
          },
        })
        this.touch()
        return
      }
      case "turn.finished": {
        const reason = str(payload, "reason")
        if (reason === "error" || reason === "interrupted" || reason === "max_turns") {
          this.insertEntry(
            {
              kind: "system",
              id: this.nextId("sys"),
              at,
              attempt: this.attempt,
              text: reason === "interrupted" ? "Turn interrupted" : reason === "max_turns" ? "Turn limit reached" : "Turn ended with an error",
              details: null,
              tone: "warning",
            },
            meta,
          )
        }
        return
      }
      case "error": {
        const message = str(payload, "message") ?? "The agent reported an error"
        const code = str(payload, "code")
        this.counters.errors += 1
        this.insertEntry({ kind: "error", id: this.nextId("err"), at, attempt: this.attempt, text: message, details: code }, meta)
        return
      }
      default:
        return
    }
  }

  // ─── persisted task row ───────────────────────────────────────────────────

  private applySnapshot(task: RunTaskSnapshot): void {
    if (this.taskId === null) this.taskId = task.id
    const statusChanged = this.snapshotStatus !== task.status || this.snapshotOutcome !== (task.outcome ?? null)
    this.task = task
    this.snapshotStatus = task.status
    this.snapshotOutcome = task.outcome ?? null
    if (task.model) this.model = this.model ?? task.model
    const started = parseTime(task.executionStartedAt)
    const elapsed = task.executionElapsedMs > 0 ? task.executionElapsedMs : null
    this.touch()
    if (!statusChanged) return

    const outcome = describeTaskExecution(task, null)
    const recovering = /^sidecar_recovery_/.test(task.outcome ?? "")
    const ranBefore = Boolean(task.executionStartedAt) || Boolean(task.outcome) || Boolean(task.prUrl) || task.executionElapsedMs > 0

    switch (task.status) {
      case "in_progress": {
        if (this.attempt === 0) this.startAttempt(started)
        if (this.startedAt === null && started !== null) this.startedAt = started
        if (recovering && !isTerminalPhase(this.phase)) {
          this.phase = "unknown"
          this.phaseSource = "snapshot"
          this.recovery = "service_restarted"
          this.touch()
          return
        }
        if (this.phase === "idle" || this.phase === "queued" || (this.phase === "unknown" && this.recovery !== "stream_lost")) {
          this.setPhase("running", "snapshot", started)
        }
        if (isReadyToPublishTask(task)) this.message = "Local commit ready — waiting for batch publication"
        return
      }
      case "done":
      case "cancelled": {
        if (!ranBefore && this.attempt === 0) return
        if (this.attempt === 0) this.startAttempt(started)
        if (this.startedAt === null && started !== null) this.startedAt = started
        this.persistedElapsedMs = elapsed
        if (isTerminalPhase(this.phase)) return
        const phase: RunPhase =
          task.status === "done" ? "succeeded" : outcome.kind === "failed" || outcome.kind === "publication_failed" || recovering ? "failed" : "cancelled"
        this.setPhase(phase, "snapshot", this.lastEventAt)
        return
      }
      case "todo": {
        if (outcome.kind === "failed" || outcome.kind === "publication_failed") {
          if (this.attempt === 0) this.startAttempt(started)
          if (!isTerminalPhase(this.phase)) this.setPhase("failed", "snapshot", this.lastEventAt)
          return
        }
        if (this.phaseSource === "snapshot" && !isTerminalPhase(this.phase)) {
          this.phase = "idle"
          this.phaseSource = "none"
          this.touch()
        }
        return
      }
    }
  }

  // ─── entries ──────────────────────────────────────────────────────────────

  private nextId(prefix: string): string {
    this.entrySeq += 1
    return `${prefix}-${this.entrySeq}`
  }

  private nextTie(id: string | null): number {
    this.arrival += 1
    const order = numericOrder(id)
    return order ?? this.arrival
  }

  private lastSortAt(): number {
    const last = this.sortMeta[this.sortMeta.length - 1]
    return last ? last.at : this.now()
  }

  private static precedes(a: SortMeta, b: SortMeta): boolean {
    if (a.run !== null && a.run === b.run && a.seq !== null && b.seq !== null) return a.seq < b.seq
    if (a.at !== b.at) return a.at < b.at
    return a.tie < b.tie
  }

  private insertEntry(entry: TimelineEntry, meta: SortMeta): number {
    let index = this.entries.length
    while (index > 0 && RunModel.precedes(meta, this.sortMeta[index - 1]!)) index -= 1
    if (index === this.entries.length) {
      this.entries.push(entry)
      this.sortMeta.push(meta)
    } else {
      this.entries.splice(index, 0, entry)
      this.sortMeta.splice(index, 0, meta)
      if (index < this.collapseCursor) {
        this.entries[index] = this.collapsed(entry)
        this.collapseCursor += 1
      }
    }
    this.counters.entriesTotal += 1
    this.enforceBounds()
    this.touch(true)
    return index
  }

  /** Replace an entry by identity (searching from the newest end, where updates land). */
  private replaceEntry(previous: TimelineEntry, next: TimelineEntry): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i] === previous) {
        this.entries[i] = i < this.collapseCursor ? this.collapsed(next) : next
        if (next.kind === "tool" && this.openTools.has(next.id)) this.openTools.set(next.id, next)
        this.touch(true)
        return
      }
    }
  }

  private toolById(id: string | undefined): ToolEntry | null {
    if (!id) return null
    const open = this.openTools.get(id)
    if (open) return open
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]
      if (entry?.id === id && entry.kind === "tool") return entry
    }
    return null
  }

  private enforceBounds(): void {
    const { maxEntries, keepFullOutputFor } = this.opts
    if (this.entries.length > maxEntries) {
      // Drop in chunks so the splice cost amortizes.
      const excess = this.entries.length - maxEntries
      const drop = Math.min(this.entries.length, excess + Math.max(1, Math.floor(maxEntries * 0.05)))
      const removed = this.entries.splice(0, drop)
      this.sortMeta.splice(0, drop)
      this.dropped += drop
      this.collapseCursor = Math.max(0, this.collapseCursor - drop)
      for (const entry of removed) {
        if (entry.kind === "tool" && this.openTools.delete(entry.id)) {
          this.counters.toolsRunning = Math.max(0, this.counters.toolsRunning - 1)
          if (entry.callId) this.toolsByCallId.delete(entry.callId)
        }
      }
    }
    while (this.entries.length - this.collapseCursor > keepFullOutputFor) {
      const entry = this.entries[this.collapseCursor]
      if (entry) this.entries[this.collapseCursor] = this.collapsed(entry)
      this.collapseCursor += 1
    }
  }

  /** Old entries keep only a short output preview; text content stays. */
  private collapsed(entry: TimelineEntry): TimelineEntry {
    const max = this.opts.collapsedOutputChars
    if (entry.kind === "tool") {
      const output = entry.output && entry.output.length > max ? clampText(entry.output, max).text : entry.output
      const args = entry.args && entry.args.length > max ? clampText(entry.args, max).text : entry.args
      if (output === entry.output && args === entry.args) return entry
      return { ...entry, output, args, outputTruncated: entry.outputTruncated || output !== entry.output }
    }
    if ((entry.kind === "system" || entry.kind === "error") && entry.details && entry.details.length > max) {
      return { ...entry, details: clampText(entry.details, max).text }
    }
    return entry
  }

  private clampDetails(details: string | null): string | null {
    if (!details) return null
    return clampText(details, this.opts.maxTextChars).text
  }

  private appendText(kind: "assistant" | "reasoning", text: string, at: number, meta: SortMeta, windowed: boolean): void {
    const lastIndex = this.entries.length - 1
    const last = this.entries[lastIndex]
    const lastMeta = this.sortMeta[lastIndex]
    const appendsAtEnd = !lastMeta || !RunModel.precedes(meta, lastMeta)
    if (
      last &&
      appendsAtEnd &&
      last.kind === kind &&
      last.attempt === this.attempt &&
      (!windowed || (last.at !== null && Math.abs(at - (lastMeta?.at ?? at)) <= MERGE_WINDOW_MS))
    ) {
      if (last.truncated) return
      const separator = windowed ? (kind === "assistant" ? "\n\n" : " ") : ""
      const clamped = clampText(`${last.text}${separator}${text}`, this.opts.maxTextChars)
      const merged: AssistantEntry | ReasoningEntry = { ...last, text: clamped.text, truncated: clamped.truncated }
      this.entries[lastIndex] = merged
      // Later chunks extend the block; keep its sort time at the newest chunk.
      this.sortMeta[lastIndex] = { ...lastMeta!, at: Math.max(lastMeta!.at, meta.at) }
      this.touch(true)
      return
    }
    const clamped = clampText(text, this.opts.maxTextChars)
    this.insertEntry({ kind, id: this.nextId(kind === "assistant" ? "msg" : "think"), at, attempt: this.attempt, text: clamped.text, truncated: clamped.truncated }, meta)
  }

  private openTool(args: {
    name: string | null
    summary: string | null
    at: number | null
    meta: SortMeta
    callId: string | null
    args: string | null
  }): ToolEntry {
    const tool: ToolEntry = {
      kind: "tool",
      id: this.nextId("tool"),
      at: args.at ?? args.meta.at,
      attempt: this.attempt,
      name: args.name,
      summary: args.summary,
      status: "running",
      isCommand: isShellTool(args.name),
      startedAt: args.at,
      endedAt: null,
      durationMs: null,
      args: args.args,
      output: null,
      outputTruncated: false,
      callId: args.callId,
    }
    this.counters.tools += 1
    this.counters.toolsRunning += 1
    this.openTools.set(tool.id, tool)
    if (args.callId) this.toolsByCallId.set(args.callId, tool.id)
    this.insertEntry(tool, args.meta)
    return this.openTools.get(tool.id) ?? tool
  }

  private closeTool(
    tool: ToolEntry,
    result: { name: string; ok: boolean; output: string | null; at: number; keepOutput?: boolean },
  ): void {
    const output = result.output === null ? null : result.keepOutput ? { text: result.output, truncated: tool.outputTruncated } : clampText(result.output, this.opts.maxTextChars)
    const name = tool.name ?? result.name
    const next: ToolEntry = {
      ...tool,
      name,
      isCommand: isShellTool(name),
      status: result.ok ? "completed" : "error",
      endedAt: result.at,
      durationMs: tool.startedAt !== null ? Math.max(0, result.at - tool.startedAt) : null,
      output: output ? output.text : tool.output,
      outputTruncated: tool.outputTruncated || Boolean(output?.truncated),
    }
    if (this.openTools.delete(tool.id)) this.counters.toolsRunning = Math.max(0, this.counters.toolsRunning - 1)
    if (!result.ok) this.counters.toolErrors += 1
    this.replaceEntry(tool, next)
  }

  private recordFile(path: string, change: FileChangeKind, at: number, meta: SortMeta): void {
    this.insertEntry({ kind: "file", id: this.nextId("file"), at, attempt: this.attempt, path, change }, meta)
    const existing = this.files.get(path)
    if (existing) {
      // An added file stays "added" when later edited; a delete wins.
      const merged: FileChangeKind = change === "deleted" ? "deleted" : existing.change === "added" ? "added" : change
      this.files.set(path, { ...existing, change: merged, edits: existing.edits + 1, lastAt: at })
    } else if (this.files.size < this.opts.maxFiles) {
      this.files.set(path, { path, change, edits: 1, lastAt: at })
    } else {
      this.filesOverflow += 1
    }
    this.touch(false, true)
  }

  // ─── derived values ───────────────────────────────────────────────────────

  private cost(): RunCost {
    let known = false
    let usd = 0
    let basis: string | null = null
    for (const usage of this.usageByMessage.values()) {
      if (usage.cost === null) continue
      known = true
      usd += usage.cost
      basis = usage.basis ?? basis
    }
    return known ? { status: "known", usd, basis } : { status: "unknown" }
  }

  private tokens(): RunTokens | null {
    if (this.usageByMessage.size === 0) return null
    const total: RunTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    for (const usage of this.usageByMessage.values()) {
      total.input += usage.tokens.input
      total.output += usage.tokens.output
      total.reasoning += usage.tokens.reasoning
      total.cacheRead += usage.tokens.cacheRead
      total.cacheWrite += usage.tokens.cacheWrite
    }
    return total
  }

  private outcome(): TaskExecutionOutcome | null {
    if (this.attempt === 0 && !this.task) return null
    const last = this.lastProgress
    // A queued beat says nothing about the outcome (and isn't a legacy store status).
    const progress = last && last.status !== "queued"
      ? { status: last.status, prUrl: last.prUrl ?? undefined, isCompareLink: last.isCompareLink }
      : null
    if (this.task) {
      // The live terminal beat usually lands before the task row catches up.
      if (this.task.status === "in_progress" && isTerminalPhase(this.phase)) {
        const failure = FAILURE_PHASES.has(this.phase) ? this.lastProgress?.message ?? this.task.outcome ?? "Run failed" : this.task.outcome
        return describeTaskExecution(
          { ...this.task, status: phaseToTaskStatus(this.phase), outcome: failure, prUrl: this.task.prUrl ?? this.logPrUrl },
          progress,
        )
      }
      return describeTaskExecution(this.task, progress)
    }
    if (this.journalOutcome) {
      return describeTaskExecution({ ...this.journalOutcome, batchId: null }, progress)
    }
    const failureText = FAILURE_PHASES.has(this.phase) ? this.lastProgress?.message ?? "Run failed" : null
    const synthesized: Mutable<Pick<Task, "status" | "outcome" | "prUrl" | "batchId">> = {
      status: phaseToTaskStatus(this.phase),
      outcome: failureText,
      prUrl: this.logPrUrl,
      batchId: null,
    }
    return describeTaskExecution(synthesized, progress)
  }
}

/** Fold a whole event list (fixtures, history) and return the snapshot. */
export function foldRunEvents(inputs: Iterable<RunInput>, options?: RunModelOptions): RunSnapshot {
  const model = new RunModel(options)
  model.applyMany(inputs)
  return model.getSnapshot()
}
