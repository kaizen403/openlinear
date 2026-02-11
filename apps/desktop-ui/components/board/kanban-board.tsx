"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { DragDropContext, Droppable, Draggable, DropResult } from "@hello-pangea/dnd"
import { Column } from "./column"
import { TaskCard } from "./task-card"
import { BatchControls } from "./batch-controls"
import { BatchProgress } from "./batch-progress"
import { DashboardLoading } from "./dashboard-loading"
import { TaskFormDialog } from "@/components/task-form"
import { TaskDetailView } from "@/components/task-detail-view"
import { Plus, Loader2, Check, GitPullRequest, ExternalLink, GripVertical } from "lucide-react"
import { useSSE, SSEEventType, SSEEventData } from "@/hooks/use-sse"
import { useAuth } from "@/hooks/use-auth"
import { getActivePublicRepository, PublicRepository, Project } from "@/lib/api"
import { openExternal } from "@/lib/utils"
import { Task, ExecutionProgress, ExecutionLogEntry } from "@/types/task"

const COLUMNS = [
  { id: 'todo', title: 'Todo', status: 'todo' as const },
  { id: 'in_progress', title: 'In Progress', status: 'in_progress' as const },
  { id: 'done', title: 'Done', status: 'done' as const },
  { id: 'cancelled', title: 'Cancelled', status: 'cancelled' as const },
]

interface ActiveBatch {
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

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
const SSE_URL = `${API_BASE_URL}/api/events`

interface KanbanBoardProps {
  projectId?: string | null
  teamId?: string | null
  projects?: Project[]
}

export function KanbanBoard({ projectId, teamId, projects = [] }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [executionProgress, setExecutionProgress] = useState<Record<string, ExecutionProgress>>({})
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [defaultStatus, setDefaultStatus] = useState<Task['status']>('todo')
  const [publicProject, setPublicProject] = useState<PublicRepository | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskLogs, setTaskLogs] = useState<Record<string, ExecutionLogEntry[]>>({})
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [selectingColumns, setSelectingColumns] = useState<Set<string>>(new Set())
  const [activeBatch, setActiveBatch] = useState<ActiveBatch | null>(null)
  const [completedBatch, setCompletedBatch] = useState<{ taskIds: string[]; prUrl: string | null; mode: string } | null>(null)
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

  const refreshPublicProject = useCallback(async () => {
    if (!isAuthenticated) {
      try {
        const project = await getActivePublicRepository()
        setPublicProject(project)
      } catch {
        setPublicProject(null)
      }
    }
  }, [isAuthenticated])

  useEffect(() => {
    refreshPublicProject()
  }, [refreshPublicProject])

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (isAuthenticated) {
        refreshActiveRepository()
      }
      refreshPublicProject()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleVisibility)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleVisibility)
    }
  }, [isAuthenticated, refreshActiveRepository, refreshPublicProject])

  const canExecute = isAuthenticated ? !!activeRepository : !!publicProject

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
        refreshPublicProject()
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
  }, [fetchTasks, isAuthenticated, refreshActiveRepository, refreshPublicProject, projectId, teamId])

  useSSE(SSE_URL, handleSSEEvent)

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
    }, 10000)

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

  if (loading) {
    return <DashboardLoading />
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={() => { setLoading(true); setError(null); fetchTasks() }}
            className="px-4 py-2 bg-linear-accent text-white rounded-md hover:bg-linear-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex-1 overflow-hidden relative bg-[#111111] flex flex-col">
        {activeBatch && (
          <BatchProgress
            batchId={activeBatch.id}
            status={activeBatch.status}
            mode={activeBatch.mode}
            tasks={activeBatch.tasks}
            prUrl={activeBatch.prUrl}
            onCancel={handleCancelBatch}
            onDismiss={activeBatch.status === 'completed' ? () => setActiveBatch(null) : undefined}
            onViewActivity={handleTaskClick}
          />
        )}
        <div className="flex md:grid md:grid-cols-2 lg:grid-cols-4 flex-1 min-h-0 overflow-x-auto snap-x snap-mandatory md:overflow-x-visible">
          {COLUMNS.map((column) => {
            const columnTasks = getTasksByStatus(column.status)
            const hasParallelGroup =
              (column.status === 'in_progress' && batchTaskIds.length > 0) ||
              (column.status === 'done' && completedBatchTaskIds.length > 0)
            const selectionActive = !hasParallelGroup && selectingColumns.has(column.id)
            return (
              <Droppable key={column.id} droppableId={column.id}>
                {(provided, snapshot) => (
                  <Column
                    id={column.id}
                    title={column.title}
                    taskCount={columnTasks.length}
                    onAddTask={() => handleAddTask(column.status)}
                    selectionActive={selectionActive}
                    onToggleSelection={!hasParallelGroup ? () => toggleColumnSelection(column.id) : undefined}
                    onSelectAll={selectionActive ? () => toggleColumnSelectAll(column.status) : undefined}
                    innerRef={provided.innerRef}
                    droppableProps={provided.droppableProps}
                    isDraggingOver={snapshot.isDraggingOver}
                  >
                    {columnTasks.length === 0 && !snapshot.isDraggingOver ? (
                      <button
                        onClick={() => handleAddTask(column.status)}
                        className="w-full flex flex-col items-center justify-center py-8 text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-white/[0.03] rounded-lg transition-all cursor-pointer group"
                      >
                        <div className="w-10 h-10 rounded-full bg-white/[0.04] flex items-center justify-center mb-3 group-hover:bg-white/[0.06] group-hover:scale-110 transition-all">
                          <Plus className="w-5 h-5" />
                        </div>
                        <span className="text-sm">Add task</span>
                      </button>
                    ) : (() => {
                      const renderTask = (task: Task, index: number, completedBatch?: boolean) => (
                        <Draggable key={task.id} draggableId={task.id} index={index}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                              style={provided.draggableProps.style}
                            >
                              <TaskCard
                                task={task}
                                onMoveToInProgress={column.status === 'todo' ? handleMoveToInProgress : undefined}
                                onExecute={column.status === 'in_progress' && canExecute ? handleExecute : undefined}
                                onCancel={column.status === 'in_progress' ? handleCancel : undefined}
                                onDelete={handleDelete}
                                onTaskClick={handleTaskClick}
                                executionProgress={executionProgress[task.id]}
                                selected={selectedTaskIds.has(task.id)}
                                onToggleSelect={toggleTaskSelect}
                                selectionMode={selectionActive}
                                isBatchTask={batchTaskIds.includes(task.id)}
                                isCompletedBatchTask={completedBatch}
                                isDragging={snapshot.isDragging}
                              />
                            </div>
                          )}
                        </Draggable>
                      )

                      if (column.status === 'in_progress' && batchTaskIds.length > 0) {
                        const batch = columnTasks.filter(t => batchTaskIds.includes(t.id))
                        const rest = columnTasks.filter(t => !batchTaskIds.includes(t.id))
                        const batchGroupCount = batch.length > 0 && activeBatch ? 1 : 0
                        return (
                          <>
                            {batch.length > 0 && activeBatch && (
                              <Draggable draggableId={`batch-group-${activeBatch.id}`} index={0}>
                                {(provided, snapshot) => (
                                  <div
                                    ref={provided.innerRef}
                                    {...provided.draggableProps}
                                    className={`border border-dashed border-white/[0.08] rounded-lg p-2 mb-3 bg-white/[0.01] transition-all duration-200 ${snapshot.isDragging ? 'shadow-2xl shadow-black/50 ring-1 ring-white/10 scale-[1.02] rotate-1' : ''}`}
                                  >
                                    <div className="flex items-center gap-1.5 px-1 mb-1.5" {...provided.dragHandleProps}>
                                      <GripVertical className="w-3 h-3 text-zinc-500/60 cursor-grab active:cursor-grabbing" />
                                      <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />
                                      <span className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider">
                                        {activeBatch.mode === 'queue' ? 'Queue' : 'Parallel'} Issues
                                      </span>
                                    </div>
                                    <div className="space-y-0">
                                      {batch.map((task, i) => (
                                        <div key={`batch-connector-${task.id}`}>
                                          {i > 0 && (
                                            <div className="flex justify-center">
                                              <div className="w-px h-2 bg-white/[0.12]" />
                                            </div>
                                          )}
                                          <TaskCard
                                            task={task}
                                            onMoveToInProgress={undefined}
                                            onExecute={canExecute ? handleExecute : undefined}
                                            onCancel={handleCancel}
                                            onDelete={handleDelete}
                                            onTaskClick={handleTaskClick}
                                            executionProgress={executionProgress[task.id]}
                                            selected={selectedTaskIds.has(task.id)}
                                            onToggleSelect={toggleTaskSelect}
                                            selectionMode={false}
                                            isBatchTask={true}
                                            isCompletedBatchTask={false}
                                            isDragging={false}
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </Draggable>
                            )}
                            {rest.map((task, i) => renderTask(task, batchGroupCount + i))}
                          </>
                        )
                      }

                      if (column.status === 'done') {
                        const batchGroups = new Map<string, Task[]>()
                        const orderedItems: Array<
                          { type: 'group'; batchId: string; tasks: Task[] }
                          | { type: 'task'; task: Task }
                        > = []

                        for (const t of columnTasks) {
                          if (t.batchId) {
                            if (!batchGroups.has(t.batchId)) {
                              const group: Task[] = []
                              batchGroups.set(t.batchId, group)
                              orderedItems.push({ type: 'group', batchId: t.batchId, tasks: group })
                            }
                            batchGroups.get(t.batchId)!.push(t)
                          } else {
                            orderedItems.push({ type: 'task', task: t })
                          }
                        }

                        if (batchGroups.size > 0) {
                          return (
                            <>
                              {orderedItems.map((item, index) => {
                                if (item.type === 'task') {
                                  return renderTask(item.task, index)
                                }

                                const batchTasks = item.tasks
                                const groupPrUrl = batchTasks.find(t => t.prUrl)?.prUrl || null
                                const groupMode = completedBatch?.taskIds.some(id => batchTasks.some(t => t.id === id))
                                  ? completedBatch.mode
                                  : null

                                return (
                                  <Draggable key={`batch-group-${item.batchId}`} draggableId={`batch-group-${item.batchId}`} index={index}>
                                    {(provided, snapshot) => (
                                      <div
                                        ref={provided.innerRef}
                                        {...provided.draggableProps}
                                        className={`border border-dashed border-purple-500/20 rounded-lg p-2 space-y-3 mb-3 hover:border-purple-500/40 transition-all duration-200 ${snapshot.isDragging ? 'shadow-2xl shadow-black/50 ring-1 ring-purple-500/20 scale-[1.02] rotate-1' : ''}`}
                                      >
                                        <div className="flex items-center justify-between gap-3 px-1" {...provided.dragHandleProps}>
                                          <div className="flex items-center gap-1.5 min-w-0">
                                            <GripVertical className="w-3 h-3 text-purple-400/60 cursor-grab active:cursor-grabbing flex-shrink-0" />
                                            <Check className="w-3 h-3 text-purple-400 flex-shrink-0" />
                                            <span className="text-[11px] text-purple-400/80 font-medium uppercase tracking-wider truncate">
                                              {groupMode === 'queue' ? 'Queue' : 'Parallel'} Issues
                                            </span>
                                          </div>
                                          {groupPrUrl && (
                                            <button
                                              onClick={() => openExternal(groupPrUrl)}
                                              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/30 hover:border-purple-500/50 text-[11px] text-purple-300 font-medium transition-all duration-200 flex-shrink-0"
                                            >
                                              <GitPullRequest className="w-3 h-3" />
                                              Open PR
                                              <ExternalLink className="w-2.5 h-2.5" />
                                            </button>
                                          )}
                                        </div>
                                        {batchTasks.map((task) => (
                                          <TaskCard
                                            key={task.id}
                                            task={task}
                                            onMoveToInProgress={undefined}
                                            onExecute={undefined}
                                            onCancel={undefined}
                                            onDelete={handleDelete}
                                            onTaskClick={handleTaskClick}
                                            executionProgress={executionProgress[task.id]}
                                            selected={selectedTaskIds.has(task.id)}
                                            onToggleSelect={toggleTaskSelect}
                                            selectionMode={false}
                                            isBatchTask={false}
                                            isCompletedBatchTask={true}
                                            isDragging={false}
                                          />
                                        ))}
                                      </div>
                                    )}
                                  </Draggable>
                                )
                              })}
                            </>
                          )
                        }
                      }

                      return columnTasks.map((task, index) => renderTask(task, index))
                    })()}
                    {provided.placeholder}
                  </Column>
                )}
              </Droppable>
            )
          })}
        </div>

        <TaskFormDialog
          open={isTaskFormOpen}
          onOpenChange={setIsTaskFormOpen}
          defaultStatus={defaultStatus}
          defaultProjectId={projectId}
          projects={projects}
        />

        <TaskDetailView
          task={selectedTask}
          logs={selectedTaskId ? (taskLogs[selectedTaskId] || []) : []}
          progress={selectedTaskId ? executionProgress[selectedTaskId] : undefined}
          open={!!selectedTaskId}
          onClose={handleDrawerClose}
          onDelete={handleDelete}
          onCancel={handleCancel}
          onExecute={selectedTaskId && batchTaskIds.includes(selectedTaskId) ? undefined : handleExecute}
          onUpdate={handleUpdateTask}
          isExecuting={selectedTask?.status === 'in_progress'}
        />

        {(() => {
          if (selectedTaskIds.size === 0) return null
          const selectedTodoIds = Array.from(selectedTaskIds).filter(
            id => tasks.find(t => t.id === id)?.status === 'todo'
          )
          const selectedInProgressIds = Array.from(selectedTaskIds).filter(
            id => tasks.find(t => t.id === id)?.status === 'in_progress'
          )
          const hasTodo = selectedTodoIds.length > 0
          const hasInProgress = selectedInProgressIds.length > 0
          const mode = hasTodo && hasInProgress ? 'mixed' as const : hasTodo ? 'move' as const : hasInProgress ? 'execute' as const : 'view' as const
          return (
            <BatchControls
              selectedCount={selectedTaskIds.size}
              mode={mode}
              onExecuteParallel={() => handleBatchExecute('parallel')}
              onExecuteQueue={() => handleBatchExecute('queue')}
              onMoveToInProgress={handleBatchMoveToInProgress}
              onClearSelection={clearSelection}
              disabled={!canExecute}
            />
          )
        })()}
      </div>
    </DragDropContext>
  )
}
