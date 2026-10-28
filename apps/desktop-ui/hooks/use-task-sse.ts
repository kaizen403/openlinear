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
import { isOutsideBoardScope, mergeTaskUpdate, taskFromCreatedEvent } from "@/lib/query/task-cache"
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
  /**
   * The board's single removal path for remote deletes. A bulk delete is
   * announced twice — `tasks:bulk-deleted` plus one `task:deleted` per task —
   * and this handler must treat the second announcement as a no-op. Without
   * it, `task:deleted` falls back to a local, identity-preserving removal.
   */
  onTasksRemoved?: (taskIds: string[]) => void
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
  onTasksRemoved,
}: UseTaskSSEProps) {
  const batchDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (batchDismissTimerRef.current) clearTimeout(batchDismissTimerRef.current)
    }
  }, [])

  const handleSSEEvent = useCallback((eventType: SSEEventType, data: SSEEventData) => {
    switch (eventType) {
      case 'task:created': {
        // Same construction and scope rules as the SSE → cache bridge (lib/query/task-cache).
        const newTask = taskFromCreatedEvent(data)
        if (!newTask) break
        if (projectId && newTask.projectId !== projectId) break
        if (teamId && newTask.teamId !== teamId) break
        setTasks((prev) => upsertBoardTask(prev, newTask))
        break
      }

      case 'tasks:bulk-created':
        if (!projectId || data.projectId === projectId) {
          fetchTasks({ silent: true })
        }
        break

      case 'task:updated':
        if (data.id) {
          const taskId = data.id
          if (data.status && data.status !== 'in_progress') {
            clearExecutionProgress(taskId)
          }
          if (isOutsideBoardScope({ projectId: projectId ?? null, teamId: teamId ?? null }, data)) {
            setTasks((prev) => prev.filter((task) => task.id !== taskId))
            setSelectedTaskId((prev) => (prev === taskId ? null : prev))
            setSelectedTaskIds((prev) => {
              if (!prev.has(taskId)) return prev
              const next = new Set(prev)
              next.delete(taskId)
              return next
            })
            if (lastSelectedIdRef.current === taskId) {
              lastSelectedIdRef.current = null
            }
            break
          }

          setTasks((prev) => {
            const existing = prev.find((task) => task.id === taskId)
            if (!existing) return prev
            const updated = mergeTaskUpdate(existing, data)
            return updated === existing ? prev : upsertBoardTask(prev, updated)
          })
        }
        break

      case 'task:deleted':
        if (data.id) {
          if (onTasksRemoved) {
            onTasksRemoved([data.id])
            break
          }
          const deletedId = data.id
          clearExecutionProgress(deletedId)
          // Same array when the task is already gone (a repeated announcement).
          setTasks((prev) => (prev.some((task) => task.id === deletedId) ? prev.filter((task) => task.id !== deletedId) : prev))
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
        // Run-journal events from the API ({ runId, taskId, seq, type, payload })
        // share this SSE name but are not legacy progress: they have no
        // `status`, and storing them would make task cards read an undefined
        // phase. The run model consumes them directly (lib/run-model).
        if ('runId' in data && 'seq' in data) break
        const progressData = data as unknown as ExecutionProgress
        if (progressData.taskId && typeof progressData.status === 'string') {
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

      case 'replay-gap':
        // The stream could not replay what was missed: resynchronize like a
        // fresh connection instead of trusting partial live state.
        fetchTasks({ silent: true })
        void reconcileActiveBatches()
        break

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

      case 'batch:progress':
        // Sidecar progress beats: a member's work was committed locally
        // (publish-ready, not done), or a cancelled batch's cleanup retained
        // artifacts and reports its publication state.
        setActiveBatch((prev) => {
          if (!prev || prev.id !== data.batchId) return prev
          let next = prev
          if (data.phase === 'committed' && typeof data.taskId === 'string') {
            next = {
              ...next,
              tasks: next.tasks.map(t =>
                t.taskId === data.taskId && t.status === 'running' ? { ...t, status: 'completed' } : t
              ),
            }
          }
          if (data.publication !== undefined) {
            next = { ...next, publication: (data.publication as ActiveBatch['publication']) ?? null }
          }
          return next
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
  }, [fetchTasks, isAuthenticated, refreshActiveRepository, projectId, teamId, reconcileActiveBatches, setTasks, setSelectedTaskId, setSelectedTaskIds, setActiveBatch, setCompletedBatch, setTaskDeletionMode, lastSelectedIdRef, onTasksRemoved])

  useSSESubscription(handleSSEEvent)
}
