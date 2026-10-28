import { hashKey, replaceEqualDeep, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { ApiError, NetworkError, apiFetch } from "@/lib/api/fetch"
import { isApiErrorCode } from "@/lib/api/errors"
import { fetchMyIssues, fetchProjectIssues } from "@/lib/api/tasks"
import type { MyIssueTask } from "@/lib/api/types"
import { BOARD_STATUSES } from "@/components/board/board-state"
import type { Task } from "@/types/task"
import { STALE_TIME } from "./client"
import { queryKeys, type BoardTaskScope, type MyIssuesScope, type ProjectIssuesScope } from "./keys"
import { BOARD_OWNED_META } from "./sse-bridge"
import { taskFromCreatedEvent, type TaskEventData } from "./task-cache"

/**
 * Board task lists with keyset pagination (`GET /api/tasks?pagination=cursor
 * &view=compact`, ordered `createdAt DESC, id DESC`).
 *
 * The cache entry stays ONE flat `Task[]` per board scope (the key from
 * `queryKeys.tasks.list(scope)`, cursor never in the key), so the SSE bridge,
 * `use-task-sse` and the board's optimistic bulk/rollback code keep working
 * on it unchanged. Paging state lives next to it, per query client and key,
 * for exactly as long as the cache entry exists:
 *
 * - The first page (`scope.pageSize`, all four columns) is one request. When
 *   it has more, every column starts at the first page's cursor.
 * - "Load more" on a column fetches that column's next page
 *   (`status=<column>&cursor=<column cursor>`, BOARD_COLUMN_PAGE_SIZE rows)
 *   and appends it after the column's last loaded task. Each column is
 *   always a prefix of its server order, so the cursor of a combined page is
 *   a valid start for a per-status page (the cursor is a position in the
 *   shared order, not bound to filters — apps/api/src/lib/keyset.ts).
 * - A full (re)load — first load, resync, Retry, stale remount — reloads the
 *   first page and then each column the user had extended, to the same depth
 *   (pages of up to TASK_LIST_MAX_PAGE_SIZE), so a reconnect never collapses
 *   what is on screen.
 *
 * SSE rule for tasks the board has not loaded: see `placeUnloadedBoardTask`.
 */

type TaskStatus = Task["status"]

/** Rows per "Load more" on one column. */
export const BOARD_COLUMN_PAGE_SIZE = 50
/** apps/api/src/schemas/tasks.ts TASK_LIST_MAX_PAGE_SIZE. */
export const TASK_LIST_MAX_PAGE_SIZE = 200

/** A row's position in the API's list order (`createdAt DESC, id DESC`). */
export interface TaskSortKey {
  createdAt: number
  id: string
}

export interface BoardColumnPaging {
  /** Opaque token for this column's next page; null when the column is complete. */
  cursor: string | null
  hasMore: boolean
  /**
   * Position of the last row the server sent for this column's loaded
   * window (taken from the row itself, never decoded from the cursor).
   * Every task of the column that sorts before it is loaded.
   */
  boundary: TaskSortKey | null
  /** Rows this column received through its own pages (re-fetched on a full reload). */
  extraLoaded: number
  loading: boolean
}

export interface BoardPaging {
  columns: Readonly<Record<TaskStatus, BoardColumnPaging>>
}

export interface BoardTaskPage {
  items: Task[]
  hasMore: boolean
  nextCursor: string | null
}

interface TaskListResponse {
  items?: Task[]
  hasMore?: boolean
  nextCursor?: string | null
}

// --- requests ------------------------------------------------------------------

/** `pageSize` stays the first parameter (request matchers in the data-layer bench key on it). */
export function boardTasksPath(
  scope: Pick<BoardTaskScope, "projectId" | "teamId">,
  page: { pageSize: number; status?: TaskStatus; cursor?: string | null },
): string {
  const params = new URLSearchParams({ pageSize: String(page.pageSize), pagination: "cursor", view: "compact" })
  if (scope.projectId) params.set("projectId", scope.projectId)
  if (scope.teamId) params.set("teamId", scope.teamId)
  if (page.status) params.set("status", page.status)
  if (page.cursor) params.set("cursor", page.cursor)
  return `/api/tasks?${params.toString()}`
}

/**
 * One keyset page. `view=compact` omits `executionLogs` (the board never
 * reads them; the detail view fetches the full row, see `fetchQuery(taskDetailQuery)`
 * in use-kanban-board). A response without a `nextCursor` (bare array, or a
 * server without keyset paging) can't be paged further and counts as complete.
 */
export async function fetchBoardTaskPage(
  scope: Pick<BoardTaskScope, "projectId" | "teamId">,
  page: { pageSize: number; status?: TaskStatus; cursor?: string | null },
): Promise<BoardTaskPage> {
  const data = await apiFetch<TaskListResponse | Task[]>(boardTasksPath(scope, page))
  if (Array.isArray(data)) return { items: data, hasMore: false, nextCursor: null }
  const items = Array.isArray(data.items) ? data.items : []
  const nextCursor = typeof data.nextCursor === "string" && data.nextCursor.length > 0 ? data.nextCursor : null
  return { items, hasMore: data.hasMore === true && nextCursor !== null, nextCursor }
}

// --- order and window -------------------------------------------------------------

export function taskSortKey(task: { id?: string; createdAt?: string | null }): TaskSortKey | null {
  if (!task.id || !task.createdAt) return null
  const createdAt = Date.parse(task.createdAt)
  return Number.isNaN(createdAt) ? null : { createdAt, id: task.id }
}

/** Negative when `a` comes first in `createdAt DESC, id DESC` (newer), positive when after. */
export function compareTaskSortKeys(a: TaskSortKey, b: TaskSortKey): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  if (a.id === b.id) return 0
  return a.id > b.id ? -1 : 1
}

/** Whether a task at `key` belongs to the loaded part of a column. */
export function isWithinColumnWindow(column: BoardColumnPaging, key: TaskSortKey): boolean {
  if (!column.hasMore) return true
  return column.boundary !== null && compareTaskSortKeys(key, column.boundary) <= 0
}

function initialColumn(page: BoardTaskPage): BoardColumnPaging {
  const last = page.items.at(-1)
  return {
    cursor: page.hasMore ? page.nextCursor : null,
    hasMore: page.hasMore,
    boundary: page.hasMore && last ? taskSortKey(last) : null,
    extraLoaded: 0,
    loading: false,
  }
}

function pagingFromFirstPage(page: BoardTaskPage): BoardPaging {
  return {
    columns: {
      todo: initialColumn(page),
      in_progress: initialColumn(page),
      done: initialColumn(page),
      cancelled: initialColumn(page),
    },
  }
}

function advanceColumn(column: BoardColumnPaging, page: BoardTaskPage, extraLoaded: number): BoardColumnPaging {
  const last = page.items.at(-1)
  return {
    cursor: page.hasMore ? page.nextCursor : null,
    hasMore: page.hasMore,
    boundary: page.hasMore ? (last ? taskSortKey(last) : column.boundary) : null,
    extraLoaded,
    loading: false,
  }
}

// --- list updaters (pure) --------------------------------------------------------------

/**
 * Append one column's page after that column's last task in the flat list,
 * in page order. Tasks already on the board keep their copy and position: an
 * optimistic or SSE-updated copy is never replaced by an older page copy.
 */
export function mergeColumnPage(list: Task[], status: TaskStatus, items: readonly Task[]): Task[] {
  if (items.length === 0) return list
  const present = new Set(list.map((task) => task.id))
  const added: Task[] = []
  for (const task of items) {
    if (present.has(task.id)) continue
    present.add(task.id)
    added.push(task)
  }
  if (added.length === 0) return list
  let insertAt = list.length
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]!.status === status) {
      insertAt = index + 1
      break
    }
  }
  return [...list.slice(0, insertAt), ...added, ...list.slice(insertAt)]
}

function insertSorted(list: Task[], task: Task, key: TaskSortKey): Task[] {
  let lastOfStatus = -1
  for (let index = 0; index < list.length; index += 1) {
    const candidate = list[index]!
    if (candidate.status !== task.status) continue
    const candidateKey = taskSortKey(candidate)
    if (candidateKey && compareTaskSortKeys(key, candidateKey) < 0) {
      return [...list.slice(0, index), task, ...list.slice(index)]
    }
    lastOfStatus = index
  }
  const at = lastOfStatus === -1 ? list.length : lastOfStatus + 1
  return [...list.slice(0, at), task, ...list.slice(at)]
}

/**
 * The paged-board SSE rule for a `task:updated` about a task the board has
 * NOT loaded (loaded tasks are merged in place by use-task-sse):
 *
 * 1. It must belong to the board's scope by the event's own fields
 *    (project/team match, not archived) and carry `createdAt` — without a
 *    position it is never guessed.
 * 2. It is inserted only when its column is fully loaded, or when it sorts
 *    inside the column's loaded window (at or before the column's boundary).
 *    It goes to its sorted position (`createdAt DESC, id DESC`) among that
 *    column's tasks.
 * 3. Otherwise it is left out: it arrives with that column's next page, in
 *    order. No refetch is triggered.
 *
 * Returns the same array when nothing is inserted.
 */
export function placeUnloadedBoardTask(
  list: Task[],
  paging: BoardPaging | undefined,
  scope: Pick<BoardTaskScope, "projectId" | "teamId">,
  data: TaskEventData,
): Task[] {
  if (!paging || !data.id || !data.createdAt || data.archived === true) return list
  if (scope.projectId !== null && data.projectId !== scope.projectId) return list
  if (scope.teamId !== null && data.teamId !== scope.teamId) return list
  if (list.some((task) => task.id === data.id)) return list
  const task = taskFromCreatedEvent(data)
  const key = task ? taskSortKey(task) : null
  if (!task || !key) return list
  const column = paging.columns[task.status]
  if (!column || !isWithinColumnWindow(column, key)) return list
  return insertSorted(list, task, key)
}

/**
 * A reload keeps every task object whose content is unchanged (matched by
 * id, so a new task at the top doesn't defeat the reuse), and the previous
 * array when nothing changed at all: memoized cards and columns skip.
 */
function preserveTaskIdentity(previous: Task[], next: Task[]): Task[] {
  const byId = new Map(previous.map((task) => [task.id, task]))
  let unchanged = previous.length === next.length
  const result = next.map((task, index) => {
    const old = byId.get(task.id)
    const kept = old ? replaceEqualDeep(old, task) : task
    if (unchanged && previous[index] !== kept) unchanged = false
    return kept
  })
  return unchanged ? previous : result
}

// --- paging registry ------------------------------------------------------------

interface PagingRegistry {
  entries: Map<string, BoardPaging>
  /**
   * Bumped by every full load (not part of the rendered snapshot): a column
   * page started under an older generation belongs to a replaced list and is
   * dropped; a full load that lost the race to a newer one doesn't commit.
   */
  generations: Map<string, number>
  listeners: Map<string, Set<() => void>>
}

const registries = new WeakMap<QueryClient, PagingRegistry>()

function notify(registry: PagingRegistry, hash: string): void {
  const listeners = registry.listeners.get(hash)
  if (listeners) for (const listener of [...listeners]) listener()
}

function registryFor(client: QueryClient): PagingRegistry {
  const existing = registries.get(client)
  if (existing) return existing
  const registry: PagingRegistry = { entries: new Map(), generations: new Map(), listeners: new Map() }
  // Paging lives exactly as long as its list's cache entry (gc, sign-out clear()).
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "removed") return
    const hash = event.query.queryHash
    registry.generations.delete(hash)
    if (registry.entries.delete(hash)) notify(registry, hash)
  })
  registries.set(client, registry)
  return registry
}

export function getBoardPaging(client: QueryClient, queryKey: QueryKey): BoardPaging | undefined {
  return registryFor(client).entries.get(hashKey(queryKey))
}

function currentGeneration(client: QueryClient, queryKey: QueryKey): number {
  return registryFor(client).generations.get(hashKey(queryKey)) ?? 0
}

function nextGeneration(client: QueryClient, queryKey: QueryKey): number {
  const registry = registryFor(client)
  const hash = hashKey(queryKey)
  const generation = (registry.generations.get(hash) ?? 0) + 1
  registry.generations.set(hash, generation)
  return generation
}

function setBoardPaging(client: QueryClient, queryKey: QueryKey, paging: BoardPaging): void {
  const registry = registryFor(client)
  const hash = hashKey(queryKey)
  if (registry.entries.get(hash) === paging) return
  registry.entries.set(hash, paging)
  notify(registry, hash)
}

function setColumnPaging(client: QueryClient, queryKey: QueryKey, status: TaskStatus, column: BoardColumnPaging): void {
  const paging = getBoardPaging(client, queryKey)
  if (!paging) return
  setBoardPaging(client, queryKey, { ...paging, columns: { ...paging.columns, [status]: column } })
}

/** For `useSyncExternalStore`: called whenever the paging of this list changes. */
export function subscribeBoardPaging(client: QueryClient, queryKey: QueryKey, listener: () => void): () => void {
  const registry = registryFor(client)
  const hash = hashKey(queryKey)
  let listeners = registry.listeners.get(hash)
  if (!listeners) {
    listeners = new Set()
    registry.listeners.set(hash, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = registry.listeners.get(hash)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) registry.listeners.delete(hash)
  }
}

// --- loads ------------------------------------------------------------------------

async function reloadColumnDepth(
  scope: BoardTaskScope,
  status: TaskStatus,
  start: BoardColumnPaging,
  depth: number,
): Promise<{ column: BoardColumnPaging; items: Task[] }> {
  let column = start
  const items: Task[] = []
  let remaining = depth
  try {
    while (remaining > 0 && column.hasMore) {
      const page = await fetchBoardTaskPage(scope, {
        status,
        cursor: column.cursor,
        pageSize: Math.min(TASK_LIST_MAX_PAGE_SIZE, remaining),
      })
      items.push(...page.items)
      column = advanceColumn(column, page, column.extraLoaded + page.items.length)
      remaining -= page.items.length
      if (page.items.length === 0) break
    }
  } catch (error) {
    // A failed extra page leaves this column shorter; the board still loads.
    console.error(`Error reloading the ${status} column:`, error)
  }
  return { column, items }
}

/**
 * Full load of a board list (the query function): the first page across all
 * columns (one request), then every column the user had extended, to the
 * same depth. Returns one flat list in board order.
 */
export async function fetchBoardTasks(client: QueryClient, scope: BoardTaskScope): Promise<Task[]> {
  const queryKey = queryKeys.tasks.list(scope)
  const previousPaging = getBoardPaging(client, queryKey)
  // Column pages still in flight belong to the list being replaced.
  const generation = nextGeneration(client, queryKey)

  const first = await fetchBoardTaskPage(scope, { pageSize: scope.pageSize })
  let tasks = first.items
  const columns: Record<TaskStatus, BoardColumnPaging> = { ...pagingFromFirstPage(first).columns }

  if (previousPaging && first.hasMore) {
    const reloads = await Promise.all(BOARD_STATUSES.map(async (status) => ({
      status,
      ...(await reloadColumnDepth(scope, status, columns[status], previousPaging.columns[status].extraLoaded)),
    })))
    for (const { status, column, items } of reloads) {
      tasks = mergeColumnPage(tasks, status, items)
      columns[status] = column
    }
  }

  // A newer full load may have started meanwhile; its paging wins.
  if (currentGeneration(client, queryKey) === generation) setBoardPaging(client, queryKey, { columns })
  const previous = client.getQueryData<Task[]>(queryKey)
  return previous ? preserveTaskIdentity(previous, tasks) : tasks
}

async function fetchColumnPage(
  client: QueryClient,
  scope: BoardTaskScope,
  queryKey: QueryKey,
  status: TaskStatus,
  column: BoardColumnPaging,
): Promise<{ page: BoardTaskPage; restarted: boolean }> {
  try {
    const page = await fetchBoardTaskPage(scope, { status, cursor: column.cursor, pageSize: BOARD_COLUMN_PAGE_SIZE })
    return { page, restarted: false }
  } catch (error) {
    // The API asks clients to restart from the first page when it no longer
    // accepts a cursor: restart this column; rows already shown are skipped
    // on merge.
    if (!isApiErrorCode(error, "INVALID_CURSOR")) throw error
    const loaded = (client.getQueryData<Task[]>(queryKey) ?? []).filter((task) => task.status === status).length
    const page = await fetchBoardTaskPage(scope, {
      status,
      pageSize: Math.min(TASK_LIST_MAX_PAGE_SIZE, loaded + BOARD_COLUMN_PAGE_SIZE),
    })
    return { page, restarted: true }
  }
}

/**
 * "Load more" for one column: one request, appended in place. Resolves to
 * the number of tasks added (0 when the column is complete, already loading,
 * or the list was fully reloaded meanwhile). Errors propagate to the caller.
 */
export async function loadMoreBoardColumn(client: QueryClient, scope: BoardTaskScope, status: TaskStatus): Promise<number> {
  const queryKey = queryKeys.tasks.list(scope)
  const paging = getBoardPaging(client, queryKey)
  const column = paging?.columns[status]
  if (!paging || !column?.hasMore || column.loading) return 0
  const generation = currentGeneration(client, queryKey)
  setColumnPaging(client, queryKey, status, { ...column, loading: true })
  try {
    const { page, restarted } = await fetchColumnPage(client, scope, queryKey, status, column)
    const current = getBoardPaging(client, queryKey)
    if (!current || currentGeneration(client, queryKey) !== generation) return 0
    let added = 0
    client.setQueryData<Task[]>(queryKey, (list) => {
      if (!list) return list
      const next = mergeColumnPage(list, status, page.items)
      added = next.length - list.length
      return next
    })
    const latest = current.columns[status]
    const extraLoaded = latest.extraLoaded + (restarted ? added : page.items.length)
    setColumnPaging(client, queryKey, status, advanceColumn(latest, page, extraLoaded))
    return added
  } finally {
    const current = getBoardPaging(client, queryKey)?.columns[status]
    if (current?.loading) setColumnPaging(client, queryKey, status, { ...current, loading: false })
  }
}

// --- query definitions ------------------------------------------------------------

/** The board's initial-load policy, as before: up to 5 retries, 1.5 s apart, for network and 5xx failures. */
export function shouldRetryBoardFetch(failureCount: number, error: unknown): boolean {
  return failureCount < 5 && (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500))
}

export function boardTasksQuery(client: QueryClient, scope: BoardTaskScope) {
  return {
    queryKey: queryKeys.tasks.list(scope),
    // A resync that returns what we already show keeps every task object
    // (and so every memoized card and column) as it is.
    queryFn: (): Promise<Task[]> => fetchBoardTasks(client, scope),
    staleTime: STALE_TIME.tasks,
    retry: shouldRetryBoardFetch,
    retryDelay: 1500,
    // Writes go through the board's identity-preserving helpers
    // (components/board/board-state.ts); deep-comparing 2,000 tasks on every
    // SSE event would only cost time.
    structuralSharing: false,
    meta: BOARD_OWNED_META,
  }
}

export function myIssuesQuery(scope: MyIssuesScope) {
  return {
    queryKey: queryKeys.tasks.list(scope),
    queryFn: (): Promise<MyIssueTask[]> => fetchMyIssues(scope.filter),
    staleTime: STALE_TIME.tasks,
  }
}

export function projectIssuesQuery(scope: ProjectIssuesScope) {
  return {
    queryKey: queryKeys.tasks.list(scope),
    queryFn: (): Promise<MyIssueTask[]> => fetchProjectIssues(scope.projectId),
    staleTime: STALE_TIME.tasks,
  }
}
