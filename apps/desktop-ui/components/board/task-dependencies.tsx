"use client"

import { useDeferredValue, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Ban, Check, Link2, Loader2, Play, Plus, X } from "lucide-react"
import { focusRing } from "@/components/ui/focus-ring"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { STATUS_COLORS } from "@/lib/design-tokens"
import { describeApiError, toastApiError } from "@/lib/api/errors"
import {
  addTaskBlocker,
  dependencyLabel,
  fetchTaskDependencies,
  removeTaskBlocker,
  searchBlockerCandidates,
  type DependencyTaskRef,
  type TaskDependencies,
} from "@/lib/api/task-dependencies"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import type { Task } from "@/types/task"
import { cn } from "@/lib/utils"

/**
 * W17a: "Blocked by" / "Blocking" for one task. A blocker stops blocking once
 * it is done (cancelled still blocks: a failed run also ends as cancelled).
 * Runs of a blocked task are refused unless started anyway; batches run
 * blockers first.
 */

/** Patch the task's board/list rows so the "Blocked" chip follows at once. */
function patchListRows(client: ReturnType<typeof useAppQueryClient>, taskId: string, deps: TaskDependencies): void {
  const blockedByIds = deps.blockedBy.map((ref) => ref.id)
  const openBlockerCount = deps.blockedBy.filter((ref) => !ref.resolved).length
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.tasks.lists() })) {
    const data = query.state.data
    const list: Task[] | undefined = Array.isArray(data) ? data : undefined
    if (!list?.some((task) => task.id === taskId)) continue
    client.setQueryData(query.queryKey, list.map((task) => (task.id === taskId ? { ...task, blockedByIds, openBlockerCount } : task)))
  }
}

function StatusDot({ status }: { status: Task["status"] }) {
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_COLORS[status].dot)} aria-hidden="true" />
}

function DependencyRow({ item, onRemove, removing }: { item: DependencyTaskRef; onRemove?: () => void; removing?: boolean }) {
  const label = dependencyLabel(item)
  return (
    <li className="group flex items-center gap-2 py-1">
      <StatusDot status={item.status} />
      {item.identifier && <span className="shrink-0 font-mono text-[11px] text-linear-text-tertiary">{item.identifier}</span>}
      <span className={cn("min-w-0 flex-1 truncate text-xs", item.resolved ? "text-linear-text-tertiary line-through" : "text-linear-text")} title={item.title}>
        {item.title}
      </span>
      {item.resolved
        ? <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Done" />
        : item.status === "cancelled" && <span className="shrink-0 text-[10px] text-linear-text-tertiary" title="Cancelled tasks still block: a failed run also ends as cancelled. Remove the dependency if it no longer applies.">cancelled</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          aria-label={`Remove blocker ${label}`}
          className={cn("shrink-0 rounded-sm p-0.5 text-linear-text-tertiary opacity-0 hover:text-linear-text group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50", focusRing)}
        >
          {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
        </button>
      )}
    </li>
  )
}

export function TaskDependenciesSection({ taskId, projectId, onRunWithBlockers }: {
  taskId: string
  projectId: string | null
  /** FE-10: start this task with its unfinished blockers (shown while any are open). */
  onRunWithBlockers?: () => void
}) {
  const client = useAppQueryClient()
  const key = queryKeys.tasks.dependencies(taskId)
  const deps = useQuery({ queryKey: key, queryFn: () => fetchTaskDependencies(taskId) }, client)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const deferredSearch = useDeferredValue(search)
  const blockerIds = deps.data?.blockedBy.map((ref) => ref.id) ?? []
  const candidates = useQuery({
    queryKey: [...key, "candidates", deferredSearch],
    queryFn: () => searchBlockerCandidates({ projectId: projectId ?? "", taskId, query: deferredSearch, exclude: blockerIds }),
    enabled: open && projectId !== null,
    staleTime: 10_000,
  }, client)

  const settle = (next: TaskDependencies) => {
    client.setQueryData(key, { blockedBy: next.blockedBy, blocking: next.blocking })
    patchListRows(client, taskId, next)
    void client.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId), exact: true })
  }

  const add = useMutation({
    mutationFn: (dependsOnTaskId: string) => addTaskBlocker(taskId, dependsOnTaskId),
    onSuccess: (next, dependsOnTaskId) => {
      settle(next)
      void client.invalidateQueries({ queryKey: queryKeys.tasks.dependencies(dependsOnTaskId), exact: true })
      setOpen(false)
      setSearch("")
    },
    onError: (error) => { toastApiError(error, { fallbackMessage: "Couldn't add the blocker" }) },
  }, client)

  const remove = useMutation({
    mutationFn: (dependsOnTaskId: string) => removeTaskBlocker(taskId, dependsOnTaskId),
    onSuccess: async (_result, dependsOnTaskId) => {
      const current = client.getQueryData<TaskDependencies>(key)
      if (current) settle({ ...current, blockedBy: current.blockedBy.filter((ref) => ref.id !== dependsOnTaskId) })
      void client.invalidateQueries({ queryKey: queryKeys.tasks.dependencies(dependsOnTaskId), exact: true })
    },
    onError: (error) => { toastApiError(error, { fallbackMessage: "Couldn't remove the blocker" }) },
  }, client)

  const blockedBy = deps.data?.blockedBy ?? []
  const blocking = deps.data?.blocking ?? []
  const openCount = blockedBy.filter((ref) => !ref.resolved).length

  return (
    <section aria-labelledby={`deps-${taskId}`}>
      <div className="mb-2 flex items-center justify-between">
        <h3 id={`deps-${taskId}`} className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-linear-text-tertiary">
          <Link2 className="h-3 w-3" aria-hidden="true" />
          Dependencies
        </h3>
        {projectId && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button" aria-label="Add a blocker" className={cn("rounded-sm p-0.5 text-linear-text-tertiary hover:text-linear-text", focusRing)}>
                <Plus className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 border-linear-border bg-linear-bg-secondary p-0" align="end">
              <Command shouldFilter={false} className="bg-transparent">
                <CommandInput
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Blocked by…"
                  className="h-8 text-xs text-linear-text placeholder:text-linear-text-tertiary"
                />
                <CommandList>
                  {candidates.isFetching && !candidates.data ? (
                    <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-linear-text-tertiary" aria-label="Searching" /></div>
                  ) : candidates.isError ? (
                    <p role="alert" className="px-3 py-4 text-center text-xs text-linear-text-tertiary">{describeApiError(candidates.error, "Couldn't search tasks.").message}</p>
                  ) : (
                    <CommandEmpty className="py-4 text-center text-xs text-linear-text-tertiary">No tasks found.</CommandEmpty>
                  )}
                  <CommandGroup>
                    {(candidates.data ?? []).map((candidate) => (
                      <CommandItem
                        key={candidate.id}
                        value={candidate.id}
                        onSelect={() => add.mutate(candidate.id)}
                        disabled={add.isPending}
                        className="cursor-pointer gap-2 text-xs text-linear-text data-[selected=true]:bg-linear-bg-tertiary"
                      >
                        <StatusDot status={candidate.status} />
                        {candidate.identifier && <span className="shrink-0 font-mono text-[11px] text-linear-text-tertiary">{candidate.identifier}</span>}
                        <span className="truncate">{candidate.title}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {deps.isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-linear-text-tertiary" aria-label="Loading dependencies" />
      ) : deps.isError ? (
        <p role="alert" className="text-xs text-linear-text-tertiary">{describeApiError(deps.error, "Couldn't load dependencies.").message}</p>
      ) : blockedBy.length === 0 && blocking.length === 0 ? (
        <p className="text-xs text-linear-text-tertiary">{projectId ? "Not blocked by anything." : "Only tasks in a project can have blockers."}</p>
      ) : (
        <div className="space-y-3">
          {blockedBy.length > 0 && (
            <div>
              <p className={cn("mb-1 flex items-center gap-1 text-xs", openCount > 0 ? "text-warning" : "text-linear-text-secondary")}>
                {openCount > 0 && <Ban className="h-3 w-3" aria-hidden="true" />}
                {openCount > 0 ? `Blocked by ${openCount} unfinished ${openCount === 1 ? "task" : "tasks"}` : "Blocked by (all done)"}
              </p>
              <ul>
                {blockedBy.map((item) => (
                  <DependencyRow key={item.id} item={item} onRemove={() => remove.mutate(item.id)} removing={remove.isPending && remove.variables === item.id} />
                ))}
              </ul>
              {openCount > 0 && onRunWithBlockers && (
                <button
                  type="button"
                  onClick={onRunWithBlockers}
                  title="Run the unfinished blockers first, then this task, in one batch"
                  className={cn("mt-2 inline-flex items-center gap-1.5 rounded-sm border border-linear-border px-2 py-1 text-xs text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text", focusRing)}
                >
                  <Play className="h-3 w-3" aria-hidden="true" />
                  Run with blockers
                </button>
              )}
            </div>
          )}
          {blocking.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-linear-text-secondary">Blocking</p>
              <ul>{blocking.map((item) => <DependencyRow key={item.id} item={item} />)}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
