import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('@/lib/api/fetch', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, apiFetch: vi.fn() }
})

vi.mock('@/lib/api/opencode', () => ({
  getSetupStatus: vi.fn(),
  OpenCodeUnavailableError: class OpenCodeUnavailableError extends Error {},
}))

const { apiFetch, ApiError } = await import('@/lib/api/fetch')
const { toast } = await import('sonner')
const { useBatchExecution } = await import('./use-batch-execution.ts')

const PR = 'https://github.com/acme/app/pull/7'

function detail(overrides = {}) {
  return {
    id: 'b1',
    status: 'failed',
    mode: 'parallel',
    tasks: [
      { taskId: 't1', title: 'One', status: 'failed', branch: 'openlinear/b1/t1', error: 'Merge conflict', startedAt: null, completedAt: null },
      { taskId: 't2', title: 'Two', status: 'cancelled', branch: 'openlinear/b1/t2', error: null, startedAt: null, completedAt: null, cancelUnconfirmed: true },
    ],
    prUrl: null,
    createdAt: '2026-10-25T00:00:00.000Z',
    completedAt: '2026-10-25T00:05:00.000Z',
    progress: { total: 2, completed: 0, failed: 1, running: 0, queued: 0, skipped: 0, cancelled: 1, percentage: 100 },
    publication: { phase: 'failed', error: 'Provider abort could not be confirmed', receiptPath: '/repos/.receipts/batch-b1.json' },
    ...overrides,
  }
}

function props(activeBatch) {
  return {
    tasks: [],
    selectedTaskIds: new Set(),
    activeBatch,
    setActiveBatch: vi.fn(),
    clearSelection: vi.fn(),
    setTasks: vi.fn(),
    setShowProviderSetup: vi.fn(),
    setSelectedTaskIds: vi.fn(),
  }
}

const running = {
  id: 'b1',
  status: 'running',
  mode: 'parallel',
  tasks: [
    { taskId: 't1', title: 'One', status: 'running' },
    { taskId: 't2', title: 'Two', status: 'running' },
  ],
  prUrl: null,
}

describe('useBatchExecution W01 outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiFetch.mockImplementation(async (path) => (path === '/api/batches/b1' ? detail() : {}))
  })

  it('keeps a failed batch with its retained branches after the live batch is cleared', async () => {
    const { result, rerender } = renderHook((p) => useBatchExecution(p), { initialProps: props(running) })
    expect(result.current.settledBatch).toBeNull()

    const failed = { ...running, status: 'failed', tasks: [{ ...running.tasks[0], status: 'failed' }, { ...running.tasks[1], status: 'cancelled' }] }
    rerender(props(failed))
    await waitFor(() => expect(result.current.settledBatch?.publication?.receiptPath).toBe('/repos/.receipts/batch-b1.json'))
    expect(apiFetch).toHaveBeenCalledWith('/api/batches/b1', { sidecar: true })
    expect(result.current.settledBatch.tasks).toEqual([
      { taskId: 't1', title: 'One', status: 'failed', branch: 'openlinear/b1/t1', error: 'Merge conflict' },
      { taskId: 't2', title: 'Two', status: 'cancelled', branch: 'openlinear/b1/t2', error: null, cancelUnconfirmed: true },
    ])

    // use-task-sse clears the live batch 5 s after failure; the summary stays.
    rerender(props(null))
    expect(result.current.settledBatch?.id).toBe('b1')

    act(() => { result.current.dismissSettledBatch() })
    expect(result.current.settledBatch).toBeNull()
  })

  it('drops the previous summary when a different batch starts', async () => {
    const { result, rerender } = renderHook((p) => useBatchExecution(p), { initialProps: props({ ...running, status: 'completed', prUrl: PR }) })
    await waitFor(() => expect(result.current.settledBatch?.id).toBe('b1'))
    rerender(props({ ...running, id: 'b2' }))
    await waitFor(() => expect(result.current.settledBatch).toBeNull())
  })

  it('acknowledges a cancel only from the HTTP result and offers a retry for CANCEL_INCOMPLETE', async () => {
    let cancels = 0
    apiFetch.mockImplementation(async (path) => {
      if (path === '/api/batches/b1/cancel') {
        cancels += 1
        if (cancels === 1) throw new ApiError(503, 'Cancellation was requested, but some persistence or provider operations could not be confirmed', 'CANCEL_INCOMPLETE', { retained: true })
        return { success: true }
      }
      if (path === '/api/batches/b1') return detail({ status: 'cancelled' })
      return {}
    })
    const { result } = renderHook(() => useBatchExecution(props(running)))

    let accepted
    await act(async () => { accepted = await result.current.handleCancelBatch('b1') })
    expect(accepted).toBe(false)
    const [title, options] = toast.error.mock.calls[0]
    expect(title).toBe('Cancellation was requested, but some persistence or provider operations could not be confirmed')
    expect(options.action.label).toBe('Retry stop')

    await act(async () => { options.action.onClick() })
    await waitFor(() => expect(cancels).toBe(2))
    await act(async () => { accepted = await result.current.handleCancelBatch('b1') })
    expect(accepted).toBe(true)
  })

  it('maps batch admission errors', async () => {
    const { getSetupStatus } = await import('@/lib/api/opencode')
    getSetupStatus.mockResolvedValue({ ready: true })
    apiFetch.mockImplementation(async (path) => {
      if (path === '/api/batches') throw new ApiError(409, 'Selected tasks changed before admission completed', 'BATCH_SELECTION_CHANGED')
      return {}
    })
    const p = { ...props(null), tasks: [{ id: 't1', title: 'One', status: 'in_progress' }], selectedTaskIds: new Set(['t1']) }
    const { result } = renderHook(() => useBatchExecution(p))
    await act(async () => { await result.current.handleBatchExecute('parallel') })
    expect(toast.error).toHaveBeenCalledWith('The selected tasks changed before the batch could start.', {
      description: 'A task was edited, moved, archived or started elsewhere. Review the selection and start the batch again.',
    })
    expect(p.setActiveBatch).toHaveBeenLastCalledWith(null)
  })

  it('surfaces a finished batch that still needs attention after a reload', async () => {
    apiFetch.mockImplementation(async (path) => {
      if (path === '/api/batches') return [{ id: 'b1', status: 'cancelled', mode: 'parallel', createdAt: '2026-10-25T00:00:00.000Z' }]
      if (path === '/api/batches/b1') return detail({ status: 'cancelled' })
      return {}
    })
    const p = props(null)
    const { result } = renderHook(() => useBatchExecution(p))
    await act(async () => { await result.current.reconcileActiveBatches() })
    expect(p.setActiveBatch).not.toHaveBeenCalled()
    expect(result.current.settledBatch?.tasks[1]).toMatchObject({ cancelUnconfirmed: true })
  })

  it('ignores finished batches that need nothing', async () => {
    apiFetch.mockImplementation(async (path) => {
      if (path === '/api/batches') return [{ id: 'b1', status: 'completed', mode: 'parallel' }]
      if (path === '/api/batches/b1') return detail({ status: 'completed', prUrl: PR, publication: { phase: 'completed' }, tasks: [] })
      return {}
    })
    const { result } = renderHook(() => useBatchExecution(props(null)))
    await act(async () => { await result.current.reconcileActiveBatches() })
    expect(result.current.settledBatch).toBeNull()
  })
})
