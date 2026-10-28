import type { ExecutionLogEntry } from "@/types/task"
import type { RunPhase } from "./types"

/**
 * Classifier for today's sidecar log lines (`addLogEntry` in
 * apps/sidecar/src/services/execution/{state,events,lifecycle}.ts and
 * event-stream-processor.ts). The legacy wire format carries meaning only in
 * the message text, so the patterns live here, in one place, until the run
 * journal (W05) replaces them with typed events.
 */
export type LegacyLogMeaning =
  | { t: "assistant"; text: string }
  | { t: "reasoning"; text: string }
  | { t: "thinking" }
  | { t: "tool-start"; label: string }
  | { t: "tool-end"; name: string; ok: boolean; output: string | null }
  | { t: "file"; path: string }
  | { t: "error"; text: string; details: string | null }
  | {
      t: "system"
      text: string
      details: string | null
      tone: "neutral" | "success" | "warning"
      /** Forward-only phase implied by the line, used when no progress event says otherwise. */
      phase?: RunPhase
      branch?: string
      model?: string
      runner?: string
      prUrl?: string
    }

const RUNNING = "Running: "
const COMPLETED = "Completed: "
const FAILED = "Failed: "
const EDITED = "Edited file: "
const THINKING_PREFIX = "Thinking: "

function details(entry: ExecutionLogEntry): string | null {
  return typeof entry.details === "string" && entry.details.length > 0 ? entry.details : null
}

function after(message: string, prefix: string): string {
  return message.slice(prefix.length).trim()
}

export function classifyLegacyLog(entry: ExecutionLogEntry): LegacyLogMeaning {
  const message = typeof entry.message === "string" ? entry.message : String(entry.message ?? "")
  const extra = details(entry)

  switch (entry.type) {
    case "agent": {
      if (message === "Agent is thinking...") return { t: "thinking" }
      if (message.startsWith(THINKING_PREFIX)) return { t: "reasoning", text: after(message, THINKING_PREFIX) }
      return { t: "assistant", text: message }
    }
    case "tool": {
      if (message.startsWith(RUNNING)) return { t: "tool-start", label: after(message, RUNNING) || "tool" }
      return { t: "tool-start", label: message.trim() || "tool" }
    }
    case "success": {
      if (message.startsWith(COMPLETED)) return { t: "tool-end", name: after(message, COMPLETED), ok: true, output: extra }
      if (message.startsWith(EDITED)) return { t: "file", path: after(message, EDITED) }
      if (message === "Pull request created") {
        return { t: "system", text: message, details: extra, tone: "success", phase: "succeeded", ...(extra ? { prUrl: extra } : {}) }
      }
      return { t: "system", text: message, details: extra, tone: "success" }
    }
    case "error": {
      if (message.startsWith(FAILED)) return { t: "tool-end", name: after(message, FAILED), ok: false, output: extra }
      return { t: "error", text: message, details: extra }
    }
    default:
      return classifyInfo(message, extra)
  }
}

function classifyInfo(message: string, extra: string | null): LegacyLogMeaning {
  const system = (tone: "neutral" | "success" | "warning", more: Partial<Extract<LegacyLogMeaning, { t: "system" }>> = {}) =>
    ({ t: "system" as const, text: message, details: extra, tone, ...more })

  if (message.startsWith("Branch created: ")) return system("neutral", { branch: after(message, "Branch created: "), phase: "preparing" })
  if (message.startsWith("Using model: ")) return system("neutral", { model: after(message, "Using model: ") })
  if (message.startsWith("Using local repository: ") || message === "Repository cloned successfully") {
    return system("neutral", { phase: "preparing" })
  }
  if (message === "OpenCode agent started") return system("neutral", { runner: "OpenCode", phase: "preparing" })
  if (message === "Task prompt sent to agent") return system("neutral", { phase: "running" })
  if (message.startsWith("Agent finished, committing changes")) return system("neutral", { phase: "committing" })
  if (message.startsWith("Agent stop confirmed after stream failure")) return system("warning", { phase: "committing" })
  if (message.startsWith("Creating pull request")) return system("neutral", { phase: "publishing" })
  if (message === "Execution cancelled by user") return system("warning", { phase: "cancelled" })
  if (
    message.startsWith("Retrying: ") ||
    message.startsWith("Permission requested: ") ||
    message.startsWith("Reconnected to the agent event stream")
  ) {
    return system("warning")
  }
  return system("neutral")
}
