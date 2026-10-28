"use client"

import { useMemo, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { focusRing } from "@/components/ui/focus-ring"
import { fetchTeamMembers } from "@/lib/api/comments"
import { toastApiError } from "@/lib/api/errors"
import { IdempotencyIntent } from "@/lib/api/idempotency"
import {
  createSchedule,
  describeCadence,
  localTimeZone,
  scheduleKeys,
  timeZoneOptions,
  updateSchedule,
  WEEKDAYS,
  type Schedule,
  type ScheduleCadence,
  type ScheduleInput,
  type SchedulePriority,
} from "@/lib/api/schedules"
import { fetchTeams } from "@/lib/api/teams"
import { projectLabelsQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * FE-14: create or edit a recurring issue — the issue it creates (title,
 * description, priority, labels, assignee) and when (cadence, local time,
 * time zone). Saving makes the caller the schedule's owner on the server.
 */

export interface ScheduleDraft {
  title: string
  description: string
  priority: SchedulePriority
  labelIds: string[]
  assigneeId: string
  cadence: ScheduleCadence
  weekday: number
  dayOfMonth: number
  /** "HH:MM" (an `<input type="time">` value). */
  time: string
  timezone: string
}

const CADENCES: ReadonlyArray<{ value: ScheduleCadence; label: string }> = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday (Mon–Fri)" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
]
const PRIORITIES: readonly SchedulePriority[] = ["low", "medium", "high"]
const DAYS = Array.from({ length: 28 }, (_, index) => index + 1)

function two(value: number): string {
  return String(value).padStart(2, "0")
}

export function emptyDraft(timezone = localTimeZone()): ScheduleDraft {
  return { title: "", description: "", priority: "medium", labelIds: [], assigneeId: "", cadence: "weekly", weekday: 1, dayOfMonth: 1, time: "09:00", timezone }
}

export function draftFromSchedule(schedule: Schedule): ScheduleDraft {
  return {
    title: schedule.title,
    description: schedule.description ?? "",
    priority: schedule.priority,
    labelIds: schedule.labelIds,
    assigneeId: schedule.assigneeId ?? "",
    cadence: schedule.cadence,
    weekday: schedule.weekday ?? 1,
    dayOfMonth: schedule.dayOfMonth ?? 1,
    time: `${two(schedule.hour)}:${two(schedule.minute)}`,
    timezone: schedule.timezone,
  }
}

/** The request body for a draft, or null while it is incomplete (no title, no valid time). */
export function draftToInput(draft: ScheduleDraft): ScheduleInput | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(draft.time.trim())
  const hour = match ? Number(match[1]) : Number.NaN
  const minute = match ? Number(match[2]) : Number.NaN
  const title = draft.title.trim()
  if (!title || title.length > 200 || !(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null
  return {
    title,
    description: draft.description.trim() ? draft.description.trim() : null,
    priority: draft.priority,
    labelIds: draft.labelIds,
    assigneeId: draft.assigneeId || null,
    cadence: draft.cadence,
    ...(draft.cadence === "weekly" ? { weekday: draft.weekday } : {}),
    ...(draft.cadence === "monthly" ? { dayOfMonth: draft.dayOfMonth } : {}),
    hour,
    minute,
    timezone: draft.timezone,
  }
}

/** The project's team members (assignee choices). */
async function fetchScheduleAssignees(projectId: string): Promise<Array<{ id: string; name: string }>> {
  const [team] = await fetchTeams({ projectId, fields: ["id", "name"] })
  if (!team) return []
  const members = await fetchTeamMembers(team.id)
  return members.map((member) => ({ id: member.userId, name: member.user?.username ?? member.userId }))
}

const inputClass = cn("w-full rounded-sm border border-linear-border bg-linear-bg px-2 py-1 text-xs text-linear-text placeholder:text-linear-text-tertiary", focusRing)
const fieldClass = "block text-xs text-linear-text-secondary"

export function ScheduleForm({ projectId, schedule, onSaved, onCancel }: {
  projectId: string
  /** Edit this schedule; omitted: create a new one. */
  schedule?: Schedule
  onSaved: (schedule: Schedule) => void
  onCancel: () => void
}) {
  const client = useAppQueryClient()
  const [draft, setDraft] = useState<ScheduleDraft>(() => (schedule ? draftFromSchedule(schedule) : emptyDraft()))
  // One key per pending create; a changed form gets a new one (a reused key with another body is a 409).
  const intent = useRef(new IdempotencyIntent())
  const labels = useQuery({ ...projectLabelsQuery(projectId), retry: false }, client)
  const assignees = useQuery({ queryKey: scheduleKeys.assignees(projectId), queryFn: () => fetchScheduleAssignees(projectId), retry: false, staleTime: 60_000 }, client)
  const zones = useMemo(() => timeZoneOptions(draft.timezone), [draft.timezone])
  const set = (patch: Partial<ScheduleDraft>) => setDraft((current) => ({ ...current, ...patch }))

  // Labels deleted since (and an assignee who left the team) are not offered, so not sent.
  const knownLabelIds = labels.data ? new Set(labels.data.map((label) => label.id)) : null
  const assigneeGone = assignees.data !== undefined && draft.assigneeId !== "" && !assignees.data.some((member) => member.id === draft.assigneeId)
  const effective: ScheduleDraft = {
    ...draft,
    labelIds: knownLabelIds ? draft.labelIds.filter((id) => knownLabelIds.has(id)) : draft.labelIds,
    assigneeId: assigneeGone ? "" : draft.assigneeId,
  }
  const input = draftToInput(effective)

  const save = useMutation({
    mutationFn: async (body: ScheduleInput) => {
      if (schedule) return updateSchedule(schedule.id, body)
      return createSchedule(projectId, body, intent.current.keyFor(JSON.stringify(body)))
    },
    onSuccess: (saved) => {
      intent.current.complete()
      void client.invalidateQueries({ queryKey: scheduleKeys.list(projectId) })
      toast.success(schedule ? "Schedule saved" : "Schedule created", { description: describeCadence(saved) })
      onSaved(saved)
    },
    onError: (error) => toastApiError(error, { fallbackMessage: "Couldn't save the schedule" }),
  })

  return (
    <form
      className="space-y-4"
      aria-label={schedule ? "Edit schedule" : "New schedule"}
      onSubmit={(event) => {
        event.preventDefault()
        if (input) save.mutate(input)
      }}
    >
      <label className={fieldClass}>
        Issue title
        <input value={draft.title} maxLength={200} onChange={(event) => set({ title: event.target.value })} placeholder="Weekly dependency updates" className={cn(inputClass, "mt-1 text-sm")} />
        <span className="mt-1 block text-[11px] text-linear-text-tertiary">{"{date}"} becomes each issue's date.</span>
      </label>
      <label className={fieldClass}>
        Description
        <textarea value={draft.description} rows={3} onChange={(event) => set({ description: event.target.value })} className={cn(inputClass, "mt-1")} />
      </label>

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="sr-only">When</legend>
        <label className={fieldClass}>
          Repeats
          <select value={draft.cadence} onChange={(event) => set({ cadence: CADENCES.find((option) => option.value === event.target.value)?.value ?? "weekly" })} className={cn(inputClass, "mt-1")}>
            {CADENCES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {draft.cadence === "weekly" && (
          <label className={fieldClass}>
            On
            <select value={draft.weekday} onChange={(event) => set({ weekday: Number(event.target.value) })} className={cn(inputClass, "mt-1")}>
              {WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}
            </select>
          </label>
        )}
        {draft.cadence === "monthly" && (
          <label className={fieldClass}>
            Day of the month
            <select value={draft.dayOfMonth} onChange={(event) => set({ dayOfMonth: Number(event.target.value) })} className={cn(inputClass, "mt-1")}>
              {DAYS.map((day) => <option key={day} value={day}>{day}</option>)}
            </select>
          </label>
        )}
        <label className={fieldClass}>
          At
          <input type="time" value={draft.time} onChange={(event) => set({ time: event.target.value })} className={cn(inputClass, "mt-1")} />
        </label>
        <label className={fieldClass}>
          Time zone
          <select value={draft.timezone} onChange={(event) => set({ timezone: event.target.value })} className={cn(inputClass, "mt-1")}>
            {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </label>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={fieldClass}>
          Priority
          <select value={draft.priority} onChange={(event) => set({ priority: PRIORITIES.find((priority) => priority === event.target.value) ?? "medium" })} className={cn(inputClass, "mt-1 capitalize")}>
            {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
        </label>
        <label className={fieldClass}>
          Assignee
          <select value={effective.assigneeId} onChange={(event) => set({ assigneeId: event.target.value })} className={cn(inputClass, "mt-1")}>
            <option value="">Unassigned</option>
            {(assignees.data ?? []).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </label>
      </div>

      {(labels.data ?? []).length > 0 && (
        <fieldset>
          <legend className="text-xs text-linear-text-secondary">Labels</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {(labels.data ?? []).map((label) => {
              const checked = effective.labelIds.includes(label.id)
              return (
                <label key={label.id} className="flex items-center gap-1.5 rounded-sm border border-linear-border px-2 py-0.5 text-xs text-linear-text">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => set({ labelIds: checked ? effective.labelIds.filter((id) => id !== label.id) : [...effective.labelIds, label.id] })}
                  />
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} aria-hidden="true" />
                  {label.name}
                </label>
              )
            })}
          </div>
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-linear-border pt-3">
        <p className="flex-1 text-[11px] text-linear-text-tertiary">
          {input ? `${describeCadence({ ...input, weekday: input.weekday ?? null, dayOfMonth: input.dayOfMonth ?? null })}. Creates an issue only; nothing runs it.` : "Add a title and a time."}
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!input || save.isPending}>
          {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {schedule ? "Save changes" : "Create schedule"}
        </Button>
      </div>
    </form>
  )
}
