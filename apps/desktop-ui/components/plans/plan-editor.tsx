"use client"

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { CircleAlert, Loader2, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { focusRing } from "@/components/ui/focus-ring"
import { toastApiError } from "@/lib/api/errors"
import { createPlan, nextPlanTaskKey, planIssuesFromError, revisePlan, type PlanEstimate, type PlanIssue, type PlanRisk, type PlanTaskSpec, type PlanView } from "@/lib/api/plans"
import { createIdempotencyKey } from "@/lib/api/idempotency"
import { cn } from "@/lib/utils"

/**
 * FE-09: edit the latest revision and save it as the next one. Keys of
 * existing tasks stay fixed (they map to created issues); new tasks get a
 * fresh key. The server checks the result (unique keys, known blockers, no
 * loops) and refuses it with the problems listed here.
 */

interface DraftTask {
  key: string
  title: string
  description: string
  priority: "" | "low" | "medium" | "high"
  estimate: "" | PlanEstimate
  risk: "" | PlanRisk
  /** One check per line. */
  acceptance: string
  /** Comma-separated keys. */
  blockedBy: string
  isNew: boolean
}

const ESTIMATES: readonly PlanEstimate[] = ["xs", "s", "m", "l", "xl"]
const RISKS: readonly PlanRisk[] = ["low", "medium", "high"]

function toEstimate(value: string): DraftTask["estimate"] {
  return ESTIMATES.find((size) => size === value) ?? ""
}

function toRisk(value: string): DraftTask["risk"] {
  return RISKS.find((risk) => risk === value) ?? ""
}

function toDraft(task: PlanTaskSpec): DraftTask {
  return {
    key: task.key,
    title: task.title,
    description: task.description ?? "",
    priority: task.priority ?? "",
    estimate: task.estimate ?? "",
    risk: task.risk ?? "",
    acceptance: (task.acceptance ?? []).join("\n"),
    blockedBy: (task.blockedBy ?? []).join(", "),
    isNew: false,
  }
}

/** The spec a set of drafts stands for (empty fields dropped). */
export function draftsToSpec(summary: string, drafts: readonly DraftTask[]): PlanView["revision"]["spec"] {
  return {
    ...(summary.trim() ? { summary: summary.trim() } : {}),
    tasks: drafts.map((draft) => {
      const acceptance = draft.acceptance.split("\n").map((line) => line.trim()).filter(Boolean)
      const blockedBy = [...new Set(draft.blockedBy.split(",").map((key) => key.trim()).filter(Boolean))]
      return {
        key: draft.key.trim(),
        title: draft.title.trim(),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        ...(draft.priority ? { priority: draft.priority } : {}),
        ...(acceptance.length ? { acceptance } : {}),
        ...(draft.estimate ? { estimate: draft.estimate } : {}),
        ...(draft.risk ? { risk: draft.risk } : {}),
        ...(blockedBy.length ? { blockedBy } : {}),
      }
    }),
  }
}

const inputClass = cn("w-full rounded-sm border border-linear-border bg-linear-bg px-2 py-1 text-xs text-linear-text placeholder:text-linear-text-tertiary", focusRing)

export interface PlanFormInput {
  title: string
  spec: PlanView["revision"]["spec"]
  note?: string
}

/**
 * The plan form: summary, task rows, note (and a title when creating). The
 * parent saves it; a refusal with PLAN_INVALID shows its problems here.
 */
export function PlanForm({ initialTitle, initialSpec, askTitle = false, submitLabel, onSubmit, onCancel }: {
  initialTitle: string
  initialSpec: PlanView["revision"]["spec"]
  askTitle?: boolean
  submitLabel: string
  onSubmit: (input: PlanFormInput) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState(initialTitle)
  const [summary, setSummary] = useState(initialSpec.summary ?? "")
  const [drafts, setDrafts] = useState<DraftTask[]>(() => initialSpec.tasks.map(toDraft))
  const [note, setNote] = useState("")
  const [issues, setIssues] = useState<PlanIssue[]>([])

  const update = (index: number, patch: Partial<DraftTask>) => setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)))
  const remove = (index: number) => setDrafts((current) => current.filter((_, at) => at !== index))
  const add = () => setDrafts((current) => [...current, { key: nextPlanTaskKey(current.map((draft) => ({ key: draft.key, title: draft.title }))), title: "", description: "", priority: "", estimate: "", risk: "", acceptance: "", blockedBy: "", isNew: true }])

  const save = useMutation({
    mutationFn: () => onSubmit({ title: title.trim(), spec: draftsToSpec(summary, drafts), ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => setIssues([]),
    onError: (error) => {
      const found = planIssuesFromError(error)
      if (found.length > 0) setIssues(found)
      else toastApiError(error, { fallbackMessage: "Couldn't save the plan" })
    },
  })

  const incomplete = (askTitle && !title.trim()) || drafts.length === 0 || drafts.some((draft) => !draft.title.trim() || !draft.key.trim())

  return (
    <form
      className="space-y-4"
      aria-label={askTitle ? "New plan" : "Edit plan"}
      onSubmit={(event) => {
        event.preventDefault()
        if (!incomplete) save.mutate()
      }}
    >
      {askTitle && (
        <label className="block text-xs text-linear-text-secondary">
          Plan title
          <input value={title} onChange={(event) => setTitle(event.target.value)} className={cn(inputClass, "mt-1 text-sm")} />
        </label>
      )}
      <label className="block text-xs text-linear-text-secondary">
        Summary
        <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={2} className={cn(inputClass, "mt-1")} />
      </label>

      {issues.length > 0 && (
        <div role="alert" className="rounded-sm border border-danger/40 bg-danger/5 p-3">
          {issues.map((issue) => (
            <p key={issue.code + issue.message} className="flex items-start gap-1.5 text-xs text-danger"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{issue.message}</p>
          ))}
        </div>
      )}

      <ul className="space-y-3">
        {drafts.map((draft, index) => (
          <li key={`${draft.isNew ? "new" : "old"}:${index}:${draft.isNew ? "" : draft.key}`} className="space-y-2 rounded-sm border border-linear-border bg-linear-bg-secondary p-3" aria-label={`Task ${draft.key || index + 1}`}>
            <div className="flex items-center gap-2">
              {draft.isNew ? (
                <input aria-label="Key" value={draft.key} onChange={(event) => update(index, { key: event.target.value })} className={cn(inputClass, "w-28 font-mono")} />
              ) : (
                <span className="w-28 shrink-0 font-mono text-[11px] text-linear-text-tertiary" title="Keys of existing tasks stay fixed">{draft.key}</span>
              )}
              <input aria-label="Title" placeholder="Title" value={draft.title} onChange={(event) => update(index, { title: event.target.value })} className={inputClass} />
              <select aria-label="Estimate" value={draft.estimate} onChange={(event) => update(index, { estimate: toEstimate(event.target.value) })} className={cn(inputClass, "w-20")}>
                <option value="">—</option>
                {ESTIMATES.map((size) => <option key={size} value={size}>{size.toUpperCase()}</option>)}
              </select>
              <select aria-label="Risk" value={draft.risk} onChange={(event) => update(index, { risk: toRisk(event.target.value) })} className={cn(inputClass, "w-24")}>
                <option value="">risk —</option>
                {RISKS.map((risk) => <option key={risk} value={risk}>{risk}</option>)}
              </select>
              <button type="button" onClick={() => remove(index)} aria-label={`Remove ${draft.key || "task"}`} className={cn("shrink-0 rounded-sm p-1 text-linear-text-tertiary hover:text-danger", focusRing)}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <textarea aria-label="Acceptance checks" placeholder="Acceptance checks, one per line" value={draft.acceptance} onChange={(event) => update(index, { acceptance: event.target.value })} rows={2} className={inputClass} />
            <input aria-label="Blocked by" placeholder="Blocked by (keys, comma-separated)" value={draft.blockedBy} onChange={(event) => update(index, { blockedBy: event.target.value })} className={cn(inputClass, "font-mono")} />
          </li>
        ))}
      </ul>

      <Button type="button" size="sm" variant="outline" onClick={add}>
        <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Add task
      </Button>

      <div className="flex flex-wrap items-center gap-2 border-t border-linear-border pt-3">
        <input aria-label="Revision note" placeholder="What changed and why (optional)" value={note} onChange={(event) => setNote(event.target.value)} className={cn(inputClass, "min-w-[12rem] flex-1")} />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={incomplete || save.isPending}>
          {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

/** Edit the latest revision and save it as the next one. */
export function PlanEditor({ plan, onSaved, onCancel }: { plan: PlanView; onSaved: (next: PlanView) => void; onCancel: () => void }) {
  return (
    <PlanForm
      initialTitle={plan.title}
      initialSpec={plan.revision.spec}
      submitLabel={`Save as revision ${plan.latestRevision + 1}`}
      onCancel={onCancel}
      onSubmit={async ({ spec, note }) => {
        const result = await revisePlan(plan.id, { baseRevision: plan.revision.number, spec, ...(note ? { note } : {}) })
        toast.success(result.unchanged ? "Nothing changed" : `Saved revision ${result.plan.revision.number}`, result.unchanged ? { description: "The plan is the same as the latest revision." } : { description: "Review it, then approve to apply the changes." })
        onSaved(result.plan)
      }}
    />
  )
}

/** Start a plan by hand (agents and Home Chat propose them too). Nothing is created until it is approved. */
export function NewPlanForm({ projectId, onCreated, onCancel }: { projectId: string; onCreated: (plan: PlanView) => void; onCancel: () => void }) {
  // One key per form: a retried create returns the same plan.
  const [key] = useState(() => createIdempotencyKey())
  return (
    <PlanForm
      askTitle
      initialTitle=""
      initialSpec={{ tasks: [{ key: "task-1", title: "" }] }}
      submitLabel="Create draft plan"
      onCancel={onCancel}
      onSubmit={async ({ title, spec, note }) => {
        const plan = await createPlan(projectId, { title, spec, ...(note ? { note } : {}) }, key)
        toast.success("Draft plan created", { description: "Review it and approve to create the issues." })
        onCreated(plan)
      }}
    />
  )
}
