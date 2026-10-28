import { describe, it, expect } from 'vitest'

const {
  batchNeedsAttention,
  carryBatchDetail,
  isBatchStatusResponse,
  isTerminalBatchStatus,
  mergeBatchDetail,
  toActiveBatch,
} = await import('./batch-state.ts')

const detail = {
  id: 'b1',
  status: 'running',
  mode: 'parallel',
  tasks: [
    { taskId: 't1', title: 'One', status: 'completed', branch: 'openlinear/b1/t1', error: null, startedAt: null, completedAt: null },
    { taskId: 't2', title: 'Two', status: 'running', branch: 'openlinear/b1/t2', error: null, startedAt: null, completedAt: null, cancelUnconfirmed: true },
  ],
  prUrl: null,
  createdAt: '2026-10-25T00:00:00.000Z',
  completedAt: null,
  progress: { total: 2, completed: 1, failed: 0, running: 1, queued: 0, skipped: 0, cancelled: 0, percentage: 50 },
  publication: { phase: 'committed', receiptPath: '/r/batch-b1.json' },
}

describe('batch state', () => {
  it('maps GET /api/batches/:id onto the board batch, keeping W01 fields', () => {
    expect(isBatchStatusResponse(detail)).toBe(true)
    expect(isBatchStatusResponse({ id: 'x' })).toBe(false)
    expect(isBatchStatusResponse(undefined)).toBe(false)
    expect(toActiveBatch(detail)).toEqual({
      id: 'b1',
      status: 'running',
      mode: 'parallel',
      tasks: [
        { taskId: 't1', title: 'One', status: 'completed', branch: 'openlinear/b1/t1', error: null },
        { taskId: 't2', title: 'Two', status: 'running', branch: 'openlinear/b1/t2', error: null, cancelUnconfirmed: true },
      ],
      prUrl: null,
      publication: { phase: 'committed', receiptPath: '/r/batch-b1.json' },
    })
  })

  it('never moves a status backwards when merging a detail snapshot', () => {
    const local = {
      id: 'b1',
      status: 'failed',
      mode: 'parallel',
      tasks: [
        { taskId: 't1', title: 'One', status: 'completed' },
        { taskId: 't2', title: 'Two', status: 'failed' },
      ],
      prUrl: null,
    }
    const merged = mergeBatchDetail(local, toActiveBatch(detail))
    expect(merged.status).toBe('failed')
    expect(merged.tasks.map((task) => task.status)).toEqual(['completed', 'failed'])
    expect(merged.tasks[1]).toMatchObject({ branch: 'openlinear/b1/t2', cancelUnconfirmed: true })
    expect(merged.publication).toEqual(detail.publication)
    expect(mergeBatchDetail(local, { ...toActiveBatch(detail), id: 'other' })).toBe(local)
  })

  it('carries detail-only fields across SSE replacements of the same batch', () => {
    const enriched = toActiveBatch(detail)
    const fromEvent = {
      id: 'b1',
      status: 'cancelled',
      mode: 'parallel',
      tasks: [
        { taskId: 't1', title: 'One', status: 'completed' },
        { taskId: 't2', title: 'Two', status: 'cancelled' },
      ],
      prUrl: null,
    }
    const carried = carryBatchDetail(enriched, fromEvent)
    expect(carried.status).toBe('cancelled')
    expect(carried.tasks[1]).toMatchObject({ status: 'cancelled', branch: 'openlinear/b1/t2', cancelUnconfirmed: true })
    expect(carried.publication).toEqual(detail.publication)
    expect(carryBatchDetail(null, fromEvent)).toBe(fromEvent)
  })

  it('flags finished batches that still need the user', () => {
    expect(isTerminalBatchStatus('cancelled')).toBe(true)
    expect(isTerminalBatchStatus('merging')).toBe(false)
    expect(batchNeedsAttention(toActiveBatch(detail))).toBe(true)
    expect(batchNeedsAttention({ status: 'failed', tasks: [], publication: { phase: 'failed', error: 'push rejected' } })).toBe(true)
    expect(batchNeedsAttention({ status: 'completed', tasks: [{ taskId: 't1', title: 'x', status: 'completed' }], publication: { phase: 'completed' } })).toBe(false)
  })
})
