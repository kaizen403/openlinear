import { useState, useEffect, useCallback, useRef, useDeferredValue, useMemo } from "react"
import { DropResult } from "@hello-pangea/dnd"
import { toast } from "sonner"
import { useAuth } from "@/hooks/use-auth"
import { Project } from "@/lib/api"
import type { Repository } from "@/lib/api"
import { Task, ExecutionProgress, ExecutionLogEntry } from "@/types/task"
import { apiFetch, ApiError, NetworkError } from "@/lib/api/fetch"
import { getSetupStatus, OpenCodeUnavailableError } from "@/lib/api/opencode"
import { isModelNotConfiguredApiError } from "@/lib/api/model-errors"
import {
  clearExecutionProgress,
  getExecutionProgress,
  hasExecutionLogs,
  replaceExecutionLogs,
} from "@/lib/execution-state-store"
import type { BatchMode } from "./batch-mode"
import {
  applyBoardStatusChange,
  moveBoardTask,
  replaceOptimisticTask,
  upsertBoardTask,
} from "./board-state"
import { useTaskSelection } from "@/hooks/use-task-selection"
import { useBatchExecution } from "@/hooks/use-batch-execution"
import { useTaskSSE } from "@/hooks/use-task-sse"

export const COLUMNS = [
  { id: 'todo', title: 'All Issues', status: 'todo' as const },
  { id: 'in_progress', title: 'In Progress', status: 'in_progress' as const },
  { id: 'done', title: 'Done', status: 'done' as const },
  { id: 'cancelled', title: 'Cancelled', status: 'cancelled' as const },
]

export interface ActiveBatch {
  id: string
  status: string
  mode: BatchMode
  tasks: Array<{
    taskId: string
    title: string
    status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
  }>
  prUrl: string | null
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
  return ['cloning', 'executing', 'committing', 'creating_pr'].includes(progress.status)
}

export interface KanbanBoardProps {
  projectId?: string | null
  teamId?: string | null
  projects?: Project[]
  searchQuery?: string
}

export interface UseKanbanBoardReturn {
  tasks: Task[]
  loading: boolean
  error: string | null
  isTaskFormOpen: boolean
  setIsTaskFormOpen: (open: boolean) => void
  defaultStatus: Task['status']
  selectedTaskId: string | null
  selectedTaskIds: Set<string>
  selectionActive: boolean
  selectingColumns: Set<string>
  activeBatch: ActiveBatch | null
  setActiveBatch: (batch: ActiveBatch | null) => void
  completedBatch: { taskIds: string[]; prUrl: string | null; mode: BatchMode } | null
  canExecute: boolean
  activeRepository: Repository | null
  selectedProject: Project | undefined
  batchTaskIds: string[]
  completedBatchTaskIds: string[]
  selectedTask: Task | null
  startingExecuteIds: Set<string>
  isSelectedTaskExecuting: boolean
  getTasksByStatus: (status: Task['status']) => Task[]
  handleAddTask: (status: Task['status']) => void
  handleDragEnd: (result: DropResult) => void
  handleExecute: (taskId: string) => Promise<void>
  handleCancel: (taskId: string) => Promise<void>
  handleTaskClick: (taskId: string) => Promise<void>
  handleDrawerClose: () => void
  handleDelete: (taskId: string) => Promise<void>
  handleUpdateTask: (taskId: string, data: { title?: string; description?: string | null }) => Promise<void>
  handleMoveToInProgress: (taskId: string) => Promise<void>
  handleBatchMoveToInProgress: () => Promise<void>
  handleBatchExecute: (mode: BatchMode) => Promise<void>
  handleCancelBatch: (batchId: string) => Promise<void>
  handleApproveNextBatchTask: (batchId: string) => Promise<void>
  toggleTaskSelect: (taskId: string, modifiers?: { shift?: boolean; meta?: boolean }) => void
  toggleColumnSelection: (columnId: string) => void
  toggleColumnSelectAll: (status: Task['status']) => void
  selectAllVisible: () => void
  clearSelection: () => void
  handleInlineCreateTask: (status: Task['status'], title: string) => Promise<void>
  handleTaskCreated: (task: Task) => void
  handleBulkDelete: () => Promise<void>
  handleBulkChangeStatus: (status: Task['status']) => Promise<void>
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

export function useKanbanBoard({ projectId, teamId, projects = [], searchQuery = "" }: KanbanBoardProps): UseKanbanBoardReturn {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [defaultStatus, setDefaultStatus] = useState<Task['status']>('todo')
  const [activeBatch, setActiveBatch] = useState<ActiveBatch | null>(null)
  const [showProviderSetup, setShowProviderSetup] = useState(false)
  const [pendingExecuteTaskId, setPendingExecuteTaskId] = useState<string | null>(null)
  const [startingExecuteIds, setStartingExecuteIds] = useState<Set<string>>(new Set())
  const [taskDeletionMode, setTaskDeletionMode] = useState<"archive" | "delete">("archive")
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

  // --- Batch Execution ---
  const batch = useBatchExecution({
    tasks,
    selectedTaskIds: new Set(), // will be overridden below
    activeBatch,
    setActiveBatch,
    clearSelection: () => {}, // will be overridden below
    setTasks,
    setShowProviderSetup,
    setSelectedTaskIds: () => {},
  })

  // --- Task Selection ---
  const selection = useTaskSelection({
    tasks,
    filteredTasks,
    batchTaskIds: batch.batchTaskIds,
  })

  // Re-wire batch with actual selection values
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

  const { batchTaskIds, completedBatchTaskIds, completedBatch, setCompletedBatch } = batchWithSelection

  const batchTaskIdsRef = useRef(batchTaskIds)
  batchTaskIdsRef.current = batchTaskIds

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

  const handleAddTask = (status: Task['status']) => {
    setDefaultStatus(status)
    setIsTaskFormOpen(true)
  }

  // --- Fetch Tasks ---
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const retryAttemptRef = useRef(0)

  const fetchTasks = useCallback(async (options?: {
    showLoading?: boolean
    allowRetry?: boolean
    clearError?: boolean
    resetRetry?: boolean
    silent?: boolean
  }) => {
    const { showLoading = false, allowRetry = false, clearError = false, resetRetry = false, silent = false } = options || {}
    if (clearError) setError(null)
    if (resetRetry) retryAttemptRef.current = 0
    if (showLoading) setLoading(true)
    let shouldStopLoading = showLoading

    try {
      const params = new URLSearchParams({ pageSize: "200" })
      if (projectId) params.set('projectId', projectId)
      if (teamId) params.set('teamId', teamId)
      const qs = params.toString()
      const path = qs ? `/api/tasks?${qs}` : `/api/tasks`
      const data = await apiFetch<{ items: Task[] } | Task[]>(path)
      const items = Array.isArray(data) ? data : data.items
      setTasks(items)
      setError(null)
      retryAttemptRef.current = 0
      if (retryTimeoutRef.current) { clearTimeout(retryTimeoutRef.current); retryTimeoutRef.current = null }
    } catch (err) {
      if (allowRetry && retryAttemptRef.current < 5 && (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500))) {
        retryAttemptRef.current += 1
        if (showLoading) shouldStopLoading = false
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = setTimeout(() => { fetchTasks({ showLoading, allowRetry, silent: true }) }, 1500)
        return
      }
      if (!silent) {
        const msg = err instanceof Error ? err.message : 'Failed to fetch tasks'
        setError(msg)
        if (!(err instanceof ApiError && err.status === 401)) toast.error(msg)
      }
    } finally {
      if (shouldStopLoading) setLoading(false)
    }
  }, [projectId, teamId])

  // --- SSE ---
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
  })

  // --- Initial load ---
  useEffect(() => {
    fetchTasks({ showLoading: true, allowRetry: true, clearError: true, resetRetry: true })
    apiFetch("/api/settings")
      .then((data: any) => { if (data?.taskDeletionMode) setTaskDeletionMode(data.taskDeletionMode) })
      .catch(() => {})
    return () => { if (retryTimeoutRef.current) { clearTimeout(retryTimeoutRef.current); retryTimeoutRef.current = null } }
  }, [fetchTasks])

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
  const updateTaskStatus = async (taskIds: string | string[], newStatus: Task['status'], options: { destinationIndex?: number } = {}) => {
    const ids = Array.isArray(taskIds) ? taskIds : [taskIds]
    if (ids.length === 0) return
    let snapshot: Task[] = []
    setTasks((prev) => {
      snapshot = prev
      const idSet = new Set(ids)
      if (ids.length === 1 && options.destinationIndex !== undefined) {
        const destinationIndex = getFullDestinationIndex(ids[0]!, newStatus, options.destinationIndex)
        return moveBoardTask(prev, ids[0]!, newStatus, destinationIndex)
      }
      return prev.map((task) => idSet.has(task.id) ? applyBoardStatusChange(task, newStatus) : task)
    })
    if (newStatus !== 'in_progress') ids.forEach(clearExecutionProgress)
    try {
      const updatedTasks = await Promise.all(ids.map((id) => apiFetch<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) })))
      setTasks((prev) => updatedTasks.reduce((next, task) => upsertBoardTask(next, task), prev))
    } catch (err) {
      setTasks(snapshot)
      const msg = err instanceof Error ? err.message : 'Operation failed'
      console.error('Error updating task:', err)
      toast.error(msg)
    }
  }

  const handleMoveToInProgress = async (taskId: string) => { await updateTaskStatus(taskId, 'in_progress') }

  const handleBatchMoveToInProgress = async () => {
    const todoIds = Array.from(selection.selectedTaskIds).filter(id => tasks.find(t => t.id === id)?.status === 'todo')
    if (todoIds.length === 0) return
    selection.clearSelection()
    await updateTaskStatus(todoIds, 'in_progress')
  }

  const handleInlineCreateTask = useCallback(async (status: Task['status'], title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const optimistic: Task = { id: tempId, title: trimmed, description: null, priority: 'medium', status, sessionId: null, createdAt: now, updatedAt: now, labels: [], executionStartedAt: null, executionPausedAt: null, executionElapsedMs: 0, executionProgress: null, prUrl: null, outcome: null, batchId: null, inboxRead: false, identifier: null, number: null, dueDate: null, projectId: projectId ?? null, teamId: teamId ?? null, model: null, archived: false }
    setTasks(prev => [optimistic, ...prev])
    try {
      const created = await apiFetch<Task>('/api/tasks', { method: 'POST', body: JSON.stringify({ title: trimmed, status, projectId: projectId || undefined, teamId: teamId || undefined }) })
      setTasks(prev => replaceOptimisticTask(prev, tempId, created))
    } catch (err) {
      setTasks(prev => prev.filter(t => t.id !== tempId))
      const msg = err instanceof Error ? err.message : 'Failed to create task'
      console.error('Error creating task inline:', err)
      toast.error(msg)
    }
  }, [projectId, teamId])

  const handleTaskCreated = useCallback((task: Task) => { setTasks((prev) => upsertBoardTask(prev, task)) }, [])

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selection.selectedTaskIds).filter(id => !batchTaskIds.includes(id))
    if (ids.length === 0) return
    const snapshot = tasks
    setTasks(prev => prev.filter(t => !ids.includes(t.id)))
    selection.clearSelection()
    const permanent = taskDeletionModeRef.current === "delete"
    const results = await Promise.allSettled(ids.map(id => apiFetch(`/api/tasks/${id}${permanent ? "?permanent=true" : ""}`, { method: 'DELETE' })))
    const failures = results.filter(r => r.status === 'rejected').length
    if (failures > 0) { setTasks(snapshot); toast.error(`Failed to delete ${failures} of ${ids.length} task${ids.length !== 1 ? 's' : ''}`) }
    else { const action = permanent ? "Deleted" : "Archived"; toast.success(`${action} ${ids.length} task${ids.length !== 1 ? 's' : ''}`) }
  }, [selection.selectedTaskIds, tasks, batchTaskIds, selection.clearSelection])

  const handleBulkChangeStatus = useCallback(async (newStatus: Task['status']) => {
    const ids = Array.from(selection.selectedTaskIds).filter(id => !batchTaskIds.includes(id))
    if (ids.length === 0) return
    let snapshot: Task[] = []
    setTasks(prev => { snapshot = prev; const idSet = new Set(ids); return prev.map(t => (idSet.has(t.id) ? { ...t, status: newStatus } : t)) })
    selection.clearSelection()
    const results = await Promise.allSettled(ids.map(id => apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) })))
    const failures = results.filter(r => r.status === 'rejected').length
    if (failures > 0) { setTasks(snapshot); toast.error(`Failed to update ${failures} of ${ids.length} task${ids.length !== 1 ? 's' : ''}`) }
  }, [selection.selectedTaskIds, batchTaskIds, selection.clearSelection])

  const handleDragEnd = async (result: DropResult) => {
    const { destination, source, draggableId } = result
    if (!destination) return
    if (destination.droppableId === source.droppableId && destination.index === source.index) return
    const newStatus = destination.droppableId as Task['status']
    if (draggableId.startsWith('batch-group-')) {
      const batchId = draggableId.replace('batch-group-', '')
      const ids = tasks.filter(task => task.batchId === batchId).map(task => task.id)
      if (ids.length === 0) return
      await updateTaskStatus(ids, newStatus)
      return
    }
    await updateTaskStatus(draggableId, newStatus, { destinationIndex: destination.index })
  }

  const handleExecute = async (taskId: string) => {
    if (!canExecute) { toast.error("No active project — connect a repo first"); return }
    if (startingExecuteIds.has(taskId)) return
    const live = getExecutionProgress(taskId)
    if (live && ['cloning', 'executing', 'committing', 'creating_pr'].includes(live.status)) return
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
      try {
        await apiFetch(`/api/tasks/${taskId}/execute`, { method: 'POST', sidecar: true })
      } catch (err) {
        if (isModelNotConfiguredApiError(err)) {
          setPendingExecuteTaskId(taskId)
          setShowProviderSetup(true)
          toast.error(err.message)
          return
        }
        const msg = err instanceof Error ? err.message : 'Failed to execute task'
        console.error('Error executing task:', err)
        toast.error(msg)
      }
    } finally { removeStartingExecute(taskId) }
  }

  const handleProviderSetupComplete = useCallback(async () => {
    setShowProviderSetup(false)
    if (pendingExecuteTaskId) {
      const taskId = pendingExecuteTaskId
      setPendingExecuteTaskId(null)
      addStartingExecute(taskId)
      try {
        await apiFetch(`/api/tasks/${taskId}/execute`, { method: 'POST', sidecar: true })
      } catch (err) {
        if (isModelNotConfiguredApiError(err)) {
          setPendingExecuteTaskId(taskId)
          setShowProviderSetup(true)
          toast.error(err.message)
          return
        }
        const msg = err instanceof Error ? err.message : 'Failed to execute task'
        console.error('Error executing task:', err)
        toast.error(msg)
      }
      finally { removeStartingExecute(taskId) }
    }
  }, [pendingExecuteTaskId, addStartingExecute, removeStartingExecute])

  const handleCancel = async (taskId: string) => {
    try { await apiFetch(`/api/tasks/${taskId}/cancel`, { method: 'POST', sidecar: true }) }
    catch (err) { const msg = err instanceof Error ? err.message : 'Failed to cancel task'; console.error('Error cancelling task:', err); toast.error(msg) }
  }

  const handleTaskClick = async (taskId: string) => {
    selection.clearSelection()
    selection.setSelectedTaskId(taskId)
    if (!hasExecutionLogs(taskId)) {
      try { const data = await apiFetch<{ logs?: ExecutionLogEntry[] }>(`/api/tasks/${taskId}/logs`, { sidecar: true }); replaceExecutionLogs(taskId, data.logs || []) }
      catch (err) { console.error('Error fetching task logs:', err) }
    }
  }

  const handleDrawerClose = () => { selection.setSelectedTaskId(null) }

  const handleDelete = useCallback(async (taskId: string) => {
    const previousTasks = tasksRef.current
    const previousSelectedTaskId = selection.selectedTaskId
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
    selection.setSelectedTaskId(null)
    const permanent = taskDeletionModeRef.current === "delete"
    try { await apiFetch(`/api/tasks/${taskId}${permanent ? "?permanent=true" : ""}`, { method: 'DELETE' }) }
    catch (err) { setTasks(previousTasks); selection.setSelectedTaskId(previousSelectedTaskId); const msg = err instanceof Error ? err.message : 'Operation failed'; console.error('Error deleting task:', err); toast.error(msg) }
  }, [selection.selectedTaskId])

  const handleUpdateTask = async (taskId: string, data: { title?: string; description?: string | null }) => {
    try { await apiFetch(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(data) }) }
    catch (err) { const msg = err instanceof Error ? err.message : 'Failed to update task'; console.error('Error updating task:', err); toast.error(msg) }
  }

  const selectedTask = selection.selectedTaskId ? tasks.find((t) => t.id === selection.selectedTaskId) || null : null
  const isSelectedTaskExecuting = isTaskActivelyExecuting(selectedTask, selection.selectedTaskId ? getExecutionProgress(selection.selectedTaskId) : undefined, startingExecuteIds, selection.selectedTaskId)
  const getTasksByStatus = (status: Task['status']) => filteredTasks.filter((task) => task.status === status)

  return {
    tasks,
    loading,
    error,
    isTaskFormOpen,
    setIsTaskFormOpen,
    defaultStatus,
    selectedTaskId: selection.selectedTaskId,
    selectedTaskIds: selection.selectedTaskIds,
    selectionActive: selection.selectionActive,
    selectingColumns: selection.selectingColumns,
    activeBatch,
    setActiveBatch,
    completedBatch,
    canExecute,
    activeRepository,
    selectedProject,
    batchTaskIds,
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
    handleCancelBatch: batchWithSelection.handleCancelBatch,
    handleApproveNextBatchTask: batchWithSelection.handleApproveNextBatchTask,
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
