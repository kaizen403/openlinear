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
import { Plus, Loader2, Check, GitPullRequest, ExternalLink, X } from "lucide-react"
import { useSSE, SSEEventType, SSEEventData } from "@/hooks/use-sse"
import { useAuth } from "@/hooks/use-auth"
import { getActivePublicProject, PublicProject } from "@/lib/api"
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

export function KanbanBoard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [executionProgress, setExecutionProgress] = useState<Record<string, ExecutionProgress>>({})
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [defaultStatus, setDefaultStatus] = useState<Task['status']>('todo')
  const [publicProject, setPublicProject] = useState<PublicProject | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskLogs, setTaskLogs] = useState<Record<string, ExecutionLogEntry[]>>({})
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [activeBatch, setActiveBatch] = useState<ActiveBatch | null>(null)
  const [completedBatch, setCompletedBatch] = useState<{ taskIds: string[]; prUrl: string | null; mode: string } | null>(null)
  const { isAuthenticated, activeProject } = useAuth()

  const selectionMode = selectedTaskIds.size > 0

  const batchTaskIds = activeBatch?.tasks.map(t => t.taskId) ?? []
  const completedBatchTaskIds = completedBatch?.taskIds ?? []

  const toggleTaskSelect = (taskId: string) => {
    if (batchTaskIds.includes(taskId)) return
    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const clearSelection = () => setSelectedTaskIds(new Set())

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
    if (!isAuthenticated) {
      getActivePublicProject().then(setPublicProject).catch(() => setPublicProject(null))
    }
  }, [isAuthenticated])

  const canExecute = isAuthenticated ? !!activeProject : !!publicProject

  const handleAddTask = (status: Task['status']) => {
    setDefaultStatus(status)
    setIsTaskFormOpen(true)
  }

  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleSSEEvent = useCallback((eventType: SSEEventType, data: SSEEventData) => {
    switch (eventType) {
      case 'task:created':
        if (data.id && data.title && data.status) {
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
        fetchTasks()
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
  }, [])

  useSSE(SSE_URL, handleSSEEvent)

  const fetchTasks = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/tasks`)
      if (!response.ok) {
        throw new Error(`Failed to fetch tasks: ${response.statusText}`)
      }
      const data = await response.json()
      setTasks(data)
      setError(null)
      setLoading(false)
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
    } catch (err) {
      if (loading) {
        retryTimeoutRef.current = setTimeout(() => fetchTasks(), 2000)
      } else {
        setError(err instanceof Error ? err.message : "Failed to fetch tasks")
        setLoading(false)
      }
    }
  }, [loading])

  useEffect(() => {
    fetchTasks()
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
    }
  }, [])

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
      fetchTasks()
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

  const handleDragEnd = async (result: DropResult) => {
    const { destination, source, draggableId } = result

    if (!destination) return
    if (destination.droppableId === source.droppableId && destination.index === source.index) return

    const newStatus = destination.droppableId as Task['status']
    
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
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        throw new Error(`Failed to delete task: ${response.statusText}`)
      }
      setSelectedTaskId(null)
    } catch (err) {
      console.error("Error deleting task:", err)
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
      <div className="flex-1 overflow-hidden relative bg-[#111111]">
        {activeBatch && (
          <BatchProgress
            batchId={activeBatch.id}
            status={activeBatch.status}
            mode={activeBatch.mode}
            tasks={activeBatch.tasks}
            prUrl={activeBatch.prUrl}
            onCancel={handleCancelBatch}
            onDismiss={activeBatch.status === 'completed' ? () => setActiveBatch(null) : undefined}
            onTaskClick={handleTaskClick}
          />
        )}
        <div className="grid grid-cols-4 h-full">
          {COLUMNS.map((column) => {
            const columnTasks = getTasksByStatus(column.status)
            return (
              <Droppable key={column.id} droppableId={column.id}>
                {(provided, snapshot) => (
                  <Column
                    id={column.id}
                    title={column.title}
                    taskCount={columnTasks.length}
                    onAddTask={() => handleAddTask(column.status)}
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
                              className={snapshot.isDragging ? 'opacity-90' : ''}
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
                                selectionMode={selectionMode}
                                isBatchTask={batchTaskIds.includes(task.id)}
                                isCompletedBatchTask={completedBatch}
                              />
                            </div>
                          )}
                        </Draggable>
                      )

                      if (column.status === 'in_progress' && batchTaskIds.length > 0) {
                        const batch = columnTasks.filter(t => batchTaskIds.includes(t.id))
                        const rest = columnTasks.filter(t => !batchTaskIds.includes(t.id))
                        return (
                          <>
                            {batch.length > 0 && (
                              <div className="border border-dashed border-white/[0.08] rounded-lg p-2 space-y-3 mb-3 bg-white/[0.01]">
                                <div className="flex items-center gap-1.5 px-1">
                                  <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />
                                  <span className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider">
                                    {activeBatch?.mode === 'queue' ? 'Queue' : 'Parallel'} Execution
                                  </span>
                                </div>
                                {batch.map((task, i) => renderTask(task, i))}
                              </div>
                            )}
                            {rest.map((task, i) => renderTask(task, batch.length + i))}
                          </>
                        )
                      }

                      if (column.status === 'done' && completedBatchTaskIds.length > 0) {
                        const batch = columnTasks.filter(t => completedBatchTaskIds.includes(t.id))
                        const rest = columnTasks.filter(t => !completedBatchTaskIds.includes(t.id))
                        return (
                          <>
                            {batch.length > 0 && (
                              <div className="border border-dashed border-purple-500/20 rounded-lg p-2 space-y-3 mb-3 bg-purple-500/[0.02] hover:border-purple-500/40 transition-colors">
                                <div className="flex items-center justify-between px-1">
                                  <div className="flex items-center gap-1.5">
                                    <Check className="w-3 h-3 text-purple-400" />
                                    <span className="text-[11px] text-purple-400/80 font-medium uppercase tracking-wider">
                                      {completedBatch?.mode === 'queue' ? 'Queue' : 'Parallel'} Execution
                                    </span>
                                  </div>
                                  {completedBatch?.prUrl && (
                                    <button
                                      onClick={() => openExternal(completedBatch.prUrl!)}
                                      className="flex items-center gap-1 text-[11px] text-purple-400 hover:text-purple-300 font-medium transition-colors"
                                    >
                                      <GitPullRequest className="w-3 h-3" />
                                      Open PR
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </button>
                                  )}
                                </div>
                                {batch.map((task, i) => renderTask(task, i, true))}
                              </div>
                            )}
                            {rest.map((task, i) => renderTask(task, batch.length + i))}
                          </>
                        )
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
          const selectedNonDoneTaskIds = Array.from(selectedTaskIds).filter(
            id => tasks.find(t => t.id === id)?.status !== 'done'
          )
          return selectedNonDoneTaskIds.length > 0 ? (
            <BatchControls
              selectedCount={selectedNonDoneTaskIds.length}
              onExecuteParallel={() => handleBatchExecute('parallel')}
              onExecuteQueue={() => handleBatchExecute('queue')}
              onClearSelection={clearSelection}
              disabled={!canExecute}
            />
          ) : null
        })()}
      </div>
    </DragDropContext>
  )
}
