import { useState, useEffect, useCallback, useRef } from "react"
import { DropResult } from "@hello-pangea/dnd"
import { SSEEventType, SSEEventData } from "@/hooks/use-sse"
import { useSSESubscription } from "@/providers/sse-provider"
import { useAuth } from "@/hooks/use-auth"
import { Project } from "@/lib/api"
import { Task, ExecutionProgress, ExecutionLogEntry } from "@/types/task"
import { API_URL } from "@/lib/api/client"
import { getSetupStatus, hasConfiguredProviders } from "@/lib/api/opencode"

export const COLUMNS = [
  { id: 'todo', title: 'Dashboard', status: 'todo' as const },
  { id: 'in_progress', title: 'In Progress', status: 'in_progress' as const },
  { id: 'done', title: 'Done', status: 'done' as const },
  { id: 'cancelled', title: 'Cancelled', status: 'cancelled' as const },
]

export interface ActiveBatch {
  id: string
  status: string
  mode: string
  tasks: Array<{
    taskId: string
    title: string
    status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
  }>
  prUrl: string | null
}

export const API_BASE_URL = API_URL

export interface KanbanBoardProps {
  projectId?: string | null
  teamId?: string | null
  projects?: Project[]
}

export interface UseKanbanBoardReturn {
  tasks: Task[]
  loading: boolean
  error: string | null
  executionProgress: Record<string, ExecutionProgress>
  isTaskFormOpen: boolean
  setIsTaskFormOpen: (open: boolean) => void
  defaultStatus: Task['status']
  selectedTaskId: string | null
  taskLogs: Record<string, ExecutionLogEntry[]>
  selectedTaskIds: Set<string>
  selectingColumns: Set<string>
  activeBatch: ActiveBatch | null
  setActiveBatch: (batch: ActiveBatch | null) => void
  completedBatch: { taskIds: string[]; prUrl: string | null; mode: string } | null
  canExecute: boolean
  selectedProject: Project | undefined
  batchTaskIds: string[]
  completedBatchTaskIds: string[]
  selectedTask: Task | null
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
  handleBatchExecute: (mode: 'parallel' | 'queue') => Promise<void>
  handleCancelBatch: (batchId: string) => Promise<void>
  toggleTaskSelect: (taskId: string) => void
  toggleColumnSelection: (columnId: string) => void
  toggleColumnSelectAll: (status: Task['status']) => void
  clearSelection: () => void
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
}

export function useKanbanBoard({ projectId, teamId, projects = [] }: KanbanBoardProps): UseKanbanBoardReturn {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [executionProgress, setExecutionProgress] = useState<Record<string, ExecutionProgress>>({})
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [defaultStatus, setDefaultStatus] = useState<Task['status']>('todo')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskLogs, setTaskLogs] = useState<Record<string, ExecutionLogEntry[]>>({})
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [selectingColumns, setSelectingColumns] = useState<Set<string>>(new Set())
  const [activeBatch, setActiveBatch] = useState<ActiveBatch | null>(null)
  const [completedBatch, setCompletedBatch] = useState<{ taskIds: string[]; prUrl: string | null; mode: string } | null>(null)
  const [showProviderSetup, setShowProviderSetup] = useState(false)
  const [pendingExecuteTaskId, setPendingExecuteTaskId] = useState<string | null>(null)
  const { isAuthenticated, activeRepository, refreshActiveRepository } = useAuth()

  const batchTaskIds = activeBatch?.tasks.map(t => t.taskId) ?? []
  const completedBatchTaskIds = completedBatch?.taskIds ?? []

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

  const toggleTaskSelect = (taskId: string) => {
    if (batchTaskIds.includes(taskId)) return
    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleColumnSelectAll = useCallback((status: Task['status']) => {
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
  }

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

  const handleBatchExecute = async (mode: 'parallel' | 'queue') => {
    try {
      const token = localStorage.getItem('token')
      const nonDoneTaskIds = Array.from(selectedTaskIds).filter(
        id => tasks.find(t => t.id === id)?.status !== 'done'
      )
      if (nonDoneTaskIds.length === 0) return
      const response = await fetch(`${API_BASE_URL}/api/batches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          taskIds: nonDoneTaskIds,
          mode,
        }),
      })
      if (!response.ok) throw new Error('Failed to create batch')
      clearSelection()
    } catch (err) {
      console.error('Error creating batch:', err)
    }
  }

  const handleCancelBatch = async (batchId: string) => {
    try {
      const token = localStorage.getItem('token')
      await fetch(`${API_BASE_URL}/api/batches/${batchId}/cancel`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
    } catch (err) {
      console.error('Error cancelling batch:', err)
    }
  }

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
  const safetyTimeoutRef = useRef<NodeJS.Timeout | null>(null)

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
      const url = qs
        ? `${API_BASE_URL}/api/tasks?${qs}`
        : `${API_BASE_URL}/api/tasks`
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch tasks: ${response.statusText}`)
      }
      const data = await response.json()
      setTasks(data)
      setError(null)
      retryAttemptRef.current = 0

      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
    } catch (err) {
      if (allowRetry && retryAttemptRef.current < 5) {
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
        setError(err instanceof Error ? err.message : "Failed to fetch tasks")
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
          setExecutionProgress((prev) => ({
            ...prev,
            [progressData.taskId]: progressData,
          }))
        }
        break

      case 'execution:log':
        const logData = data as unknown as { taskId: string; entry: ExecutionLogEntry }
        if (logData.taskId && logData.entry) {
          setTaskLogs((prev) => ({
            ...prev,
            [logData.taskId]: [...(prev[logData.taskId] || []), logData.entry],
          }))
        }
        break

      case 'connected':
        console.log("[SSE] Connected with clientId:", data.clientId)
        fetchTasks({ silent: true })
        if (isAuthenticated) {
          refreshActiveRepository()
        }
        break

      case 'batch:created':
      case 'batch:started':
        if (data.batchId) {
          setActiveBatch({
            id: data.batchId as string,
            status: data.status as string || 'running',
            mode: data.mode as string || 'parallel',
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

    // Safety timeout: force loading to false after 10s no matter what
    safetyTimeoutRef.current = setTimeout(() => {
      setLoading(prev => {
        if (prev) {
          console.warn('[KanbanBoard] Safety timeout triggered - forcing loading to false')
          return false
        }
        return prev
      })
    }, 3000)

    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
      if (safetyTimeoutRef.current) {
        clearTimeout(safetyTimeoutRef.current)
        safetyTimeoutRef.current = null
      }
    }
  }, [fetchTasks])

  const updateTaskStatus = async (taskId: string, newStatus: Task['status']) => {
    try {
      const token = localStorage.getItem('token')
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }
      const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: newStatus }),
      })
      if (!response.ok) {
        throw new Error(`Failed to update task: ${response.statusText}`)
      }
    } catch (err) {
      console.error("Error updating task:", err)
      fetchTasks({ silent: true })
    }
  }

  const handleMoveToInProgress = async (taskId: string) => {
    setTasks((prev) =>
      prev.map((task) =>
        task.id === taskId ? { ...task, status: 'in_progress' as const } : task
      )
    )
    await updateTaskStatus(taskId, 'in_progress')
  }

  const handleBatchMoveToInProgress = async () => {
    const todoIds = Array.from(selectedTaskIds).filter(
      id => tasks.find(t => t.id === id)?.status === 'todo'
    )
    if (todoIds.length === 0) return
    for (const id of todoIds) {
      setTasks((prev) =>
        prev.map((task) =>
          task.id === id ? { ...task, status: 'in_progress' as const } : task
        )
      )
    }
    clearSelection()
    await Promise.all(todoIds.map(id => updateTaskStatus(id, 'in_progress')))
  }

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

      setTasks((prev) =>
        prev.map((task) =>
          batchTaskIds.includes(task.id) ? { ...task, status: newStatus } : task
        )
      )

      await Promise.all(batchTaskIds.map(id => updateTaskStatus(id, newStatus)))
      return
    }

    setTasks((prev) =>
      prev.map((task) =>
        task.id === draggableId ? { ...task, status: newStatus } : task
      )
    )

    await updateTaskStatus(draggableId, newStatus)
  }

  const handleExecute = async (taskId: string) => {
    if (!canExecute) {
      console.error("No active project - connect a repo first")
      return
    }

    try {
      const status = await getSetupStatus();
      if (!status.ready && !hasConfiguredProviders()) {
        setPendingExecuteTaskId(taskId);
        setShowProviderSetup(true);
        return;
      }
    } catch {
    }

    try {
      const token = localStorage.getItem('token')
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {}
      const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}/execute`, {
        method: "POST",
        headers,
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || `Failed to execute task: ${response.statusText}`)
      }
    } catch (err) {
      console.error("Error executing task:", err)
    }
  }

  const handleProviderSetupComplete = useCallback(async () => {
    setShowProviderSetup(false);
    if (pendingExecuteTaskId) {
      const taskId = pendingExecuteTaskId;
      setPendingExecuteTaskId(null);
      // Retry execution
      try {
        const token = localStorage.getItem('token');
        const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
        await fetch(`${API_BASE_URL}/api/tasks/${taskId}/execute`, {
          method: "POST",
          headers,
        });
      } catch (err) {
        console.error("Error executing task:", err);
      }
    }
  }, [pendingExecuteTaskId]);

  const handleCancel = async (taskId: string) => {
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}/cancel`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        throw new Error(`Failed to cancel task: ${response.statusText}`)
      }
    } catch (err) {
      console.error("Error cancelling task:", err)
    }
  }

  const handleTaskClick = async (taskId: string) => {
    setSelectedTaskId(taskId)
    
    if (!taskLogs[taskId]) {
      try {
        const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}/logs`)
        if (response.ok) {
          const data = await response.json()
          setTaskLogs((prev) => ({ ...prev, [taskId]: data.logs || [] }))
        }
      } catch (err) {
        console.error("Error fetching task logs:", err)
      }
    }
  }

  const handleDrawerClose = () => {
    setSelectedTaskId(null)
  }

  const handleDelete = async (taskId: string) => {
    const previousTasks = tasks
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
    setSelectedTaskId(null)
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        setTasks(previousTasks)
      }
    } catch {
      setTasks(previousTasks)
    }
  }

  const handleUpdateTask = async (taskId: string, data: { title?: string; description?: string | null }) => {
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data),
      })
      if (!response.ok) {
        throw new Error(`Failed to update task: ${response.statusText}`)
      }
    } catch (err) {
      console.error("Error updating task:", err)
    }
  }

  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) || null : null

  const getTasksByStatus = (status: Task['status']) => {
    return tasks.filter((task) => task.status === status)
  }

  return {
    tasks,
    loading,
    error,
    executionProgress,
    isTaskFormOpen,
    setIsTaskFormOpen,
    defaultStatus,
    selectedTaskId,
    taskLogs,
    selectedTaskIds,
    selectingColumns,
    activeBatch,
    setActiveBatch,
    completedBatch,
    canExecute,
    selectedProject,
    batchTaskIds,
    completedBatchTaskIds,
    selectedTask,
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
    toggleTaskSelect,
    toggleColumnSelection,
    toggleColumnSelectAll,
    clearSelection,
    fetchTasks,
    showProviderSetup,
    setShowProviderSetup,
    handleProviderSetupComplete,
  }
}
