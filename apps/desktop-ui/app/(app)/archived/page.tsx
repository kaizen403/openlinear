"use client"

import { useState, useEffect } from "react"
import {
  Archive,
  Trash2,
  AlertTriangle,
  Flag,
  Loader2,
  Check,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useArchivedTasks } from "@/hooks/use-archived-tasks"
import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"

const PRIORITY_TABS = ["all", "high", "medium", "low"] as const
type PriorityTab = (typeof PRIORITY_TABS)[number]

const priorityConfig: Record<string, { label: string; color: string; icon: typeof Flag }> = {
  high: { label: "High", color: "text-danger", icon: AlertTriangle },
  medium: { label: "Medium", color: "text-warning", icon: Flag },
  low: { label: "Low", color: "text-success", icon: Flag },
}

export default function ArchivedPage() {
  // The archive from the query cache: archiving anywhere marks it stale
  // (task:deleted), so the page shows the cached list or refetches once.
  const { tasks, loading, error, errorUpdatedAt, deleteMany, deleteAll } = useArchivedTasks()
  const [activeTab, setActiveTab] = useState<PriorityTab>("all")
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const deletingAll = deleteAll.isPending
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deletingSelected, setDeletingSelected] = useState(false)

  // One toast per failed load, as before.
  useEffect(() => {
    if (!error) return
    console.error("Error fetching archived tasks:", error)
    toast.error(error instanceof Error ? error.message : 'Failed to fetch archived tasks')
  }, [error, errorUpdatedAt])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [activeTab])

  const handleDeleteOne = async (taskId: string) => {
    setDeletingIds((prev) => new Set(prev).add(taskId))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(taskId)
      return next
    })

    try {
      // Optimistic; the row comes back in place if the delete fails.
      const { failed } = await deleteMany.mutateAsync([taskId])
      if (failed.length > 0) toast.error('Failed to delete task')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete task')
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }

  const handleDeleteAll = async () => {
    setSelectedIds(new Set())
    try {
      await deleteAll.mutateAsync()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete all tasks')
    }
  }

  const handleDeleteSelected = async () => {
    const idsToDelete = Array.from(selectedIds)
    if (idsToDelete.length === 0) return

    setDeletingSelected(true)
    setSelectedIds(new Set())

    try {
      // Per-item outcome: only the failed tasks come back (and stay selectable).
      const { failed } = await deleteMany.mutateAsync(idsToDelete)
      if (failed.length > 0) toast.error(`Failed to delete ${failed.length} task(s)`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete selected tasks')
    } finally {
      setDeletingSelected(false)
    }
  }

  const toggleSelected = (taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const filteredTasks = activeTab === "all"
    ? tasks
    : tasks.filter((t) => t.priority === activeTab)

  const countByPriority = (p: string) => tasks.filter((t) => t.priority === p).length
  const selectedCount = selectedIds.size
  const canSelectAll = filteredTasks.length > 0 && filteredTasks.some((t) => !selectedIds.has(t.id))

  return (
    <>
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-linear-bg">
        <div className="border-b border-linear-border">
          <div className="px-4 sm:px-6 py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-semibold text-linear-text">Archived</h1>
                {tasks.length > 0 && (
                  <span className="text-xs text-linear-text-tertiary bg-linear-bg-tertiary px-2 py-0.5 rounded-full">
                    {tasks.length}
                  </span>
                )}
              </div>
              {tasks.length > 0 && (
                <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
                  {selectedCount > 0 && (
                    <button
                      onClick={handleDeleteSelected}
                      disabled={deletingSelected}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm font-medium text-danger hover:bg-danger/10 transition-colors disabled:opacity-50"
                    >
                      {deletingSelected ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      Delete selected
                    </button>
                  )}
                  {canSelectAll && (
                    <button
                      onClick={() => setSelectedIds(new Set(filteredTasks.map((t) => t.id)))}
                      className="px-3 py-1.5 rounded-sm text-sm font-medium text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary/50 transition-colors"
                    >
                      Select all
                    </button>
                  )}
                  {selectedCount > 0 && (
                    <button
                      onClick={() => setSelectedIds(new Set())}
                      className="px-3 py-1.5 rounded-sm text-sm font-medium text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary/50 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    onClick={handleDeleteAll}
                    disabled={deletingAll}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm font-medium text-danger hover:bg-danger/10 transition-colors disabled:opacity-50"
                  >
                    {deletingAll ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    Delete all
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1">
              {PRIORITY_TABS.map((tab) => {
                const count = tab === "all" ? tasks.length : countByPriority(tab)
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      "px-3 py-1.5 rounded-sm text-sm font-medium transition-colors",
                      activeTab === tab
                        ? "bg-linear-bg-tertiary text-linear-text"
                        : "text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary/50"
                    )}
                  >
                    {tab === "all" ? "All" : priorityConfig[tab]?.label}
                    {count > 0 && (
                      <span className="ml-1.5 text-xs text-linear-text-tertiary">{count}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="divide-y divide-linear-border/50">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 sm:px-6 py-3">
                  <Skeleton className="w-4 h-4 rounded" />
                  <Skeleton className="w-4 h-4 rounded" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-2/3 rounded" />
                    <Skeleton className="h-2.5 w-1/3 rounded" />
                  </div>
                  <Skeleton className="h-5 w-14 rounded" />
                </div>
              ))}
            </div>
          ) : filteredTasks.length > 0 ? (
            <div className="divide-y divide-linear-border/50">
              {filteredTasks.map((task) => {
                const config = priorityConfig[task.priority]
                const PriorityIcon = config?.icon || Flag
                const isSelected = selectedIds.has(task.id)
                return (
                  <div
                    key={task.id}
                    className="flex items-center gap-3 px-4 sm:px-6 py-3 hover:bg-linear-bg-secondary/50 transition-colors group"
                  >
                    <button
                      onClick={() => toggleSelected(task.id)}
                      className={cn(
                        "w-4 h-4 rounded border flex items-center justify-center",
                        isSelected
                          ? "bg-linear-accent/20 border-linear-accent text-linear-accent"
                          : "border-linear-border text-transparent"
                      )}
                      aria-label={isSelected ? "Unselect task" : "Select task"}
                    >
                      {isSelected && <Check className="w-3 h-3" />}
                    </button>
                    <div className={cn("flex-shrink-0", config?.color || "text-linear-text-tertiary")}>
                      <PriorityIcon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-linear-text truncate">{task.title}</p>
                      {task.description && (
                        <p className="text-xs text-linear-text-tertiary truncate mt-0.5">{task.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={cn(
                        "text-xs px-1.5 py-0.5 rounded",
                        task.priority === "high" && "bg-danger/10 text-danger",
                        task.priority === "medium" && "bg-warning/10 text-warning",
                        task.priority === "low" && "bg-success/10 text-success",
                      )}>
                        {config?.label}
                      </span>
                      <button
                        onClick={() => handleDeleteOne(task.id)}
                        disabled={deletingIds.has(task.id)}
                        className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-sm text-linear-text-tertiary hover:text-danger hover:bg-danger/10 transition-all disabled:opacity-50"
                        title="Delete permanently"
                      >
                        {deletingIds.has(task.id) ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <EmptyState
              icon={Archive}
              title={activeTab === "all" ? "No archived tasks" : `No ${activeTab} priority tasks`}
              description={
                activeTab === "all"
                  ? "Tasks you archive will appear here"
                  : "Try switching to a different priority tab"
              }
            />
          )}
        </div>
      </div>
    </>
  )
}
