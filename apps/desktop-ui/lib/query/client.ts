import { QueryClient, notifyManager } from "@tanstack/react-query"
import { ApiError, AuthExpiredError, NetworkError } from "@/lib/api/fetch"
import { describeApiError } from "@/lib/api/errors"

/**
 * Cache notifications are delivered synchronously (TanStack's default is a
 * `setTimeout(0)` per batch). Every hook migrated here replaced a `useState`;
 * synchronous delivery keeps exactly the old update timing — an optimistic
 * board write is visible in the same React batch, `act()` flushes it, and
 * one SSE event still means one React update. React itself still batches the
 * resulting renders. Nothing in this app subscribes to the QueryCache during
 * render, which is the case the deferred default guards against.
 */
notifyManager.setScheduler((callback) => callback())

/** Freshness per resource (ms). SSE keeps cached data current between fetches. */
export const STALE_TIME = {
  /** Rarely changes; SSE `workspace:*` patches the list. */
  workspaces: 5 * 60_000,
  /** SSE `workspace:member-*` invalidates. */
  members: 5 * 60_000,
  /** SSE `project:*` patches the lists. */
  projects: 60_000,
  /** SSE `team:*` invalidates. */
  teams: 60_000,
  /** SSE `label:*` patches; the old picker cached labels for the whole session. */
  labels: 5 * 60_000,
  /** SSE `chat:session:updated` patches. */
  chatSessions: 30_000,
  /** SSE `task:*` patches every cached list; `connected` resyncs. */
  tasks: 30_000,
  /** SSE `task:updated` / `comment:*` patch. */
  taskDetail: 30_000,
  /** SSE `settings:updated` patches. */
  settings: 5 * 60_000,
  /** SSE `team:*` patches the full team (team settings, Settings → Members, Teams page). */
  teamDetail: 60_000,
  /** SSE `project:*` / `project:access-changed` patch (project settings). */
  projectDetail: 60_000,
  /** SSE `project:*`, `team:*` and `workspace:member-*` mark it stale. */
  workspaceStructure: 60_000,
  /** SSE `notification:created` patches the list and the unread count. */
  notifications: 30_000,
  /** SSE `task:deleted` (archiving) marks it stale. */
  archivedTasks: 30_000,
} as const

const MAX_QUERY_RETRIES = 2
const MAX_RETRY_DELAY_MS = 30_000

/**
 * Whether a failed query read should be retried. Mirrors the error map in
 * lib/api/errors.ts: never a 4xx (auth, validation, permission, not found),
 * except 408 (timeout) and 429 (rate limited); always transient network and
 * 5xx failures, up to `MAX_QUERY_RETRIES` times. Unknown errors (bugs,
 * parse failures) are not retried.
 */
export function isRetryableQueryError(error: unknown): boolean {
  if (error instanceof AuthExpiredError) return false
  if (error instanceof NetworkError) return true
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return false
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_QUERY_RETRIES && isRetryableQueryError(error)
}

/** Server-provided wait (Retry-After / RATE_LIMITED details) when known, else 1 s, 2 s, 4 s … capped at 8 s. */
export function queryRetryDelay(failureCount: number, error: unknown): number {
  const { retryAfterMs } = describeApiError(error)
  if (error instanceof ApiError && typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS)
  }
  return Math.min(1000 * 2 ** failureCount, 8000)
}

/**
 * The app's QueryClient defaults.
 *
 * - No refetch on window focus or on `online`: the desktop webview fires focus
 *   constantly, and the SSE bridge already resynchronizes on every stream
 *   (re)connect, which is what both triggers would approximate.
 * - `networkMode: 'always'`: requests always go out (the sidecar is local and
 *   `navigator.onLine` is unreliable in webviews); failures surface exactly as
 *   they did before the migration.
 * - Mutations never retry automatically: writes that may be retried carry an
 *   Idempotency-Key and use `sendWithIdempotencyKey` explicitly.
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        networkMode: "always",
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
      },
      mutations: {
        networkMode: "always",
        retry: false,
      },
    },
  })
}
