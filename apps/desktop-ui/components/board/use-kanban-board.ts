import { useState, useEffect, useCallback, useRef, useDeferredValue, useMemo } from "react"
import { DropResult } from "@hello-pangea/dnd"
import { toast } from "sonner"
import type { SSEEventType, SSEEventData } from "@/providers/sse-provider"
import { useSSESubscription } from "@/providers/sse-provider"
import { useAuth } from "@/hooks/use-auth"
import { Project } from "@/lib/api"
import type { Repository } from "@/lib/api"
import { Task, ExecutionProgress, ExecutionLogEntry } from "@/types/task"
import { apiFetch, ApiError, NetworkError } from "@/lib/api/fetch"
import { getSetupStatus, OpenCodeUnavailableError } from "@/lib/api/opencode"
import {
  appendExecutionLog,
  getExecutionProgress,
  hasExecutionLogs,
  replaceExecutionLogs,
  setExecutionProgress,
} from "@/lib/execution-state-store"
import type { BatchMode } from "./batch-mode"

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
 * in an active phase. Being in the In Progress column alone does NOT mean
 * the task is running — In Progress is a Kanban state, not a runtime state.
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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [selectingColumns, setSelectingColumns] = useState<Set<string>>(new Set())
  const [activeBatch, setActiveBatch] = useState<ActiveBatch | null>(null)
  const [completedBatch, setCompletedBatch] = useState<{ taskIds: string[]; prUrl: string | null; mode: BatchMode } | null>(null)
  const [showProviderSetup, setShowProviderSetup] = useState(false)
  const [pendingExecuteTaskId, setPendingExecuteTaskId] = useState<string | null>(null)
  // Tracks tasks whose Execute POST is in flight so the UI can show "starting…"
  // and the second click on Execute is ignored. Cleared on success or failure.
  const [startingExecuteIds, setStartingExecuteIds] = useState<Set<string>>(new Set())
  const [taskDeletionMode, setTaskDeletionMode] = useState<"archive" | "delete">("archive")
  const lastSelectedIdRef = useRef<string | null>(null)
  const { isAuthenticated, activeRepository, refreshActiveRepository } = useAuth()

  const batchTaskIds = activeBatch?.tasks.map(t => t.taskId) ?? []
  const completedBatchTaskIds = completedBatch?.taskIds ?? []

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

  const clearColumnSelection = useCallback((status: Task['status']) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      tasks
        .filter(task => task.status === status)
        .forEach(task => next.delete(task.id))
      return next
    })
  }, [tasks])

  const toggleColumnSelection = useCallback((columnId: string) => {
    setSelectedTaskId(null)
    setSelectingColumns(prev => {
      const next = new Set(prev)
      if (next.has(columnId)) {
        next.delete(columnId)
        const columnStatus = COLUMNS.find(c => c.id === columnId)?.status
        if (columnStatus) {
          clearColumnSelection(columnStatus)
        }
      } else {
        next.add(columnId)
      }
      return next
    })
  }, [clearColumnSelection])

  const toggleTaskSelect = useCallback((taskId: string, modifiers?: { shift?: boolean; meta?: boolean }) => {
    if (batchTaskIds.includes(taskId)) return
    setSelectedTaskId(null)

    if (modifiers?.shift && lastSelectedIdRef.current) {
      const orderedIds: string[] = []
      for (const col of COLUMNS) {
        for (const t of tasks) {
          if (t.status === col.status) orderedIds.push(t.id)
        }
      }
      const anchorIdx = orderedIds.indexOf(lastSelectedIdRef.current)
      const targetIdx = orderedIds.indexOf(taskId)
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const [from, to] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
        setSelectedTaskIds(prev => {
          const next = new Set(prev)
          for (let i = from; i <= to; i++) {
            const id = orderedIds[i]
            if (id && !batchTaskIds.includes(id)) next.add(id)
          }
          return next
        })
        lastSelectedIdRef.current = taskId
        return
      }
    }

    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
    lastSelectedIdRef.current = taskId
  }, [batchTaskIds, tasks])

  const toggleColumnSelectAll = useCallback((status: Task['status']) => {
    setSelectedTaskId(null)
    const columnTasks = tasks.filter(task => task.status === status)
    const columnTaskIds = columnTasks.map(task => task.id)
    const allSelected = columnTaskIds.every(id => selectedTaskIds.has(id))
    
    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      if (allSelected) {
        columnTaskIds.forEach(id => next.delete(id))
      } else {
        columnTaskIds.forEach(id => {
          if (!batchTaskIds.includes(id)) {
            next.add(id)
          }
        })
      }
      return next
    })
  }, [tasks, selectedTaskIds, batchTaskIds])

  const clearSelection = () => {
    setSelectedTaskIds(new Set())
    setSelectingColumns(new Set())
    lastSelectedIdRef.current = null
  }

  const selectionActive = selectedTaskIds.size > 0

  useEffect(() => {
    setSelectingColumns(prev => {
      const next = new Set(prev)
      let changed = false
      if (batchTaskIds.length > 0 && next.has('in_progress')) {
        next.delete('in_progress')
        clearColumnSelection('in_progress')
        changed = true
      }
      if (completedBatchTaskIds.length > 0 && next.has('done')) {
        next.delete('done')
        clearColumnSelection('done')
        changed = true
      }
      return changed ? next : prev
    })
  }, [batchTaskIds.length, completedBatchTaskIds.length, clearColumnSelection])

  const handleBatchExecute = async (mode: BatchMode) => {
    // Only In Progress tasks may be executed in a batch. Mixed selections
    // (Todo + In Progress) used to send Todo task ids to /api/batches too,
    // which is wrong: Todo tasks must be moved to In Progress first.
    const inProgressTaskIds = Array.from(selectedTaskIds).filter(
      id => tasks.find(t => t.id === id)?.status === 'in_progress'
    )
    if (inProgressTaskIds.length === 0) {
      toast.error('Select at least one In Progress task to execute as a batch')
      return
    }

    const previousSelection = selectedTaskIds
    const previousTasks = tasks
    const previousActiveBatch = activeBatch
    const pendingTasks = inProgressTaskIds.map((taskId) => {
      const task = tasks.find(candidate => candidate.id === taskId)
      return {
        taskId,
        title: task?.title || 'Untitled task',
        status: 'queued' as const,
      }
    })

    clearSelection()
    setActiveBatch({
      id: `starting-${mode}-${Date.now()}`,
      status: 'starting',
      mode,
      tasks: pendingTasks,
      prUrl: null,
    })

    try {
      const status = await getSetupStatus()
      if (!status.ready) {
        setActiveBatch(previousActiveBatch)
        setSelectedTaskIds(previousSelection)
        setShowProviderSetup(true)
        toast.error('Configure an AI provider before starting batch execution')
        return
      }
    } catch (err) {
      if (err instanceof OpenCodeUnavailableError) {
        setActiveBatch(previousActiveBatch)
        setSelectedTaskIds(previousSelection)
        toast.error(
          'Execution service is not running. Start the sidecar (pnpm dev) or switch off CRUD-only mode.',
        )
        console.error('Setup status check failed (sidecar unavailable):', err)
        return
      }
      console.warn('Could not check provider setup before batch execution, proceeding anyway:', err)
    }

    try {
      const created = await apiFetch<{
        id: string
        status: string
        mode: BatchMode
        tasks: Array<{ taskId: string; title: string; status: ActiveBatch['tasks'][number]['status'] }>
      }>('/api/batches', {
        method: 'POST',
        sidecar: true,
        body: JSON.stringify({ taskIds: inProgressTaskIds, mode }),
      })
      // Seed activeBatch immediately from the POST response so the UI shows
      // the batch panel even before the first SSE batch:* event arrives.
      setActiveBatch({
        id: created.id,
        status: created.status || 'running',
        mode: created.mode || mode,
        tasks: created.tasks.map(t => ({ taskId: t.taskId, title: t.title, status: t.status })),
        prUrl: null,
      })
      setCompletedBatch(null)
    } catch (err) {
      setTasks(previousTasks)
      setSelectedTaskIds(previousSelection)
      setActiveBatch(previousActiveBatch)
      const msg = err instanceof Error ? err.message : 'Operation failed'
      console.error('Error creating batch:', err)
      toast.error(msg)
    }
  }

  const handleCancelBatch = async (batchId: string) => {
    try {
      await apiFetch(`/api/batches/${batchId}/cancel`, {
        method: 'POST',
        sidecar: true,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to cancel batch'
      console.error('Error cancelling batch:', err)
      toast.error(msg)
    }
  }

  const handleApproveNextBatchTask = useCallback(async (batchId: string) => {
    try {
      await apiFetch(`/api/batches/${batchId}/approve`, {
        method: 'POST',
        sidecar: true,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to approve next task'
      console.error('Error approving next batch task:', err)
      toast.error(msg)
    }
  }, [])

  const reconcileActiveBatches = useCallback(async () => {
    try {
      const batches = await apiFetch<Array<{ id: string; status: string; mode: BatchMode }>>(
        '/api/batches',
        { sidecar: true },
      )
      const running = batches.find(b => b.status === 'running' || b.status === 'pending' || b.status === 'merging')
      if (running) {
        const detail = await apiFetch<{
          id: string
          status: string
          mode: BatchMode
          prUrl: string | null
          tasks: Array<{ taskId: string; title: string; status: ActiveBatch['tasks'][number]['status'] }>
        }>(`/api/batches/${running.id}`, { sidecar: true })
        setActiveBatch({
          id: detail.id,
          status: detail.status,
          mode: detail.mode,
          tasks: detail.tasks.map(t => ({ taskId: t.taskId, title: t.title, status: t.status })),
          prUrl: detail.prUrl ?? null,
        })
      }
    } catch (err) {
      // Sidecar may not be running (CRUD-only mode); reconciliation is best-effort.
      if (!(err instanceof OpenCodeUnavailableError) && !(err instanceof NetworkError)) {
        console.debug('Active batch reconciliation skipped:', err)
      }
    }
  }, [])

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (isAuthenticated) {
        refreshActiveRepository()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleVisibility)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleVisibility)
    }
  }, [isAuthenticated, refreshActiveRepository])

  const selectedProject = projects.find(p => p.id === projectId)
  const canExecute = !!(selectedProject?.repositoryId || selectedProject?.localPath || activeRepository)

  const handleAddTask = (status: Task['status']) => {
    setDefaultStatus(status)
    setIsTaskFormOpen(true)
  }

  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const retryAttemptRef = useRef(0)

  const fetchTasks = useCallback(async (options?: {
    showLoading?: boolean
    allowRetry?: boolean
    clearError?: boolean
    resetRetry?: boolean
    silent?: boolean
  }) => {
    const {
      showLoading = false,
      allowRetry = false,
      clearError = false,
      resetRetry = false,
      silent = false,
    } = options || {}

    if (clearError) {
      setError(null)
    }

    if (resetRetry) {
      retryAttemptRef.current = 0
    }

    if (showLoading) {
      setLoading(true)
    }

    let shouldStopLoading = showLoading

    try {
      const params = new URLSearchParams()
      if (projectId) params.set('projectId', projectId)
      if (teamId) params.set('teamId', teamId)
      const qs = params.toString()
      const path = qs ? `/api/tasks?${qs}` : `/api/tasks`
      const data = await apiFetch<{ items: Task[] } | Task[]>(path)
      const items = Array.isArray(data) ? data : data.items
      setTasks(items)
      setError(null)
      retryAttemptRef.current = 0

      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
    } catch (err) {
      if (allowRetry && retryAttemptRef.current < 5 && (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500))) {
        retryAttemptRef.current += 1
        if (showLoading) {
          shouldStopLoading = false
        }
        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current)
        }
        retryTimeoutRef.current = setTimeout(() => {
          fetchTasks({ showLoading, allowRetry, silent: true })
        }, 1500)
        return
      }

      if (!silent) {
        const msg = err instanceof Error ? err.message : 'Failed to fetch tasks'
        setError(msg)
        if (!(err instanceof ApiError && err.status === 401)) {
          toast.error(msg)
        }
      }
    } finally {
      if (shouldStopLoading) {
        setLoading(false)
      }
    }
  }, [projectId, teamId])

  const handleSSEEvent = useCallback((eventType: SSEEventType, data: SSEEventData) => {
    switch (eventType) {
      case 'task:created':
        if (data.id && data.title && data.status) {
          const taskProjectId = (data as unknown as { projectId?: string }).projectId
          const taskTeamId = (data as unknown as { teamId?: string }).teamId
          if (projectId && taskProjectId !== projectId) {
            break
          }
          if (teamId && taskTeamId !== teamId) {
            break
          }
          const newTask: Task = {
            id: data.id,
            title: data.title,
            description: data.description ?? null,
            priority: data.priority ?? 'medium',
            status: data.status,
            sessionId: data.sessionId ?? null,
            createdAt: data.createdAt ?? new Date().toISOString(),
            updatedAt: data.updatedAt ?? new Date().toISOString(),
            labels: data.labels ?? [],
            executionStartedAt: data.executionStartedAt ?? null,
            executionPausedAt: data.executionPausedAt ?? null,
            executionElapsedMs: data.executionElapsedMs ?? 0,
            executionProgress: data.executionProgress ?? null,
            prUrl: data.prUrl ?? null,
            outcome: data.outcome ?? null,
            batchId: data.batchId ?? null,
            inboxRead: data.inboxRead ?? false,
            identifier: data.identifier ?? null,
            number: data.number ?? null,
            dueDate: data.dueDate ?? null,
          }
          setTasks((prev) => [...prev, newTask])
        }
        break

      case 'task:updated':
        if (data.id) {
          setTasks((prev) =>
            prev.map((task) =>
              task.id === data.id
                ? {
                    ...task,
                    ...(data.title && { title: data.title }),
                    ...(data.description !== undefined && { description: data.description }),
                    ...(data.priority && { priority: data.priority }),
                    ...(data.status && { status: data.status }),
                    ...(data.sessionId !== undefined && { sessionId: data.sessionId }),
                    ...(data.updatedAt && { updatedAt: data.updatedAt }),
                    ...(data.labels && { labels: data.labels }),
                    ...(data.executionStartedAt !== undefined && { executionStartedAt: data.executionStartedAt }),
                    ...(data.executionPausedAt !== undefined && { executionPausedAt: data.executionPausedAt }),
                    ...(data.executionElapsedMs !== undefined && { executionElapsedMs: data.executionElapsedMs }),
                    ...(data.executionProgress !== undefined && { executionProgress: data.executionProgress }),
                    ...(data.prUrl !== undefined && { prUrl: data.prUrl }),
                    ...(data.outcome !== undefined && { outcome: data.outcome }),
                    ...(data.batchId !== undefined && { batchId: data.batchId }),
                    ...(data.dueDate !== undefined && { dueDate: data.dueDate }),
                  }
                : task
            )
          )
        }
        break

      case 'task:deleted':
        if (data.id) {
          setTasks((prev) => prev.filter((task) => task.id !== data.id))
        }
        break

      case 'execution:progress':
        const progressData = data as unknown as ExecutionProgress
        if (progressData.taskId) {
          setExecutionProgress(progressData)
        }
        break

      case 'execution:log':
        const logData = data as unknown as { taskId: string; entry: ExecutionLogEntry }
        if (logData.taskId && logData.entry) {
          appendExecutionLog(logData.taskId, logData.entry)
        }
        break

      case 'connected':
        console.log("[SSE] Connected with clientId:", data.clientId)
        fetchTasks({ silent: true })
        if (isAuthenticated) {
          refreshActiveRepository()
        }
        // On (re)connect, fetch active batches so we don't show a stale empty
        // BatchProgress panel after the sidecar restarts or the SSE drops.
        void reconcileActiveBatches()
        break

      case 'batch:created':
      case 'batch:started':
        if (data.batchId) {
          setActiveBatch({
            id: data.batchId as string,
            status: data.status as string || 'running',
            mode: (data.mode as BatchMode | undefined) || 'parallel',
            tasks: (data.tasks as ActiveBatch['tasks']) || [],
            prUrl: null,
          })
        }
        break

      case 'batch:task:started':
        setActiveBatch(prev => {
          if (!prev || prev.id !== data.batchId) return prev
          return {
            ...prev,
            tasks: prev.tasks.map(t =>
              t.taskId === data.taskId ? { ...t, status: 'running' } : t
            ),
          }
        })
        break

      case 'batch:task:completed':
        setActiveBatch(prev => {
          if (!prev || prev.id !== data.batchId) return prev
          return {
            ...prev,
            tasks: prev.tasks.map(t =>
              t.taskId === data.taskId ? { ...t, status: 'completed' } : t
            ),
          }
        })
        break

      case 'batch:task:failed':
        setActiveBatch(prev => {
          if (!prev || prev.id !== data.batchId) return prev
          return {
            ...prev,
            tasks: prev.tasks.map(t =>
              t.taskId === data.taskId ? { ...t, status: 'failed' } : t
            ),
          }
        })
        break

      case 'batch:task:skipped':
        setActiveBatch(prev => {
          if (!prev || prev.id !== data.batchId) return prev
          return {
            ...prev,
            tasks: prev.tasks.map(t =>
              t.taskId === data.taskId ? { ...t, status: 'skipped' } : t
            ),
          }
        })
        break

      case 'batch:task:cancelled':
        setActiveBatch(prev => {
          if (!prev || prev.id !== data.batchId) return prev
          return {
            ...prev,
            tasks: prev.tasks.map(t =>
              t.taskId === data.taskId ? { ...t, status: 'cancelled' } : t
            ),
          }
        })
        break

      case 'batch:merging':
        setActiveBatch(prev => {
          if (prev?.id === data.batchId) {
            return { ...prev, status: 'merging' } as ActiveBatch
          }
          return prev
        })
        break

      case 'batch:completed':
        if (data.batchId && data.prUrl) {
          setTasks(prev => prev.map(task =>
            task.batchId === data.batchId ? { ...task, prUrl: data.prUrl as string } : task
          ))
        }
        setActiveBatch(prev => {
          if (prev && prev.id === data.batchId) {
            const prUrl = (data.prUrl as string) || prev.prUrl || null
            const taskIds = prev.tasks.map(t => t.taskId)
            setCompletedBatch({ taskIds, prUrl, mode: prev.mode })
            return { ...prev, status: 'completed', prUrl } as ActiveBatch
          }
          return prev
        })
        break
      case 'batch:failed':
      case 'batch:cancelled':
        setActiveBatch(prev => {
          if (prev && prev.id === data.batchId) {
            setTimeout(() => setActiveBatch(null), 5000)
            return { ...prev, status: eventType.split(':')[1]! } as ActiveBatch
          }
          return prev
        })
        break

      default:
        break
    }
  }, [fetchTasks, isAuthenticated, refreshActiveRepository, projectId, teamId])

  useSSESubscription(handleSSEEvent)

  useEffect(() => {
    fetchTasks({ showLoading: true, allowRetry: true, clearError: true, resetRetry: true })

    apiFetch("/api/settings")
      .then((data: any) => {
        if (data?.taskDeletionMode) {
          setTaskDeletionMode(data.taskDeletionMode)
        }
      })
      .catch(() => {
        // ignore settings fetch errors
      })

    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
    }
  }, [fetchTasks])

  const updateTaskStatus = async (
    taskIds: string | string[],
    newStatus: Task['status'],
  ) => {
    const ids = Array.isArray(taskIds) ? taskIds : [taskIds]
    if (ids.length === 0) return

    let snapshot: Task[] = []
    setTasks((prev) => {
      snapshot = prev
      const idSet = new Set(ids)
      return prev.map((task) =>
        idSet.has(task.id) ? { ...task, status: newStatus } : task,
      )
    })

    try {
      await Promise.all(
        ids.map((id) =>
          apiFetch(`/api/tasks/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: newStatus }),
          }),
        ),
      )
    } catch (err) {
      setTasks(snapshot)
      const msg = err instanceof Error ? err.message : 'Operation failed'
      console.error('Error updating task:', err)
      toast.error(msg)
    }
  }

  const handleMoveToInProgress = async (taskId: string) => {
    await updateTaskStatus(taskId, 'in_progress')
  }

  const handleBatchMoveToInProgress = async () => {
    const todoIds = Array.from(selectedTaskIds).filter(
      id => tasks.find(t => t.id === id)?.status === 'todo'
    )
    if (todoIds.length === 0) return
    clearSelection()
    await updateTaskStatus(todoIds, 'in_progress')
  }

  const handleInlineCreateTask = useCallback(async (status: Task['status'], title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const optimistic: Task = {
      id: tempId,
      title: trimmed,
      description: null,
      priority: 'medium',
      status,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
      labels: [],
      executionStartedAt: null,
      executionPausedAt: null,
      executionElapsedMs: 0,
      executionProgress: null,
      prUrl: null,
      outcome: null,
      batchId: null,
      inboxRead: false,
      identifier: null,
      number: null,
      dueDate: null,
    }

    setTasks(prev => [...prev, optimistic])

    try {
      const created = await apiFetch<Task>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: trimmed,
          status,
          projectId: projectId || undefined,
          teamId: teamId || undefined,
        }),
      })
      setTasks(prev => prev.map(t => (t.id === tempId ? created : t)))
    } catch (err) {
      setTasks(prev => prev.filter(t => t.id !== tempId))
      const msg = err instanceof Error ? err.message : 'Failed to create task'
      console.error('Error creating task inline:', err)
      toast.error(msg)
    }
  }, [projectId, teamId])

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedTaskIds).filter(id => !batchTaskIds.includes(id))
    if (ids.length === 0) return

    const snapshot = tasks
    setTasks(prev => prev.filter(t => !ids.includes(t.id)))
    clearSelection()

    const permanent = taskDeletionMode === "delete"
    const results = await Promise.allSettled(
      ids.map(id => apiFetch(`/api/tasks/${id}${permanent ? "?permanent=true" : ""}`, { method: 'DELETE' })),
    )
    const failures = results.filter(r => r.status === 'rejected').length
    if (failures > 0) {
      setTasks(snapshot)
      toast.error(`Failed to delete ${failures} of ${ids.length} task${ids.length !== 1 ? 's' : ''}`)
    } else {
      const action = permanent ? "Deleted" : "Archived"
      toast.success(`${action} ${ids.length} task${ids.length !== 1 ? 's' : ''}`)
    }
  }, [selectedTaskIds, tasks, batchTaskIds, taskDeletionMode])

  const handleBulkChangeStatus = useCallback(async (newStatus: Task['status']) => {
    const ids = Array.from(selectedTaskIds).filter(id => !batchTaskIds.includes(id))
    if (ids.length === 0) return

    let snapshot: Task[] = []
    setTasks(prev => {
      snapshot = prev
      const idSet = new Set(ids)
      return prev.map(t => (idSet.has(t.id) ? { ...t, status: newStatus } : t))
    })
    clearSelection()

    const results = await Promise.allSettled(
      ids.map(id =>
        apiFetch(`/api/tasks/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus }),
        }),
      ),
    )
    const failures = results.filter(r => r.status === 'rejected').length
    if (failures > 0) {
      setTasks(snapshot)
      toast.error(`Failed to update ${failures} of ${ids.length} task${ids.length !== 1 ? 's' : ''}`)
    }
  }, [selectedTaskIds, batchTaskIds])

  const handleDragEnd = async (result: DropResult) => {
    const { destination, source, draggableId } = result

    if (!destination) return
    if (destination.droppableId === source.droppableId && destination.index === source.index) return

    const newStatus = destination.droppableId as Task['status']

    if (draggableId.startsWith('batch-group-')) {
      const batchId = draggableId.replace('batch-group-', '')
      const batchTaskIds = tasks
        .filter(task => task.batchId === batchId)
        .map(task => task.id)

      if (batchTaskIds.length === 0) return

      await updateTaskStatus(batchTaskIds, newStatus)
      return
    }

    await updateTaskStatus(draggableId, newStatus)
  }

  const handleExecute = async (taskId: string) => {
    if (!canExecute) {
      const msg = "No active project — connect a repo first"
      console.error(msg)
      toast.error(msg)
      return
    }

    // Block duplicate clicks while the POST is in flight or live progress is
    // already in an active phase.
    if (startingExecuteIds.has(taskId)) return
    const live = getExecutionProgress(taskId)
    if (live && ['cloning', 'executing', 'committing', 'creating_pr'].includes(live.status)) {
      return
    }

    addStartingExecute(taskId)

    try {
      try {
        const status = await getSetupStatus();
        if (!status.ready) {
          setPendingExecuteTaskId(taskId);
          setShowProviderSetup(true);
          return;
        }
      } catch (err) {
        if (err instanceof OpenCodeUnavailableError) {
          // Setup-status check failed because the sidecar isn't reachable
          // (404 from CRUD-only API, or 5xx from unhealthy sidecar). Do NOT
          // proceed — POST /execute would just 404 again with a worse message.
          toast.error(
            'Execution service is not running. Start the sidecar (pnpm dev) or switch off CRUD-only mode.',
          )
          console.error('Setup status check failed (sidecar unavailable):', err)
          return
        }
        console.warn('Could not check provider setup, proceeding anyway:', err)
      }

      try {
        await apiFetch(`/api/tasks/${taskId}/execute`, {
          method: 'POST',
          sidecar: true,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to execute task'
        console.error('Error executing task:', err)
        toast.error(msg)
      }
    } finally {
      removeStartingExecute(taskId)
    }
  }

  const handleProviderSetupComplete = useCallback(async () => {
    setShowProviderSetup(false);
    if (pendingExecuteTaskId) {
      const taskId = pendingExecuteTaskId;
      setPendingExecuteTaskId(null);
      addStartingExecute(taskId)
      try {
        await apiFetch(`/api/tasks/${taskId}/execute`, {
          method: 'POST',
          sidecar: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to execute task'
        console.error('Error executing task:', err);
        toast.error(msg)
      } finally {
        removeStartingExecute(taskId)
      }
    }
  }, [pendingExecuteTaskId, addStartingExecute, removeStartingExecute]);

  const handleCancel = async (taskId: string) => {
    try {
      await apiFetch(`/api/tasks/${taskId}/cancel`, {
        method: 'POST',
        sidecar: true,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to cancel task'
      console.error('Error cancelling task:', err)
      toast.error(msg)
    }
  }

  const handleTaskClick = async (taskId: string) => {
    clearSelection()
    setSelectedTaskId(taskId)

    if (!hasExecutionLogs(taskId)) {
      try {
        const data = await apiFetch<{ logs?: ExecutionLogEntry[] }>(
          `/api/tasks/${taskId}/logs`,
          { sidecar: true },
        )
        replaceExecutionLogs(taskId, data.logs || [])
      } catch (err) {
        console.error('Error fetching task logs:', err)
      }
    }
  }

  const handleDrawerClose = () => {
    setSelectedTaskId(null)
  }

  const handleDelete = async (taskId: string) => {
    const previousTasks = tasks
    const previousSelectedTaskId = selectedTaskId
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
    setSelectedTaskId(null)
    const permanent = taskDeletionMode === "delete"
    try {
      await apiFetch(`/api/tasks/${taskId}${permanent ? "?permanent=true" : ""}`, { method: 'DELETE' })
    } catch (err) {
      setTasks(previousTasks)
      setSelectedTaskId(previousSelectedTaskId)
      const msg = err instanceof Error ? err.message : 'Operation failed'
      console.error('Error deleting task:', err)
      toast.error(msg)
    }
  }

  const handleUpdateTask = async (taskId: string, data: { title?: string; description?: string | null }) => {
    try {
      await apiFetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update task'
      console.error('Error updating task:', err)
      toast.error(msg)
    }
  }

  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) || null : null

  const isSelectedTaskExecuting = isTaskActivelyExecuting(
    selectedTask,
    selectedTaskId ? getExecutionProgress(selectedTaskId) : undefined,
    startingExecuteIds,
    selectedTaskId,
  )

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

  const getTasksByStatus = (status: Task['status']) => {
    return filteredTasks.filter((task) => task.status === status)
  }

  const selectAllVisible = useCallback(() => {
    const ids = filteredTasks
      .filter(t => !batchTaskIds.includes(t.id))
      .map(t => t.id)
    if (ids.length === 0) return
    setSelectedTaskId(null)
    setSelectedTaskIds(new Set(ids))
  }, [filteredTasks, batchTaskIds])

  return {
    tasks,
    loading,
    error,
    isTaskFormOpen,
    setIsTaskFormOpen,
    defaultStatus,
    selectedTaskId,
    selectedTaskIds,
    selectionActive,
    selectingColumns,
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
    handleBatchExecute,
    handleCancelBatch,
    handleApproveNextBatchTask,
    toggleTaskSelect,
    toggleColumnSelection,
    toggleColumnSelectAll,
    selectAllVisible,
    clearSelection,
    handleInlineCreateTask,
    handleBulkDelete,
    handleBulkChangeStatus,
    fetchTasks,
    showProviderSetup,
    setShowProviderSetup,
    handleProviderSetupComplete,
    taskDeletionMode,
  }
}
