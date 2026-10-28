/**
 * Per-tool presentation: one switch from the tool's name (and input, when the
 * journal provides it) to a title and the single most identifying argument.
 * Unknown and MCP tools degrade to the generic row instead of disappearing
 * (R5 §4.2.2).
 */

export type ToolKind = "read" | "write" | "search" | "list" | "shell" | "web" | "task" | "todo" | "generic"

/** Tool names OpenCode reports today (`part.tool`). */
const TOOL_KINDS: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>(Object.entries({
  read: "read",
  write: "write",
  edit: "write",
  multiedit: "write",
  patch: "write",
  apply_patch: "write",
  grep: "search",
  glob: "search",
  codesearch: "search",
  list: "list",
  ls: "list",
  bash: "shell",
  shell: "shell",
  webfetch: "web",
  websearch: "web",
  task: "task",
  todowrite: "todo",
  todoread: "todo",
}) as Array<[string, ToolKind]>)

const TOOL_TITLES: Readonly<Record<ToolKind, string>> = {
  read: "Read",
  write: "Edit",
  search: "Search",
  list: "List",
  shell: "Shell",
  web: "Web",
  task: "Subagent",
  todo: "Plan",
  generic: "Tool",
}

export function isKnownToolName(name: string | null | undefined): boolean {
  return typeof name === "string" && TOOL_KINDS.has(name.toLowerCase())
}

export function toolKind(name: string | null | undefined): ToolKind {
  if (!name) return "generic"
  return TOOL_KINDS.get(name.toLowerCase()) ?? "generic"
}

export function isShellTool(name: string | null | undefined): boolean {
  return toolKind(name) === "shell"
}

/** "mcp__github__create_issue" → "github · create issue"; "bash" → "Shell". */
export function toolTitle(name: string | null | undefined): string {
  if (!name) return TOOL_TITLES.generic
  const kind = toolKind(name)
  if (kind !== "generic") {
    if (name === "write") return "Write"
    if (name === "glob") return "Glob"
    if (name === "grep") return "Grep"
    if (name === "todowrite") return "Update plan"
    if (name === "todoread") return "Read plan"
    return TOOL_TITLES[kind]
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  if (mcp) return `${mcp[1]} · ${mcp[2]!.replace(/_/g, " ")}`
  return name.replace(/_/g, " ")
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index === -1 ? trimmed : trimmed.slice(index + 1) || trimmed
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringAt(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function singleLine(value: string, max = 160): string {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * The single most identifying argument of a tool call: a file name for
 * read/edit, the command for shell, the pattern for search, the URL or query
 * for web tools, the description for subagents, else the first string arg.
 */
export function summarizeToolInput(name: string | null | undefined, input: unknown): string | null {
  if (typeof input === "string") return input.trim() ? singleLine(input) : null
  const record = asRecord(input)
  if (!record) return null
  const kind = toolKind(name)
  switch (kind) {
    case "read":
    case "write": {
      const path = stringAt(record, "filePath", "file_path", "path")
      return path ? basename(path) : null
    }
    case "list": {
      const path = stringAt(record, "path", "dir")
      return path ? basename(path) || path : null
    }
    case "search":
      return stringAt(record, "pattern", "query", "glob") ? singleLine(stringAt(record, "pattern", "query", "glob")!) : null
    case "shell": {
      const command = stringAt(record, "command", "cmd")
      return command ? singleLine(command) : stringAt(record, "description")
    }
    case "web":
      return stringAt(record, "url", "query") ? singleLine(stringAt(record, "url", "query")!) : null
    case "task":
      return stringAt(record, "description", "prompt") ? singleLine(stringAt(record, "description", "prompt")!) : null
    default: {
      for (const value of Object.values(record)) {
        if (typeof value === "string" && value.trim()) return singleLine(value)
      }
      return null
    }
  }
}

/** Arguments for the expanded row: pretty JSON (bounded) or the raw string. */
export function formatToolArgs(input: unknown, maxChars: number): string | null {
  if (input === undefined || input === null) return null
  let text: string
  if (typeof input === "string") {
    text = input
  } else {
    try {
      text = JSON.stringify(input, null, 2)
    } catch {
      return null
    }
  }
  if (!text || text === "{}") return null
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}
