"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useSSESubscription } from "@/providers/sse-provider"
import { apiFetch } from "@/lib/api/fetch"
import { toast } from "sonner"

export interface NotificationActor {
  id: string
  username: string
  avatarUrl: string | null
}

export interface Notification {
  id: string
  userId: string
  type: string
  taskId?: string | null
  commentId?: string | null
  actorUserId?: string | null
  actor?: NotificationActor | null
  body: string
  readAt: string | null
  createdAt: string
}

interface NotificationsResponse {
  data: Notification[]
  total: number
  page: number
  pageSize: number
  unreadCount: number
}

export function useNotifications() {
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(true)

  const fetchNotifications = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<NotificationsResponse>("/api/notifications?page=1&pageSize=20")
      if (mountedRef.current) {
        setNotifications(res.data)
        setUnreadCount(res.unreadCount)
      }
    } catch {
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await apiFetch<NotificationsResponse>("/api/notifications?page=1&pageSize=1&unreadOnly=1")
      if (mountedRef.current) {
        setUnreadCount(res.unreadCount)
      }
    } catch {
    }
  }, [])

  const markRead = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: "PATCH" })
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, readAt: new Date().toISOString() } : n))
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch {
    }
  }, [])

  const markAllRead = useCallback(async () => {
    try {
      await apiFetch("/api/notifications/read-all", { method: "POST" })
      setNotifications(prev => prev.map(n => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })))
      setUnreadCount(0)
    } catch {
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchUnreadCount()
    return () => { mountedRef.current = false }
  }, [fetchUnreadCount])

  useSSESubscription(useCallback((eventType, data) => {
    if (eventType === "notification:created") {
      const notification = data as unknown as Notification
      setUnreadCount(prev => prev + 1)
      setNotifications(prev => [notification, ...prev].slice(0, 20))

      const actorName = notification.actor?.username ?? "Someone"
      toast(notification.body, {
        description: actorName,
        duration: 5000,
        action: notification.taskId ? {
          label: "View",
          onClick: () => {
            window.location.href = `/projects/board?task=${notification.taskId}`
          },
        } : undefined,
      })
    }
  }, []))

  return {
    unreadCount,
    notifications,
    loading,
    markRead,
    markAllRead,
    refetch: fetchNotifications,
  }
}
