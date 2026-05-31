import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  },
  Toaster: () => null,
}))

vi.mock('@/lib/api/fetch', () => ({
  apiFetch: vi.fn(),
  NetworkError: class NetworkError extends Error {
    constructor(m) { super(m); this.name = 'NetworkError' }
  },
}))

vi.mock('@/lib/api/opencode', () => ({
  getSetupStatus: vi.fn(),
  OpenCodeUnavailableError: class OpenCodeUnavailableError extends Error {
    constructor(s, m) { super(m); this.status = s; this.name = 'OpenCodeUnavailableError' }
  },
}))

vi.mock('@/lib/api/model-errors', () => ({
  isModelNotConfiguredApiError: vi.fn().mockReturnValue(false),
}))

const { apiFetch } = await import('@/lib/api/fetch')
const { getSetupStatus } = await import('@/lib/api/opencode')
const { useBatchExecution } = await import('./use-batch-execution.ts')

function createTask(id, status) {
  return { id, title: `Task ${id}`, status, priority: 'medium', createdAt: '', updatedAt: '', labels: [], executionElapsedMs: 0, inboxRead: false, archived: false }
}

function createMockProps() {
  return {
    tasks: [createTask('t1', 'in_progress'), createTask('t2', 'todo'), createTask('t3', 'in_progress')],
    selectedTaskIds: new Set(['t1', 't3']),
    activeBatch: null,
    setActiveBatch: vi.fn(),
    clearSelection: vi.fn(),
    setTasks: vi.fn(),
    setShowProviderSetup: vi.fn(),
    setSelectedTaskIds: vi.fn(),
  }
}

describe('useBatchExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty batch arrays when no active batch', () => {
    const props = createMockProps()
    const { result } = renderHook(() => useBatchExecution(props))
    expect(result.current.batchTaskIds).toEqual([])
    expect(result.current.completedBatchTaskIds).toEqual([])
    expect(result.current.completedBatch).toBeNull()
  })

  it('lockedBatchTaskIds is empty when no active batch', () => {
    const props = createMockProps()
    const { result } = renderHook(() => useBatchExecution(props))
    expect(result.current.lockedBatchTaskIds).toEqual(new Set())
  })

  it('handleBatchExecute shows error when no in-progress tasks selected', async () => {
    const props = { ...createMockProps(), selectedTaskIds: new Set(['t2']) }
    const { result } = renderHook(() => useBatchExecution(props))

    const { toast } = await import('sonner')
    await act(async () => {
      await result.current.handleBatchExecute('parallel')
    })

    expect(toast.error).toHaveBeenCalledWith('Select at least one In Progress task to execute as a batch')
  })

  it('handleBatchExecute sets active batch after setup check passes', async () => {
    const props = createMockProps()
    getSetupStatus.mockResolvedValue({ ready: true })
    apiFetch.mockResolvedValue({
      id: 'batch1',
      status: 'running',
      mode: 'parallel',
      tasks: [{ taskId: 't1', title: 'Task 1', status: 'queued' }],
    })

    const { result } = renderHook(() => useBatchExecution(props))
    await act(async () => {
      await result.current.handleBatchExecute('parallel')
    })

    expect(props.clearSelection).toHaveBeenCalled()
    expect(apiFetch).toHaveBeenCalledWith('/api/batches', expect.objectContaining({
      method: 'POST',
      sidecar: true,
    }))
    expect(props.setActiveBatch).toHaveBeenCalledWith(expect.objectContaining({
      id: 'batch1',
      status: 'running',
      mode: 'parallel',
    }))
  })

  it('handleBatchExecute restores state on OpenCodeUnavailableError', async () => {
    const props = createMockProps()
    const { OpenCodeUnavailableError } = await import('@/lib/api/opencode')
    getSetupStatus.mockRejectedValue(new OpenCodeUnavailableError(404, 'Not available'))

    const { result } = renderHook(() => useBatchExecution(props))
    await act(async () => {
      await result.current.handleBatchExecute('parallel')
    })

    expect(props.setActiveBatch).toHaveBeenCalledWith(null)
    expect(props.setSelectedTaskIds).toHaveBeenCalledWith(props.selectedTaskIds)
  })

  it('handleBatchExecute shows provider setup when setup not ready', async () => {
    const props = createMockProps()
    getSetupStatus.mockResolvedValue({ ready: false, hasProvider: true, hasModel: false })

    const { result } = renderHook(() => useBatchExecution(props))
    await act(async () => {
      await result.current.handleBatchExecute('parallel')
    })

    expect(props.setShowProviderSetup).toHaveBeenCalledWith(true)
  })

  it('handleCancelBatch calls apiFetch with correct endpoint', async () => {
    const props = createMockProps()
    apiFetch.mockResolvedValue(undefined)

    const { result } = renderHook(() => useBatchExecution(props))
    await act(async () => {
      await result.current.handleCancelBatch('batch1')
    })

    expect(apiFetch).toHaveBeenCalledWith('/api/batches/batch1/cancel', {
      method: 'POST',
      sidecar: true,
    })
  })

  it('handleApproveNextBatchTask calls apiFetch with correct endpoint', async () => {
    const props = createMockProps()
    apiFetch.mockResolvedValue(undefined)

    const { result } = renderHook(() => useBatchExecution(props))
    await act(async () => {
      await result.current.handleApproveNextBatchTask('batch1')
    })

    expect(apiFetch).toHaveBeenCalledWith('/api/batches/batch1/approve', {
      method: 'POST',
      sidecar: true,
    })
  })

  it('reconcileActiveBatches fetches and sets active batch', async () => {
    const props = createMockProps()
    apiFetch.mockResolvedValue([
      { id: 'b1', status: 'running', mode: 'parallel' },
    ])
    apiFetch.mockResolvedValueOnce([
      { id: 'b1', status: 'running', mode: 'parallel' },
    ])
    apiFetch.mockResolvedValueOnce({
      id: 'b1',
      status: 'running',
      mode: 'parallel',
      prUrl: null,
      tasks: [{ taskId: 't1', title: 'Task', status: 'running' }],
    })

    const { result } = renderHook(() => useBatchExecution(props))
    await act(async () => {
      await result.current.reconcileActiveBatches()
    })

    expect(props.setActiveBatch).toHaveBeenCalledWith(expect.objectContaining({
      id: 'b1',
      status: 'running',
    }))
  })

  it('reconcileActiveBatches silently ignores OpenCodeUnavailableError', async () => {
    const props = createMockProps()
    const { OpenCodeUnavailableError } = await import('@/lib/api/opencode')
    const { NetworkError } = await import('@/lib/api/fetch')
    apiFetch.mockRejectedValue(new OpenCodeUnavailableError(404, 'Unavailable'))

    const { result } = renderHook(() => useBatchExecution(props))
    await act(async () => {
      await result.current.reconcileActiveBatches()
    })

    expect(props.setActiveBatch).not.toHaveBeenCalled()
  })

  it('reconcileActiveBatches silently ignores NetworkError', async () => {
    const props = createMockProps()
    const { NetworkError } = await import('@/lib/api/fetch')
    apiFetch.mockRejectedValue(new NetworkError('Offline'))

    const { result } = renderHook(() => useBatchExecution(props))
    await act(async () => {
      await result.current.reconcileActiveBatches()
    })

    expect(props.setActiveBatch).not.toHaveBeenCalled()
  })
})
