"use client"

import { useState, useEffect, useCallback } from "react"
import {
  Inbox, Check, CheckCheck, GitPullRequest, ExternalLink,
  Clock, GitMerge, Loader2
} from "lucide-react"
import { AppShell } from "@/components/layout/app-shell"
import { cn, openExternal } from "@/lib/utils"
import { formatDuration } from "@/types/task"
import {
  fetchInboxTasks, fetchInboxCount, markInboxRead, markAllInboxRead,
  type InboxTask
} from "@/lib/api"
import { useSSE, SSEEventType, SSEEventData } from "@/hooks/use-sse"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
const SSE_URL = `${API_BASE_URL}/api/events`

interface InboxGroup {
  type: "batch" | "single"
  batchId: string | null
  tasks: InboxTask[]
  prUrl: string | null
  latestUpdatedAt: string
}

function groupInboxTasks(tasks: InboxTask[]): InboxGroup[] {
  const batchMap = new Map<string, InboxTask[]>()
  const singles: InboxTask[] = []

  for (const task of tasks) {
    if (task.batchId) {
      const existing = batchMap.get(task.batchId)
      if (existing) {
        existing.push(task)
      } else {
        batchMap.set(task.batchId, [task])
      }
    } else {
      singles.push(task)
    }
  }

  const groups: InboxGroup[] = []

  for (const [batchId, batchTasks] of batchMap) {
    const prUrl = batchTasks.find(t => t.prUrl)?.prUrl ?? null
    const latestUpdatedAt = batchTasks.reduce(
      (latest, t) => (t.updatedAt > latest ? t.updatedAt : latest),
      batchTasks[0]!.updatedAt
    )
    groups.push({ type: "batch", batchId, tasks: batchTasks, prUrl, latestUpdatedAt })
  }

  for (const task of singles) {
    groups.push({
      type: "single",
      batchId: null,
      tasks: [task],
      prUrl: task.prUrl,
      latestUpdatedAt: task.updatedAt,
    })
  }

  groups.sort((a, b) => new Date(b.latestUpdatedAt).getTime() - new Date(a.latestUpdatedAt).getTime())
  return groups
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

const priorityDots: Record<string, string> = {
  low: "bg-emerald-700",
  medium: "bg-yellow-700",
  high: "bg-red-700",
}

function InboxTaskRow({
  task,
  onMarkRead,
  compact,
  hidePrLink,
}: {
  task: InboxTask
  onMarkRead: (id: string) => void
  compact?: boolean
  hidePrLink?: boolean
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3 transition-colors group",
        !compact && "hover:bg-white/[0.03]",
        !task.inboxRead && "bg-white/[0.02]"
      )}
    >
      <div className={cn(
        "w-2 h-2 rounded-full flex-shrink-0",
        task.inboxRead ? "bg-transparent" : "bg-linear-accent"
      )} />

      <div className={cn("w-2 h-2 rounded-full flex-shrink-0", priorityDots[task.priority])} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {task.identifier && (
            <span className="text-[11px] text-linear-text-tertiary font-mono flex-shrink-0">
              {task.identifier}
            </span>
          )}
          <span className={cn(
            "text-sm truncate",
            task.inboxRead ? "text-linear-text-secondary" : "text-linear-text"
          )}>
            {task.title}
          </span>
        </div>
        {task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
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

      {task.executionElapsedMs > 0 && (
        <span className="text-[11px] text-linear-text-tertiary flex items-center gap-1 flex-shrink-0">
          <Clock className="w-3 h-3" />
          {formatDuration(task.executionElapsedMs)}
        </span>
      )}

      {task.prUrl && !hidePrLink && (
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

      {!task.inboxRead && (
        <button
          onClick={(e) => { e.stopPropagation(); onMarkRead(task.id) }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/[0.06] transition-all flex-shrink-0"
          title="Mark as read"
        >
          <Check className="w-3.5 h-3.5 text-linear-text-tertiary" />
        </button>
      )}
    </div>
  )
}

export default function InboxPage() {
  const [tasks, setTasks] = useState<InboxTask[]>([])
  const [loading, setLoading] = useState(true)
  const [unreadCount, setUnreadCount] = useState(0)

  const loadData = useCallback(async () => {
    try {
      const [inboxTasks, count] = await Promise.all([
        fetchInboxTasks(),
        fetchInboxCount(),
      ])
      setTasks(inboxTasks)
      setUnreadCount(count)
    } catch (err) {
      console.error("Failed to load inbox:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleSSEEvent = useCallback((eventType: SSEEventType, _data: SSEEventData) => {
    if (eventType === 'task:updated' || eventType === 'task:created' || eventType === 'batch:completed') {
      loadData()
    }
  }, [loadData])

  useSSE(SSE_URL, handleSSEEvent)

  const handleMarkRead = async (taskId: string) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, inboxRead: true } : t))
    setUnreadCount(prev => Math.max(0, prev - 1))
    await markInboxRead(taskId)
  }

  const handleMarkAllRead = async () => {
    setTasks(prev => prev.map(t => ({ ...t, inboxRead: true })))
    setUnreadCount(0)
    await markAllInboxRead()
  }

  const groups = groupInboxTasks(tasks)

  return (
    <AppShell>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
        <div className="flex items-center gap-3 min-w-0">
          <Inbox className="w-5 h-5 text-linear-text-secondary flex-shrink-0" />
          <h1 className="text-lg font-semibold truncate">Inbox</h1>
          {unreadCount > 0 && (
            <span className="text-xs text-linear-text-tertiary bg-linear-bg-tertiary px-1.5 py-0.5 rounded">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
        {unreadCount > 0 && (
          <button
            onClick={handleMarkAllRead}
            className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            Mark all read
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto bg-[#111111]">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 animate-spin text-linear-text-tertiary" />
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-linear-text-tertiary">
            <Inbox className="w-10 h-10 mb-3 opacity-40" />
            <p className="text-sm">No completed tasks yet</p>
            <p className="text-xs mt-1 opacity-60">Tasks will appear here when they&apos;re done</p>
          </div>
        ) : (
          <div className="divide-y divide-linear-border">
            {groups.map((group) => {
              if (group.type === "single") {
                return (
                  <InboxTaskRow
                    key={group.tasks[0]!.id}
                    task={group.tasks[0]!}
                    onMarkRead={handleMarkRead}
                  />
                )
              }

              const allRead = group.tasks.every(t => t.inboxRead)

              return (
                <div key={group.batchId} className={cn(
                  "border-l-2 transition-colors",
                  allRead ? "border-l-transparent" : "border-l-purple-500/40"
                )}>
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-white/[0.015]">
                    <GitMerge className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                    <span className="text-[11px] text-purple-400/80 font-medium uppercase tracking-wider">
                      Parallel Batch · {group.tasks.length} tasks
                    </span>
                    <div className="flex-1" />

                    {group.prUrl && (
                      <button
                        onClick={() => openExternal(group.prUrl!)}
                        className="flex items-center gap-1 text-[11px] text-purple-400 hover:text-purple-300 font-medium transition-colors"
                      >
                        <GitPullRequest className="w-3 h-3" />
                        Open PR
                        <ExternalLink className="w-2.5 h-2.5" />
                      </button>
                    )}

                    <span className="text-[11px] text-linear-text-tertiary">
                      {timeAgo(group.latestUpdatedAt)}
                    </span>
                  </div>
                  <div className="divide-y divide-white/[0.04]">
                    {group.tasks.map(task => (
                      <InboxTaskRow
                        key={task.id}
                        task={task}
                        onMarkRead={handleMarkRead}
                        compact
                        hidePrLink
                      />
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
