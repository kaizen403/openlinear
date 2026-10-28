"use client"

import { useId } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fetchRunnerCatalogue, isRunnerId, RUNNER_IDS, RUNNER_LABELS, type RunnerCatalogueResponse, type RunnerId, type RunnerPickerEntry } from "@/lib/api/runners"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

const INHERIT = "__inherit__"

/**
 * FE-02 picker model: one option per runner this engine knows, enabled only
 * when this device can run it (installed, signed in, supported by the
 * engine) — otherwise disabled with the sidecar's reason. Without a reachable
 * sidecar (web) every runner is offered and availability is "unknown".
 */
export interface RunnerOption {
  id: RunnerId
  label: string
  detail: string | null
  disabled: boolean
  reason: string | null
}

export function runnerOptions(catalogue: RunnerCatalogueResponse | null | undefined): RunnerOption[] {
  if (!catalogue) {
    return RUNNER_IDS.map((id) => ({ id, label: RUNNER_LABELS[id], detail: null, disabled: false, reason: null }))
  }
  const byId = new Map<RunnerId, RunnerPickerEntry>(catalogue.runners.map((entry) => [entry.id, entry]))
  return RUNNER_IDS.map((id) => {
    const entry = byId.get(id)
    return {
      id,
      label: RUNNER_LABELS[id],
      detail: entry?.version ? `v${entry.version.replace(/^v/, "")}` : null,
      disabled: entry ? !entry.executable : true,
      reason: entry ? entry.reason : "Not reported by the execution service",
    }
  })
}

/** Why the current value can't run (a stored choice that became unavailable), or null. */
export function selectionProblem(value: string | null | undefined, options: readonly RunnerOption[]): string | null {
  if (!value || !isRunnerId(value)) return null
  const option = options.find((item) => item.id === value)
  return option?.disabled ? option.reason ?? `${option.label} can't run on this device` : null
}

interface RunnerSelectProps {
  value: string | null | undefined
  onChange: (runner: RunnerId | null) => void
  /** Label of the inherited choice (e.g. "Project default (Codex)"); omit to require a runner. */
  inheritLabel?: string
  disabled?: boolean
  className?: string
  "aria-label"?: string
}

export function RunnerSelect({ value, onChange, inheritLabel, disabled, className, "aria-label": ariaLabel }: RunnerSelectProps) {
  const client = useAppQueryClient()
  const id = useId()
  const catalogue = useQuery({
    queryKey: queryKeys.runners(),
    queryFn: () => fetchRunnerCatalogue(),
    staleTime: 30_000,
    retry: false,
  }, client)
  const options = runnerOptions(catalogue.data)
  const problem = selectionProblem(value, options)
  const current = value && isRunnerId(value) ? value : INHERIT

  return (
    <div className={cn("space-y-1", className)}>
      <Select
        value={current}
        disabled={disabled}
        onValueChange={(next) => onChange(next === INHERIT ? null : isRunnerId(next) ? next : null)}
      >
        <SelectTrigger id={id} aria-label={ariaLabel ?? "Agent"} className="h-8 border-linear-border bg-linear-bg-secondary text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {inheritLabel && <SelectItem value={INHERIT} className="text-xs">{inheritLabel}</SelectItem>}
          {options.map((option) => (
            // A stored choice stays selectable so it isn't silently replaced; new picks need an executable runner.
            <SelectItem key={option.id} value={option.id} disabled={option.disabled && option.id !== value} className="text-xs">
              <span className="flex flex-col">
                <span>
                  {option.label}
                  {option.detail && <span className="ml-1.5 text-linear-text-tertiary">{option.detail}</span>}
                </span>
                {option.disabled && option.reason && <span className="text-[11px] text-linear-text-tertiary">{option.reason}</span>}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {problem && (
        <p role="note" className="flex items-start gap-1 text-[11px] text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{problem}. Runs of this task will fail until it's fixed or another agent is chosen.</span>
        </p>
      )}
      {catalogue.isError && (
        <p className="text-[11px] text-linear-text-tertiary">Availability unknown — the execution service isn't reachable.</p>
      )}
    </div>
  )
}
