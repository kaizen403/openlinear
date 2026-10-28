"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import {
  applyNotificationsRead,
  markAllNotificationsRead,
  markNotificationRead,
  notificationsQuery,
  revertNotificationsRead,
  unreadCountQuery,
  type AppNotification,
} from "@/lib/query/notifications"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

const NO_NOTIFICATIONS: AppNotification[] = []

/**
 * The unread count (sidebar badge, inbox header). One cache entry: the inbox
 * list writes its count into it, `notification:created` bumps it, marking
 * read lowers it — the badge used to refetch on every route change and lag
 * behind the inbox until the next navigation.
 */
export function useUnreadNotificationCount(enabled = true) {
  const client = useAppQueryClient()
  const { data } = useQuery({ ...unreadCountQuery(), enabled }, client)
  return enabled ? data ?? 0 : 0
}

/** The inbox list plus optimistic mark-read writes (rolled back if the request fails). */
export function useNotifications() {
  const client = useAppQueryClient()
  const query = useQuery(notificationsQuery(client), client)

  const markRead = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onMutate: (id) => applyNotificationsRead(client, new Set([id]), new Date().toISOString()),
    onError: (error, _id, change) => {
      console.error("Failed to mark notification read:", error)
      if (change) revertNotificationsRead(client, change)
    },
  }, client)

  const markAllRead = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onMutate: () => applyNotificationsRead(client, "all", new Date().toISOString()),
    onError: (error, _variables, change) => {
      console.error("Failed to mark all read:", error)
      if (change) revertNotificationsRead(client, change)
    },
  }, client)

  return {
    notifications: query.data?.items ?? NO_NOTIFICATIONS,
    loading: query.isPending,
    error: query.error,
    errorUpdatedAt: query.errorUpdatedAt,
    markRead: markRead.mutate,
    markAllRead: markAllRead.mutate,
  }
}
