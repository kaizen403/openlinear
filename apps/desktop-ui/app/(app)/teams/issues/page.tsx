"use client"

import { Suspense, useState, useEffect, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { ListTodo } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { apiFetch } from "@/lib/api/fetch"
import { STATUS_COLORS, PRIORITY_COLORS, type StatusKey, type PriorityKey } from "@/lib/design-tokens"
import type { MyIssueTask } from "@/lib/api/types"
import { Skeleton } from "@/components/ui/skeleton"

const statusKeyMap: Record<string, StatusKey> = {
  backlog: "todo",
  todo: "todo",
  in_progress: "in_progress",
  done: "done",
  completed: "done",
  cancelled: "cancelled",
}

function TeamIssuesContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const teamId = searchParams.get("id")
  const teamName = searchParams.get("name") || "Team"

  const [tasks, setTasks] = useState<MyIssueTask[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchTasks = useCallback(async () => {
    if (!teamId) return
    setIsLoading(true)
    try {
      const data = await apiFetch<MyIssueTask[] | { items: MyIssueTask[] }>(`/api/tasks?teamId=${teamId}`)
      setTasks(Array.isArray(data) ? data : data.items)
    } catch {
      setTasks([])
    } finally {
      setIsLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const getStatusColor = (status: string) => {
    const key = statusKeyMap[status.toLowerCase()] ?? "todo"
    return STATUS_COLORS[key].text
  }

  const getPriorityColor = (priority: string) => {
    const key = priority.toLowerCase() as PriorityKey
    return PRIORITY_COLORS[key]?.text ?? PRIORITY_COLORS.low.text
  }

  if (!teamId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-linear-text-tertiary">No team selected</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-linear-bg">
      <header className="h-14 border-b border-linear-border flex items-center px-6 bg-linear-bg">
        <div className="flex items-center gap-2.5">
          <ListTodo className="w-4 h-4 text-linear-text-secondary" />
          <h1 className="text-sm font-medium text-linear-text">{teamName} Issues</h1>
          {!isLoading && (
            <span className="text-xs text-linear-text-tertiary">{tasks.length}</span>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-20">
            <ListTodo className="w-8 h-8 text-linear-text-tertiary mb-3" />
            <p className="text-sm text-linear-text-secondary">No issues yet</p>
            <p className="text-xs text-linear-text-tertiary mt-1">Issues assigned to this team will appear here</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-linear-border bg-linear-bg-secondary/50">
                <th className="text-left py-2.5 px-6 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider">
                  Issue
                </th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                  Status
                </th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                  Priority
                </th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[140px]">
                  Assignee
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  className="border-b border-linear-border/50 hover:bg-linear-bg-tertiary/30 transition-colors cursor-pointer"
                  onClick={() => router.push(`/?teamId=${teamId}`)}
                >
                  <td className="py-3 px-6">
                    <div className="flex items-center gap-2.5">
                      {task.identifier && (
                        <span className="text-xs font-mono text-linear-text-tertiary">{task.identifier}</span>
                      )}
                      <span className="text-sm text-linear-text">{task.title}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <Badge variant="outline" className={cn(getStatusColor(task.status), "text-xs capitalize whitespace-nowrap bg-transparent border-linear-border")}>
                      {task.status.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td className="py-3 px-4">
                    <Badge variant="outline" className={cn(getPriorityColor(task.priority), "text-xs capitalize whitespace-nowrap bg-transparent border-linear-border")}>
                      {task.priority}
                    </Badge>
                  </td>
                  <td className="py-3 px-4">
                    {task.assignee ? (
                      <span className="text-xs text-linear-text-secondary">{task.assignee.username}</span>
                    ) : (
                      <span className="text-xs text-linear-text-tertiary">Unassigned</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default function TeamIssuesPage() {
  return (
    <Suspense fallback={
      <div className="flex-1 flex flex-col bg-linear-bg">
        <div className="h-14 border-b border-linear-border flex items-center px-6">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="p-6 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    }>
      <TeamIssuesContent />
    </Suspense>
  )
}
