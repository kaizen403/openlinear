/** Display names for runner ids (sidecar `resolveAgentId`); unknown ids and legacy labels pass through. */
const RUNNER_NAMES: Readonly<Record<string, string>> = {
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  codex: "Codex",
}

export function runnerDisplayName(runner: string | null | undefined): string | null {
  if (!runner) return null
  return RUNNER_NAMES[runner] ?? runner
}
