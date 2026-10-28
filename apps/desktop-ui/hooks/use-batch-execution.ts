import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import { toast } from "sonner"
import { apiFetch, NetworkError } from "@/lib/api/fetch"
import { getSetupStatus, OpenCodeUnavailableError } from "@/lib/api/opencode"
import { isModelNotConfiguredApiError } from "@/lib/api/model-errors"
import { isApiErrorCode, toastApiError } from "@/lib/api/errors"
import type { Task } from "@/types/task"
import type { ActiveBatch } from "@/components/board/use-kanban-board"
import type { BatchMode } from "@/components/board/batch-mode"
import { getLockedBatchTaskIds } from "@/components/board/board-state"
import {
  batchNeedsAttention,
  carryBatchDetail,
  isBatchStatusResponse,
  isTerminalBatchStatus,
  mergeBatchDetail,
  toActiveBatch,
} from "@/components/board/batch-state"

export interface UseBatchExecutionProps {
  tasks: Task[]
  selectedTaskIds: Set<string>
  activeBatch: ActiveBatch | null
  setActiveBatch: React.Dispatch<React.SetStateAction<ActiveBatch | null>>
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
  /**
   * The last finished batch (completed/failed/cancelled) with its W01
   * publication and retained-work details. Kept until dismissed — the live
   * batch is cleared a few seconds after failure/cancellation, but retained
   * branches and unconfirmed stops must stay visible.
   */
  settledBatch: ActiveBatch | null
  dismissSettledBatch: () => void
  handleBatchExecute: (mode: BatchMode) => Promise<void>
  /** FE-10: start a batch of exactly these tasks (any column). */
  handleBatchExecuteTasks: (taskIds: string[], mode: BatchMode) => Promise<void>
  /** Resolves true once the sidecar accepted the cancellation. */
  handleCancelBatch: (batchId: string) => Promise<boolean>
  handleApproveNextBatchTask: (batchId: string) => Promise<void>
  reconcileActiveBatches: () => Promise<void>
  refreshBatchDetail: (batchId: string) => Promise<void>
}

const LIVE_BATCH_STATUSES = new Set(['running', 'pending', 'merging'])

function fetchBatchDetail(batchId: string): Promise<unknown> {
  return apiFetch<unknown>(`/api/batches/${batchId}`, { sidecar: true })
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
  const [settledBatch, setSettledBatch] = useState<ActiveBatch | null>(null)

  const lockedBatchTaskIds = useMemo(() => getLockedBatchTaskIds(activeBatch), [activeBatch])
  const batchTaskIds = useMemo(() => Array.from(lockedBatchTaskIds) as string[], [lockedBatchTaskIds])
  const completedBatchTaskIds = completedBatch?.taskIds ?? []

  /** Pull publication, retained branches and unconfirmed stops from the sidecar. */
  const refreshBatchDetail = useCallback(async (batchId: string) => {
    try {
      const detail = await fetchBatchDetail(batchId)
      if (!isBatchStatusResponse(detail) || detail.id !== batchId) return
      const enriched = toActiveBatch(detail)
      setActiveBatch((prev) => (prev && prev.id === batchId ? mergeBatchDetail(prev, enriched) : prev))
      setSettledBatch((prev) => {
        if (prev && prev.id === batchId) return mergeBatchDetail(prev, enriched)
        return prev
      })
    } catch (err) {
      // A finished batch is evicted from the sidecar after ~10 minutes; the
      // board keeps what it already knows.
      if (!(err instanceof OpenCodeUnavailableError) && !(err instanceof NetworkError)) {
        console.debug('Batch detail refresh skipped:', err)
      }
    }
  }, [setActiveBatch])

  // Retain the finished batch, and drop it once a different batch starts.
  useEffect(() => {
    if (!activeBatch) return
    if (isTerminalBatchStatus(activeBatch.status)) {
      setSettledBatch((prev) => carryBatchDetail(prev, activeBatch))
    } else {
      setSettledBatch((prev) => (prev && prev.id !== activeBatch.id ? null : prev))
    }
  }, [activeBatch])

  // Fetch the detail once per terminal state / failed member, so failure and
  // cancellation views show the retained branches and publication facts the
  // SSE events don't carry.
  const enrichedSignatureRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeBatch || activeBatch.id.startsWith('starting-')) return
    const troubled = activeBatch.tasks.filter((task) => task.status === 'failed' || task.status === 'skipped' || task.status === 'cancelled').length
    if (!isTerminalBatchStatus(activeBatch.status) && troubled === 0) return
    const signature = `${activeBatch.id}:${activeBatch.status}:${troubled}`
    if (enrichedSignatureRef.current === signature) return
    enrichedSignatureRef.current = signature
    void refreshBatchDetail(activeBatch.id)
  }, [activeBatch, refreshBatchDetail])

  const dismissSettledBatch = useCallback(() => setSettledBatch(null), [])

  /** Start a batch of exactly `taskIds`; restores the board state if it can't start. */
  const startBatch = async (taskIds: string[], mode: BatchMode, options: { clearSelection: boolean }) => {
    const previousSelection = selectedTaskIds
    const previousTasks = tasks
    const previousActiveBatch = activeBatch
    const pendingTasks = taskIds.map((taskId) => {
      const task = tasks.find(candidate => candidate.id === taskId)
      return {
        taskId,
        title: task?.title || 'Untitled task',
        status: 'queued' as const,
      }
    })

    if (options.clearSelection) clearSelection()
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
        tasks: Array<{ taskId: string; title: string; status: ActiveBatch['tasks'][number]['status']; branch?: string }>
      }>('/api/batches', {
        method: 'POST',
        sidecar: true,
        body: JSON.stringify({ taskIds, mode }),
      })
      setActiveBatch({
        id: created.id,
        status: created.status || 'running',
        mode: created.mode || mode,
        tasks: created.tasks.map(t => ({
          taskId: t.taskId,
          title: t.title,
          status: t.status,
          ...(t.branch ? { branch: t.branch } : {}),
        })),
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
      console.error('Error creating batch:', err)
      toastApiError(err, { fallbackMessage: 'Failed to start the batch' })
    }
  }

  const handleBatchExecute = async (mode: BatchMode) => {
    const inProgressTaskIds = Array.from(selectedTaskIds).filter(
      id => tasks.find(t => t.id === id)?.status === 'in_progress'
    )
    if (inProgressTaskIds.length === 0) {
      toast.error('Select at least one In Progress task to execute as a batch')
      return
    }
    await startBatch(inProgressTaskIds, mode, { clearSelection: true })
  }

  /** FE-10: a batch of exactly these tasks, from any column (e.g. a task and its blockers). */
  const handleBatchExecuteTasks = async (taskIds: string[], mode: BatchMode) => {
    await startBatch(taskIds, mode, { clearSelection: false })
  }

  const handleCancelBatch = useCallback(async (batchId: string): Promise<boolean> => {
    try {
      // Cancellation is acknowledged only by the HTTP result (W01).
      await apiFetch(`/api/batches/${batchId}/cancel`, {
        method: 'POST',
        sidecar: true,
      })
      void refreshBatchDetail(batchId)
      return true
    } catch (err) {
      console.error('Error cancelling batch:', err)
      const incomplete = isApiErrorCode(err, 'CANCEL_INCOMPLETE')
      toastApiError(err, {
        fallbackMessage: 'Failed to cancel batch',
        ...(incomplete ? { action: { label: 'Retry stop', onClick: () => { void handleCancelBatchRef.current(batchId) } } } : {}),
      })
      void refreshBatchDetail(batchId)
      return false
    }
  }, [refreshBatchDetail])
  const handleCancelBatchRef = useRef(handleCancelBatch)
  handleCancelBatchRef.current = handleCancelBatch

  const handleApproveNextBatchTask = useCallback(async (batchId: string) => {
    try {
      await apiFetch(`/api/batches/${batchId}/approve`, {
        method: 'POST',
        sidecar: true,
      })
    } catch (err) {
      console.error('Error approving next batch task:', err)
      toastApiError(err, { fallbackMessage: 'Failed to approve next task' })
    }
  }, [])

  const reconcileActiveBatches = useCallback(async () => {
    try {
      const batches = await apiFetch<Array<{ id: string; status: string; mode: BatchMode; createdAt?: string }>>(
        '/api/batches',
        { sidecar: true },
      )
      if (!Array.isArray(batches)) return
      const running = batches.find(b => LIVE_BATCH_STATUSES.has(b.status))
      if (running) {
        const detail = await fetchBatchDetail(running.id)
        if (isBatchStatusResponse(detail)) setActiveBatch(toActiveBatch(detail))
        return
      }
      // No live batch: after a reload, still surface the newest finished batch
      // when it needs action (unconfirmed stop or publication error).
      const finished = batches
        .filter(b => isTerminalBatchStatus(b.status))
        .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))[0]
      if (!finished) return
      const detail = await fetchBatchDetail(finished.id)
      if (!isBatchStatusResponse(detail)) return
      const batch = toActiveBatch(detail)
      if (batchNeedsAttention(batch)) setSettledBatch((prev) => prev ?? batch)
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
    settledBatch,
    dismissSettledBatch,
    handleBatchExecute,
    handleBatchExecuteTasks,
    handleCancelBatch,
    handleApproveNextBatchTask,
    reconcileActiveBatches,
    refreshBatchDetail,
  }
}
