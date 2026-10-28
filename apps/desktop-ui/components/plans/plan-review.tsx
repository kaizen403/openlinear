"use client"

import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { AlertTriangle, ArrowLeft, Check, CircleAlert, GitCompare, Link2, ListChecks, Loader2, Pencil, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { focusRing } from "@/components/ui/focus-ring"
import { STATUS_COLORS } from "@/lib/design-tokens"
import { describeApiError, toastApiError } from "@/lib/api/errors"
import { getSetupStatus } from "@/lib/api/opencode"
import { PlanEditor } from "./plan-editor"
import { approvePlan, describeApproval, fetchPlan, planRunSelection, planWaves, runPlanTasks, type PlanTaskSpec, type PlanView } from "@/lib/api/plans"
import { queryKeys } from "@/lib/query/keys"
import { maxBatchSizeOf, settingsQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * FE-09: review one plan revision before anything is created — tasks in
 * blocker order with acceptance checks and estimates, problems that block
 * approval, review warnings, and what changed against the previous revision.
 * Approve is offered for the latest revision only and creates the issues.
 */

const ESTIMATE_LABEL: Readonly<Record<string, string>> = { xs: "XS", s: "S", m: "M", l: "L", xl: "XL" }

function FIELD_LABEL(field: string): string {
  return field === "blockedBy" ? "blockers" : field
}

function TaskRow({ task, plan }: { task: PlanTaskSpec; plan: PlanView }) {
  const created = plan.tasks.find((row) => row.key === task.key)
  const diff = plan.revision.diff
  const added = diff?.added.includes(task.key) ?? false
  const changed = diff?.changed.find((entry) => entry.key === task.key)
  const flagged = plan.revision.warnings.some((issue) => issue.code === "NO_ACCEPTANCE" && issue.keys.includes(task.key))
  return (
    <li className="border-b border-linear-border/60 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-linear-text-tertiary">{task.key}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-linear-text">{task.title}</span>
        {added && <span className="rounded-sm bg-success/15 px-1.5 py-0.5 text-[10px] text-success">new</span>}
        {changed && <span className="rounded-sm bg-info/15 px-1.5 py-0.5 text-[10px] text-info" title={`Changed: ${changed.fields.map(FIELD_LABEL).join(", ")}`}>changed: {changed.fields.map(FIELD_LABEL).join(", ")}</span>}
        {task.estimate && <span className="rounded-sm border border-linear-border px-1.5 py-0.5 text-[10px] text-linear-text-secondary" title="Estimate">{ESTIMATE_LABEL[task.estimate] ?? task.estimate}</span>}
        {task.risk && task.risk !== "low" && (
          <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px]", task.risk === "high" ? "bg-danger/15 text-danger" : "bg-warning/15 text-warning")} title="Risk">{task.risk} risk</span>
        )}
        {task.priority && task.priority !== "medium" && <span className="text-[10px] uppercase text-linear-text-tertiary">{task.priority}</span>}
        {created && (
          <span className="inline-flex items-center gap-1 text-[11px] text-linear-text-secondary" title={`Created as ${created.identifier ?? created.title}`}>
            <span className={cn("h-2 w-2 rounded-full", STATUS_COLORS[created.status].dot)} aria-hidden="true" />
            {created.identifier ?? "issue"}
          </span>
        )}
      </div>
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-linear-text-tertiary">
          <Link2 className="h-3 w-3" aria-hidden="true" />
          after {task.blockedBy.join(", ")}
        </p>
      )}
      {task.acceptance && task.acceptance.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {task.acceptance.map((check) => (
            <li key={check} className="flex items-start gap-1.5 text-xs text-linear-text-secondary">
              <ListChecks className="mt-0.5 h-3 w-3 shrink-0 text-linear-text-tertiary" aria-hidden="true" />
              {check}
            </li>
          ))}
        </ul>
      ) : flagged ? (
        <p className="mt-1 text-[11px] text-warning">No acceptance checks — "done" can't be verified.</p>
      ) : null}
    </li>
  )
}

export function PlanReview({ planId, onBack, onRunStarted }: {
  planId: string
  onBack?: () => void
  /** FE-10: after "Run plan" started a batch (e.g. open the board to watch it). */
  onRunStarted?: (projectId: string) => void
}) {
  const client = useAppQueryClient()
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [confirmRun, setConfirmRun] = useState(false)
  const [editing, setEditing] = useState(false)
  const settings = useQuery(settingsQuery(), client)
  const plan = useQuery({ queryKey: queryKeys.plans.detail(planId, revision ?? null), queryFn: () => fetchPlan(planId, revision) }, client)

  const approve = useMutation({
    mutationFn: (number: number) => approvePlan(planId, number),
    onSuccess: ({ approval, plan: next }) => {
      client.setQueryData(queryKeys.plans.detail(planId, null), next)
      void client.invalidateQueries({ queryKey: queryKeys.plans.all(next.projectId) })
      void client.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      toast.success(`Plan approved (revision ${next.approvedRevision})`, { description: describeApproval(approval) })
    },
    onError: (error) => { toastApiError(error, { fallbackMessage: "Couldn't approve the plan" }) },
  }, client)

  const run = useMutation({
    mutationFn: async (taskIds: string[]) => {
      const setup = await getSetupStatus()
      if (!setup.ready) throw new Error(setup.hasProvider ? "Pick a model in Settings → AI Providers before running the plan." : "Connect an AI provider in Settings → AI Providers before running the plan.")
      return runPlanTasks(taskIds)
    },
    onSuccess: (_batch, taskIds) => {
      setConfirmRun(false)
      const projectId = plan.data?.projectId
      toast.success(`Running ${taskIds.length} ${taskIds.length === 1 ? "issue" : "issues"}`, {
        description: "Blockers run first; an issue starts once everything it waits on succeeded.",
        ...(projectId && onRunStarted ? { action: { label: "Open board", onClick: () => onRunStarted(projectId) } } : {}),
      })
      void client.invalidateQueries({ queryKey: queryKeys.plans.details(planId) })
    },
    onError: (error) => {
      setConfirmRun(false)
      toastApiError(error, { fallbackMessage: "Couldn't start the plan" })
    },
  }, client)

  if (plan.isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-linear-text-secondary" aria-label="Loading plan" /></div>
  }
  if (plan.isError || !plan.data) {
    return <p role="alert" className="p-6 text-sm text-linear-text-secondary">{describeApiError(plan.error, "Couldn't load the plan.").message}</p>
  }

  const data = plan.data
  const view = data.revision
  const isLatest = view.number === data.latestRevision
  const approvedHere = data.approvedRevision === view.number
  const canApprove = isLatest && !approvedHere && view.errors.length === 0 && data.status !== "archived"
  const waves = planWaves(data.revision.spec.tasks)
  const runSelection = data.approvedRevision !== null && data.status !== "archived" ? planRunSelection(data, maxBatchSizeOf(settings.data)) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-linear-border px-4 py-3 sm:px-6">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to plans" className={cn("rounded-sm p-1 text-linear-text-tertiary hover:text-linear-text", focusRing)}>
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-linear-text">{data.title}</h2>
        <span className="rounded-sm border border-linear-border px-1.5 py-0.5 text-[11px] capitalize text-linear-text-secondary">{data.status}</span>
        <label className="flex items-center gap-1.5 text-xs text-linear-text-secondary">
          Revision
          <select
            aria-label="Revision"
            value={view.number}
            onChange={(event) => setRevision(Number(event.target.value) === data.latestRevision ? undefined : Number(event.target.value))}
            className={cn("rounded-sm border border-linear-border bg-linear-bg px-1.5 py-0.5 text-xs text-linear-text", focusRing)}
          >
            {data.revisions.map((entry) => (
              <option key={entry.number} value={entry.number}>
                {entry.number}{entry.number === data.approvedRevision ? " (approved)" : entry.number === data.latestRevision ? " (latest)" : ""}
              </option>
            ))}
          </select>
        </label>
        {runSelection && runSelection.taskIds.length > 0 && (
          confirmRun ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-xs text-linear-text-secondary">
                Run {runSelection.taskIds.length} {runSelection.taskIds.length === 1 ? "issue" : "issues"}{runSelection.remaining > 0 ? ` (${runSelection.remaining} more next time)` : ""}?
              </span>
              <Button size="sm" disabled={run.isPending} onClick={() => run.mutate(runSelection.taskIds)}>
                {run.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
                Run
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRun(false)}>Cancel</Button>
            </span>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirmRun(true)} title="Run the plan's unfinished issues as one batch, blockers first">
              <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Run plan
            </Button>
          )
        )}
        {isLatest && data.status !== "archived" && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </Button>
        )}
        {isLatest && !editing && (
          <Button size="sm" disabled={!canApprove || approve.isPending} onClick={() => approve.mutate(view.number)}>
            {approve.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
            {approvedHere ? "Approved" : data.approvedRevision ? `Approve revision ${view.number}` : "Approve and create issues"}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
          {data.revision.spec.summary && <p className="whitespace-pre-wrap text-sm text-linear-text-secondary">{data.revision.spec.summary}</p>}
          {view.note && <p className="text-xs text-linear-text-tertiary">Revision note: {view.note}</p>}
          {!isLatest && <p className="text-xs text-linear-text-tertiary">An older revision; only the latest ({data.latestRevision}) can be approved.</p>}

          {view.errors.length > 0 && (
            <div role="alert" className="rounded-sm border border-danger/40 bg-danger/5 p-3">
              {view.errors.map((issue) => (
                <p key={issue.code + issue.message} className="flex items-start gap-1.5 text-xs text-danger"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{issue.message}</p>
              ))}
            </div>
          )}
          {view.warnings.length > 0 && (
            <div className="rounded-sm border border-warning/40 bg-warning/5 p-3">
              {view.warnings.map((issue) => (
                <p key={issue.code} className="flex items-start gap-1.5 text-xs text-warning"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{issue.message}</p>
              ))}
            </div>
          )}
          {view.diff && (
            <p className="flex items-center gap-1.5 text-xs text-linear-text-secondary">
              <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
              Against revision {view.number - 1}: {view.diff.added.length} added, {view.diff.changed.length} changed, {view.diff.removed.length} removed
              {view.diff.removed.length > 0 && <span className="text-linear-text-tertiary"> ({view.diff.removed.join(", ")} — their issues are kept)</span>}
            </p>
          )}

          {editing ? (
            <PlanEditor
              plan={data}
              onCancel={() => setEditing(false)}
              onSaved={(next) => {
                setEditing(false)
                setRevision(undefined)
                client.setQueryData(queryKeys.plans.detail(planId, null), next)
                void client.invalidateQueries({ queryKey: queryKeys.plans.all(next.projectId) })
              }}
            />
          ) : (
            <div aria-label="Plan tasks" role="list" className="space-y-3">
              {waves.map((wave, index) => (
                <section key={wave.map((task) => task.key).join(",")} role="listitem" aria-label={`Wave ${index + 1}`}>
                  <h3 className="mb-1 text-[11px] uppercase tracking-wider text-linear-text-tertiary">
                    Wave {index + 1}
                    <span className="ml-1.5 normal-case tracking-normal">
                      {index === 0 ? "· nothing to wait for" : "· after the waves above"}{wave.length > 1 ? ` · ${wave.length} can run in parallel` : ""}
                    </span>
                  </h3>
                  <ul className="rounded-sm border border-linear-border bg-linear-bg-secondary">
                    {wave.map((task) => <TaskRow key={task.key} task={task} plan={data} />)}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
