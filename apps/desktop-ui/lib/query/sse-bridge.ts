import type { Query, QueryClient, QueryKey } from "@tanstack/react-query"
import type { EventStreamName } from "@/lib/api/event-stream"
import type { Comment } from "@/lib/api/comments"
import type { ChatSession } from "@/lib/api/chat"
import type { MyIssueTask, Project, Workspace } from "@/lib/api/types"
import type { Label, Task } from "@/types/task"
import {
  projectListParamsFromKey,
  queryKeys,
  taskListScopeFromKey,
  workspaceIdFromKey,
  type TaskListScope,
} from "./keys"
import {
  applyDependencyChange,
  applyLabelToTasks,
  applyTaskCreatedToBoard,
  applyTaskEventToIssueList,
  applyTaskLabelChange,
  applyTaskUpdatedToBoard,
  mergeTaskUpdate,
  removeTasks,
  type ListUpdate,
  type TaskEventData,
} from "./task-cache"
import { applyPageCacheEvent } from "./page-caches"

/**
 * The single SSE → query-cache bridge.
 *
 * Every domain event that changes cached server state is applied here:
 * precise `setQueryData` patches where the payload is enough (task, project,
 * workspace, comment, label, chat-session and settings events), targeted
 * invalidation where it isn't (team and membership events, a task entering a
 * server-filtered list), and a resync when the stream (re)connects or reports
 * a replay gap. Events reach this module through `useSSESubscription`, after
 * the provider's (stream, id) dedupe.
 *
 * Board lists that a mounted board is showing are owned by that board's own
 * handler (hooks/use-task-sse.ts, which also clears selection and execution
 * state); the bridge skips them for the event types the board handles, so
 * no event is applied twice. Unmounted (cached) boards are patched here.
 */

export type BridgeEventType = string

export interface BridgeEventMeta {
  stream: EventStreamName
  id: string | null
}

/** Query meta marking the list a mounted board applies task events to itself. */
export const BOARD_OWNED_META = { owner: "board" } as const

/** Events the mounted board's handler applies to its own list (see use-task-sse / use-kanban-board). */
const BOARD_HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "task:created",
  "task:updated",
  "task:deleted",
  "tasks:bulk-created",
  "tasks:bulk-deleted",
  "batch:completed",
  "connected",
  "replay-gap",
])

function isActiveBoardList(query: Query): boolean {
  return query.meta?.owner === BOARD_OWNED_META.owner && query.getObserversCount() > 0
}

/**
 * Invalidations requested by events are coalesced per key and flushed once per
 * window, so a burst of 100 events costs at most one refetch per list. A
 * flush cancels a refetch already in flight for that key: its response may
 * predate the event that requested the invalidation.
 */
export class CoalescedInvalidator {
  private pending = new Map<string, QueryKey>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly client: QueryClient,
    private readonly windowMs = 50,
  ) {}

  queue(queryKey: QueryKey): void {
    this.pending.set(JSON.stringify(queryKey), queryKey)
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.windowMs)
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const keys = [...this.pending.values()]
    this.pending.clear()
    for (const queryKey of keys) {
      void this.client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: true })
    }
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }
}

export interface BridgeState {
  readonly invalidator: CoalescedInvalidator
  /** Streams that already delivered `connected` in this session. */
  readonly connectedStreams: Set<EventStreamName>
  /** The signed-in user (decides "assigned to me"/"created by me" membership). */
  currentUserId: string | null
}

export function createBridgeState(client: QueryClient, options: { windowMs?: number } = {}): BridgeState {
  return {
    invalidator: new CoalescedInvalidator(client, options.windowMs),
    connectedStreams: new Set(),
    currentUserId: null,
  }
}

// --- helpers -------------------------------------------------------------

function taskListQueries(client: QueryClient, eventType: string): Array<{ query: Query; scope: TaskListScope }> {
  const result: Array<{ query: Query; scope: TaskListScope }> = []
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.tasks.lists() })) {
    const scope = taskListScopeFromKey(query.queryKey)
    if (!scope) continue
    if (scope.kind === "board" && BOARD_HANDLED_EVENTS.has(eventType) && isActiveBoardList(query)) continue
    result.push({ query, scope })
  }
  return result
}

function commitListUpdate<T>(client: QueryClient, state: BridgeState, query: Query, update: ListUpdate<T>, previous: T[]): void {
  if (update.next !== previous) client.setQueryData(query.queryKey, update.next)
  if (update.stale) state.invalidator.queue(query.queryKey)
}

function listData<T>(query: Query): T[] | undefined {
  const data = query.state.data
  return Array.isArray(data) ? (data as T[]) : undefined
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readTaskIds(data: Record<string, unknown>): string[] {
  const raw = data.taskIds
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []
}

function isLabel(value: unknown): value is Label {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { name?: unknown }).name === "string"
}

function sortLabels(labels: Label[]): Label[] {
  return [...labels].sort((a, b) => a.priority - b.priority)
}

/** Remove a task's own queries (detail, comments) that nothing is showing. */
function forgetTask(client: QueryClient, taskId: string): void {
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.tasks.detail(taskId) })) {
    if (query.getObserversCount() === 0) client.getQueryCache().remove(query)
  }
}

function patchTaskDetail(client: QueryClient, taskId: string, update: (task: Task) => Task): void {
  const key = queryKeys.tasks.detail(taskId)
  const existing = client.getQueryData<Task>(key)
  if (!existing) return
  const next = update(existing)
  if (next !== existing) client.setQueryData(key, next)
}

// --- resync ----------------------------------------------------------------

function resync(client: QueryClient, scope: "tasks" | "all"): void {
  void client.invalidateQueries(
    {
      predicate: (query) => {
        if (scope === "tasks" && query.queryKey[1] !== "tasks") return false
        // A mounted board resyncs its own list (use-task-sse → fetchTasks).
        return !isActiveBoardList(query)
      },
    },
    // Dedupe: a fetch already in flight (e.g. the initial load racing the
    // first `connected`) is reused instead of being aborted and re-sent.
    { cancelRefetch: false },
  )
}

// --- the bridge -------------------------------------------------------------

export function applySseEventToCache(
  client: QueryClient,
  eventType: BridgeEventType,
  rawData: Record<string, unknown>,
  meta: BridgeEventMeta | undefined,
  state: BridgeState,
): void {
  const stream: EventStreamName = meta?.stream ?? "cloud"
  const data = rawData

  // Page-level entries (teams, team/project settings, inbox, archive): page-caches.ts.
  applyPageCacheEvent(client, eventType, data, (queryKey) => state.invalidator.queue(queryKey))

  switch (eventType) {
    case "connected": {
      const reconnect = state.connectedStreams.has(stream)
      state.connectedStreams.add(stream)
      if (stream === "cloud") resync(client, reconnect ? "all" : "tasks")
      else if (reconnect) resync(client, "tasks")
      return
    }
    case "replay-gap":
      resync(client, stream === "cloud" ? "all" : "tasks")
      return

    // --- tasks ---------------------------------------------------------------
    case "task:created":
    case "task:updated": {
      const event = data as TaskEventData
      for (const { query, scope } of taskListQueries(client, eventType)) {
        if (scope.kind === "board") {
          const list = listData<Task>(query)
          if (!list) continue
          const update = eventType === "task:created"
            ? applyTaskCreatedToBoard(list, scope, event)
            : applyTaskUpdatedToBoard(list, scope, event)
          commitListUpdate(client, state, query, update, list)
        } else {
          const list = listData<MyIssueTask>(query)
          if (!list) continue
          commitListUpdate(client, state, query, applyTaskEventToIssueList(list, scope, eventType, event, state.currentUserId), list)
        }
      }
      if (eventType === "task:updated" && event.id) patchTaskDetail(client, event.id, (task) => mergeTaskUpdate(task, event))
      return
    }
    case "task:deleted": {
      const id = stringField(data, "id")
      if (!id) return
      const ids = new Set([id])
      for (const { query } of taskListQueries(client, eventType)) {
        const list = listData<{ id: string }>(query)
        if (list) commitListUpdate(client, state, query, removeTasks(list, ids), list)
      }
      forgetTask(client, id)
      return
    }
    case "tasks:bulk-deleted": {
      const ids = new Set(readTaskIds(data))
      if (ids.size === 0) return
      for (const { query } of taskListQueries(client, eventType)) {
        const list = listData<{ id: string }>(query)
        if (list) commitListUpdate(client, state, query, removeTasks(list, ids), list)
      }
      for (const id of ids) forgetTask(client, id)
      return
    }
    case "tasks:bulk-created": {
      // Only ids are sent: refetch the lists that can contain them.
      const projectId = stringField(data, "projectId")
      for (const { query, scope } of taskListQueries(client, eventType)) {
        const affected =
          scope.kind === "mine" ||
          (scope.kind === "project-issues" && scope.projectId === projectId) ||
          (scope.kind === "board" && (scope.projectId === null || scope.projectId === projectId))
        if (affected) state.invalidator.queue(query.queryKey)
      }
      return
    }
    case "tasks:bulk-updated":
      // The server follows every bulk update with one `task:updated` per task.
      return
    case "batch:completed": {
      const batchId = stringField(data, "batchId")
      const prUrl = stringField(data, "prUrl")
      if (!batchId || !prUrl) return
      for (const { query, scope } of taskListQueries(client, eventType)) {
        if (scope.kind !== "board") continue
        const list = listData<Task>(query)
        if (!list?.some((task) => task.batchId === batchId)) continue
        client.setQueryData(query.queryKey, list.map((task) => (task.batchId === batchId ? { ...task, prUrl } : task)))
      }
      return
    }

    // --- plans (W17b) ----------------------------------------------------------------
    case "plan:created":
    case "plan:revised":
    case "plan:approved":
    case "plan:archived": {
      const projectId = stringField(data, "projectId")
      const planId = stringField(data, "planId")
      if (projectId) state.invalidator.queue(queryKeys.plans.list(projectId))
      if (planId) void client.invalidateQueries({ queryKey: queryKeys.plans.details(planId) })
      return
    }

    // --- recurring issues (W20) --------------------------------------------------------
    case "schedule:created":
    case "schedule:updated":
    case "schedule:deleted": {
      const projectId = stringField(data, "projectId")
      const scheduleId = stringField(data, "scheduleId")
      if (projectId) state.invalidator.queue(queryKeys.schedules.list(projectId))
      if (scheduleId) void client.invalidateQueries({ queryKey: queryKeys.schedules.detail(scheduleId) })
      return
    }

    // --- webhooks (FE-14) -------------------------------------------------------------
    case "webhook:created":
    case "webhook:updated":
    case "webhook:deleted": {
      const projectId = stringField(data, "projectId")
      const webhookId = stringField(data, "webhookId")
      const workspaceId = stringField(data, "workspaceId")
      if (projectId) void client.invalidateQueries({ queryKey: queryKeys.webhooks.project(projectId) })
      if (workspaceId) void client.invalidateQueries({ queryKey: queryKeys.webhooks.workspace(workspaceId) })
      if (webhookId) void client.invalidateQueries({ queryKey: queryKeys.webhooks.endpoint(webhookId) })
      return
    }

    // --- project knowledge (W19b) --------------------------------------------------
    case "knowledge:changed": {
      const projectId = stringField(data, "projectId")
      const entryId = stringField(data, "entryId")
      if (projectId) state.invalidator.queue(queryKeys.knowledge.list(projectId))
      if (entryId) void client.invalidateQueries({ queryKey: queryKeys.knowledge.detail(entryId) })
      return
    }

    // --- dependencies (W17a) -------------------------------------------------------
    case "task:dependencies": {
      const taskId = stringField(data, "taskId")
      const dependsOnTaskId = stringField(data, "dependsOnTaskId")
      const kind = stringField(data, "change")
      if (!taskId || !dependsOnTaskId || (kind !== "added" && kind !== "removed")) return
      state.invalidator.queue(queryKeys.tasks.dependencies(taskId))
      state.invalidator.queue(queryKeys.tasks.dependencies(dependsOnTaskId))
      for (const { query } of taskListQueries(client, eventType)) {
        const list = listData<Task>(query)
        if (list) commitListUpdate(client, state, query, applyDependencyChange(list, { taskId, dependsOnTaskId, kind }), list)
      }
      return
    }

    // --- labels ----------------------------------------------------------------
    case "task:label:assigned":
    case "task:label:removed": {
      const taskId = stringField(data, "taskId")
      if (!taskId) return
      let change: { add: Label } | { removeId: string } | null = null
      if (eventType === "task:label:assigned" && isLabel(data.label)) change = { add: data.label }
      const labelId = stringField(data, "labelId")
      if (eventType === "task:label:removed" && labelId) change = { removeId: labelId }
      if (!change) return
      const labelChange = change
      for (const { query } of taskListQueries(client, eventType)) {
        const list = listData<Task>(query)
        if (list) commitListUpdate(client, state, query, applyTaskLabelChange(list, taskId, labelChange), list)
      }
      patchTaskDetail(client, taskId, (task) => (
        Array.isArray(task.labels) ? applyTaskLabelChange([task], taskId, labelChange).next[0] ?? task : task
      ))
      return
    }
    case "label:created": {
      if (!isLabel(data)) return
      const projectId = stringField(data, "projectId")
      if (!projectId) return
      const label = data
      const key = queryKeys.projects.labels(projectId)
      const labels = client.getQueryData<Label[]>(key)
      if (labels && !labels.some((existing) => existing.id === label.id)) {
        client.setQueryData(key, sortLabels([...labels, label]))
      }
      return
    }
    case "label:updated":
    case "label:deleted": {
      const labelId = stringField(data, "id")
      if (!labelId) return
      const change: { update: Label } | { removeId: string } | null =
        eventType === "label:updated" ? (isLabel(data) ? { update: data } : null) : { removeId: labelId }
      if (!change) return
      for (const query of client.getQueryCache().findAll({
        predicate: (q) => q.queryKey[0] === "ol" && q.queryKey[1] === "project" && q.queryKey[3] === "labels",
      })) {
        const labels = listData<Label>(query)
        if (!labels) continue
        const next = "update" in change
          ? (labels.some((label) => label.id === labelId)
            ? sortLabels(labels.map((label) => (label.id === labelId ? { ...label, ...change.update } : label)))
            : labels)
          : labels.filter((label) => label.id !== labelId)
        if (next.length !== labels.length || next.some((label, i) => label !== labels[i])) client.setQueryData(query.queryKey, next)
      }
      for (const { query } of taskListQueries(client, eventType)) {
        const list = listData<Task>(query)
        if (list) commitListUpdate(client, state, query, applyLabelToTasks(list, change), list)
      }
      for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.tasks.details() })) {
        if (query.queryKey.length !== 4) continue
        const task = query.state.data as Task | undefined
        if (!task || !Array.isArray(task.labels)) continue
        const update = applyLabelToTasks([task], change)
        if (update.next[0] && update.next[0] !== task) client.setQueryData(query.queryKey, update.next[0])
      }
      return
    }

    // --- comments ---------------------------------------------------------------
    case "comment:created":
    case "comment:updated":
    case "comment:deleted": {
      const taskId = stringField(data, "taskId")
      if (!taskId) return
      const key = queryKeys.tasks.comments(taskId)
      const comments = client.getQueryData<Comment[]>(key)
      if (!comments) return
      const comment = data.comment as Comment | undefined
      if (eventType === "comment:created" && comment?.id) {
        if (!comments.some((c) => c.id === comment.id)) client.setQueryData(key, [...comments, comment])
      } else if (eventType === "comment:updated" && comment?.id) {
        if (comments.some((c) => c.id === comment.id)) client.setQueryData(key, comments.map((c) => (c.id === comment.id ? comment : c)))
      } else if (eventType === "comment:deleted") {
        const id = stringField(data, "id")
        if (id && comments.some((c) => c.id === id)) client.setQueryData(key, comments.filter((c) => c.id !== id))
      }
      return
    }

    // --- projects ---------------------------------------------------------------
    case "project:created": {
      const project = data as unknown as Project
      if (!project?.id) return
      for (const query of client.getQueryCache().findAll({ predicate: isProjectListQuery })) {
        if (workspaceIdFromKey(query.queryKey) !== project.workspaceId) continue
        const list = listData<Project>(query)
        if (!list) continue
        if (projectListParamsFromKey(query.queryKey)?.teamId === null && !list.some((p) => p.id === project.id)) {
          client.setQueryData(query.queryKey, [...list, project])
        }
        // Server-computed fields (`_count`, `teams`) and team filters: refetch.
        state.invalidator.queue(query.queryKey)
      }
      return
    }
    case "project:updated": {
      const project = data as unknown as Project
      if (!project?.id) return
      for (const query of client.getQueryCache().findAll({ predicate: isProjectListQuery })) {
        const list = listData<Project>(query)
        if (!list?.some((p) => p.id === project.id)) continue
        client.setQueryData(query.queryKey, list.map((p) => (p.id === project.id ? { ...p, ...project } : p)))
      }
      return
    }
    case "project:deleted": {
      const id = stringField(data, "id") ?? stringField(data, "projectId")
      if (!id) return
      for (const query of client.getQueryCache().findAll({ predicate: isProjectListQuery })) {
        const list = listData<Project>(query)
        if (list?.some((p) => p.id === id)) client.setQueryData(query.queryKey, list.filter((p) => p.id !== id))
      }
      return
    }
    case "project:access-changed":
      for (const query of client.getQueryCache().findAll({ predicate: (q) => isProjectListQuery(q) || isTeamListQuery(q) })) {
        state.invalidator.queue(query.queryKey)
      }
      return

    // --- teams ------------------------------------------------------------------
    case "team:created":
    case "team:updated":
    case "team:deleted":
    case "team:joined":
    case "team:left":
    case "team:member-added":
    case "team:member-updated":
    case "team:member-removed": {
      const teamId = stringField(data, "teamId") ?? (eventType.startsWith("team:member-") ? null : stringField(data, "id"))
      for (const query of client.getQueryCache().findAll({
        predicate: (q) =>
          isTeamListQuery(q) ||
          // The full team (`detail`) is patched from the payload in page-caches.ts.
          (q.queryKey[1] === "team" && q.queryKey[3] !== "detail" && (teamId === null || q.queryKey[2] === teamId)) ||
          // Project lists embed `teams`: a team appearing or disappearing changes them.
          ((eventType === "team:created" || eventType === "team:deleted") && isProjectListQuery(q)),
      })) {
        state.invalidator.queue(query.queryKey)
      }
      return
    }

    // --- workspaces ---------------------------------------------------------------
    case "workspace:joined":
    case "workspace:updated": {
      const workspace = data as unknown as Workspace
      if (!workspace?.id) return
      const key = queryKeys.workspaces.list()
      const list = client.getQueryData<Workspace[]>(key)
      if (!list) return
      if (eventType === "workspace:joined") {
        client.setQueryData(key, list.some((w) => w.id === workspace.id)
          ? list.map((w) => (w.id === workspace.id ? workspace : w))
          : [...list, workspace])
      } else if (list.some((w) => w.id === workspace.id)) {
        client.setQueryData(key, list.map((w) => (w.id === workspace.id ? { ...w, ...workspace } : w)))
      }
      return
    }
    case "workspace:left":
    case "workspace:deleted": {
      const id = stringField(data, "workspaceId") ?? stringField(data, "id")
      if (!id) return
      const key = queryKeys.workspaces.list()
      const list = client.getQueryData<Workspace[]>(key)
      if (list?.some((w) => w.id === id)) client.setQueryData(key, list.filter((w) => w.id !== id))
      for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.workspaces.scope(id) })) {
        if (query.getObserversCount() === 0) client.getQueryCache().remove(query)
      }
      return
    }
    case "workspace:member-added":
    case "workspace:member-updated":
    case "workspace:member-removed":
      // Member lists are patched from the payload (or refetched when it can't
      // be applied) in page-caches.ts, which also owns Settings → Members.
      return

    // --- chat sessions -------------------------------------------------------------
    case "chat:session:updated": {
      const session = data as unknown as ChatSession
      if (!session?.id || !session.workspaceId) return
      const key = queryKeys.workspaces.chatSessions(session.workspaceId)
      const list = client.getQueryData<ChatSession[]>(key)
      if (list?.some((s) => s.id === session.id)) {
        client.setQueryData(key, list.map((s) => (s.id === session.id ? { ...s, ...session } : s)))
      }
      return
    }

    // --- settings -----------------------------------------------------------------
    case "settings:updated": {
      const key = queryKeys.settings()
      const settings = client.getQueryData<Record<string, unknown>>(key)
      if (settings) client.setQueryData(key, { ...settings, ...data })
      return
    }

    default:
      return
  }
}

/**
 * A task this client just created (form or chat): insert it into every cached
 * board list whose scope it belongs to — including a mounted board — and
 * refetch issue lists that may now contain it. Idempotent with the
 * `task:created` event that follows.
 */
export function writeCreatedTaskToCache(client: QueryClient, task: Task): void {
  const event: TaskEventData = task
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.tasks.lists() })) {
    const scope = taskListScopeFromKey(query.queryKey)
    if (!scope) continue
    if (scope.kind === "board") {
      const list = listData<Task>(query)
      if (!list) continue
      const update = applyTaskCreatedToBoard(list, scope, event)
      if (update.next !== list) client.setQueryData(query.queryKey, update.next)
    } else if (scope.kind === "mine" || scope.projectId === task.projectId) {
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true })
    }
  }
}

function isProjectListQuery(query: Query): boolean {
  return query.queryKey[0] === "ol" && query.queryKey[1] === "ws" && query.queryKey[3] === "projects"
}

function isTeamListQuery(query: Query): boolean {
  return query.queryKey[0] === "ol" && query.queryKey[1] === "ws" && query.queryKey[3] === "teams"
}
