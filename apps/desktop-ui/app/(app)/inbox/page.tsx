"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useRouter } from "next/navigation"
import {
  Inbox, CheckCheck, AtSign, UserPlus, ArrowRightLeft,
  MessageSquare, Bell
} from "lucide-react"
import { cn } from "@/lib/utils"
import { apiFetch } from "@/lib/api"
import { getApiUrl, getAuthToken } from "@/lib/api/client"
import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"

type NotificationType = 'mention' | 'assignment' | 'status_change' | 'comment'

interface NotificationActor {
  id: string
  username: string
  avatarUrl: string | null
}

interface AppNotification {
  id: string
  userId: string
  type: NotificationType
  taskId: string | null
  commentId: string | null
  actorUserId: string | null
  actor?: NotificationActor | null
  body: string
  readAt: string | null
  createdAt: string
}

interface NotificationsListResponse {
  items: AppNotification[]
  page: number
  pageSize: number
  total: number
  hasMore: boolean
  unreadCount: number
}

type FilterChip = 'all' | 'mention' | 'assignment' | 'status_change'

const MS_DAY = 24 * 60 * 60 * 1000

function startOfDay(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

type Bucket = 'today' | 'week' | 'older'

function bucketFor(dateStr: string, now: number): Bucket {
  const t = new Date(dateStr).getTime()
  const todayStart = startOfDay(new Date(now))
  if (t >= todayStart) return 'today'
  if (t >= todayStart - 6 * MS_DAY) return 'week'
  return 'older'
}

const BUCKET_LABEL: Record<Bucket, string> = {
  today: 'Today',
  week: 'This week',
  older: 'Older',
}

const BUCKET_ORDER: Bucket[] = ['today', 'week', 'older']

const relativeFmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

function timeAgo(dateStr: string, now: number): string {
  const diffSec = Math.round((new Date(dateStr).getTime() - now) / 1000)
  const abs = Math.abs(diffSec)
  if (abs < 60) return relativeFmt.format(diffSec, 'second')
  if (abs < 3600) return relativeFmt.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86_400) return relativeFmt.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 7 * 86_400) return relativeFmt.format(Math.round(diffSec / 86_400), 'day')
  if (abs < 30 * 86_400) return relativeFmt.format(Math.round(diffSec / (7 * 86_400)), 'week')
  return new Date(dateStr).toLocaleDateString()
}

const TYPE_META: Record<NotificationType, {
  label: string
  Icon: typeof AtSign
  color: string
  bg: string
}> = {
  mention: {
    label: '@mention',
    Icon: AtSign,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
  },
  assignment: {
    label: 'Assigned',
    Icon: UserPlus,
    color: 'text-linear-accent',
    bg: 'bg-linear-accent/10',
  },
  status_change: {
    label: 'Status',
    Icon: ArrowRightLeft,
    color: 'text-violet-400',
    bg: 'bg-violet-400/10',
  },
  comment: {
    label: 'Comment',
    Icon: MessageSquare,
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
  },
}

const FILTER_CHIPS: { id: FilterChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mention', label: '@mentions' },
  { id: 'assignment', label: 'Assignments' },
  { id: 'status_change', label: 'Status changes' },
]

async function fetchNotifications(): Promise<NotificationsListResponse> {
  return apiFetch<NotificationsListResponse>('/api/notifications?pageSize=100')
}

async function markNotificationRead(id: string): Promise<void> {
  await apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' })
}

async function markAllNotificationsRead(): Promise<void> {
  await apiFetch('/api/notifications/read-all', { method: 'POST' })
}

function readToken(): string | null {
  if (typeof window === 'undefined') return null
  return getAuthToken()
}

function useNotificationStream(onCreated: (n: AppNotification) => void): void {
  const cbRef = useRef(onCreated)
  useEffect(() => {
    cbRef.current = onCreated
  }, [onCreated])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const token = readToken()
    if (!token) return
    const url = new URL(`${getApiUrl()}/api/events`)
    url.searchParams.set('token', token)
    const es = new EventSource(url.toString())
    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as AppNotification
        cbRef.current(data)
      } catch {
        /* swallow malformed payloads */
      }
    }
    es.addEventListener('notification:created', handler as EventListener)
    return () => {
      es.removeEventListener('notification:created', handler as EventListener)
      es.close()
    }
  }, [])
}

function NotificationRow({
  notification,
  onClick,
  now,
}: {
  notification: AppNotification
  onClick: (n: AppNotification) => void
  now: number
}) {
  const meta = TYPE_META[notification.type]
  const Icon = meta.Icon
  const unread = notification.readAt === null
  const actorName = notification.actor?.username ?? 'Someone'

  return (
    <button
      onClick={() => onClick(notification)}
      className={cn(
        "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors group",
        "hover:bg-white/[0.04]",
        unread && "bg-white/[0.02]"
      )}
    >
      <span className={cn(
        "mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0",
        unread ? "bg-linear-accent" : "bg-transparent"
      )} />

      <div className={cn(
        "w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0",
        meta.bg
      )}>
        {notification.actor?.avatarUrl ? (
          <img
            src={notification.actor.avatarUrl}
            alt={actorName}
            className="w-7 h-7 rounded-full object-cover"
          />
        ) : (
          <Icon className={cn("w-3.5 h-3.5", meta.color)} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn(
            "text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded",
            meta.bg, meta.color
          )}>
            {meta.label}
          </span>
          <span className={cn(
            "text-sm truncate",
            unread ? "text-linear-text" : "text-linear-text-secondary"
          )}>
            {notification.body}
          </span>
        </div>
        <div className="text-[11px] text-linear-text-tertiary mt-0.5">
          {actorName} · {timeAgo(notification.createdAt, now)}
        </div>
      </div>
    </button>
  )
}

export default function InboxPage() {
  const router = useRouter()
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterChip>('all')
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const loadData = useCallback(async () => {
    try {
      const res = await fetchNotifications()
      setNotifications(res.items)
      setUnreadCount(res.unreadCount)
    } catch (err) {
      console.error("Failed to load notifications:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  useNotificationStream((n) => {
    setNotifications((prev) => {
      if (prev.some((p) => p.id === n.id)) return prev
      return [n, ...prev]
    })
    if (n.readAt === null) {
      setUnreadCount((c) => c + 1)
    }
  })

  const handleNotificationClick = useCallback(async (n: AppNotification) => {
    if (n.readAt === null) {
      const nowIso = new Date().toISOString()
      setNotifications((prev) => prev.map((p) => p.id === n.id ? { ...p, readAt: nowIso } : p))
      setUnreadCount((c) => Math.max(0, c - 1))
      try {
        await markNotificationRead(n.id)
      } catch (err) {
        console.error("Failed to mark notification read:", err)
      }
    }

    if (n.taskId) {
      const params = new URLSearchParams()
      params.set('task', n.taskId)
      router.push(`/?${params.toString()}`)
      if (n.commentId) {
        const cid = n.commentId
        // wait for route change + child render before scrolling to anchor
        setTimeout(() => {
          const el = document.getElementById(`comment-${cid}`)
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 400)
      }
    }
  }, [router])

  const handleMarkAllRead = useCallback(async () => {
    const nowIso = new Date().toISOString()
    setNotifications((prev) => prev.map((p) => p.readAt ? p : { ...p, readAt: nowIso }))
    setUnreadCount(0)
    try {
      await markAllNotificationsRead()
    } catch (err) {
      console.error("Failed to mark all read:", err)
    }
  }, [])

  const filtered = useMemo(() => {
    if (filter === 'all') return notifications
    return notifications.filter((n) => n.type === filter)
  }, [notifications, filter])

  const grouped = useMemo(() => {
    const groups: Record<Bucket, AppNotification[]> = { today: [], week: [], older: [] }
    for (const n of filtered) {
      groups[bucketFor(n.createdAt, now)].push(n)
    }
    return groups
  }, [filtered, now])

  return (
    <>
      <header
        className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-3 min-w-0">
          <Inbox className="w-5 h-5 text-linear-text-secondary flex-shrink-0" />
          <h1 className="text-lg font-semibold truncate">Inbox</h1>
          {unreadCount > 0 && (
            <span className="text-xs text-linear-accent bg-linear-accent/10 px-1.5 py-0.5 rounded font-medium">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
        {unreadCount > 0 && (
          <button
            onClick={handleMarkAllRead}
            className="flex items-center gap-1.5 h-8 px-3 rounded-sm text-xs font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            Mark all read
          </button>
        )}
      </header>

      <div className="px-4 sm:px-6 py-3 border-b border-linear-border bg-linear-bg flex items-center gap-2 flex-wrap">
        {FILTER_CHIPS.map((chip) => {
          const active = filter === chip.id
          return (
            <button
              key={chip.id}
              onClick={() => setFilter(chip.id)}
              className={cn(
                "px-2.5 h-7 rounded-full text-xs font-medium transition-colors border",
                active
                  ? "bg-linear-accent/15 text-linear-accent border-linear-accent/40"
                  : "border-linear-border text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary"
              )}
            >
              {chip.label}
            </button>
          )
        })}
      </div>

      <div className="flex-1 overflow-y-auto bg-linear-bg">
        {loading ? (
          <div className="divide-y divide-linear-border">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <Skeleton className="mt-1 w-1.5 h-1.5 rounded-full" />
                <Skeleton className="w-7 h-7 rounded-full flex-shrink-0" />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-14 rounded" />
                    <Skeleton className="h-3 w-2/3 rounded" />
                  </div>
                  <Skeleton className="h-2.5 w-32 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Bell}
            title="You're all caught up"
            description={
              filter === 'all'
                ? 'No notifications yet'
                : 'No notifications match this filter'
            }
          />
        ) : (
          <div>
            {BUCKET_ORDER.map((bucket) => {
              const items = grouped[bucket]
              if (items.length === 0) return null
              return (
                <section key={bucket}>
                  <div className="px-4 sm:px-6 py-2 text-[11px] uppercase tracking-wider font-semibold text-linear-text-tertiary bg-linear-bg-secondary/40 sticky top-0 backdrop-blur">
                    {BUCKET_LABEL[bucket]} · {items.length}
                  </div>
                  <div className="divide-y divide-linear-border">
                    {items.map((n) => (
                      <NotificationRow
                        key={n.id}
                        notification={n}
                        onClick={handleNotificationClick}
                        now={now}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
