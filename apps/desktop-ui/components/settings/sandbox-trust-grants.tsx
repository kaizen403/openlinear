"use client"

import { useId, useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { AlertTriangle, Loader2, ShieldOff } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { focusRing } from "@/components/ui/focus-ring"
import { Label } from "@/components/ui/label"
import { describeApiError } from "@/lib/api/errors"
import {
  createSandboxGrant,
  fetchSandboxGrants,
  revokeSandboxGrant,
  SANDBOX_GRANT_DURATIONS,
  SANDBOX_GRANT_REASON_MAX,
  SANDBOX_GRANT_REASON_MIN,
  type SandboxGrantAuditEntry,
  type SandboxGrantsResponse,
  type SandboxGrantStatus,
  type SandboxTrustGrant,
} from "@/lib/api/sandbox-grants"
import { queryKeys } from "@/lib/query/keys"
import { projectDirectoryQuery, type ProjectOption } from "@/lib/query/teams"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * FE-03: project trust grants. When no verified sandbox is available, runs
 * are refused; the user can allow ONE project's runs without the sandbox,
 * for a limited time (1 hour / 1 day / 7 days), with a reason and an explicit
 * confirmation that the agent then runs with their own permissions. Active
 * grants can be revoked; recent audit entries (created, used, revoked,
 * expired) are listed. With a verified sandbox, grants are not needed (and
 * any existing ones can still be revoked).
 */

/** Local (sidecar) data, outside the cloud cache hierarchy. */
export const SANDBOX_GRANTS_QUERY_KEY = queryKeys.sandboxGrants()

export function sandboxGrantsQuery() {
  return { queryKey: SANDBOX_GRANTS_QUERY_KEY, queryFn: () => fetchSandboxGrants(), retry: false }
}

export interface GrantIntro {
  tone: "warning" | "ok" | "muted"
  title: string
  detail: string
  /** The "Allow runs without the sandbox…" action is offered. */
  canCreate: boolean
}

export function grantIntro(status: SandboxGrantStatus): GrantIntro {
  switch (status.state) {
    case "unavailable":
      return {
        tone: "warning",
        title: "No verified sandbox: runs are blocked",
        detail: "Agents and checks are refused instead of running unprotected on this device. You can allow one project's runs without the sandbox for a limited time.",
        canCreate: true,
      }
    case "verified":
      return {
        tone: "ok",
        title: "Trust grants aren't needed",
        detail: "The sandbox is verified on this device, so every run is isolated and grants are ignored.",
        canCreate: false,
      }
    case "unknown":
      return { tone: "muted", title: "Checking the sandbox…", detail: "If no verified sandbox is found, you can allow a project's runs without it here.", canCreate: false }
    case "env-grant":
      return {
        tone: "warning",
        title: "Trusted-host mode is set for this device",
        detail: "The execution service was started with a trusted-host grant in its environment, which applies instead of project grants.",
        canCreate: false,
      }
    case "disabled":
      return {
        tone: "muted",
        title: "Project trust grants are turned off",
        detail: "This device sets OPENLINEAR_SANDBOX_USER_GRANTS=0: runs stay blocked while the sandbox is unavailable.",
        canCreate: false,
      }
    case "invalid":
      return {
        tone: "warning",
        title: "The sandbox setting is invalid",
        detail: "Runs are refused until it is fixed; a project grant can't override it.",
        canCreate: false,
      }
  }
}

export interface GrantDraft {
  projectId: string
  reason: string
  hours: number
  confirmed: boolean
}

export function draftProblems(draft: GrantDraft): string[] {
  const problems: string[] = []
  if (!draft.projectId) problems.push("Choose a project.")
  const reason = draft.reason.trim()
  if (reason.length < SANDBOX_GRANT_REASON_MIN) problems.push(`Give a reason of at least ${SANDBOX_GRANT_REASON_MIN} characters.`)
  if (reason.length > SANDBOX_GRANT_REASON_MAX) problems.push(`Keep the reason under ${SANDBOX_GRANT_REASON_MAX} characters.`)
  if (!SANDBOX_GRANT_DURATIONS.some((option) => option.hours === draft.hours)) problems.push("Choose how long the grant lasts.")
  if (!draft.confirmed) problems.push("Confirm that runs of this project won't be isolated.")
  return problems
}

/** "in 45 min" / "in 23 h" / "in 6 days" (never negative). */
export function timeLeft(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now)
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `in ${Math.max(1, minutes)} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `in ${hours} h`
  return `in ${Math.round(hours / 24)} days`
}

const EVENT_LABELS: Readonly<Record<SandboxGrantAuditEntry["event"], string>> = {
  created: "Allowed",
  used: "Used",
  revoked: "Revoked",
  expired: "Expired",
}

export function auditLine(entry: SandboxGrantAuditEntry): string {
  const project = entry.projectName ?? entry.projectId
  if (entry.event === "used") {
    const what = entry.kind === "verification" ? "verification checks" : "an agent run"
    return `Used for ${what}${entry.runId ? ` (run ${entry.runId.slice(0, 8)})` : ""} · ${project}`
  }
  return `${EVENT_LABELS[entry.event]} · ${project}`
}

function formatWhen(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value))
}

const fieldClass = cn("w-full rounded-sm border border-linear-border bg-linear-bg-tertiary px-2.5 py-1.5 text-sm text-linear-text placeholder:text-linear-text-tertiary", focusRing)

const EMPTY_DRAFT: GrantDraft = { projectId: "", reason: "", hours: 1, confirmed: false }

function CreateGrantDialog({
  open,
  onOpenChange,
  projects,
  projectsLoading,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ProjectOption[]
  projectsLoading: boolean
  onCreated: (grant: SandboxTrustGrant, durationLabel: string) => void
}) {
  const client = useAppQueryClient()
  const [draft, setDraft] = useState<GrantDraft>(EMPTY_DRAFT)
  const [problems, setProblems] = useState<string[]>([])
  const projectId = useId()
  const reasonId = useId()
  const confirmId = useId()

  const create = useMutation({
    mutationFn: () => createSandboxGrant({
      projectId: draft.projectId,
      projectName: projects.find((project) => project.id === draft.projectId)?.name,
      reason: draft.reason.trim(),
      hours: draft.hours,
    }),
    onSuccess: (grant) => {
      const label = SANDBOX_GRANT_DURATIONS.find((option) => option.hours === draft.hours)?.label ?? `${draft.hours} hours`
      setDraft(EMPTY_DRAFT)
      setProblems([])
      onCreated(grant, label)
    },
    onError: (error: unknown) => {
      const described = describeApiError(error, "Couldn't allow runs without the sandbox.")
      setProblems([described.hint ? `${described.message} ${described.hint}` : described.message])
    },
  }, client)

  const submit = () => {
    const found = draftProblems(draft)
    setProblems(found)
    if (found.length === 0) create.mutate()
  }

  const close = (next: boolean) => {
    if (!next) {
      setDraft(EMPTY_DRAFT)
      setProblems([])
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="bg-linear-bg-secondary border-linear-border sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-linear-text">Allow runs without the sandbox</DialogTitle>
          <DialogDescription className="text-linear-text-secondary">
            For one project, while no verified sandbox is available on this device.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={projectId} className="text-xs text-linear-text-secondary">Project</Label>
            <select
              id={projectId}
              value={draft.projectId}
              onChange={(event) => setDraft((current) => ({ ...current, projectId: event.target.value }))}
              className={fieldClass}
              disabled={projectsLoading}
            >
              <option value="">{projectsLoading ? "Loading projects…" : "Choose a project"}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={reasonId} className="text-xs text-linear-text-secondary">Reason</Label>
            <textarea
              id={reasonId}
              rows={3}
              maxLength={SANDBOX_GRANT_REASON_MAX}
              value={draft.reason}
              onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))}
              placeholder="Why is it safe to run this project's agents without isolation?"
              className={fieldClass}
            />
            <p className="text-xs text-linear-text-tertiary">Recorded with the grant and in the audit log.</p>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-xs text-linear-text-secondary">Allow for</legend>
            <div className="flex flex-wrap gap-2">
              {SANDBOX_GRANT_DURATIONS.map((option) => (
                <label
                  key={option.hours}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 py-1 text-sm",
                    draft.hours === option.hours ? "border-linear-accent text-linear-text" : "border-linear-border text-linear-text-secondary",
                  )}
                >
                  <input
                    type="radio"
                    name="sandbox-grant-duration"
                    value={option.hours}
                    checked={draft.hours === option.hours}
                    onChange={() => setDraft((current) => ({ ...current, hours: option.hours }))}
                    className={focusRing}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div role="note" className="flex items-start gap-2 rounded-sm border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-medium">The agent will run with your own permissions.</p>
              <p>
                Without the sandbox, this project's agents and checks can read and change any file you can, use your
                credentials and reach any network. Only allow this for code you trust. It ends when the time is up or you
                revoke it (runs it started are then stopped), and stops applying to new runs as soon as the sandbox works
                again.
              </p>
            </div>
          </div>
          <label htmlFor={confirmId} className="flex items-start gap-2 text-sm text-linear-text">
            <input
              id={confirmId}
              type="checkbox"
              checked={draft.confirmed}
              onChange={(event) => setDraft((current) => ({ ...current, confirmed: event.target.checked }))}
              className={cn("mt-0.5", focusRing)}
            />
            I understand that runs of this project will not be isolated.
          </label>
          {problems.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {problems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => close(false)}>Cancel</Button>
          <Button variant="destructive" size="sm" onClick={submit} disabled={create.isPending || !draft.confirmed}>
            {create.isPending ? "Allowing…" : "Allow without sandbox"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GrantRow({ grant, now, onRevoke, revoking }: { grant: SandboxTrustGrant; now: number; onRevoke: () => void; revoking: boolean }) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-sm border border-linear-border px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-linear-text">{grant.projectName ?? grant.projectId}</p>
        <p className="break-words text-xs text-linear-text-secondary">{grant.reason}</p>
        <p className="text-xs text-linear-text-tertiary">
          Expires {timeLeft(grant.expiresAt, now)} ({formatWhen(grant.expiresAt)})
          {" · "}
          {grant.useCount === 0 ? "not used yet" : `used ${grant.useCount} time${grant.useCount === 1 ? "" : "s"}`}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onRevoke}
        disabled={revoking}
        aria-label={`Revoke the grant for ${grant.projectName ?? grant.projectId}`}
      >
        {revoking ? "Revoking…" : "Revoke"}
      </Button>
    </li>
  )
}

export function SandboxTrustGrantsCard({ now = Date.now() }: { now?: number }) {
  const client = useAppQueryClient()
  const grants = useQuery(sandboxGrantsQuery(), client)
  const [dialogOpen, setDialogOpen] = useState(false)
  const intro = grants.data ? grantIntro(grants.data.sandbox) : null
  const projects = useQuery({ ...projectDirectoryQuery(), enabled: dialogOpen }, client)

  const available = useMemo(() => {
    const granted = new Set((grants.data?.grants ?? []).map((grant) => grant.projectId))
    return (projects.data ?? []).filter((project) => !granted.has(project.id))
  }, [grants.data, projects.data])

  const revoke = useMutation({
    mutationFn: (id: string) => revokeSandboxGrant(id),
    onSuccess: (grant) => {
      client.setQueryData<SandboxGrantsResponse>(SANDBOX_GRANTS_QUERY_KEY, (current) => current
        ? { ...current, grants: current.grants.filter((candidate) => candidate.id !== grant.id) }
        : current)
      void client.invalidateQueries({ queryKey: SANDBOX_GRANTS_QUERY_KEY })
      toast.success(`Revoked: ${grant.projectName ?? grant.projectId} runs need the sandbox again; runs it started are being stopped`)
    },
    onError: (error: unknown) => {
      const described = describeApiError(error, "Couldn't revoke the grant.")
      toast.error(described.message, described.hint ? { description: described.hint } : undefined)
    },
  }, client)

  const created = (grant: SandboxTrustGrant, durationLabel: string) => {
    setDialogOpen(false)
    void client.invalidateQueries({ queryKey: SANDBOX_GRANTS_QUERY_KEY })
    toast.success(`${grant.projectName ?? grant.projectId} can run without the sandbox for ${durationLabel}`)
  }

  const data = grants.data
  return (
    <Card className="bg-linear-bg-secondary border-linear-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-linear-text">
          <ShieldOff className="h-4 w-4 text-linear-text-secondary" aria-hidden="true" />
          Runs without the sandbox
        </CardTitle>
        <CardDescription className="text-linear-text-secondary">
          Explicit, per-project, expiring trust grants for when no verified sandbox is available.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {grants.isLoading && (
          <p className="flex items-center gap-2 text-xs text-linear-text-tertiary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Checking the sandbox…
          </p>
        )}
        {grants.isError && (
          <p role="alert" className="text-xs text-linear-text-secondary">
            {describeApiError(grants.error, "Trust grants on this device couldn't be loaded.").message}
          </p>
        )}
        {data && intro && (
          <>
            <div className={cn("text-sm", intro.tone === "warning" ? "text-warning" : "text-linear-text")}>
              <p className="font-medium">{intro.title}</p>
              <p className="text-xs text-linear-text-secondary">{intro.detail}</p>
              {data.sandbox.state === "unavailable" && data.sandbox.blockers[0] && (
                <p className="mt-1 text-xs text-linear-text-tertiary">Why: {data.sandbox.blockers[0]}</p>
              )}
            </div>
            {data.problem && (
              <p role="alert" className="text-xs text-danger">Stored grants are ignored: {data.problem}.</p>
            )}
            {intro.canCreate && (
              <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
                Allow runs without the sandbox for a project…
              </Button>
            )}

            {data.grants.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-linear-text-secondary">
                  {data.sandbox.state === "verified" ? "Existing grants (not used while the sandbox works)" : "Active grants"}
                </p>
                <ul className="space-y-2">
                  {data.grants.map((grant) => (
                    <GrantRow
                      key={grant.id}
                      grant={grant}
                      now={now}
                      onRevoke={() => revoke.mutate(grant.id)}
                      revoking={revoke.isPending && revoke.variables === grant.id}
                    />
                  ))}
                </ul>
              </div>
            )}
            {data.grants.length === 0 && intro.canCreate && (
              <p className="text-xs text-linear-text-tertiary">No project may run without the sandbox.</p>
            )}

            {data.audit.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-linear-text-secondary">Recent activity</p>
                <ul className="space-y-1" aria-label="Trust grant activity">
                  {data.audit.slice(0, 10).map((entry) => (
                    <li key={entry.id} className="flex gap-2 text-xs text-linear-text-tertiary">
                      <time dateTime={entry.at} className="shrink-0 tabular-nums">{formatWhen(entry.at)}</time>
                      <span className="text-linear-text-secondary">{auditLine(entry)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
      <CreateGrantDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projects={available}
        projectsLoading={projects.isLoading}
        onCreated={created}
      />
    </Card>
  )
}
