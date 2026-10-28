"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import {
  Inbox, CheckCheck, AtSign, UserPlus, ArrowRightLeft,
  MessageSquare, Bell
} from "lucide-react"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/empty-state"
import { ApprovalInbox } from "@/components/execution/approval-inbox"
import { Skeleton } from "@/components/ui/skeleton"
import { useNotifications, useUnreadNotificationCount } from "@/hooks/use-notifications"
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  FILTER_CHIPS,
  TYPE_META,
  bucketFor,
  timeAgo,
  type AppNotification,
  type Bucket,
  type FilterChip,
  type NotificationType,
} from "./inbox-utils"

const TYPE_ICON: Record<NotificationType, typeof AtSign> = {
  mention: AtSign,
  assignment: UserPlus,
  status_change: ArrowRightLeft,
  comment: MessageSquare,
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
  const Icon = TYPE_ICON[notification.type]
  const unread = notification.readAt === null
  const actorName = notification.actor?.username ?? 'Someone'

  return (
    <button
      onClick={() => onClick(notification)}
      className={cn(
        "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors group",
        "hover:bg-layer-hover",
        unread && "bg-layer-faint"
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
  // The list and the unread count come from the query cache (shared with the
  // sidebar badge); `notification:created` events patch both (SSE bridge).
  const { notifications, loading, error, errorUpdatedAt, markRead, markAllRead } = useNotifications()
  const unreadCount = useUnreadNotificationCount()
  const [filter, setFilter] = useState<FilterChip>('all')
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (error) console.error("Failed to load notifications:", error)
  }, [error, errorUpdatedAt])

  const handleNotificationClick = useCallback((n: AppNotification) => {
    // Optimistic; rolled back if the request fails.
    if (n.readAt === null) markRead(n.id)

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
  }, [markRead, router])

  const handleMarkAllRead = useCallback(() => {
    markAllRead()
  }, [markAllRead])

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

      <div className="flex-1 min-h-0 overflow-y-auto bg-linear-bg">
        <ApprovalInbox />
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
