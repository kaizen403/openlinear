import { useState, useCallback, useMemo, useRef } from "react"
import { toast } from "sonner"
import { apiFetch, NetworkError } from "@/lib/api/fetch"
import { getSetupStatus, OpenCodeUnavailableError } from "@/lib/api/opencode"
import { isModelNotConfiguredApiError } from "@/lib/api/model-errors"
import type { Task } from "@/types/task"
import type { ActiveBatch } from "@/components/board/use-kanban-board"
import type { BatchMode } from "@/components/board/batch-mode"
import { getLockedBatchTaskIds } from "@/components/board/board-state"

export interface UseBatchExecutionProps {
  tasks: Task[]
  selectedTaskIds: Set<string>
  activeBatch: ActiveBatch | null
  setActiveBatch: (batch: ActiveBatch | null) => void
  clearSelection: () => void
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>
  setShowProviderSetup: (show: boolean) => void
  setSelectedTaskIds: React.Dispatch<React.SetStateAction<Set<string>>>
}

export interface UseBatchExecutionReturn {
  completedBatch: { taskIds: string[]; prUrl: string | null; mode: BatchMode } | null
  setCompletedBatch: React.Dispatch<React.SetStateAction<{ taskIds: string[]; prUrl: string | null; mode: BatchMode } | null>>
  batchTaskIds: string[]
  completedBatchTaskIds: string[]
  lockedBatchTaskIds: Set<string>
  handleBatchExecute: (mode: BatchMode) => Promise<void>
  handleCancelBatch: (batchId: string) => Promise<void>
  handleApproveNextBatchTask: (batchId: string) => Promise<void>
  reconcileActiveBatches: () => Promise<void>
}

export function useBatchExecution({
  tasks,
  selectedTaskIds,
  activeBatch,
  setActiveBatch,
  clearSelection,
  setTasks,
  setShowProviderSetup,
  setSelectedTaskIds,
}: UseBatchExecutionProps): UseBatchExecutionReturn {
  const [completedBatch, setCompletedBatch] = useState<{ taskIds: string[]; prUrl: string | null; mode: BatchMode } | null>(null)

  const lockedBatchTaskIds = useMemo(() => getLockedBatchTaskIds(activeBatch), [activeBatch])
  const batchTaskIds = useMemo(() => Array.from(lockedBatchTaskIds) as string[], [lockedBatchTaskIds])
  const completedBatchTaskIds = completedBatch?.taskIds ?? []

  const handleBatchExecute = async (mode: BatchMode) => {
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
        if (status.hasProvider && !status.hasModel) {
          toast.error('Pick a model in Settings → AI Providers before starting batch execution')
        } else {
          toast.error('Configure an AI provider before starting batch execution')
        }
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
      if (isModelNotConfiguredApiError(err)) {
        setShowProviderSetup(true)
        toast.error(err.message)
        return
      }
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
      if (!(err instanceof OpenCodeUnavailableError) && !(err instanceof NetworkError)) {
        console.debug('Active batch reconciliation skipped:', err)
      }
    }
  }, [setActiveBatch])

  return {
    completedBatch,
    setCompletedBatch,
    batchTaskIds,
    completedBatchTaskIds,
    lockedBatchTaskIds,
    handleBatchExecute,
    handleCancelBatch,
    handleApproveNextBatchTask,
    reconcileActiveBatches,
  }
}
