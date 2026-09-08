import { describe, it, expect } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { appendExecutionLog, replaceExecutionLogs, useExecutionLogs } from './execution-state-store'

// Regression coverage for T7: an SSE reconnect can replay execution log
// events the client already has (e.g. after also re-fetching history over
// HTTP), and appendExecutionLog used to append unconditionally — so
// reconnects rendered duplicate log lines. The server doesn't send a
// sequence/id on these events, so the fix dedupes on a stable content key
// (timestamp + type + message + details) instead.

function entry(overrides = {}) {
  return {
    timestamp: '2026-05-22T00:00:00.000Z',
    type: 'info',
    message: 'Cloning repository',
    ...overrides,
  }
}

describe('execution log dedupe', () => {
  it('does not duplicate an identical entry appended twice', async () => {
    const taskId = 'dedupe-append-identical'
    const { result } = renderHook(() => useExecutionLogs(taskId))

    appendExecutionLog(taskId, entry())
    await waitFor(() => expect(result.current).toHaveLength(1))

    appendExecutionLog(taskId, entry())
    // No second render should even occur, but give it a chance to (wrongly)
    // grow before asserting the final count.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(result.current).toHaveLength(1)
  })

  it('still appends a genuinely different entry for the same task', async () => {
    const taskId = 'dedupe-append-distinct'
    const { result } = renderHook(() => useExecutionLogs(taskId))

    appendExecutionLog(taskId, entry({ message: 'Cloning repository' }))
    appendExecutionLog(taskId, entry({ message: 'Installing dependencies' }))

    await waitFor(() => expect(result.current).toHaveLength(2))
    expect(result.current.map((e) => e.message)).toEqual([
      'Cloning repository',
      'Installing dependencies',
    ])
  })

  it('rebuilds the dedupe set on replaceExecutionLogs, so a later append of one of those entries is still caught', async () => {
    const taskId = 'dedupe-replace-then-append'
    const { result } = renderHook(() => useExecutionLogs(taskId))
    const history = [
      entry({ message: 'Cloning repository' }),
      entry({ message: 'Installing dependencies' }),
    ]

    replaceExecutionLogs(taskId, history)
    await waitFor(() => expect(result.current).toHaveLength(2))

    appendExecutionLog(taskId, entry({ message: 'Cloning repository' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(result.current).toHaveLength(2)
  })
})
