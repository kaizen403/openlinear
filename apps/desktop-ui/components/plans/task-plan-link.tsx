"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ClipboardList } from "lucide-react"
import { taskDetailQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

/** W17b: "Plan: Login · api" in the task sidebar, linking to the plan review. Nothing when the task isn't from a plan. */
export function TaskPlanLink({ taskId, projectId }: { taskId: string; projectId: string | null }) {
  const client = useAppQueryClient()
  const detail = useQuery(taskDetailQuery(taskId), client)
  const plan = detail.data?.plan
  if (!plan || !projectId) return null
  return (
    <div className="flex items-center justify-between gap-2 py-2 border-b border-linear-border">
      <span className="text-sm text-linear-text-secondary">Plan</span>
      <Link
        href={`/projects/plans?id=${encodeURIComponent(projectId)}&plan=${encodeURIComponent(plan.id)}`}
        className="flex min-w-0 items-center gap-1.5 text-sm text-linear-accent hover:underline"
        title={`From the plan "${plan.title}" (task key ${plan.key})`}
      >
        <ClipboardList className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{plan.title}</span>
        <span className="shrink-0 font-mono text-[11px] text-linear-text-tertiary">{plan.key}</span>
      </Link>
    </div>
  )
}
