import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

const sse = vi.hoisted(() => ({ listeners: new Set(), status: { isConnected: true, isReconnecting: false } }))
const api = vi.hoisted(() => ({ fetchExecutionLogs: null, fetchTaskRunState: null }))

vi.mock('@/providers/sse-provider', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    useSSESubscription(handler) {
      const ref = useRef(handler)
      ref.current = handler
      useEffect(() => {
        const listener = (...args) => ref.current(...args)
        sse.listeners.add(listener)
        return () => sse.listeners.delete(listener)
      }, [])
    },
    useSSEStatus: () => sse.status,
  }
})

vi.mock('@/lib/api/tasks', () => ({
  fetchExecutionLogs: (...args) => api.fetchExecutionLogs(...args),
}))

vi.mock('@/lib/api/review', () => ({
  fetchTaskRunState: (...args) => api.fetchTaskRunState(...args),
}))

const { useRunModel } = await import('./use-run-model.ts')
const store = await import('@/lib/execution-state-store')
const { NetworkError } = await import('@/lib/api/fetch.ts')
const { legacySuccessRun, legacyHistory, TASK_ID } = await import('@/lib/run-model/fixtures.mjs')

let counter = 0
function freshTaskId() {
  counter += 1
  return `${TASK_ID}-${counter}`
}

/** Re-target fixture events at another task id. */
function forTask(taskId, events) {
  return events.map(([type, data, meta]) => [type, { ...data, taskId }, meta])
}

function emit(events) {
  act(() => {
    for (const [type, data, meta] of events) {
      for (const listener of sse.listeners) listener(type, data, meta)
    }
  })
}

async function frames() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
}

function row(taskId, overrides = {}) {
  return { id: taskId, status: 'in_progress', outcome: null, prUrl: null, batchId: null, executionStartedAt: '2026-10-25T10:00:00.000Z', executionElapsedMs: 0, model: null, ...overrides }
}

beforeEach(() => {
  sse.listeners.clear()
  sse.status = { isConnected: true, isReconnecting: false }
  api.fetchExecutionLogs = vi.fn(async () => ({ logs: [] }))
  // Default: no v2 run on this device (legacy engine) — the sidecar answers 404.
  api.fetchTaskRunState = vi.fn(async () => { throw new Error('RUN_NOT_FOUND') })
})
afterEach(() => cleanup())

describe('useRunModel', () => {
  it('seeds from what the board already collected, before first paint', () => {
    const taskId = freshTaskId()
    const events = forTask(taskId, legacySuccessRun())
    for (const entry of legacyHistory(events).slice(0, 12)) store.appendExecutionLog(taskId, entry)
    store.setExecutionProgress({ taskId, status: 'executing', message: 'Running: src/auth/login.ts' })

    const { result } = renderHook(() => useRunModel({ taskId, task: row(taskId) }))
    expect(result.current.snapshot.phase).toBe('running')
    expect(result.current.snapshot.entries.length).toBeGreaterThan(5)
    expect(result.current.snapshot.message).toBe('Running: src/auth/login.ts')
    // The store already has logs, so no history request.
    expect(api.fetchExecutionLogs).not.toHaveBeenCalled()
  })

  it('folds live events once even though the store receives the same lines', async () => {
    const taskId = freshTaskId()
    const events = forTask(taskId, legacySuccessRun())
    const { result } = renderHook(() => useRunModel({ taskId, task: row(taskId) }))

    emit(events)
    // use-task-sse appends the same lines to the store (no ids).
    act(() => { for (const entry of legacyHistory(events)) store.appendExecutionLog(taskId, entry) })
    // Reconnect replay of the tail.
    emit(events.slice(20))
    await frames()

    const snapshot = result.current.snapshot
    expect(snapshot.phase).toBe('succeeded')
    expect(snapshot.counters.tools).toBe(4)
    expect(snapshot.entries.filter((entry) => entry.kind === 'tool')).toHaveLength(4)
    expect(snapshot.outcome).toMatchObject({ kind: 'pull_request' })
  })

  it('ignores other tasks and routes journal events without a taskId by run', async () => {
    const taskId = freshTaskId()
    const { result } = renderHook(() => useRunModel({ taskId, task: row(taskId) }))
    emit([
      ['execution:log', { taskId: 'someone-else', entry: { timestamp: '2026-10-25T10:00:01.000Z', type: 'agent', message: 'not mine' } }, { stream: 'cloud', id: '1' }],
      ['execution:progress', { runId: 'r-1', taskId, seq: 1, type: 'session.started', payload: { t: 'session.started', externalId: 's', model: { id: 'claude-sonnet-4-5' } } }, { stream: 'cloud', id: 'run:r-1:1' }],
      ['execution:progress', { runId: 'r-1', seq: 2, type: 'message.delta', payload: { t: 'message.delta', text: 'from the local journal' } }, { stream: 'local', id: 'run:r-1:2' }],
      ['execution:progress', { runId: 'r-other', seq: 1, type: 'message.delta', payload: { t: 'message.delta', text: 'unknown run' } }, { stream: 'local', id: 'run:r-other:1' }],
    ])
    await frames()
    const texts = result.current.snapshot.entries.map((entry) => entry.text)
    expect(texts).toEqual(['from the local journal'])
    expect(result.current.snapshot.model).toBe('claude-sonnet-4-5')
  })

  it('goes unknown while the event stream is down and recovers when it reconnects', async () => {
    const taskId = freshTaskId()
    const { result, rerender } = renderHook(() => useRunModel({ taskId, task: row(taskId) }))
    emit(forTask(taskId, legacySuccessRun()).slice(0, 10))
    await frames()
    expect(result.current.snapshot.phase).toBe('running')

    sse.status = { isConnected: false, isReconnecting: true }
    rerender()
    expect(result.current.snapshot).toMatchObject({ phase: 'unknown', recovery: 'stream_lost' })

    sse.status = { isConnected: true, isReconnecting: false }
    rerender()
    expect(result.current.snapshot).toMatchObject({ phase: 'running', recovery: null })
  })

  it('loads history for a task that ran, skips tasks that never ran, and maps fetch errors', async () => {
    const ran = freshTaskId()
    const events = forTask(ran, legacySuccessRun())
    api.fetchExecutionLogs = vi.fn(async () => ({ logs: legacyHistory(events) }))
    const { result } = renderHook(() => useRunModel({ taskId: ran, task: row(ran, { status: 'done', prUrl: 'https://github.com/acme/app/pull/42', outcome: '4 files changed, 4 tools executed' }) }))
    expect(result.current.loading).toBe(true)
    await frames()
    expect(api.fetchExecutionLogs).toHaveBeenCalledWith(ran)
    expect(result.current.loading).toBe(false)
    expect(result.current.snapshot.phase).toBe('succeeded')
    expect(result.current.snapshot.entries.length).toBeGreaterThan(10)

    const never = freshTaskId()
    api.fetchExecutionLogs = vi.fn(async () => ({ logs: [] }))
    renderHook(() => useRunModel({ taskId: never, task: row(never, { status: 'todo', executionStartedAt: null }) }))
    await frames()
    expect(api.fetchExecutionLogs).not.toHaveBeenCalled()

    const failing = freshTaskId()
    api.fetchExecutionLogs = vi.fn(async () => { throw new NetworkError('offline') })
    const failed = renderHook(() => useRunModel({ taskId: failing, task: row(failing, { status: 'cancelled', outcome: 'Run failed' }) }))
    await frames()
    expect(failed.result.current.error).toMatchObject({ message: "Couldn't reach OpenLinear.", hint: 'Check your connection and try again.' })
    api.fetchExecutionLogs = vi.fn(async () => ({ logs: [] }))
    act(() => failed.result.current.retry())
    await frames()
    expect(api.fetchExecutionLogs).toHaveBeenCalledTimes(1)
    expect(failed.result.current.error).toBeNull()
  })

  it('shows queued while a start is pending and drops it when the start is rejected', async () => {
    const taskId = freshTaskId()
    const done = row(taskId, { status: 'done', prUrl: 'https://github.com/acme/app/pull/42', outcome: '1 file changed, 4 tools executed' })
    const { result, rerender } = renderHook(({ starting }) => useRunModel({ taskId, task: done, startRequested: starting }), { initialProps: { starting: false } })
    expect(result.current.snapshot.phase).toBe('succeeded')
    rerender({ starting: true })
    expect(result.current.snapshot).toMatchObject({ phase: 'queued', message: 'Waiting for the execution service…' })
    rerender({ starting: false })
    expect(result.current.snapshot.phase).toBe('succeeded')
    await frames() // let the history request settle inside act
  })

  it('follows the task row and ignores a journal payload mis-cast into the progress store', async () => {
    const taskId = freshTaskId()
    // use-task-sse stores any execution:progress with a taskId as legacy progress.
    store.setExecutionProgress({ taskId, runId: 'r', seq: 3, type: 'usage', payload: {} })
    const { result, rerender } = renderHook(({ task }) => useRunModel({ taskId, task }), { initialProps: { task: row(taskId) } })
    expect(result.current.snapshot.phase).toBe('running')
    rerender({ task: row(taskId, { status: 'cancelled', outcome: 'Cancelled. Work retained on openlinear/x at /w/x', executionElapsedMs: 4000 }) })
    expect(result.current.snapshot.phase).toBe('cancelled')
    expect(result.current.snapshot.outcome).toMatchObject({ kind: 'cancelled', retained: { branch: 'openlinear/x', path: '/w/x' } })
    await frames() // let the history request settle inside act
  })
})

describe('useRunModel with the v2 run engine (FE-01: reload/reconnect reproduce the journal state)', () => {
  const runState = (state, lastSeq, runner = 'claude-code') => ({ run: { runId: 'run-v2-9', state, attemptId: 'a', lastSeq, relayAckSeq: lastSeq, terminal: null, effects: [], runner, followUp: null } })

  it('a reload mid-verification shows "verifying" and the runner the attempt uses, not the task row guess', async () => {
    const taskId = freshTaskId()
    api.fetchTaskRunState = vi.fn(async () => runState('verifying', 41))
    const { result } = renderHook(() => useRunModel({ taskId, task: row(taskId) }))
    await frames()
    expect(api.fetchTaskRunState).toHaveBeenCalledWith(taskId)
    expect(result.current.snapshot).toMatchObject({ phase: 'verifying', runId: 'run-v2-9', runner: 'claude-code' })
    // A replayed older beat doesn't rewind it; the next live beat moves it on.
    emit([
      ['execution:progress', { taskId, status: 'executing', message: 'old', runState: 'running', runId: 'run-v2-9', runSeq: 30 }, { stream: 'local' }],
      ['execution:progress', { taskId, status: 'committing', message: 'verification passed', runState: 'finishing', runId: 'run-v2-9', runSeq: 42 }, { stream: 'local' }],
    ])
    await frames()
    expect(result.current.snapshot).toMatchObject({ phase: 'committing', message: 'verification passed' })
  })

  it('re-reads the run state after the stream reconnects', async () => {
    const taskId = freshTaskId()
    api.fetchTaskRunState = vi.fn(async () => runState('running', 5))
    const { result, rerender } = renderHook(() => useRunModel({ taskId, task: row(taskId) }))
    await frames()
    expect(result.current.snapshot.phase).toBe('running')

    sse.status = { isConnected: false, isReconnecting: true }
    rerender()
    expect(result.current.snapshot.phase).toBe('unknown')
    // While offline the run hit an unprovable restart.
    api.fetchTaskRunState = vi.fn(async () => runState('recovery_required', 9))
    sse.status = { isConnected: true, isReconnecting: false }
    rerender()
    await frames()
    expect(api.fetchTaskRunState).toHaveBeenCalledTimes(1)
    expect(result.current.snapshot.phase).toBe('recovery_required')
  })

  it('tasks that never ran do not ask for a run state', async () => {
    const taskId = freshTaskId()
    renderHook(() => useRunModel({ taskId, task: row(taskId, { status: 'todo', executionStartedAt: null }) }))
    await frames()
    expect(api.fetchTaskRunState).not.toHaveBeenCalled()
  })
})
