"use client"

import { Suspense } from "react"
import { useQuery } from "@tanstack/react-query"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { ClipboardList, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NewPlanForm } from "@/components/plans/plan-editor"
import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { PlanReview } from "@/components/plans/plan-review"
import { describeApiError } from "@/lib/api/errors"
import { fetchProjectPlans, type PlanSummary } from "@/lib/api/plans"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * FE-09: a project's plans. Plans are proposed by agents (MCP
 * `openlinear_propose_plan`) or people, reviewed here revision by revision,
 * and approved to create their issues.
 */

function PlanRow({ plan, onOpen }: { plan: PlanSummary; onOpen: () => void }) {
  const progress = plan.createdTaskCount > 0 ? Math.round((plan.doneTaskCount / plan.createdTaskCount) * 100) : 0
  const pending = plan.approvedRevision !== null && plan.latestRevision > plan.approvedRevision
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-linear-bg-tertiary">
        <ClipboardList className="h-4 w-4 shrink-0 text-linear-text-tertiary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm text-linear-text">{plan.title}</span>
        {pending && <span className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">revision {plan.latestRevision} to review</span>}
        <span className={cn("rounded-sm border border-linear-border px-1.5 py-0.5 text-[11px] capitalize", plan.status === "draft" ? "text-linear-text" : "text-linear-text-secondary")}>{plan.status}</span>
        <span className="w-28 shrink-0 text-right text-[11px] text-linear-text-tertiary">
          {plan.createdTaskCount > 0 ? `${plan.doneTaskCount}/${plan.createdTaskCount} done (${progress}%)` : `${plan.taskCount} tasks proposed`}
        </span>
      </button>
    </li>
  )
}

function ProjectPlansContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const projectId = searchParams.get("id")
  const projectName = searchParams.get("name") || "Project"
  const planId = searchParams.get("plan")
  const client = useAppQueryClient()
  const [creating, setCreating] = useState(false)
  const plans = useQuery({
    queryKey: queryKeys.plans.list(projectId ?? ""),
    queryFn: () => fetchProjectPlans(projectId ?? ""),
    enabled: projectId !== null,
  }, client)

  const open = (id: string | null) => {
    const next = new URLSearchParams(searchParams.toString())
    if (id) next.set("plan", id)
    else next.delete("plan")
    router.push(`${pathname}?${next.toString()}`)
  }

  if (!projectId) {
    return <EmptyState icon={ClipboardList} title="No project selected" description="Select a project from the sidebar" />
  }
  if (planId) {
    return (
      <div className="flex-1 min-h-0 bg-linear-bg">
        <PlanReview
          planId={planId}
          onBack={() => open(null)}
          onRunStarted={(id) => router.push(`/projects/board?id=${encodeURIComponent(id)}&name=${encodeURIComponent(projectName)}`)}
        />
      </div>
    )
  }

  return (
    <>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-3" data-tauri-drag-region>
        <ClipboardList className="w-5 h-5 text-linear-text-secondary flex-shrink-0" />
        <h1 className="text-lg font-semibold truncate">{projectName} · Plans</h1>
        <div className="flex-1 h-full" data-tauri-drag-region />
        {!creating && (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            New plan
          </Button>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto bg-linear-bg">
        {creating ? (
          <div className="mx-auto max-w-3xl p-4 sm:p-6">
            <NewPlanForm
              projectId={projectId}
              onCancel={() => setCreating(false)}
              onCreated={(plan) => {
                setCreating(false)
                void client.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) })
                open(plan.id)
              }}
            />
          </div>
        ) : plans.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full rounded" />)}</div>
        ) : plans.isError ? (
          <p role="alert" className="p-6 text-sm text-linear-text-secondary">{describeApiError(plans.error, "Couldn't load the plans.").message}</p>
        ) : (plans.data ?? []).length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No plans yet"
            description="Start one with New plan, or ask Home Chat or an agent to propose one. You review it here; approving it creates the issues."
          />
        ) : (
          <ul className="divide-y divide-linear-border/50">
            {(plans.data ?? []).map((plan) => <PlanRow key={plan.id} plan={plan} onOpen={() => open(plan.id)} />)}
          </ul>
        )}
      </div>
    </>
  )
}

export default function ProjectPlansPage() {
  return (
    <Suspense fallback={<div className="flex-1 bg-linear-bg" />}>
      <ProjectPlansContent />
    </Suspense>
  )
}
