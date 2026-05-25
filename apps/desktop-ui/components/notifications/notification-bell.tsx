"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Bell, CheckCheck } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useNotifications, type Notification } from "@/hooks/use-notifications"
import { cn } from "@/lib/utils"

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const date = new Date(dateStr).getTime()
  const diff = now - date
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

function NotificationItem({
  notification,
  onClickNotification,
}: {
  notification: Notification
  onClickNotification: (n: Notification) => void
}) {
  const isUnread = !notification.readAt
  return (
    <button
      type="button"
      onClick={() => onClickNotification(notification)}
      className={cn(
        "w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-linear-bg-tertiary/50 rounded-sm",
        isUnread && "bg-linear-bg-tertiary/30"
      )}
    >
      <Avatar className="h-7 w-7 flex-shrink-0 mt-0.5">
        <AvatarImage src={notification.actor?.avatarUrl ?? undefined} />
        <AvatarFallback className="text-[10px] bg-linear-bg-secondary text-linear-text-secondary">
          {notification.actor?.username?.charAt(0).toUpperCase() ?? "?"}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className={cn("text-xs leading-relaxed", isUnread ? "text-linear-text" : "text-linear-text-secondary")}>
          {notification.body}
        </p>
        <p className="text-[11px] text-linear-text-tertiary mt-0.5">
          {formatRelativeTime(notification.createdAt)}
        </p>
      </div>
      {isUnread && (
        <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-2" />
      )}
    </button>
  )
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const { unreadCount, notifications, markRead, markAllRead, refetch } = useNotifications()

  const handleOpen = useCallback((isOpen: boolean) => {
    setOpen(isOpen)
    if (isOpen) refetch()
  }, [refetch])

  const handleClickNotification = useCallback((notification: Notification) => {
    if (!notification.readAt) {
      markRead(notification.id)
    }
    setOpen(false)
    if (notification.taskId) {
      router.push(`/projects/board?task=${notification.taskId}`)
    }
  }, [markRead, router])

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative p-1.5 rounded-sm text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50 transition-colors"
          aria-label="Notifications"
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-medium px-1">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-0 bg-linear-bg-secondary border-linear-border shadow-xl"
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-linear-border">
          <h3 className="text-sm font-medium text-linear-text">Notifications</h3>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="flex items-center gap-1 text-[11px] text-linear-text-secondary hover:text-linear-text transition-colors"
            >
              <CheckCheck className="w-3.5 h-3.5" />
              Mark all read
            </button>
          )}
        </div>
        <ScrollArea className="max-h-80">
          {notifications.length === 0 ? (
            <div className="py-8 text-center text-xs text-linear-text-tertiary">
              No notifications yet
            </div>
          ) : (
            <div className="py-1">
              {notifications.map((n) => (
                <NotificationItem
                  key={n.id}
                  notification={n}
                  onClickNotification={handleClickNotification}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
