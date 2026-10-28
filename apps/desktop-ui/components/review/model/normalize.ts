import type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  DiffLineKind,
  TaskDiffLimits,
  TaskDiffResponse,
  TaskRunState,
  RunEffectSummary,
  RunTerminalSummary,
  RunVerification,
  VerificationCheck,
  VerificationStatus,
} from "@/lib/api/review"

/**
 * Defensive decoding of sidecar review payloads. The sidecar is ours, but a
 * desktop app can talk to an older or newer sidecar, and diff text comes from
 * an agent-controlled worktree. Malformed entries are dropped (never thrown on)
 * and every string stays a string — nothing here is ever rendered as HTML.
 *
 * Hand-written instead of zod: a 20,000-line diff decodes in a few ms.
 */

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
}

function count(value: unknown): number {
  return nonNegativeInt(value) ?? 0
}

const FILE_STATUSES: ReadonlySet<string> = new Set<DiffFileStatus>(["added", "modified", "deleted", "renamed", "binary"])
const LINE_KINDS: ReadonlySet<string> = new Set<DiffLineKind>(["context", "add", "del"])

function decodeLine(raw: unknown): DiffLine | null {
  if (!isObject(raw)) return null
  const kind = str(raw.kind)
  const text = str(raw.text)
  if (!kind || !LINE_KINDS.has(kind) || text === null) return null
  const line: DiffLine = { kind: kind as DiffLineKind, text }
  const oldNo = nonNegativeInt(raw.oldNo)
  const newNo = nonNegativeInt(raw.newNo)
  if (oldNo !== null && kind !== "add") line.oldNo = oldNo
  if (newNo !== null && kind !== "del") line.newNo = newNo
  if (raw.truncated === true) line.truncated = true
  if (raw.noEol === true) line.noEol = true
  return line
}

function decodeHunk(raw: unknown): DiffHunk | null {
  if (!isObject(raw) || !Array.isArray(raw.lines)) return null
  const lines: DiffLine[] = []
  for (const item of raw.lines) {
    const line = decodeLine(item)
    if (line) lines.push(line)
  }
  return {
    header: str(raw.header) ?? "",
    oldStart: count(raw.oldStart),
    oldLines: count(raw.oldLines),
    newStart: count(raw.newStart),
    newLines: count(raw.newLines),
    lines,
  }
}

function decodeFile(raw: unknown): DiffFile | null {
  if (!isObject(raw)) return null
  const path = str(raw.path)
  const status = str(raw.status)
  if (!path || !status || !FILE_STATUSES.has(status)) return null
  const hunks: DiffHunk[] = []
  if (Array.isArray(raw.hunks)) {
    for (const item of raw.hunks) {
      const hunk = decodeHunk(item)
      if (hunk) hunks.push(hunk)
    }
  }
  const file: DiffFile = {
    path,
    status: status as DiffFileStatus,
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    hunks,
  }
  const oldPath = str(raw.oldPath)
  if (oldPath && oldPath !== path) file.oldPath = oldPath
  if (raw.truncated === true) file.truncated = true
  if (raw.untracked === true) file.untracked = true
  const similarity = nonNegativeInt(raw.similarity)
  if (similarity !== null) file.similarity = Math.min(similarity, 100)
  return file
}

const DEFAULT_LIMITS: TaskDiffLimits = {
  maxFiles: 300,
  maxLinesPerFile: 5000,
  maxTotalLines: 20000,
  maxLineChars: 1000,
  maxPatchBytes: 8 * 1024 * 1024,
  maxUntrackedFileBytes: 512 * 1024,
}

export class DiffPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DiffPayloadError"
  }
}

/** Throws {@link DiffPayloadError} only when the envelope itself is unusable. */
export function normalizeTaskDiff(raw: unknown): TaskDiffResponse {
  if (!isObject(raw) || !Array.isArray(raw.files) || !isObject(raw.base)) {
    throw new DiffPayloadError("The local execution service returned an unreadable diff.")
  }
  const files: DiffFile[] = []
  for (const item of raw.files) {
    const file = decodeFile(item)
    if (file) files.push(file)
  }
  const base = raw.base
  const head = isObject(raw.head) ? raw.head : {}
  const stats = isObject(raw.stats) ? raw.stats : {}
  const limits = isObject(raw.limits) ? raw.limits : {}
  const headSha = str(head.sha)
  const revision = str(raw.revision) ?? `${str(base.sha) ?? ""}:${headSha ?? ""}:${files.length}`
  const source = str(raw.source)
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
  return {
    base: { ref: str(base.ref) ?? "base", sha: str(base.sha) ?? "" },
    head: { ref: str(head.ref), sha: headSha, dirty: head.dirty === true },
    revision,
    source: source === "v2" || source === "legacy-disk" ? source : "legacy-live",
    files,
    truncated: raw.truncated === true || files.some((file) => file.truncated === true),
    stats: {
      files: nonNegativeInt(stats.files) ?? files.length,
      additions: nonNegativeInt(stats.additions) ?? totalAdditions,
      deletions: nonNegativeInt(stats.deletions) ?? totalDeletions,
      shownFiles: files.length,
      binaryFiles: nonNegativeInt(stats.binaryFiles) ?? files.filter((file) => file.status === "binary").length,
      untrackedFiles: nonNegativeInt(stats.untrackedFiles) ?? files.filter((file) => file.untracked).length,
    },
    limits: {
      maxFiles: nonNegativeInt(limits.maxFiles) ?? DEFAULT_LIMITS.maxFiles,
      maxLinesPerFile: nonNegativeInt(limits.maxLinesPerFile) ?? DEFAULT_LIMITS.maxLinesPerFile,
      maxTotalLines: nonNegativeInt(limits.maxTotalLines) ?? DEFAULT_LIMITS.maxTotalLines,
      maxLineChars: nonNegativeInt(limits.maxLineChars) ?? DEFAULT_LIMITS.maxLineChars,
      maxPatchBytes: nonNegativeInt(limits.maxPatchBytes) ?? DEFAULT_LIMITS.maxPatchBytes,
      maxUntrackedFileBytes: nonNegativeInt(limits.maxUntrackedFileBytes) ?? DEFAULT_LIMITS.maxUntrackedFileBytes,
    },
  }
}

// ─── Run state ────────────────────────────────────────────────────────────────

const TERMINAL_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "recovery_required", "abandoned"])
const EFFECT_STATUSES: ReadonlySet<string> = new Set(["pending", "confirmed", "failed"])
const VERIFICATION_STATUSES: ReadonlySet<string> = new Set<VerificationStatus>(["passed", "failed", "running", "pending", "skipped", "error"])

function decodeTerminal(raw: unknown): RunTerminalSummary | null {
  if (!isObject(raw)) return null
  const state = str(raw.state)
  if (!state || !TERMINAL_STATES.has(state)) return null
  return {
    state: state as RunTerminalSummary["state"],
    reason: str(raw.reason) ?? "",
    outcome: str(raw.outcome),
    prUrl: str(raw.prUrl),
    claimed: raw.claimed === true,
  }
}

function decodeVerification(raw: unknown): RunVerification | null {
  if (!isObject(raw)) return null
  const status = str(raw.status)
  if (!status || !VERIFICATION_STATUSES.has(status)) return null
  const checks: VerificationCheck[] = []
  if (Array.isArray(raw.checks)) {
    for (const item of raw.checks.slice(0, 100)) {
      if (!isObject(item)) continue
      const name = str(item.name)
      const checkStatus = str(item.status)
      if (!name || !checkStatus || !VERIFICATION_STATUSES.has(checkStatus)) continue
      const check: VerificationCheck = { name, status: checkStatus as VerificationStatus }
      const summary = str(item.summary)
      const url = str(item.url)
      if (summary) check.summary = summary
      if (url && /^https:\/\//i.test(url)) check.url = url
      checks.push(check)
    }
  }
  return { status: status as VerificationStatus, commit: str(raw.commit) ?? str(raw.sha), checks }
}

/** `{ run }` from `GET /api/tasks/:id/run`, or null when it isn't a run state. */
export function normalizeRunState(raw: unknown): TaskRunState | null {
  const run = isObject(raw) && isObject(raw.run) ? raw.run : null
  if (!run) return null
  const runId = str(run.runId)
  const state = str(run.state)
  if (!runId || !state) return null
  const effects: RunEffectSummary[] = []
  if (Array.isArray(run.effects)) {
    for (const item of run.effects) {
      if (!isObject(item)) continue
      const key = str(item.key)
      const kind = str(item.kind)
      const status = str(item.status)
      if (key && kind && status && EFFECT_STATUSES.has(status)) effects.push({ key, kind, status: status as RunEffectSummary["status"] })
    }
  }
  return {
    runId,
    state,
    attemptId: str(run.attemptId),
    lastSeq: count(run.lastSeq),
    relayAckSeq: count(run.relayAckSeq),
    terminal: decodeTerminal(run.terminal),
    effects,
    verification: decodeVerification(run.verification),
    phases: decodePhases(run.phases),
    knowledge: decodeKnowledge(run.knowledge),
    workspaceExpired: decodeWorkspaceExpired(run.workspaceExpired),
  }
}

/** W11a: the run's worktree was removed by the retention sweep (Continue can't resume it). */
function decodeWorkspaceExpired(raw: unknown): TaskRunState["workspaceExpired"] {
  if (!isObject(raw)) return null
  const at = str(raw.at)
  const reason = str(raw.reason)
  return at && reason ? { at, reason } : null
}

/** W19b: which knowledge revisions the run was given (malformed items dropped). */
function decodeKnowledge(raw: unknown): NonNullable<TaskRunState["knowledge"]> {
  if (!Array.isArray(raw)) return []
  const entries: NonNullable<TaskRunState["knowledge"]> = []
  for (const item of raw.slice(0, 50)) {
    if (!isObject(item)) continue
    const id = str(item.id)
    const title = str(item.title)
    const kind = str(item.kind)
    const version = nonNegativeInt(item.version)
    if (id && title && kind && version !== null && version > 0) entries.push({ id, version, kind, title })
  }
  return entries
}

/** W15: phase timings, or null when absent or malformed (an older sidecar). */
function decodePhases(raw: unknown): TaskRunState["phases"] {
  if (!isObject(raw)) return null
  const keys = ["queuedMs", "preparingMs", "setupMs", "agentMs", "approvalWaitMs", "verifyingMs", "finishingMs", "totalMs"] as const
  const values: Record<(typeof keys)[number], number> = { queuedMs: 0, preparingMs: 0, setupMs: 0, agentMs: 0, approvalWaitMs: 0, verifyingMs: 0, finishingMs: 0, totalMs: 0 }
  for (const key of keys) {
    const value = nonNegativeInt(raw[key])
    if (value === null) return null
    values[key] = value
  }
  return { ...values, live: raw.live === true }
}
