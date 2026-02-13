"use client"

import { useState, useEffect, useCallback } from "react"
import {
  Archive,
  Trash2,
  AlertTriangle,
  Flag,
  Loader2,
  Check,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { AppShell } from "@/components/layout/app-shell"
import { Task } from "@/types/task"
import { API_URL } from "@/lib/api/client"

const API_BASE_URL = API_URL

const PRIORITY_TABS = ["all", "high", "medium", "low"] as const
type PriorityTab = (typeof PRIORITY_TABS)[number]

const priorityConfig: Record<string, { label: string; color: string; icon: typeof Flag }> = {
  high: { label: "High", color: "text-red-600", icon: AlertTriangle },
  medium: { label: "Medium", color: "text-yellow-600", icon: Flag },
  low: { label: "Low", color: "text-emerald-600", icon: Flag },
}

export default function ArchivedPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<PriorityTab>("all")
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const [deletingAll, setDeletingAll] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deletingSelected, setDeletingSelected] = useState(false)

  const fetchArchived = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/tasks/archived`)
      if (!response.ok) throw new Error("Failed to fetch")
      const data = await response.json()
      setTasks(data)
    } catch (err) {
      console.error("Error fetching archived tasks:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchArchived()
  }, [fetchArchived])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [activeTab])

  const handleDeleteOne = async (taskId: string) => {
    setDeletingIds((prev) => new Set(prev).add(taskId))
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(taskId)
      return next
    })

    try {
      const token = localStorage.getItem("token")
      const response = await fetch(`${API_BASE_URL}/api/tasks/archived/${taskId}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        fetchArchived()
      }
    } catch {
      fetchArchived()
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }

  const handleDeleteAll = async () => {
    setDeletingAll(true)
    const previousTasks = tasks
    setTasks([])
    setSelectedIds(new Set())

    try {
      const token = localStorage.getItem("token")
      const response = await fetch(`${API_BASE_URL}/api/tasks/archived`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        setTasks(previousTasks)
      }
    } catch {
      setTasks(previousTasks)
    } finally {
      setDeletingAll(false)
    }
  }

  const handleDeleteSelected = async () => {
    const idsToDelete = Array.from(selectedIds)
    if (idsToDelete.length === 0) return

    setDeletingSelected(true)
    const previousTasks = tasks
    setTasks((prev) => prev.filter((t) => !selectedIds.has(t.id)))
    setSelectedIds(new Set())

    try {
      const token = localStorage.getItem("token")
      const results = await Promise.all(
        idsToDelete.map((taskId) =>
          fetch(`${API_BASE_URL}/api/tasks/archived/${taskId}`, {
            method: "DELETE",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          })
        )
      )
      if (results.some((r) => !r.ok)) {
        setTasks(previousTasks)
        fetchArchived()
      }
    } catch {
      setTasks(previousTasks)
      fetchArchived()
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
    <AppShell>
      <div className="flex-1 flex flex-col min-w-0 bg-linear-bg">
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
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50"
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
                      className="px-3 py-1.5 rounded-md text-sm font-medium text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary/50 transition-colors"
                    >
                      Select all
                    </button>
                  )}
                  {selectedCount > 0 && (
                    <button
                      onClick={() => setSelectedIds(new Set())}
                      className="px-3 py-1.5 rounded-md text-sm font-medium text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary/50 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    onClick={handleDeleteAll}
                    disabled={deletingAll}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50"
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
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
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

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="w-5 h-5 animate-spin text-linear-text-tertiary" />
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
                        task.priority === "high" && "bg-red-500/10 text-red-600",
                        task.priority === "medium" && "bg-yellow-500/10 text-yellow-600",
                        task.priority === "low" && "bg-emerald-500/10 text-emerald-600",
                      )}>
                        {config?.label}
                      </span>
                      <button
                        onClick={() => handleDeleteOne(task.id)}
                        disabled={deletingIds.has(task.id)}
                        className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-md text-linear-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
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
            <div className="flex-1 flex flex-col items-center justify-center py-24">
              <div className="w-12 h-12 rounded-xl bg-linear-bg-tertiary border border-linear-border flex items-center justify-center mb-4">
                <Archive className="w-6 h-6 text-linear-text-tertiary" />
              </div>
              <h3 className="text-sm font-medium text-linear-text mb-1">
                {activeTab === "all" ? "No archived tasks" : `No ${activeTab} priority tasks`}
              </h3>
              <p className="text-sm text-linear-text-tertiary">
                {activeTab === "all"
                  ? "Tasks you archive will appear here"
                  : "Try switching to a different priority tab"}
              </p>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
