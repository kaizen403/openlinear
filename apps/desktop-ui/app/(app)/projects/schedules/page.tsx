"use client"

import { Suspense, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "next/navigation"
import { Plus, Repeat } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { ScheduleForm } from "@/components/schedules/schedule-form"
import { ScheduleList } from "@/components/schedules/schedule-list"
import { describeApiError } from "@/lib/api/errors"
import { fetchProjectSchedules, scheduleKeys, type Schedule } from "@/lib/api/schedules"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

/**
 * FE-14: a project's recurring issues (W20 schedules). Each schedule creates
 * one issue from its template at every slot; running issues stays a person's
 * decision on the board.
 */

type Editing = { kind: "new" } | { kind: "edit"; schedule: Schedule } | null

function ProjectSchedulesContent() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get("id")
  const projectName = searchParams.get("name") || "Project"
  const client = useAppQueryClient()
  const [editing, setEditing] = useState<Editing>(null)
  const schedules = useQuery({
    queryKey: scheduleKeys.list(projectId ?? ""),
    queryFn: () => fetchProjectSchedules(projectId ?? ""),
    enabled: projectId !== null,
  }, client)

  if (!projectId) {
    return <EmptyState icon={Repeat} title="No project selected" description="Select a project from the sidebar" />
  }
  const items = schedules.data?.items ?? []
  const active = items.filter((schedule) => !schedule.pausedAt).length

  return (
    <>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-3" data-tauri-drag-region>
        <Repeat className="w-5 h-5 text-linear-text-secondary flex-shrink-0" />
        <h1 className="text-lg font-semibold truncate">{projectName} · Recurring issues</h1>
        <div className="flex-1 h-full" data-tauri-drag-region />
        {schedules.data && (
          <span className="text-[11px] text-linear-text-tertiary">{active} of {schedules.data.limits.active} active</span>
        )}
        {editing === null && (
          <Button size="sm" variant="outline" onClick={() => setEditing({ kind: "new" })}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            New schedule
          </Button>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto bg-linear-bg">
        {editing !== null ? (
          <div className="mx-auto max-w-2xl p-4 sm:p-6">
            <ScheduleForm
              projectId={projectId}
              schedule={editing.kind === "edit" ? editing.schedule : undefined}
              onCancel={() => setEditing(null)}
              onSaved={() => setEditing(null)}
            />
          </div>
        ) : schedules.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full rounded" />)}</div>
        ) : schedules.isError ? (
          <p role="alert" className="p-6 text-sm text-linear-text-secondary">{describeApiError(schedules.error, "Couldn't load the schedules.").message}</p>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title="No recurring issues yet"
            description="New schedule creates an issue every day, weekday, week or month at the time you pick. It only creates issues; you decide when to run them."
          />
        ) : (
          <ScheduleList schedules={items} onEdit={(schedule) => setEditing({ kind: "edit", schedule })} />
        )}
      </div>
    </>
  )
}

export default function ProjectSchedulesPage() {
  return (
    <Suspense fallback={<div className="flex-1 bg-linear-bg" />}>
      <ProjectSchedulesContent />
    </Suspense>
  )
}
