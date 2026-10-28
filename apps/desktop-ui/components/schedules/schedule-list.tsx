"use client"

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { Loader2, Pause, Pencil, Play, Repeat, Trash2, Zap } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { focusRing } from "@/components/ui/focus-ring"
import { toastApiError } from "@/lib/api/errors"
import {
  deleteSchedule,
  describeCadence,
  formatLocalDateTime,
  nextRunText,
  pauseReasonText,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  scheduleKeys,
  type Schedule,
} from "@/lib/api/schedules"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * FE-14: a project's recurring issues — cadence in words, next run in the
 * device's local time, and Run now / Pause / Resume / Edit / Delete.
 */

const actionClass = cn("inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text disabled:opacity-50", focusRing)

function ScheduleRow({ schedule, onEdit, onDelete }: { schedule: Schedule; onEdit: () => void; onDelete: () => void }) {
  const client = useAppQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: scheduleKeys.list(schedule.projectId) })
  const toggle = useMutation({
    mutationFn: () => (schedule.pausedAt ? resumeSchedule(schedule.id) : pauseSchedule(schedule.id)),
    onSuccess: (next) => {
      void refresh()
      toast.success(next.pausedAt ? "Schedule paused" : "Schedule resumed", next.pausedAt ? undefined : { description: `${nextRunText(next)} — issues will be created as you.` })
    },
    onError: (error) => toastApiError(error, { fallbackMessage: schedule.pausedAt ? "Couldn't resume the schedule" : "Couldn't pause the schedule" }),
  })
  const runNow = useMutation({
    mutationFn: () => runScheduleNow(schedule.id),
    onSuccess: (result) => {
      void refresh()
      const name = result.occurrence.task?.identifier ?? result.occurrence.task?.title ?? "the issue"
      toast.success(result.created ? `Created ${name}` : `Already created ${name} this minute`)
    },
    onError: (error) => toastApiError(error, { fallbackMessage: "Couldn't create the issue" }),
  })
  const reason = pauseReasonText(schedule.pauseReason)

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3" aria-label={`Schedule ${schedule.title}`}>
      <Repeat className="h-4 w-4 shrink-0 text-linear-text-tertiary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-linear-text">{schedule.title}</p>
        <p className="text-[11px] text-linear-text-tertiary">
          {describeCadence(schedule)}
          {schedule.lastRunAt ? ` · last issue ${formatLocalDateTime(schedule.lastRunAt)}` : ""}
        </p>
        {reason && <p className="mt-0.5 text-[11px] text-warning">{reason}</p>}
      </div>
      <span className={cn("rounded-sm border border-linear-border px-1.5 py-0.5 text-[11px]", schedule.pausedAt ? "text-warning" : "text-linear-text-secondary")}>
        {nextRunText(schedule)}
      </span>
      <div className="flex items-center gap-0.5">
        <button type="button" className={actionClass} onClick={() => runNow.mutate()} disabled={runNow.isPending} aria-label={`Create an issue from ${schedule.title} now`}>
          {runNow.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}
          Run now
        </button>
        <button type="button" className={actionClass} onClick={() => toggle.mutate()} disabled={toggle.isPending} aria-label={`${schedule.pausedAt ? "Resume" : "Pause"} ${schedule.title}`}>
          {schedule.pausedAt ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
          {schedule.pausedAt ? "Resume" : "Pause"}
        </button>
        <button type="button" className={actionClass} onClick={onEdit} aria-label={`Edit ${schedule.title}`}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" className={cn(actionClass, "hover:text-danger")} onClick={onDelete} aria-label={`Delete ${schedule.title}`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}

export function ScheduleList({ schedules, onEdit }: { schedules: readonly Schedule[]; onEdit: (schedule: Schedule) => void }) {
  const client = useAppQueryClient()
  const [toDelete, setToDelete] = useState<Schedule | null>(null)
  const remove = useMutation({
    mutationFn: (schedule: Schedule) => deleteSchedule(schedule.id),
    onSuccess: (_result, schedule) => {
      void client.invalidateQueries({ queryKey: scheduleKeys.list(schedule.projectId) })
      toast.success("Schedule deleted", { description: "Issues it already created are kept." })
    },
    onError: (error) => toastApiError(error, { fallbackMessage: "Couldn't delete the schedule" }),
    onSettled: () => setToDelete(null),
  })

  return (
    <>
      <ul className="divide-y divide-linear-border/50">
        {schedules.map((schedule) => (
          <ScheduleRow key={schedule.id} schedule={schedule} onEdit={() => onEdit(schedule)} onDelete={() => setToDelete(schedule)} />
        ))}
      </ul>
      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent className="bg-linear-bg-secondary border-linear-border text-linear-text">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
            <AlertDialogDescription className="text-linear-text-secondary">
              {toDelete ? `"${toDelete.title}" stops creating issues. Issues it already created are kept.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (toDelete) remove.mutate(toDelete) }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive-hover"
            >
              Delete schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
