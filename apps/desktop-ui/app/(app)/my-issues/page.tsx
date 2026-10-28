"use client"

import {
  Layers, Clock, GitPullRequest, ExternalLink,
  Circle, Timer, CheckCircle2, XCircle
} from "lucide-react"
import { cn, openExternal } from "@/lib/utils"
import { formatDuration } from "@/types/task"
import type { MyIssueTask } from "@/lib/api"
import { useMyIssues } from "@/hooks/use-issue-lists"
import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"

type StatusGroup = 'in_progress' | 'todo' | 'done' | 'cancelled'

const statusConfig: Record<StatusGroup, { label: string; icon: typeof Circle; iconClass: string }> = {
  in_progress: { label: "In Progress", icon: Timer, iconClass: "text-warning" },
  todo: { label: "Todo", icon: Circle, iconClass: "text-linear-text-tertiary" },
  done: { label: "Done", icon: CheckCircle2, iconClass: "text-success" },
  cancelled: { label: "Cancelled", icon: XCircle, iconClass: "text-danger" },
}

const priorityDots: Record<string, string> = {
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-danger",
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
    <div className="flex items-start sm:items-center gap-3 px-4 py-3 hover:bg-layer-hover transition-colors group flex-wrap">
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
                  className="text-[10px] px-1.5 py-0.5 rounded border border-layer-outline"
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
          className="flex items-center gap-1 text-[11px] text-discovery hover:text-linear-text font-medium transition-colors flex-shrink-0"
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
  // Cached list kept live by the SSE → cache bridge (no refetch per event).
  const { tasks, loading } = useMyIssues()

  const grouped = (['in_progress', 'todo', 'done', 'cancelled'] as StatusGroup[]).map(status => ({
    status,
    tasks: tasks.filter(t => t.status === status),
  })).filter(g => g.tasks.length > 0)

  const activeCount = tasks.filter(t => t.status === 'todo' || t.status === 'in_progress').length

  return (
    <>
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

      <div className="flex-1 min-h-0 overflow-y-auto bg-linear-bg">
        {loading ? (
          <div>
            {Array.from({ length: 2 }).map((_, gi) => (
              <div key={gi}>
                <div className="flex items-center gap-2 px-4 py-2 bg-layer-faint border-b border-linear-border">
                  <Skeleton className="w-3.5 h-3.5 rounded" />
                  <Skeleton className="h-3 w-20 rounded" />
                </div>
                <div className="divide-y divide-layer-divider">
                  {Array.from({ length: 3 }).map((_, ri) => (
                    <div key={ri} className="flex items-center gap-3 px-4 py-3">
                      <Skeleton className="w-2 h-2 rounded-full" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-3.5 w-2/3 rounded" />
                        <Skeleton className="h-2.5 w-32 rounded" />
                      </div>
                      <Skeleton className="h-3 w-12 rounded" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No issues yet"
            description="Create tasks in a project to see them here"
          />
        ) : (
          <div>
            {grouped.map(({ status, tasks: groupTasks }) => {
              const config = statusConfig[status]
              const StatusIcon = config.icon
              return (
                <div key={status}>
                  <div className="flex items-center gap-2 px-4 py-2 bg-layer-faint border-b border-linear-border sticky top-0 z-10">
                    <StatusIcon className={cn("w-3.5 h-3.5", config.iconClass)} />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-linear-text-secondary">
                      {config.label}
                    </span>
                    <span className="text-[11px] text-linear-text-tertiary">
                      {groupTasks.length}
                    </span>
                  </div>
                  <div className="divide-y divide-layer-divider">
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
    </>
  )
}
