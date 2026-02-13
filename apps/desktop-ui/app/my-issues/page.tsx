"use client"

import { useState, useEffect, useCallback } from "react"
import {
  Layers, Clock, GitPullRequest, ExternalLink,
  Loader2, Circle, Timer, CheckCircle2, XCircle
} from "lucide-react"
import { AppShell } from "@/components/layout/app-shell"
import { cn, openExternal } from "@/lib/utils"
import { formatDuration } from "@/types/task"
import { fetchMyIssues, type MyIssueTask } from "@/lib/api"
import { useSSE, SSEEventType, SSEEventData } from "@/hooks/use-sse"
import { API_URL } from "@/lib/api/client"

const SSE_URL = `${API_URL}/api/events`

type StatusGroup = 'in_progress' | 'todo' | 'done' | 'cancelled'

const statusConfig: Record<StatusGroup, { label: string; icon: typeof Circle; iconClass: string }> = {
  in_progress: { label: "In Progress", icon: Timer, iconClass: "text-yellow-400" },
  todo: { label: "Todo", icon: Circle, iconClass: "text-linear-text-tertiary" },
  done: { label: "Done", icon: CheckCircle2, iconClass: "text-emerald-400" },
  cancelled: { label: "Cancelled", icon: XCircle, iconClass: "text-red-400" },
}

const priorityDots: Record<string, string> = {
  low: "bg-emerald-700",
  medium: "bg-yellow-700",
  high: "bg-red-700",
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function TaskRow({ task }: { task: MyIssueTask }) {
  return (
    <div className="flex items-start sm:items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors group flex-wrap">
      <div className={cn("w-2 h-2 rounded-full flex-shrink-0", priorityDots[task.priority])} />

      <div className="flex-1 min-w-0 w-full sm:w-auto">
        <div className="flex items-center gap-2">
          {task.identifier && (
            <span className="text-[11px] text-linear-text-tertiary font-mono flex-shrink-0">
              {task.identifier}
            </span>
          )}
          <span className={cn(
            "text-sm truncate text-linear-text",
            task.status === 'cancelled' && "line-through opacity-70"
          )}>
            {task.title}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {task.project && (
            <span className="flex items-center gap-1 text-[10px] text-linear-text-tertiary">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: task.project.color }}
              />
              {task.project.name}
            </span>
          )}
          {task.team && (
            <span className="text-[10px] text-linear-text-tertiary">
              {task.team.name}
            </span>
          )}
          {task.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {task.labels.map(label => (
                <span
                  key={label.id}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-white/10"
                  style={{ backgroundColor: `${label.color}20`, color: label.color }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {task.executionElapsedMs > 0 && (
        <span className="text-[11px] text-linear-text-tertiary flex items-center gap-1 flex-shrink-0">
          <Clock className="w-3 h-3" />
          {formatDuration(task.executionElapsedMs)}
        </span>
      )}

      {task.prUrl && (
        <button
          onClick={(e) => { e.stopPropagation(); openExternal(task.prUrl!) }}
          className="flex items-center gap-1 text-[11px] text-purple-400 hover:text-purple-300 font-medium transition-colors flex-shrink-0"
        >
          <GitPullRequest className="w-3 h-3" />
          PR
          <ExternalLink className="w-2.5 h-2.5" />
        </button>
      )}

      <span className="text-[11px] text-linear-text-tertiary flex-shrink-0">
        {timeAgo(task.updatedAt)}
      </span>
    </div>
  )
}

export default function MyIssuesPage() {
  const [tasks, setTasks] = useState<MyIssueTask[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    try {
      const data = await fetchMyIssues()
      setTasks(data)
    } catch (err) {
      console.error("Failed to load my issues:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleSSEEvent = useCallback((eventType: SSEEventType, _data: SSEEventData) => {
    if (eventType === 'task:updated' || eventType === 'task:created') {
      loadData()
    }
  }, [loadData])

  useSSE(SSE_URL, handleSSEEvent)

  const grouped = (['in_progress', 'todo', 'done', 'cancelled'] as StatusGroup[]).map(status => ({
    status,
    tasks: tasks.filter(t => t.status === status),
  })).filter(g => g.tasks.length > 0)

  const activeCount = tasks.filter(t => t.status === 'todo' || t.status === 'in_progress').length

  return (
    <AppShell>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
        <div className="flex items-center gap-3 min-w-0">
          <Layers className="w-5 h-5 text-linear-text-secondary flex-shrink-0" />
          <h1 className="text-lg font-semibold truncate">My Issues</h1>
          {activeCount > 0 && (
            <span className="text-xs text-linear-text-tertiary bg-linear-bg-tertiary px-1.5 py-0.5 rounded">
              {activeCount}
            </span>
          )}
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
      </header>

      <div className="flex-1 overflow-y-auto bg-[#111111]">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 animate-spin text-linear-text-tertiary" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-linear-text-tertiary">
            <Layers className="w-10 h-10 mb-3 opacity-40" />
            <p className="text-sm">No issues yet</p>
            <p className="text-xs mt-1 opacity-60">Create tasks in a project to see them here</p>
          </div>
        ) : (
          <div>
            {grouped.map(({ status, tasks: groupTasks }) => {
              const config = statusConfig[status]
              const StatusIcon = config.icon
              return (
                <div key={status}>
                  <div className="flex items-center gap-2 px-4 py-2 bg-white/[0.015] border-b border-linear-border sticky top-0 z-10">
                    <StatusIcon className={cn("w-3.5 h-3.5", config.iconClass)} />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-linear-text-secondary">
                      {config.label}
                    </span>
                    <span className="text-[11px] text-linear-text-tertiary">
                      {groupTasks.length}
                    </span>
                  </div>
                  <div className="divide-y divide-white/[0.04]">
                    {groupTasks.map(task => (
                      <TaskRow key={task.id} task={task} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </AppShell>
  )
}
