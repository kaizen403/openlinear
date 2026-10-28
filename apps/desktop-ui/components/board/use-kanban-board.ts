import { useState, useEffect, useCallback, useRef, useDeferredValue, useMemo, useSyncExternalStore, type Dispatch, type SetStateAction } from "react"
import { DropResult } from "@hello-pangea/dnd"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { useAuth } from "@/hooks/use-auth"
import { Project } from "@/lib/api"
import type { Repository } from "@/lib/api"
import { Task, ExecutionProgress, ExecutionLogEntry, isActiveProgressStatus } from "@/types/task"
import { apiFetch, ApiError } from "@/lib/api/fetch"
import { boardTaskScope, queryKeys } from "@/lib/query/keys"
import { maxBatchSizeOf, settingsQuery, taskDetailQuery, type UserSettings } from "@/lib/query/resources"
import {
  boardTasksQuery,
  getBoardPaging,
  loadMoreBoardColumn,
  placeUnloadedBoardTask,
  subscribeBoardPaging,
  type BoardPaging,
} from "@/lib/query/task-queries"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { getSetupStatus, OpenCodeUnavailableError } from "@/lib/api/opencode"
import { isModelNotConfiguredApiError } from "@/lib/api/model-errors"
import { formatApiError, toastApiError } from "@/lib/api/errors"
import { createIdempotencyKey, sendWithIdempotencyKey } from "@/lib/api/idempotency"
import { createTaskWithKey } from "@/lib/api/task-commands"
import { refreshTaskPr } from "@/lib/api/tasks"
import { blockedByFromError, dependencyLabel, fetchBlockerClosure, runWithBlockersProblem } from "@/lib/api/task-dependencies"
import { useSSESubscription, type SSEEventData, type SSEEventType } from "@/providers/sse-provider"
import {
  clearExecutionProgress,
  getExecutionProgress,
  hasExecutionLogs,
  replaceExecutionLogs,
} from "@/lib/execution-state-store"
import type { BatchMode } from "./batch-mode"
import {
  applyBoardStatusChange,
  bucketTasksByStatus,
  getLockedBatchTaskIds,
  moveBoardTask,
  removeBoardTasks,
  replaceBoardTasks,
  replaceOptimisticTask,
  restoreRemovedTasks,
  stabilizeBuckets,
  upsertBoardTask,
  type TaskBuckets,
} from "./board-state"
import {
  bulkFailureTitle,
  describeBulkAction,
  isPersistedTaskId,
  pluralTasks,
  runBulkAction,
  summarizeBulkFailures,
  type BulkAction,
} from "./bulk-actions"
import type { BatchPublication } from "./execution-outcome"
import { useStableCallback } from "./use-stable-callback"
import { isTerminalBatchStatus } from "./batch-state"
import { useTaskSelection } from "@/hooks/use-task-selection"
import { useBatchExecution } from "@/hooks/use-batch-execution"
import { useTaskSSE } from "@/hooks/use-task-sse"

export const COLUMNS = [
  { id: 'todo', title: 'All Issues', status: 'todo' as const },
  { id: 'in_progress', title: 'In Progress', status: 'in_progress' as const },
  { id: 'done', title: 'Done', status: 'done' as const },
  { id: 'cancelled', title: 'Cancelled', status: 'cancelled' as const },
]

export interface ActiveBatchTask {
  taskId: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
  /** Batch/attempt branch; known once the batch detail has been fetched. */
  branch?: string
  error?: string | null
  /** The provider never confirmed the stop; the member's workspace stays reserved. */
  cancelUnconfirmed?: boolean
}

export interface ActiveBatch {
  id: string
  status: string
  mode: BatchMode
  tasks: ActiveBatchTask[]
  prUrl: string | null
  publication?: BatchPublication | null
}

/**
 * A task is "actively executing" when the sidecar is reporting live progress
 * in an active phase.
 */
export function isTaskActivelyExecuting(
  task: Pick<Task, 'status'> | null | undefined,
  progress: ExecutionProgress | undefined,
  pendingExecuteIds?: Set<string> | null,
  taskId?: string | null,
): boolean {
  if (!task) return false
  if (taskId && pendingExecuteIds?.has(taskId)) return true
  if (!progress) return false
  return isActiveProgressStatus(progress.status)
}

export interface KanbanBoardProps {
  projectId?: string | null
  teamId?: string | null
  projects?: Project[]
  searchQuery?: string
}

/** Per-column paging as the board renders it. */
export interface BoardColumnPageState {
  /** The server has more tasks for this column than are loaded. */
  hasMore: boolean
  loading: boolean
}

export type BoardColumnPageStates = Readonly<Record<Task['status'], BoardColumnPageState>>

export interface UseKanbanBoardReturn {
  tasks: Task[]
  /** Visible (search-filtered) tasks per column; unchanged columns keep their array identity. */
  tasksByStatus: TaskBuckets
  tasksById: ReadonlyMap<string, Task>
  loading: boolean
  error: string | null
  /** Keyset paging per column; a column's entry keeps its identity while unchanged. */
  columnPaging: BoardColumnPageStates
  /** Some column has tasks that are not loaded yet. */
  hasMoreTasks: boolean
  /** Fetch the next page of one column (one request; no-op while loading or complete). */
  loadMoreTasks: (status: Task['status']) => Promise<void>
  isTaskFormOpen: boolean
  setIsTaskFormOpen: (open: boolean) => void
  defaultStatus: Task['status']
  selectedTaskId: string | null
  selectedTaskIds: Set<string>
  selectionActive: boolean
  selectingColumns: Set<string>
  activeBatch: ActiveBatch | null
  setActiveBatch: (batch: ActiveBatch | null) => void
  /** The live batch, or the last finished one until it is dismissed. */
  displayedBatch: ActiveBatch | null
  dismissBatch: () => void
  completedBatch: { taskIds: string[]; prUrl: string | null; mode: BatchMode } | null
  canExecute: boolean
  activeRepository: Repository | null
  selectedProject: Project | undefined
  batchTaskIds: string[]
  batchTaskIdSet: ReadonlySet<string>
  completedBatchTaskIds: string[]
  selectedTask: Task | null
  startingExecuteIds: Set<string>
  isSelectedTaskExecuting: boolean
  getTasksByStatus: (status: Task['status']) => Task[]
  handleAddTask: (status: Task['status']) => void
  handleDragEnd: (result: DropResult) => void
  handleExecute: (taskId: string) => Promise<void>
  /** Resolves true once the sidecar accepted the stop. */
  handleCancel: (taskId: string) => Promise<boolean>
  handleTaskClick: (taskId: string) => Promise<void>
  handleDrawerClose: () => void
  handleDelete: (taskId: string) => Promise<void>
  handleUpdateTask: (taskId: string, data: { title?: string; description?: string | null }) => Promise<void>
  handleMoveToInProgress: (taskId: string) => Promise<void>
  handleBatchMoveToInProgress: () => Promise<void>
  handleBatchExecute: (mode: BatchMode) => Promise<void>
  /** FE-10: run a blocked task together with its unfinished blockers (one parallel batch, blockers first). */
  handleRunWithBlockers: (taskId: string) => Promise<void>
  /** "Run ready": one batch of open, unblocked tasks (priority first), within the batch size. */
  handleRunReady: (taskIds: string[]) => Promise<void>
  handleCancelBatch: (batchId: string) => Promise<boolean>
  handleApproveNextBatchTask: (batchId: string) => Promise<void>
  handleCheckPullRequest: (taskId: string) => Promise<void>
  toggleTaskSelect: (taskId: string, modifiers?: { shift?: boolean; meta?: boolean }) => void
  toggleColumnSelection: (columnId: string) => void
  toggleColumnSelectAll: (status: Task['status']) => void
  selectAllVisible: () => void
  clearSelection: () => void
  handleInlineCreateTask: (status: Task['status'], title: string) => Promise<void>
  handleTaskCreated: (task: Task) => void
  handleBulkDelete: () => Promise<void>
  /** Change status of the selection, or of `taskIds` when given (e.g. the open task). */
  handleBulkChangeStatus: (status: Task['status'], taskIds?: string[]) => Promise<void>
  fetchTasks: (options?: {
    showLoading?: boolean
    allowRetry?: boolean
    clearError?: boolean
    resetRetry?: boolean
    silent?: boolean
  }) => Promise<void>
  showProviderSetup: boolean
  setShowProviderSetup: (show: boolean) => void
  handleProviderSetupComplete: () => void
  taskDeletionMode: "archive" | "delete"
}

function isNotRunningError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'TASK_NOT_RUNNING' || /\bnot running\b/i.test(err.message))
}

function readTaskIds(data: SSEEventData): string[] {
  const raw = data.taskIds
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
}

const NO_TASKS: Task[] = []

function readDeletionMode(settings: UserSettings | undefined): "archive" | "delete" {
  return settings?.taskDeletionMode === 'delete' ? 'delete' : 'archive'
}

const COMPLETE_COLUMN: BoardColumnPageState = { hasMore: false, loading: false }
const COMPLETE_COLUMNS: BoardColumnPageStates = {
  todo: COMPLETE_COLUMN,
  in_progress: COMPLETE_COLUMN,
  done: COMPLETE_COLUMN,
  cancelled: COMPLETE_COLUMN,
}

function columnPageState(paging: BoardPaging | undefined, status: Task['status'], previous: BoardColumnPageState): BoardColumnPageState {
  const column = paging?.columns[status]
  const hasMore = column?.hasMore ?? false
  const loading = column?.loading ?? false
  return previous.hasMore === hasMore && previous.loading === loading ? previous : { hasMore, loading }
}

const LOG_ENTRY_TYPES: ReadonlySet<string> = new Set(['info', 'agent', 'tool', 'error', 'success'])

function isExecutionLogEntry(value: unknown): value is ExecutionLogEntry {
  if (typeof value !== 'object' || value === null) return false
  if (!('timestamp' in value) || !('type' in value) || !('message' in value)) return false
  return typeof value.timestamp === 'string' && typeof value.message === 'string' &&
    typeof value.type === 'string' && LOG_ENTRY_TYPES.has(value.type)
}

/** Persisted `executionLogs` of a full task row (`GET /api/tasks/:id`); compact list rows don't carry them. */
export function readPersistedExecutionLogs(detail: unknown): ExecutionLogEntry[] {
  if (typeof detail !== 'object' || detail === null || !('executionLogs' in detail)) return []
  const raw = detail.executionLogs
  return Array.isArray(raw) ? raw.filter(isExecutionLogEntry) : []
}

export function useKanbanBoard({ projectId, teamId, projects = [], searchQuery = "" }: KanbanBoardProps): UseKanbanBoardReturn {
  // --- Server state (query cache) ---
  // The board's task list is the cache entry for its scope. Every write below
  // (optimistic updates, rollbacks, server copies, SSE patches from
  // use-task-sse) goes through `setTasks`, which writes that entry, so the
  // board keeps its exact optimistic/rollback semantics while switching
  // projects re-uses cached lists and other views see the same tasks.
  const client = useAppQueryClient()
  const scope = useMemo(() => boardTaskScope(projectId, teamId), [projectId, teamId])
  const boardKey = useMemo(() => queryKeys.tasks.list(scope), [scope])
  const boardKeyRef = useRef(boardKey)
  boardKeyRef.current = boardKey
  const boardQuery = useQuery(boardTasksQuery(client, scope), client)
  const tasks = boardQuery.data ?? NO_TASKS
  const loading = boardQuery.isPending
  const boardError = boardQuery.status === 'error' && boardQuery.data === undefined ? boardQuery.error : null
  const error = boardError ? formatApiError(boardError, 'Failed to fetch tasks') : null

  const setTasks = useCallback<Dispatch<SetStateAction<Task[]>>>((action) => {
    client.setQueryData<Task[]>(boardKeyRef.current, (prev) => {
      // Nothing loaded yet: the initial fetch in flight will bring the list.
      if (prev === undefined) return undefined
      return typeof action === 'function' ? action(prev) : action
    })
  }, [client])

  // --- Paging (keyset, per column; see lib/query/task-queries.ts) ---
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const subscribePaging = useCallback(
    (listener: () => void) => subscribeBoardPaging(client, boardKey, listener),
    [client, boardKey],
  )
  const getPaging = useCallback(() => getBoardPaging(client, boardKey), [client, boardKey])
  const paging = useSyncExternalStore(subscribePaging, getPaging, getPaging)
  const columnPagingRef = useRef<BoardColumnPageStates>(COMPLETE_COLUMNS)
  const columnPaging = useMemo<BoardColumnPageStates>(() => {
    const previous = columnPagingRef.current
    const next = {
      todo: columnPageState(paging, 'todo', previous.todo),
      in_progress: columnPageState(paging, 'in_progress', previous.in_progress),
      done: columnPageState(paging, 'done', previous.done),
      cancelled: columnPageState(paging, 'cancelled', previous.cancelled),
    }
    const unchanged = next.todo === previous.todo && next.in_progress === previous.in_progress &&
      next.done === previous.done && next.cancelled === previous.cancelled
    columnPagingRef.current = unchanged ? previous : next
    return columnPagingRef.current
  }, [paging])
  const hasMoreTasks = columnPaging.todo.hasMore || columnPaging.in_progress.hasMore ||
    columnPaging.done.hasMore || columnPaging.cancelled.hasMore

  /**
   * "Load more" (explicit, per column — not scroll-triggered): the board has
   * no virtualization (@hello-pangea/dnd measures every Draggable), and its
   * search/assignee filters are client-side, so an auto-loading sentinel
   * could chain requests through every page of a filtered column. One click,
   * one request, BOARD_COLUMN_PAGE_SIZE more cards.
   */
  const loadMoreTasks = useStableCallback(async (status: Task['status']) => {
    try {
      await loadMoreBoardColumn(client, scopeRef.current, status)
    } catch (err) {
      console.error('Error loading more tasks:', err)
      toastApiError(err, { fallbackMessage: "Couldn't load more tasks" })
    }
  })

  const { data: settings } = useQuery(settingsQuery(), client)
  const taskDeletionMode = readDeletionMode(settings)
  const setTaskDeletionMode = useCallback<Dispatch<SetStateAction<"archive" | "delete">>>((action) => {
    client.setQueryData<UserSettings>(queryKeys.settings(), (prev) => {
      const current = readDeletionMode(prev)
      const next = typeof action === 'function' ? action(current) : action
      return next === current && prev ? prev : { ...(prev ?? {}), taskDeletionMode: next }
    })
  }, [client])

  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [defaultStatus, setDefaultStatus] = useState<Task['status']>('todo')
  const [activeBatch, setActiveBatch] = useState<ActiveBatch | null>(null)
  const activeBatchRef = useRef(activeBatch)
  activeBatchRef.current = activeBatch
  const [showProviderSetup, setShowProviderSetup] = useState(false)
  const [pendingExecuteTaskId, setPendingExecuteTaskId] = useState<string | null>(null)
  const [startingExecuteIds, setStartingExecuteIds] = useState<Set<string>>(new Set())
  const tasksRef = useRef(tasks)
  const taskDeletionModeRef = useRef(taskDeletionMode)
  tasksRef.current = tasks
  taskDeletionModeRef.current = taskDeletionMode

  const { isAuthenticated, activeRepository, refreshActiveRepository } = useAuth()

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const filteredTasks = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase()
    if (q.length < 1) return tasks
    return tasks.filter((task) => {
      const title = (task.title || "").toLowerCase()
      const identifier = (task.identifier || "").toLowerCase()
      return title.includes(q) || identifier.includes(q)
    })
  }, [tasks, deferredSearchQuery])

  const filteredTasksRef = useRef(filteredTasks)
  filteredTasksRef.current = filteredTasks

  // One pass for all four columns; columns whose tasks didn't change keep the
  // previous array so memoized columns skip the re-render (see KanbanBoard).
  const bucketsRef = useRef<TaskBuckets | null>(null)
  const tasksByStatus = useMemo(() => {
    const next = stabilizeBuckets(bucketsRef.current, bucketTasksByStatus(filteredTasks))
    bucketsRef.current = next
    return next
  }, [filteredTasks])

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const tasksByIdRef = useRef(tasksById)
  tasksByIdRef.current = tasksById

  // --- Batch Execution ---
  // batchTaskIds only ever depends on `activeBatch` (see getLockedBatchTaskIds),
  // so it's computed up front to break the circular dependency between
  // useBatchExecution (needs the real selection handlers) and useTaskSelection
  // (needs batchTaskIds) — without constructing a second, throwaway
  // useBatchExecution instance just to read this value.
  const batchTaskIdSet = useMemo(() => getLockedBatchTaskIds(activeBatch), [activeBatch])
  const batchTaskIds = useMemo(() => Array.from(batchTaskIdSet), [batchTaskIdSet])
  const batchTaskIdSetRef = useRef(batchTaskIdSet)
  batchTaskIdSetRef.current = batchTaskIdSet

  // --- Task Selection ---
  const selection = useTaskSelection({
    tasks,
    filteredTasks,
    batchTaskIds,
  })

  const batchWithSelection = useBatchExecution({
    tasks,
    selectedTaskIds: selection.selectedTaskIds,
    activeBatch,
    setActiveBatch,
    clearSelection: selection.clearSelection,
    setTasks,
    setShowProviderSetup,
    setSelectedTaskIds: selection.setSelectedTaskIds,
  })

  const { completedBatchTaskIds, completedBatch, setCompletedBatch, settledBatch, dismissSettledBatch } = batchWithSelection

  const selectedTaskIdsRef = useRef(selection.selectedTaskIds)
  selectedTaskIdsRef.current = selection.selectedTaskIds
  const selectedTaskIdRef = useRef(selection.selectedTaskId)
  selectedTaskIdRef.current = selection.selectedTaskId

  const addStartingExecute = useCallback((taskId: string) => {
    setStartingExecuteIds(prev => {
      const next = new Set(prev)
      next.add(taskId)
      return next
    })
  }, [])
  const removeStartingExecute = useCallback((taskId: string) => {
    setStartingExecuteIds(prev => {
      if (!prev.has(taskId)) return prev
      const next = new Set(prev)
      next.delete(taskId)
      return next
    })
  }, [])
  const startingExecuteIdsRef = useRef(startingExecuteIds)
  startingExecuteIdsRef.current = startingExecuteIds

  // Reset on scope change
  useEffect(() => {
    selection.setSelectedTaskId(null)
    selection.clearSelection()
  }, [projectId, teamId, deferredSearchQuery])

  const getFullDestinationIndex = useCallback((taskId: string, status: Task['status'], visibleIndex: number) => {
    const visibleDestinationTasks = filteredTasksRef.current.filter(
      (task) => task.status === status && task.id !== taskId,
    )
    const targetTask = visibleDestinationTasks[visibleIndex]
    if (!targetTask) {
      return tasksRef.current.filter((task) => task.status === status && task.id !== taskId).length
    }
    return tasksRef.current
      .filter((task) => task.status === status && task.id !== taskId)
      .findIndex((task) => task.id === targetTask.id)
  }, [])

  const selectedProject = projects.find(p => p.id === projectId)
  const canExecute = !!(selectedProject?.repositoryId || selectedProject?.localPath || activeRepository)

  const handleAddTask = useStableCallback((status: Task['status']) => {
    setDefaultStatus(status)
    setIsTaskFormOpen(true)
  })

  // --- Fetch Tasks ---
  // The query performs the initial load (with the old 5 × 1.5 s retry for
  // network/5xx failures) and keeps the list cached per scope. `fetchTasks`
  // refetches it: SSE resyncs pass `silent`, the error screen's Retry doesn't.
  // A fetch already in flight is reused, never duplicated.
  const lastFetchSilentRef = useRef(false)
  const fetchTasks = useCallback(async (options?: {
    showLoading?: boolean
    allowRetry?: boolean
    clearError?: boolean
    resetRetry?: boolean
    silent?: boolean
  }) => {
    lastFetchSilentRef.current = Boolean(options?.silent)
    await client.refetchQueries({ queryKey: boardKeyRef.current, exact: true }, { cancelRefetch: false })
  }, [client])

  // A failed load with nothing to show: error screen plus one toast (none for 401 or silent resyncs).
  const boardErrorUpdatedAt = boardQuery.errorUpdatedAt
  useEffect(() => {
    if (!boardError || lastFetchSilentRef.current) return
    if (!(boardError instanceof ApiError && boardError.status === 401)) toastApiError(boardError, { fallbackMessage: 'Failed to fetch tasks' })
  }, [boardError, boardErrorUpdatedAt])

  // --- SSE ---
  /**
   * The single removal path for remote deletes. The API announces a bulk
   * delete as `tasks:bulk-deleted` AND one `task:deleted` per task (same
   * commit); whichever arrives first removes the task, later announcements
   * find nothing on the board and write nothing (no second cache write, no
   * selection churn, no toast). Reads the cache, not a render-time ref: the
   * announcements are dispatched back to back, before React re-renders.
   */
  const removeTasksFromBoard = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return
    const removed = new Set(ids)
    removed.forEach(clearExecutionProgress)
    const current = client.getQueryData<Task[]>(boardKeyRef.current)
    if (current?.some((task) => removed.has(task.id))) {
      setTasks((prev) => removeBoardTasks(prev, removed))
    }
    if ([...selectedTaskIdsRef.current].some((id) => removed.has(id))) {
      selection.setSelectedTaskIds((prev) => {
        if (![...prev].some((id) => removed.has(id))) return prev
        return new Set([...prev].filter((id) => !removed.has(id)))
      })
    }
    if (selectedTaskIdRef.current && removed.has(selectedTaskIdRef.current)) {
      selection.setSelectedTaskId((prev) => (prev && removed.has(prev) ? null : prev))
    }
    if (selection.lastSelectedIdRef.current && removed.has(selection.lastSelectedIdRef.current)) {
      selection.lastSelectedIdRef.current = null
    }
  }, [client, setTasks, selection.setSelectedTaskIds, selection.setSelectedTaskId, selection.lastSelectedIdRef])

  useTaskSSE({
    projectId,
    teamId,
    isAuthenticated,
    refreshActiveRepository,
    fetchTasks,
    reconcileActiveBatches: batchWithSelection.reconcileActiveBatches,
    setTasks,
    setSelectedTaskId: selection.setSelectedTaskId,
    setSelectedTaskIds: selection.setSelectedTaskIds,
    setActiveBatch,
    setCompletedBatch,
    setTaskDeletionMode,
    lastSelectedIdRef: selection.lastSelectedIdRef,
    onTasksRemoved: removeTasksFromBoard,
  })

  // Board events use-task-sse doesn't cover. Registered after it, so for a
  // `task:updated` it already merged a loaded task; this only places a task
  // the board hasn't loaded, by the paged-board rule (placeUnloadedBoardTask).
  const handleBoardEvent = useCallback((eventType: SSEEventType, data: SSEEventData) => {
    const type: string = eventType
    if (type === 'tasks:bulk-deleted') {
      // Team-scope payloads carry `projectId: null`; ids not on this board are no-ops.
      removeTasksFromBoard(readTaskIds(data))
      return
    }
    if (type !== 'task:updated' || !data.id) return
    const current = client.getQueryData<Task[]>(boardKeyRef.current)
    if (!current) return
    const next = placeUnloadedBoardTask(current, getBoardPaging(client, boardKeyRef.current), scopeRef.current, data)
    if (next !== current) setTasks(next)
  }, [client, removeTasksFromBoard, setTasks])
  useSSESubscription(handleBoardEvent)

  // --- Initial load ---
  // Tasks and settings load through their queries above (cached per scope; a
  // remount or a switch back to a project shows the cached list at once).

  // --- Visibility ---
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (isAuthenticated) refreshActiveRepository()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleVisibility)
    return () => { document.removeEventListener('visibilitychange', handleVisibility); window.removeEventListener('focus', handleVisibility) }
  }, [isAuthenticated, refreshActiveRepository])

  // --- Task Operations ---

  /** One task, one PATCH /api/tasks/:id (drag, "Move" button, single shortcut). */
  const updateTaskStatus = useStableCallback(async (taskId: string, newStatus: Task['status'], options: { destinationIndex?: number } = {}) => {
    const before = tasksRef.current
    if (!before.some((task) => task.id === taskId)) return
    setTasks((prev) => {
      if (options.destinationIndex !== undefined) {
        const destinationIndex = getFullDestinationIndex(taskId, newStatus, options.destinationIndex)
        return moveBoardTask(prev, taskId, newStatus, destinationIndex)
      }
      return prev.map((task) => (task.id === taskId ? applyBoardStatusChange(task, newStatus) : task))
    })
    if (newStatus !== 'in_progress') clearExecutionProgress(taskId)
    try {
      const updated = await apiFetch<Task>(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) })
      setTasks((prev) => replaceBoardTasks(prev, [updated]))
    } catch (err) {
      const rollback = new Set([taskId])
      setTasks((prev) => restoreRemovedTasks(prev.filter((task) => task.id !== taskId), before, rollback))
      console.error('Error updating task:', err)
      toastApiError(err, { fallbackMessage: 'Failed to update task' })
    }
  })

  /**
   * Bulk status/archive/delete through the bulk endpoints: optimistic update,
   * then per-item reconciliation — server copies replace updated tasks, only
   * the failed items roll back, and they stay selected for a retry.
   */
  const runBoardBulkAction = useStableCallback(async (
    action: BulkAction,
    ids: readonly string[],
    options: { clearedSelection?: boolean } = {},
  ) => {
    const selectionAtStart = selectedTaskIdsRef.current
    const before = tasksRef.current
    const beforeById = tasksByIdRef.current
    const targetIds = [...new Set(ids)].filter((id) => isPersistedTaskId(id) && beforeById.has(id))
    if (targetIds.length === 0) return
    const targets = new Set(targetIds)
    const previousById = new Map(targetIds.map((id) => [id, beforeById.get(id)!]))

    if (action.kind === 'status') {
      setTasks((prev) => prev.map((task) => (targets.has(task.id) ? applyBoardStatusChange(task, action.status) : task)))
      if (action.status !== 'in_progress') targetIds.forEach(clearExecutionProgress)
    } else {
      setTasks((prev) => prev.filter((task) => !targets.has(task.id)))
    }

    const outcome = await runBulkAction(action, targetIds, beforeById)
    const failedIds = new Set(outcome.failed.map((item) => item.id))

    setTasks((prev) => {
      if (action.kind !== 'status') return failedIds.size > 0 ? restoreRemovedTasks(prev, before, failedIds) : prev
      let next = replaceBoardTasks(prev, outcome.updatedTasks)
      if (failedIds.size > 0) {
        next = next.map((task) => (failedIds.has(task.id) ? previousById.get(task.id) ?? task : task))
      }
      return next
    })

    const { past } = describeBulkAction(action)
    if (failedIds.size === 0) {
      if (action.kind !== 'status') toast.success(`${past} ${pluralTasks(targetIds.length)}`)
      return
    }

    // Re-select the failed items for a retry, unless the user already started
    // a new selection while the request was in flight.
    const keepSelected = [...failedIds].filter((id) => previousById.has(id))
    const current = selectedTaskIdsRef.current
    const reselected = keepSelected.length > 0 &&
      (current.size === 0 || (Boolean(options.clearedSelection) && current === selectionAtStart))
    if (reselected) {
      selection.setSelectedTaskIds((prev) => (prev.size === 0 ? new Set(keepSelected) : prev))
    }

    const labelFor = (id: string) => {
      const task = previousById.get(id)
      return task?.identifier || task?.title || id.slice(0, 8)
    }
    const itemFailures = outcome.failed.filter((item) => item.source === 'item')
    const parts = [
      outcome.requestError ? formatApiError(outcome.requestError) : null,
      itemFailures.length > 0 ? summarizeBulkFailures(itemFailures, labelFor) : null,
      reselected ? `${failedIds.size === 1 ? "It's" : "They're"} still selected so you can retry.` : null,
    ].filter((part): part is string => Boolean(part))
    const title = bulkFailureTitle(action, failedIds.size, targetIds.length)
    toast.error(title, parts.length > 0 ? { description: parts.join(' ') } : undefined)
  })

  /** Selected ids minus tasks locked by a running batch. */
  const selectedUnlockedIds = useCallback(() => {
    const locked = batchTaskIdSetRef.current
    return Array.from(selectedTaskIdsRef.current).filter((id) => !locked.has(id))
  }, [])

  const handleMoveToInProgress = useStableCallback(async (taskId: string) => { await updateTaskStatus(taskId, 'in_progress') })

  const handleBatchMoveToInProgress = useStableCallback(async () => {
    const byId = tasksByIdRef.current
    const todoIds = selectedUnlockedIds().filter((id) => byId.get(id)?.status === 'todo')
    if (todoIds.length === 0) return
    selection.clearSelection()
    if (todoIds.length === 1) await updateTaskStatus(todoIds[0]!, 'in_progress')
    else await runBoardBulkAction({ kind: 'status', status: 'in_progress' }, todoIds, { clearedSelection: true })
  })

  const handleInlineCreateTask = useStableCallback(async (status: Task['status'], title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const optimistic: Task = { id: tempId, title: trimmed, description: null, priority: 'medium', status, sessionId: null, createdAt: now, updatedAt: now, labels: [], executionStartedAt: null, executionPausedAt: null, executionElapsedMs: 0, executionProgress: null, prUrl: null, outcome: null, batchId: null, inboxRead: false, identifier: null, number: null, dueDate: null, projectId: projectId ?? null, teamId: teamId ?? null, model: null, archived: false }
    setTasks(prev => [optimistic, ...prev])
    // One key per inline create; automatic retries resend it, so a lost
    // response can't create the task twice (W04a).
    const idempotencyKey = createIdempotencyKey()
    const body = { title: trimmed, status, projectId: projectId || undefined, teamId: teamId || undefined }
    try {
      const created = await sendWithIdempotencyKey(idempotencyKey, (key) => createTaskWithKey(body, key))
      setTasks(prev => replaceOptimisticTask(prev, tempId, created))
    } catch (err) {
      setTasks(prev => prev.filter(t => t.id !== tempId))
      console.error('Error creating task inline:', err)
      toastApiError(err, { fallbackMessage: 'Failed to create task' })
    }
  })

  const handleTaskCreated = useCallback((task: Task) => { setTasks((prev) => upsertBoardTask(prev, task)) }, [])

  const handleBulkDelete = useStableCallback(async () => {
    const ids = selectedUnlockedIds()
    if (ids.length === 0) return
    selection.clearSelection()
    await runBoardBulkAction(taskDeletionModeRef.current === 'delete' ? { kind: 'delete' } : { kind: 'archive' }, ids, { clearedSelection: true })
  })

  const handleBulkChangeStatus = useStableCallback(async (newStatus: Task['status'], taskIds?: string[]) => {
    const locked = batchTaskIdSetRef.current
    const ids = taskIds ? taskIds.filter((id) => !locked.has(id)) : selectedUnlockedIds()
    if (ids.length === 0) return
    if (!taskIds) selection.clearSelection()
    if (ids.length === 1) {
      await updateTaskStatus(ids[0]!, newStatus)
      return
    }
    await runBoardBulkAction({ kind: 'status', status: newStatus }, ids, { clearedSelection: !taskIds })
  })

  const handleDragEnd = useStableCallback(async (result: DropResult) => {
    const { destination, source, draggableId } = result
    if (!destination) return
    if (destination.droppableId === source.droppableId && destination.index === source.index) return
    const newStatus = destination.droppableId as Task['status']
    if (draggableId.startsWith('batch-group-')) {
      const batchId = draggableId.replace('batch-group-', '')
      const ids = tasksRef.current.filter(task => task.batchId === batchId).map(task => task.id)
      if (ids.length === 0) return
      await runBoardBulkAction({ kind: 'status', status: newStatus }, ids)
      return
    }
    await updateTaskStatus(draggableId, newStatus, { destinationIndex: destination.index })
  })

  const startExecution = async (taskId: string, options: { allowBlocked?: boolean } = {}) => {
    try {
      await apiFetch(`/api/tasks/${taskId}/execute`, {
        method: 'POST',
        sidecar: true,
        ...(options.allowBlocked ? { body: JSON.stringify({ allowBlocked: true }) } : {}),
      })
    } catch (err) {
      if (isModelNotConfiguredApiError(err)) {
        setPendingExecuteTaskId(taskId)
        setShowProviderSetup(true)
        toast.error(err.message)
        return
      }
      // W17a: open blockers — run them first (FE-10), or run it anyway.
      const blockers = blockedByFromError(err)
      if (blockers) {
        const names = blockers.slice(0, 3).map(dependencyLabel).join(', ')
        toast.error(names ? `Blocked by ${names}${blockers.length > 3 ? ` and ${blockers.length - 3} more` : ''}` : 'This task is blocked', {
          description: 'Run its blockers first in one batch, or run it anyway.',
          action: { label: 'Run with blockers', onClick: () => { void handleRunWithBlockers(taskId) } },
          cancel: { label: 'Run anyway', onClick: () => { void runAnyway(taskId) } },
        })
        return
      }
      console.error('Error executing task:', err)
      toastApiError(err, { fallbackMessage: 'Failed to execute task' })
    }
  }

  const handleRunReady = useStableCallback(async (taskIds: string[]) => {
    if (!canExecute) { toast.error("No active project — connect a repo first"); return }
    const live = activeBatchRef.current
    if (live && !isTerminalBatchStatus(live.status)) {
      toast.error('A batch is already running', { description: 'Run the ready tasks when it finishes.' })
      return
    }
    if (taskIds.length === 0) return
    await batchWithSelection.handleBatchExecuteTasks(taskIds, 'parallel')
  })

  const handleRunWithBlockers = useStableCallback(async (taskId: string) => {
    if (!canExecute) { toast.error("No active project — connect a repo first"); return }
    const live = activeBatchRef.current
    if (live && !isTerminalBatchStatus(live.status)) {
      toast.error('A batch is already running', { description: 'Run this task with its blockers when it finishes.' })
      return
    }
    let closure: Awaited<ReturnType<typeof fetchBlockerClosure>>
    try {
      closure = await fetchBlockerClosure(taskId)
    } catch (err) {
      toastApiError(err, { fallbackMessage: "Couldn't read the task's blockers" })
      return
    }
    const byId = tasksByIdRef.current
    const problem = runWithBlockersProblem(closure, (id) => {
      const task = byId.get(id)
      return !!task && task.status === 'in_progress' && !!task.sessionId
    }, maxBatchSizeOf(client.getQueryData<UserSettings>(queryKeys.settings())))
    if (problem) {
      toast.error("Can't run it with its blockers", { description: problem })
      return
    }
    if (closure.tasks.length === 0) {
      // Nothing left to wait for (a blocker finished meanwhile): just run it.
      await startExecution(taskId)
      return
    }
    // The batch orders members so blockers run first and starts this task only after they succeed.
    await batchWithSelection.handleBatchExecuteTasks([...closure.tasks.map((task) => task.id), taskId], 'parallel')
  })

  const runAnyway = async (taskId: string) => {
    if (startingExecuteIdsRef.current.has(taskId)) return
    addStartingExecute(taskId)
    try { await startExecution(taskId, { allowBlocked: true }) }
    finally { removeStartingExecute(taskId) }
  }

  const handleExecute = useStableCallback(async (taskId: string) => {
    if (!canExecute) { toast.error("No active project — connect a repo first"); return }
    if (startingExecuteIdsRef.current.has(taskId)) return
    const live = getExecutionProgress(taskId)
    if (live && isActiveProgressStatus(live.status)) return
    addStartingExecute(taskId)
    try {
      try {
        const status = await getSetupStatus()
        if (!status.ready) {
          setPendingExecuteTaskId(taskId)
          setShowProviderSetup(true)
          if (status.hasProvider && !status.hasModel) {
            toast.error('Pick a model in Settings → AI Providers before executing')
          }
          return
        }
      } catch (err) {
        if (err instanceof OpenCodeUnavailableError) { toast.error('Execution service is not running. Start the sidecar (pnpm dev) or switch off CRUD-only mode.'); console.error('Setup status check failed (sidecar unavailable):', err); return }
        console.warn('Could not check provider setup, proceeding anyway:', err)
      }
      await startExecution(taskId)
    } finally { removeStartingExecute(taskId) }
  })

  const handleProviderSetupComplete = useStableCallback(async () => {
    setShowProviderSetup(false)
    if (pendingExecuteTaskId) {
      const taskId = pendingExecuteTaskId
      setPendingExecuteTaskId(null)
      addStartingExecute(taskId)
      try { await startExecution(taskId) }
      finally { removeStartingExecute(taskId) }
    }
  })

  const handleCancel = useStableCallback(async (taskId: string): Promise<boolean> => {
    try {
      await apiFetch(`/api/tasks/${taskId}/cancel`, { method: 'POST', sidecar: true })
      return true
    } catch (err) {
      console.error('Error cancelling task:', err)
      toastApiError(err, {
        fallbackMessage: 'Failed to cancel task',
        ...(isNotRunningError(err) ? {} : { action: { label: 'Retry stop', onClick: () => { void handleCancel(taskId) } } }),
      })
      return false
    }
  })

  const handleTaskClick = useStableCallback(async (taskId: string) => {
    selection.clearSelection()
    selection.setSelectedTaskId(taskId)
    // Board rows are compact (no `executionLogs`): opening a task loads its
    // full row. Same cache entry as the comments thread, so an open costs at
    // most one detail request (none while it is fresh), kept live by SSE.
    const detail = client.fetchQuery(taskDetailQuery(taskId)).catch((err: unknown) => {
      console.error('Error fetching task detail:', err)
      return null
    })
    if (hasExecutionLogs(taskId)) return
    let logs: ExecutionLogEntry[] | null = null
    try {
      const data = await apiFetch<{ logs?: ExecutionLogEntry[] }>(`/api/tasks/${taskId}/logs`, { sidecar: true })
      logs = data.logs || []
    } catch (err) {
      console.error('Error fetching task logs:', err)
    }
    // No live history from the sidecar (offline, or a run it no longer
    // holds): fall back to the logs persisted on the task row.
    if (!logs || logs.length === 0) {
      const persisted = readPersistedExecutionLogs(await detail)
      if (persisted.length > 0) logs = persisted
    }
    if (logs) replaceExecutionLogs(taskId, logs)
  })

  const handleDrawerClose = useStableCallback(() => { selection.setSelectedTaskId(null) })

  const handleDelete = useStableCallback(async (taskId: string) => {
    const previousTasks = tasksRef.current
    const previousSelectedTaskId = selectedTaskIdRef.current
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
    selection.setSelectedTaskId(null)
    const permanent = taskDeletionModeRef.current === "delete"
    try { await apiFetch(`/api/tasks/${taskId}${permanent ? "?permanent=true" : ""}`, { method: 'DELETE' }) }
    catch (err) {
      setTasks((prev) => restoreRemovedTasks(prev, previousTasks, new Set([taskId])))
      selection.setSelectedTaskId(previousSelectedTaskId)
      console.error('Error deleting task:', err)
      toastApiError(err, { fallbackMessage: permanent ? 'Failed to delete task' : 'Failed to archive task' })
    }
  })

  const handleUpdateTask = useStableCallback(async (taskId: string, data: { title?: string; description?: string | null; agent?: string | null }) => {
    try { await apiFetch(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(data) }) }
    catch (err) { console.error('Error updating task:', err); toastApiError(err, { fallbackMessage: 'Failed to update task' }) }
  })

  const handleCheckPullRequest = useStableCallback(async (taskId: string) => {
    try {
      const result = await refreshTaskPr(taskId)
      if (result.refreshed && result.prUrl) {
        const prUrl = result.prUrl
        setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, prUrl } : task)))
        toast.success('Pull request found')
      } else {
        toast.info(result.message || 'No pull request exists for this branch yet')
      }
    } catch (err) {
      toastApiError(err, { fallbackMessage: "Couldn't check the pull request status" })
    }
  })

  const dismissBatch = useStableCallback(() => {
    setActiveBatch(null)
    dismissSettledBatch()
  })

  const selectedTask = selection.selectedTaskId ? tasksById.get(selection.selectedTaskId) ?? null : null
  const isSelectedTaskExecuting = isTaskActivelyExecuting(selectedTask, selection.selectedTaskId ? getExecutionProgress(selection.selectedTaskId) : undefined, startingExecuteIds, selection.selectedTaskId)
  const getTasksByStatus = useCallback((status: Task['status']) => tasksByStatus[status], [tasksByStatus])
  const displayedBatch = activeBatch ?? settledBatch

  return {
    tasks,
    tasksByStatus,
    tasksById,
    loading,
    error,
    columnPaging,
    hasMoreTasks,
    loadMoreTasks,
    isTaskFormOpen,
    setIsTaskFormOpen,
    defaultStatus,
    selectedTaskId: selection.selectedTaskId,
    selectedTaskIds: selection.selectedTaskIds,
    selectionActive: selection.selectionActive,
    selectingColumns: selection.selectingColumns,
    activeBatch,
    setActiveBatch,
    displayedBatch,
    dismissBatch,
    completedBatch,
    canExecute,
    activeRepository,
    selectedProject,
    batchTaskIds,
    batchTaskIdSet,
    completedBatchTaskIds,
    selectedTask,
    startingExecuteIds,
    isSelectedTaskExecuting,
    getTasksByStatus,
    handleAddTask,
    handleDragEnd,
    handleExecute,
    handleCancel,
    handleTaskClick,
    handleDrawerClose,
    handleDelete,
    handleUpdateTask,
    handleMoveToInProgress,
    handleBatchMoveToInProgress,
    handleBatchExecute: batchWithSelection.handleBatchExecute,
    handleRunWithBlockers,
    handleRunReady,
    handleCancelBatch: batchWithSelection.handleCancelBatch,
    handleApproveNextBatchTask: batchWithSelection.handleApproveNextBatchTask,
    handleCheckPullRequest,
    toggleTaskSelect: selection.toggleTaskSelect,
    toggleColumnSelection: selection.toggleColumnSelection,
    toggleColumnSelectAll: selection.toggleColumnSelectAll,
    selectAllVisible: selection.selectAllVisible,
    clearSelection: selection.clearSelection,
    handleInlineCreateTask,
    handleTaskCreated,
    handleBulkDelete,
    handleBulkChangeStatus,
    fetchTasks,
    showProviderSetup,
    setShowProviderSetup,
    handleProviderSetupComplete,
    taskDeletionMode,
  }
}
