import type {
  ProjectVerificationSettings,
  ProjectVerificationSettingsInput,
  VerificationCheckInput,
  VerificationCheckSpec,
  VerificationPolicy,
} from "@/lib/api/verification"

/**
 * Editable form of the project's verification settings. A check is edited as
 * one shell command line; a stored argument-list check (`command: [...]`)
 * round-trips untouched unless its command line is edited. Network access
 * stays as stored (the editor offers "needs package registries" only).
 * W16a: setup steps (run before the agent starts) are edited with the same
 * rows and rules.
 */

export interface CheckDraft {
  /** Stable React key. */
  key: string
  id: string | null
  name: string
  command: string
  timeoutSeconds: string
  required: boolean
  registries: boolean
  cwd: string
  /** The stored argv when it isn't a `/bin/sh -c` line, and the text it was shown as. */
  original: { argv: string[]; shown: string } | null
  /** Stored egress hosts (kept as they are). */
  hosts: string[]
}

export interface VerificationDraft {
  policy: VerificationPolicy
  autoDetect: boolean
  repositoryChecks: boolean
  checks: CheckDraft[]
  /** W16a: environment setup steps, in order. */
  setup: CheckDraft[]
}

export const MAX_CHECKS = 20
export const MAX_SETUP_STEPS = 10
export const DEFAULT_TIMEOUT_SECONDS = 600

export const POLICY_COPY: Readonly<Record<VerificationPolicy, { label: string; description: string }>> = {
  warn: {
    label: "Report only",
    description: "Run the checks before publishing and show the results; publish either way.",
  },
  "require-pass": {
    label: "Require passing checks",
    description: "Publish only when every required check passes. A run with failing checks keeps its work but opens no pull request.",
  },
  off: {
    label: "Off",
    description: "Don't run verification checks for this project.",
  },
}

let counter = 0
function nextKey(): string {
  counter += 1
  return `check-${counter}`
}

function shellLine(argv: readonly string[]): string | null {
  return argv.length === 3 && argv[0] === "/bin/sh" && argv[1] === "-c" ? argv[2] ?? "" : null
}

function quote(part: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(part) ? part : JSON.stringify(part)
}

export function draftCheck(spec?: VerificationCheckSpec): CheckDraft {
  if (!spec) {
    return { key: nextKey(), id: null, name: "", command: "", timeoutSeconds: String(DEFAULT_TIMEOUT_SECONDS), required: true, registries: false, cwd: "", original: null, hosts: [] }
  }
  const line = shellLine(spec.argv)
  const shown = line ?? spec.argv.map(quote).join(" ")
  return {
    key: nextKey(),
    id: spec.id,
    name: spec.name,
    command: shown,
    timeoutSeconds: String(Math.round(spec.timeoutMs / 1000)),
    required: spec.required,
    registries: spec.network.mode === "egress" && spec.network.registries,
    cwd: spec.cwd,
    original: line === null ? { argv: spec.argv, shown } : null,
    hosts: spec.network.mode === "egress" ? spec.network.hosts : [],
  }
}

export function toDraft(settings: ProjectVerificationSettings): VerificationDraft {
  return {
    policy: settings.policy,
    autoDetect: settings.autoDetect,
    repositoryChecks: settings.repositoryChecks,
    checks: settings.checks.map((check) => draftCheck(check)),
    setup: (settings.setup ?? []).map((step) => draftCheck(step)),
  }
}

function rowProblems(rows: CheckDraft[], noun: string, problems: string[]): void {
  rows.forEach((row, index) => {
    const label = row.name.trim() || `${noun} ${index + 1}`
    if (!row.name.trim()) problems.push(`${noun} ${index + 1} needs a name.`)
    if (!row.command.trim()) problems.push(`${label} needs a command.`)
    const timeout = Number(row.timeoutSeconds)
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) problems.push(`${label}: the timeout must be 1–3600 seconds.`)
  })
}

/** Problems the server would also reject, reported per field before saving. */
export function draftProblems(draft: VerificationDraft): string[] {
  const problems: string[] = []
  if (draft.checks.length > MAX_CHECKS) problems.push(`At most ${MAX_CHECKS} checks are allowed.`)
  rowProblems(draft.checks, "Check", problems)
  if (draft.setup.length > MAX_SETUP_STEPS) problems.push(`At most ${MAX_SETUP_STEPS} setup steps are allowed.`)
  rowProblems(draft.setup, "Setup step", problems)
  return problems
}

function checkBody(check: CheckDraft): VerificationCheckInput {
  const keepArgv = check.original !== null && check.command === check.original.shown
  const network: VerificationCheckInput["network"] = check.hosts.length > 0
    ? { allow: check.hosts, registries: check.registries }
    : check.registries ? "registries" : "none"
  return {
    ...(check.id ? { id: check.id } : {}),
    name: check.name.trim(),
    ...(keepArgv && check.original ? { command: check.original.argv } : { run: check.command.trim() }),
    ...(check.cwd ? { cwd: check.cwd } : {}),
    timeoutSeconds: Number(check.timeoutSeconds),
    network,
    required: check.required,
  }
}

export function toBody(draft: VerificationDraft): ProjectVerificationSettingsInput {
  return {
    policy: draft.policy,
    autoDetect: draft.autoDetect,
    repositoryChecks: draft.repositoryChecks,
    checks: draft.checks.map(checkBody),
    setup: draft.setup.map(checkBody),
  }
}

/** Server validation errors (`details.errors`), when the response carries them. */
export function serverProblems(details: unknown): string[] {
  if (!details || typeof details !== "object") return []
  const errors = (details as { errors?: unknown }).errors
  return Array.isArray(errors) ? errors.filter((error): error is string => typeof error === "string").slice(0, 10) : []
}
