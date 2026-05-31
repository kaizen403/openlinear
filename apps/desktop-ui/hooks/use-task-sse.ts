import { useCallback, useEffect, useRef } from "react"
import type { SSEEventType, SSEEventData } from "@/providers/sse-provider"
import { useSSESubscription } from "@/providers/sse-provider"
import { Task, ExecutionProgress, ExecutionLogEntry } from "@/types/task"
import {
  appendExecutionLog,
  clearExecutionProgress,
  setExecutionProgress,
} from "@/lib/execution-state-store"
import { upsertBoardTask } from "@/components/board/board-state"
import type { ActiveBatch } from "@/components/board/use-kanban-board"
import type { BatchMode } from "@/components/board/batch-mode"

export interface UseTaskSSEProps {
  projectId?: string | null
  teamId?: string | null
  isAuthenticated: boolean
  refreshActiveRepository: () => void
  fetchTasks: (options?: { silent?: boolean }) => Promise<void>
  reconcileActiveBatches: () => Promise<void>
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string | null>>
  setSelectedTaskIds: React.Dispatch<React.SetStateAction<Set<string>>>
  setActiveBatch: React.Dispatch<React.SetStateAction<ActiveBatch | null>>
  setCompletedBatch: React.Dispatch<React.SetStateAction<{ taskIds: string[]; prUrl: string | null; mode: BatchMode } | null>>
  setTaskDeletionMode: React.Dispatch<React.SetStateAction<"archive" | "delete">>
  lastSelectedIdRef: React.MutableRefObject<string | null>
}

export function useTaskSSE({
  projectId,
  teamId,
  isAuthenticated,
  refreshActiveRepository,
  fetchTasks,
  reconcileActiveBatches,
  setTasks,
  setSelectedTaskId,
  setSelectedTaskIds,
  setActiveBatch,
  setCompletedBatch,
  setTaskDeletionMode,
  lastSelectedIdRef,
}: UseTaskSSEProps) {
  const batchDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (batchDismissTimerRef.current) clearTimeout(batchDismissTimerRef.current)
    }
  }, [])

  const handleSSEEvent = useCallback((eventType: SSEEventType, data: SSEEventData) => {
    switch (eventType) {
      case 'task:created':
        if (data.id && data.title && data.status) {
          const taskProjectId = data.projectId
          const taskTeamId = data.teamId
          if (projectId && taskProjectId !== projectId) break
          if (teamId && taskTeamId !== teamId) break
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
            teamId: taskTeamId ?? null,
            projectId: taskProjectId ?? null,
            assigneeId: data.assigneeId ?? null,
            creatorId: data.creatorId ?? null,
            assignee: data.assignee ?? null,
            creator: data.creator ?? null,
            model: data.model ?? null,
            archived: data.archived ?? false,
          }
          setTasks((prev) => upsertBoardTask(prev, newTask))
        }
        break

      case 'tasks:bulk-created':
        if (!projectId || data.projectId === projectId) {
          fetchTasks({ silent: true })
        }
        break

      case 'task:updated':
        if (data.id) {
          if (data.status && data.status !== 'in_progress') {
            clearExecutionProgress(data.id)
          }
          const movedOutOfScope =
            data.archived === true ||
            (projectId !== undefined && projectId !== null && data.projectId !== undefined && data.projectId !== projectId) ||
            (teamId !== undefined && teamId !== null && data.teamId !== undefined && data.teamId !== teamId)

          if (movedOutOfScope) {
            setTasks((prev) => prev.filter((task) => task.id !== data.id))
            setSelectedTaskId((prev) => (prev === data.id ? null : prev))
            setSelectedTaskIds((prev) => {
              if (!prev.has(data.id!)) return prev
              const next = new Set(prev)
              next.delete(data.id!)
              return next
            })
            if (lastSelectedIdRef.current === data.id) {
              lastSelectedIdRef.current = null
            }
            break
          }

          setTasks((prev) => {
            const existing = prev.find((task) => task.id === data.id)
            if (!existing) return prev

            const updated: Task = {
              ...existing,
              ...(data.title !== undefined && { title: data.title }),
              ...(data.description !== undefined && { description: data.description }),
              ...(data.priority !== undefined && { priority: data.priority }),
              ...(data.status !== undefined && { status: data.status }),
              ...(data.sessionId !== undefined && { sessionId: data.sessionId }),
              ...(data.updatedAt !== undefined && { updatedAt: data.updatedAt }),
              ...(data.labels !== undefined && { labels: data.labels }),
              ...(data.executionStartedAt !== undefined && { executionStartedAt: data.executionStartedAt }),
              ...(data.executionPausedAt !== undefined && { executionPausedAt: data.executionPausedAt }),
              ...(data.executionElapsedMs !== undefined && { executionElapsedMs: data.executionElapsedMs }),
              ...(data.executionProgress !== undefined && { executionProgress: data.executionProgress }),
              ...(data.prUrl !== undefined && { prUrl: data.prUrl }),
              ...(data.outcome !== undefined && { outcome: data.outcome }),
              ...(data.batchId !== undefined && { batchId: data.batchId }),
              ...(data.dueDate !== undefined && { dueDate: data.dueDate }),
              ...(data.inboxRead !== undefined && { inboxRead: data.inboxRead }),
              ...(data.identifier !== undefined && { identifier: data.identifier }),
              ...(data.number !== undefined && { number: data.number }),
              ...(data.teamId !== undefined && { teamId: data.teamId }),
              ...(data.projectId !== undefined && { projectId: data.projectId }),
              ...(data.assigneeId !== undefined && { assigneeId: data.assigneeId }),
              ...(data.creatorId !== undefined && { creatorId: data.creatorId }),
              ...(data.assignee !== undefined && { assignee: data.assignee }),
              ...(data.creator !== undefined && { creator: data.creator }),
              ...(data.model !== undefined && { model: data.model }),
              ...(data.archived !== undefined && { archived: data.archived }),
            }

            return upsertBoardTask(prev, updated)
          })
        }
        break

      case 'task:deleted':
        if (data.id) {
          clearExecutionProgress(data.id)
          setTasks((prev) => prev.filter((task) => task.id !== data.id))
          setSelectedTaskIds((prev) => {
            if (!prev.has(data.id!)) return prev
            const next = new Set(prev)
            next.delete(data.id!)
            return next
          })
          setSelectedTaskId((prev) => (prev === data.id ? null : prev))
          if (lastSelectedIdRef.current === data.id) {
            lastSelectedIdRef.current = null
          }
        }
        break

      case 'execution:progress': {
        const progressData = data as unknown as ExecutionProgress
        if (progressData.taskId) {
          setExecutionProgress(progressData)
        }
        break
      }

      case 'execution:log': {
        const logData = data as unknown as { taskId: string; entry: ExecutionLogEntry }
        if (logData.taskId && logData.entry) {
          appendExecutionLog(logData.taskId, logData.entry)
        }
        break
      }

      case 'connected':
        console.log("[SSE] Connected with clientId:", data.clientId)
        fetchTasks({ silent: true })
        if (isAuthenticated) {
          refreshActiveRepository()
        }
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
        setActiveBatch((prev) => {
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
        setActiveBatch((prev) => {
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
        setActiveBatch((prev) => {
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
        setActiveBatch((prev) => {
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
        setActiveBatch((prev) => {
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
        setActiveBatch((prev) => {
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
        setActiveBatch((prev) => {
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
        setActiveBatch((prev) => {
          if (prev && prev.id === data.batchId) {
            if (batchDismissTimerRef.current) clearTimeout(batchDismissTimerRef.current)
            batchDismissTimerRef.current = setTimeout(() => setActiveBatch(null), 5000)
            return { ...prev, status: eventType.split(':')[1]! } as ActiveBatch
          }
          return prev
        })
        break

      case 'settings:updated':
        if (data?.taskDeletionMode === 'archive' || data?.taskDeletionMode === 'delete') {
          setTaskDeletionMode(data.taskDeletionMode)
        }
        break

      default:
        break
    }
  }, [fetchTasks, isAuthenticated, refreshActiveRepository, projectId, teamId, reconcileActiveBatches, setTasks, setSelectedTaskId, setSelectedTaskIds, setActiveBatch, setCompletedBatch, setTaskDeletionMode, lastSelectedIdRef])

  useSSESubscription(handleSSEEvent)
}
