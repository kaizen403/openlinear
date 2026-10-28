import type { ExecutionLogEntry } from "@/types/task"
import { isLegacyProgressStatus, isRunStateWire } from "./phase"
import type { JournalInput, LegacyLogInput, LegacyProgressInput } from "./types"

/**
 * The adapter between wire events and the run model. This is the only place
 * that knows today's SSE payload shapes:
 *
 * - `execution:log`      `{ taskId, entry: { timestamp, type, message, details? } }`
 * - `execution:progress` `{ taskId, status, message, prUrl?, isCompareLink? }` (legacy),
 *   plus `{ runId, runSeq, runState? }` from the v2 run engine (local SSE and
 *   relayed through the control plane)
 * - `execution:progress` `{ runId, taskId?, seq, type, payload }` with SSE id
 *   `run:<runId>:<seq>` (run journal: sidecar `deliverLocalExecutionEvent`,
 *   API `POST /api/agent-runs/progress` live delivery and replay)
 *
 * W05 plugs in by emitting journal events; nothing else in the UI changes.
 * Malformed payloads decode to null instead of throwing (the stream must
 * never take the page down).
 */

export type DecodedExecutionEvent = LegacyProgressInput | LegacyLogInput | JournalInput

const LOG_TYPES = new Set<string>(["info", "agent", "tool", "error", "success"])
const JOURNAL_ID = /^run:([^:]+):(\d+)$/

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function decodeLogEntry(value: unknown): ExecutionLogEntry | null {
  const entry = asRecord(value)
  if (!entry) return null
  const { timestamp, type, message, details } = entry
  if (typeof timestamp !== "string" || typeof message !== "string" || typeof type !== "string" || !LOG_TYPES.has(type)) return null
  return {
    timestamp,
    type: type as ExecutionLogEntry["type"],
    message,
    ...(typeof details === "string" ? { details } : {}),
  }
}

export function decodeExecutionEvent(
  eventType: string,
  data: unknown,
  meta?: { id?: string | null } | null,
  receivedAt?: number,
): DecodedExecutionEvent | null {
  const payload = asRecord(data)
  if (!payload) return null
  const id = meta?.id ?? null

  if (eventType === "execution:log") {
    const taskId = payload.taskId
    const entry = decodeLogEntry(payload.entry)
    if (typeof taskId !== "string" || !entry) return null
    return { kind: "log", id, taskId, entry, ...(receivedAt !== undefined ? { receivedAt } : {}) }
  }

  if (eventType !== "execution:progress") return null

  const journalId = id ? JOURNAL_ID.exec(id) : null
  const runId = typeof payload.runId === "string" ? payload.runId : journalId?.[1] ?? null
  const seq = typeof payload.seq === "number" ? payload.seq : journalId ? Number(journalId[2]) : null
  if (runId && seq !== null && Number.isFinite(seq) && typeof payload.type === "string") {
    return {
      kind: "journal",
      id,
      runId,
      seq,
      taskId: typeof payload.taskId === "string" ? payload.taskId : null,
      type: payload.type,
      payload: payload.payload,
      at: typeof payload.at === "string" || typeof payload.at === "number" ? payload.at : null,
      ...(receivedAt !== undefined ? { receivedAt } : {}),
    }
  }

  if (typeof payload.taskId !== "string" || !isLegacyProgressStatus(payload.status)) return null
  // v2 run engine beat: (runId, runSeq) identify it across reconnects; runState is its state machine.
  const runSeq = typeof payload.runSeq === "number" && Number.isInteger(payload.runSeq) && payload.runSeq > 0 ? payload.runSeq : null
  const v2RunId = typeof payload.runId === "string" && payload.runId && runSeq !== null ? payload.runId : null
  return {
    kind: "progress",
    id,
    taskId: payload.taskId,
    status: payload.status,
    message: typeof payload.message === "string" ? payload.message : "",
    prUrl: typeof payload.prUrl === "string" ? payload.prUrl : null,
    isCompareLink: payload.isCompareLink === true,
    ...(v2RunId ? { runId: v2RunId, runSeq, runState: isRunStateWire(payload.runState) ? payload.runState : null } : {}),
    ...(receivedAt !== undefined ? { receivedAt } : {}),
  }
}

/** Whether a decoded event belongs to `taskId` (journal events may only name their run). */
export function eventBelongsToTask(
  event: DecodedExecutionEvent,
  taskId: string,
  knowsRun: (runId: string) => boolean,
): boolean {
  if (event.kind === "journal") return event.taskId ? event.taskId === taskId : knowsRun(event.runId)
  return event.taskId === taskId
}
