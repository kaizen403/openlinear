import type { QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/fetch"
import { STALE_TIME } from "./client"
import { queryKeys } from "./keys"

/**
 * Notifications (inbox list + unread badge) in the query cache.
 *
 * Two entries share one source of truth for the unread count:
 * - `unreadCount` — the sidebar badge and the inbox header. Fetched with
 *   `?pageSize=1` (the cheapest read that carries `unreadCount`).
 * - `list(pageSize)` — the inbox. Every list response also writes its
 *   `unreadCount` into the count entry, so opening the inbox never costs a
 *   second count request, and the badge and the header can't disagree.
 *
 * `notification:created` events patch both (sse-bridge → page-caches); marking
 * read patches both optimistically (hooks/use-notifications.ts).
 */

export type NotificationType = "mention" | "assignment" | "status_change" | "comment"

export interface NotificationActor {
  id: string
  username: string
  avatarUrl: string | null
}

export interface AppNotification {
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

export interface NotificationsListResponse {
  items: AppNotification[]
  page: number
  pageSize: number
  total: number
  hasMore: boolean
  unreadCount: number
}

/** The inbox page size (the page has always shown the latest 100). */
export const INBOX_PAGE_SIZE = 100

export async function fetchNotifications(pageSize: number): Promise<NotificationsListResponse> {
  return apiFetch<NotificationsListResponse>(`/api/notifications?pageSize=${pageSize}`)
}

export async function fetchUnreadNotificationCount(): Promise<number> {
  const res = await apiFetch<{ unreadCount?: number }>("/api/notifications?pageSize=1")
  return typeof res.unreadCount === "number" ? res.unreadCount : 0
}

export async function markNotificationRead(id: string): Promise<void> {
  await apiFetch(`/api/notifications/${id}/read`, { method: "PATCH" })
}

export async function markAllNotificationsRead(): Promise<void> {
  await apiFetch("/api/notifications/read-all", { method: "POST" })
}

export function unreadCountQuery() {
  return {
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: (): Promise<number> => fetchUnreadNotificationCount(),
    staleTime: STALE_TIME.notifications,
  }
}

export function notificationsQuery(client: QueryClient, pageSize = INBOX_PAGE_SIZE) {
  return {
    queryKey: queryKeys.notifications.list(pageSize),
    queryFn: async (): Promise<NotificationsListResponse> => {
      const res = await fetchNotifications(pageSize)
      // The list carries the authoritative count: share it with the badge.
      if (typeof res.unreadCount === "number") client.setQueryData(queryKeys.notifications.unreadCount(), res.unreadCount)
      return res
    },
    staleTime: STALE_TIME.notifications,
  }
}

function listQueries(client: QueryClient) {
  return client.getQueryCache().findAll({ queryKey: [...queryKeys.notifications.all(), "list"] })
}

function isListResponse(value: unknown): value is NotificationsListResponse {
  return typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items)
}

function isNotification(value: unknown): value is AppNotification {
  return typeof value === "object" && value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { type?: unknown }).type === "string"
}

/** `notification:created`: prepend to cached lists (once) and count it if unread. */
export function applyNotificationCreated(client: QueryClient, data: unknown): void {
  if (!isNotification(data)) return
  let alreadyKnown = false
  for (const query of listQueries(client)) {
    const list = query.state.data
    if (!isListResponse(list)) continue
    if (list.items.some((item) => item.id === data.id)) {
      alreadyKnown = true
      continue
    }
    client.setQueryData<NotificationsListResponse>(query.queryKey, {
      ...list,
      items: [data, ...list.items],
      total: list.total + 1,
      unreadCount: data.readAt === null ? list.unreadCount + 1 : list.unreadCount,
    })
  }
  if (data.readAt !== null || alreadyKnown) return
  const countKey = queryKeys.notifications.unreadCount()
  const count = client.getQueryData<number>(countKey)
  if (typeof count === "number") client.setQueryData(countKey, count + 1)
}

export interface NotificationReadChange {
  /** Notifications this change flipped from unread to read. */
  readonly ids: ReadonlySet<string>
  readonly readAt: string
  /** How much the unread count went down. */
  readonly decremented: number
}

/**
 * Optimistically mark `ids` (or every notification, `"all"`) read in the
 * cached lists and the unread count. Returns the change, for
 * `revertNotificationsRead` if the request fails.
 */
export function applyNotificationsRead(client: QueryClient, ids: ReadonlySet<string> | "all", readAt: string): NotificationReadChange {
  const flipped = new Set<string>()
  for (const query of listQueries(client)) {
    const list = query.state.data
    if (!isListResponse(list)) continue
    let changed = 0
    const items = list.items.map((item) => {
      if (item.readAt !== null || (ids !== "all" && !ids.has(item.id))) return item
      changed += 1
      flipped.add(item.id)
      return { ...item, readAt }
    })
    if (changed === 0) continue
    client.setQueryData<NotificationsListResponse>(query.queryKey, {
      ...list,
      items,
      unreadCount: ids === "all" ? 0 : Math.max(0, list.unreadCount - changed),
    })
  }
  const countKey = queryKeys.notifications.unreadCount()
  const count = client.getQueryData<number>(countKey)
  let decremented = 0
  if (typeof count === "number") {
    const next = ids === "all" ? 0 : Math.max(0, count - flipped.size)
    decremented = count - next
    if (next !== count) client.setQueryData(countKey, next)
  }
  return { ids: flipped, readAt, decremented }
}

/** Undo `applyNotificationsRead`, keeping anything that changed since (new notifications, other reads). */
export function revertNotificationsRead(client: QueryClient, change: NotificationReadChange): void {
  for (const query of listQueries(client)) {
    const list = query.state.data
    if (!isListResponse(list)) continue
    let restored = 0
    const items = list.items.map((item) => {
      if (!change.ids.has(item.id) || item.readAt !== change.readAt) return item
      restored += 1
      return { ...item, readAt: null }
    })
    if (restored > 0) client.setQueryData<NotificationsListResponse>(query.queryKey, { ...list, items, unreadCount: list.unreadCount + restored })
  }
  if (change.decremented > 0) {
    const countKey = queryKeys.notifications.unreadCount()
    const count = client.getQueryData<number>(countKey)
    if (typeof count === "number") client.setQueryData(countKey, count + change.decremented)
  }
}
