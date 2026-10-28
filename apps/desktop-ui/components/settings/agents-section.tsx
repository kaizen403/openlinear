"use client"

import { useQuery } from "@tanstack/react-query"
import { CheckCircle2, Loader2, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { describeApiError } from "@/lib/api/errors"
import { fetchRunnerCatalogue, type RunnerCatalogueResponse, type RunnerPickerEntry } from "@/lib/api/runners"
import type { SandboxGrantsResponse } from "@/lib/api/sandbox-grants"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"
import { SANDBOX_GRANTS_QUERY_KEY, SandboxTrustGrantsCard, sandboxGrantsQuery } from "./sandbox-trust-grants"

/**
 * FE-15: which agent runners this device can run and why not, and whether
 * the sandbox that isolates them is verified. "Check again" re-runs the
 * local health checks (no inference, no credentials shown).
 *
 * FE-03: when the sandbox is unavailable, runs are blocked; the trust grants
 * card below offers explicit, per-project, expiring grants and their audit.
 */

const AUTH_COPY: Readonly<Record<NonNullable<RunnerPickerEntry["auth"]>, string>> = {
  ok: "Signed in",
  missing: "Not signed in",
  "unreachable-in-sandbox": "Signed in, but unreachable from the sandbox",
  unknown: "Sign-in status unknown",
}

export function featureSummary(entry: RunnerPickerEntry): string[] {
  const features = entry.features
  if (!features) return []
  return [
    features.resume === "native-session" ? "Continues sessions in follow-ups" : "Follow-ups start a fresh session",
    features.approvals === "interactive" ? "Can ask for approvals" : "Approvals decided by policy",
    features.interrupt === "graceful-ack" ? "Graceful stop" : features.interrupt === "server-abort" ? "Stop via server" : "Stop by ending the process",
    features.modelDiscovery === "live" ? "Lists its models" : "Model by name",
  ]
}

/**
 * The sandbox headline. `grants` (FE-03, the grants endpoint runs the live
 * check) fills in a state the runner catalogue has not seen yet, and tells
 * project grants apart from an environment-wide trusted-host mode.
 */
export function sandboxSummary(
  sandbox: RunnerCatalogueResponse["sandbox"],
  grants: Pick<SandboxGrantsResponse, "sandbox" | "grants"> | null = null,
): { ok: boolean; title: string; detail: string } {
  if (sandbox.mode === "invalid") return { ok: false, title: "Sandbox misconfigured", detail: sandbox.blockers[0] ?? "The sandbox mode setting is invalid; runs are refused." }
  if (grants?.sandbox.state === "unavailable") {
    return {
      ok: false,
      title: "Sandbox unavailable",
      detail: grants.grants.length > 0
        ? "Runs are refused, except for the projects you allowed below to run without the sandbox."
        : grants.sandbox.blockers[0] ?? sandbox.blockers[0] ?? "No verified sandbox: runs are refused instead of running unprotected.",
    }
  }
  if (sandbox.mode === "trusted-host") return { ok: false, title: "Trusted-host mode", detail: "Agents run without OS isolation under an explicit grant." }
  const verified = sandbox.verified ?? (grants?.sandbox.state === "verified" ? true : null)
  const provider = sandbox.provider ?? grants?.sandbox.provider ?? null
  if (verified === false) return { ok: false, title: "Sandbox unavailable", detail: sandbox.blockers[0] ?? "No verified sandbox: runs are refused instead of running unprotected." }
  if (verified === null) return { ok: true, title: "Sandbox not checked yet", detail: "It is verified before the first run." }
  return { ok: true, title: `Sandbox verified${provider ? ` (${provider})` : ""}`, detail: "Agents run isolated: their checkout is the only writable project folder." }
}

export function AgentsSection() {
  const client = useAppQueryClient()
  const catalogue = useQuery({ queryKey: queryKeys.runners(), queryFn: () => fetchRunnerCatalogue(), retry: false }, client)
  const grants = useQuery(sandboxGrantsQuery(), client)

  const refresh = async () => {
    void client.invalidateQueries({ queryKey: SANDBOX_GRANTS_QUERY_KEY })
    const fresh = await fetchRunnerCatalogue({ refresh: true }).catch(() => null)
    if (fresh) client.setQueryData(queryKeys.runners(), fresh)
    else await catalogue.refetch()
  }

  const data = catalogue.data
  const sandbox = data ? sandboxSummary(data.sandbox, grants.data ?? null) : null

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-linear-text">Agents</h2>
          <p className="mt-1 text-sm text-linear-text-tertiary">The agent runners and the sandbox on this device.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={catalogue.isFetching}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", catalogue.isFetching && "motion-safe:animate-spin")} aria-hidden="true" />
          Check again
        </Button>
      </div>

      {catalogue.isLoading && (
        <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-linear-text-secondary" aria-label="Loading" /></div>
      )}
      {catalogue.isError && (
        <p role="alert" className="text-sm text-linear-text-secondary">{describeApiError(catalogue.error, "The execution service on this device isn't reachable.").message}</p>
      )}

      {data && sandbox && (
        <>
          <Card className="bg-linear-bg-secondary border-linear-border">
            <CardContent className="flex items-start gap-3 pt-6">
              {sandbox.ok
                ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                : <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />}
              <div>
                <p className="text-sm font-medium text-linear-text">{sandbox.title}</p>
                <p className="text-xs text-linear-text-tertiary">{sandbox.detail}</p>
              </div>
            </CardContent>
          </Card>

          <SandboxTrustGrantsCard />

          <div className="space-y-3">
            {data.runners.map((entry) => (
              <Card key={entry.id} className="bg-linear-bg-secondary border-linear-border">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base text-linear-text">
                        {entry.label}
                        {entry.version && <span className="ml-2 text-xs font-normal text-linear-text-tertiary">v{entry.version.replace(/^v/, "")}</span>}
                      </CardTitle>
                      <CardDescription className="text-linear-text-secondary">
                        {entry.auth ? AUTH_COPY[entry.auth] : entry.available ? "Ready" : "Not available"}
                      </CardDescription>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs text-linear-text-secondary">
                      {entry.executable
                        ? <><CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />Can run tasks</>
                        : <><XCircle className="h-4 w-4 text-danger" aria-hidden="true" />Can't run tasks</>}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {entry.reason && <p className="text-xs text-linear-text-secondary">{entry.reason}</p>}
                  {featureSummary(entry).length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {featureSummary(entry).map((feature) => (
                        <li key={feature} className="rounded-sm border border-linear-border px-2 py-0.5 text-[11px] text-linear-text-tertiary">{feature}</li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="text-xs text-linear-text-tertiary">
            Execution engine: {data.engine === "v2" ? "durable (v2)" : "legacy (OpenCode only)"} · checked {new Date(data.checkedAt).toLocaleTimeString()}
          </p>
        </>
      )}
    </div>
  )
}
