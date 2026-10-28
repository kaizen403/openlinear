import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { createElement } from 'react'

const sse = vi.hoisted(() => ({ listeners: new Set(), status: { isConnected: true, isReconnecting: false } }))
// The local sidecar's run state and the follow-up call (W12 Continue).
const reviewApi = vi.hoisted(() => ({ fetchTaskRunState: null, sendTaskFollowUp: null }))

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
vi.mock('@/components/comments-thread', () => ({ CommentsThread: () => null }))
vi.mock('@/lib/api/tasks', () => ({ fetchExecutionLogs: vi.fn(async () => ({ logs: [] })) }))
vi.mock('@/lib/api/review', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchTaskRunState: (...args) => reviewApi.fetchTaskRunState(...args),
  sendTaskFollowUp: (...args) => reviewApi.sendTaskFollowUp(...args),
}))

const { TaskDetailView } = await import('./task-detail-view.tsx')
const store = await import('@/lib/execution-state-store')
const { legacySuccessRun, legacyHistory, PR_URL } = await import('@/lib/run-model/fixtures.mjs')
const { installViewport, restoreViewport } = await import('./execution/test-helpers.mjs')
const { ApiError } = await import('@/lib/api/fetch')
const { CONTINUE_INTERRUPTED_MESSAGE } = await import('@/lib/api/review')
const { continuableRunId } = await import('./execution/task-run-section.tsx')
const { toast } = await import('sonner')

let counter = 0
function makeTask(overrides = {}) {
  counter += 1
  return {
    id: `detail-task-${counter}`,
    title: 'Fix the login redirect',
    description: null,
    priority: 'medium',
    status: 'in_progress',
    sessionId: null,
    createdAt: '2026-10-25T09:00:00.000Z',
    updatedAt: '2026-10-25T10:00:00.000Z',
    labels: [],
    executionStartedAt: '2026-10-25T10:00:00.000Z',
    executionPausedAt: null,
    executionElapsedMs: 0,
    executionProgress: 40,
    prUrl: null,
    outcome: null,
    batchId: null,
    inboxRead: false,
    identifier: 'KT-12',
    number: 12,
    dueDate: null,
    ...overrides,
  }
}

function seedRun(taskId, count) {
  const events = legacySuccessRun().map(([type, data, meta]) => [type, { ...data, taskId }, meta])
  for (const entry of legacyHistory(events).slice(0, count)) store.appendExecutionLog(taskId, entry)
  return events
}

function renderDetail(props) {
  const onClose = vi.fn()
  const utils = render(createElement(TaskDetailView, { open: true, onClose, ...props }))
  return { ...utils, onClose }
}

beforeEach(() => {
  installViewport(320)
  sse.listeners.clear()
  sse.status = { isConnected: true, isReconnecting: false }
  // Default: the sidecar's run state never answers (the earlier tests don't depend on it).
  reviewApi.fetchTaskRunState = vi.fn(() => new Promise(() => {}))
  reviewApi.sendTaskFollowUp = vi.fn(async () => ({ runId: 'run-next', attemptId: 'att-next', state: 'running' }))
})
afterEach(() => {
  cleanup()
  restoreViewport()
})

describe('TaskDetailView execution section', () => {
  it('replaces the raw log dump with the run view: phase, cost, timeline rows', () => {
    const task = makeTask()
    seedRun(task.id, 14)
    store.setExecutionProgress({ taskId: task.id, status: 'executing', message: 'Running: Run unit tests' })
    renderDetail({ task, isExecuting: true, onCancel: vi.fn(async () => true) })

    const run = screen.getByRole('region', { name: 'Agent run' })
    const phase = within(run).getAllByRole('status').find((region) => region.querySelector('[data-phase]'))
    expect(phase.getAttribute('aria-live')).toBe('polite')
    expect(phase.textContent).toContain('Running')
    expect(within(run).getByText('Cost unknown')).toBeTruthy()
    const feed = within(run).getByRole('feed', { name: 'Run timeline' })
    expect(within(feed).getByRole('article', { name: /^Command Run unit tests/ })).toBeTruthy()
    // No more per-line "Oct 25, 2026" date stamps from the old renderer.
    expect(within(run).queryByText(/Oct 25, 2026/)).toBeNull()
  })

  it('Stop reports the real outcome: unconfirmed → Retry stop → stopped', async () => {
    const task = makeTask()
    seedRun(task.id, 14)
    store.setExecutionProgress({ taskId: task.id, status: 'executing', message: 'Agent is thinking...' })
    const onCancel = vi.fn()
      .mockResolvedValueOnce(false) // board contract: stop not accepted (already toasted)
      .mockResolvedValueOnce(true)
    renderDetail({ task, isExecuting: true, onCancel })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop run' })) })
    expect(onCancel).toHaveBeenCalledWith(task.id)
    expect(screen.getAllByText(/Stop unconfirmed/).length).toBeGreaterThan(0)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry stop' })) })
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Stopped — the agent confirmed it stopped.')).toBeTruthy()
  })

  it('keeps Retry stop visible after the row moved on when the stop was not confirmed', async () => {
    const task = makeTask()
    seedRun(task.id, 14)
    const onCancel = vi.fn(async () => false)
    const { rerender, onClose } = renderDetail({ task, isExecuting: true, onCancel })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop run' })) })
    // The sidecar persisted `cancelled` before the abort failed.
    rerender(createElement(TaskDetailView, { open: true, onClose, task: { ...task, status: 'cancelled' }, isExecuting: false, onCancel, onExecute: vi.fn() }))
    expect(screen.getByRole('button', { name: 'Retry stop' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Execute/ })).toBeNull()
  })

  it('Escape collapses an expanded timeline row without closing the sheet', () => {
    const task = makeTask()
    seedRun(task.id, 14)
    const { onClose } = renderDetail({ task, isExecuting: true })
    const row = screen.getByRole('article', { name: /^Command Run unit tests.*collapsed$/ })
    act(() => row.focus())
    fireEvent.keyDown(row, { key: 'Enter' })
    const expanded = screen.getByRole('article', { name: /^Command Run unit tests.*expanded$/ })
    act(() => expanded.focus())
    fireEvent.keyDown(expanded, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('article', { name: /^Command Run unit tests.*collapsed$/ })).toBeTruthy()
    // A second Escape (nothing expanded) closes the sheet as before.
    fireEvent.keyDown(screen.getByRole('article', { name: /^Command Run unit tests/ }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('a finished task keeps its completion box with the agent conclusion and the PR', () => {
    const task = makeTask({ status: 'done', prUrl: PR_URL, outcome: '1 file changed, 4 tools executed', executionElapsedMs: 95_000, executionProgress: 100 })
    seedRun(task.id, 30)
    renderDetail({ task })
    expect(screen.getByText('Task Completed')).toBeTruthy()
    // The conclusion box reads the last agent message from the run model (outside the timeline).
    const conclusions = screen.getAllByText('The fix is in place and the tests pass.')
    expect(conclusions.some((element) => !element.closest('[data-run-timeline]'))).toBe(true)
    expect(screen.getByRole('button', { name: /View Pull Request/ })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Agent run' })).getAllByText('Succeeded').length).toBeGreaterThan(0)
  })

  it('shows the empty state for a task that never ran', () => {
    renderDetail({ task: makeTask({ status: 'todo', executionStartedAt: null, executionProgress: null }), onExecute: vi.fn() })
    expect(screen.getByText('No activity yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Execute/ })).toBeTruthy()
  })
})

/** `GET /api/tasks/:id/run` from this device's sidecar. */
function localRun(runId, state, extra = {}) {
  return { run: { runId, state, attemptId: 'att-1', lastSeq: 9, relayAckSeq: 9, terminal: null, effects: [], runner: 'opencode', followUp: null, ...extra } }
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })
}

function emit(type, data, meta) {
  act(() => {
    for (const listener of sse.listeners) listener(type, data, meta)
  })
}

const CONTINUE = { name: /Continue where it stopped/ }

describe('W12 Continue where it stopped: only this device\'s interrupted run on screen', () => {
  it('the rule: same run id, interrupted here and on screen, worktree kept', () => {
    const local = (runId, state, extra = {}) => ({ runId, state, attemptId: null, lastSeq: 1, relayAckSeq: 1, terminal: null, effects: [], ...extra })
    expect(continuableRunId({ phase: 'recovery_required', runId: 'r1' }, local('r1', 'recovery_required'))).toBe('r1')
    expect(continuableRunId({ phase: 'abandoned', runId: 'r1' }, local('r1', 'abandoned'))).toBe('r1')
    // Another device's run on screen (this device's latest run is older).
    expect(continuableRunId({ phase: 'recovery_required', runId: 'r-teammate' }, local('r1', 'recovery_required'))).toBeNull()
    expect(continuableRunId({ phase: 'recovery_required', runId: 'r-teammate' }, local('r1', 'succeeded'))).toBeNull()
    // No local run, no run id on screen, or an unknown local state.
    expect(continuableRunId({ phase: 'recovery_required', runId: 'r1' }, null)).toBeNull()
    expect(continuableRunId({ phase: 'recovery_required', runId: 'r1' }, undefined)).toBeNull()
    expect(continuableRunId({ phase: 'recovery_required', runId: null }, local('r1', 'recovery_required'))).toBeNull()
    expect(continuableRunId({ phase: 'recovery_required', runId: 'r1' }, local('r1', 'succeeded'))).toBeNull()
    expect(continuableRunId({ phase: 'succeeded', runId: 'r1' }, local('r1', 'recovery_required'))).toBeNull()
    // The retention sweep removed the worktree.
    expect(continuableRunId({ phase: 'recovery_required', runId: 'r1' }, local('r1', 'recovery_required', { workspaceExpired: { at: '2026-10-27T00:00:00.000Z', reason: 'ttl' } }))).toBeNull()
  })

  it('continues the interrupted local run on screen and names it (parentRunId)', async () => {
    const task = makeTask()
    reviewApi.fetchTaskRunState = vi.fn(async () => localRun('run-local', 'recovery_required'))
    renderDetail({ task, onExecute: vi.fn() })
    await settle()
    const run = screen.getByRole('region', { name: 'Agent run' })
    await act(async () => { fireEvent.click(within(run).getByRole('button', CONTINUE)) })
    expect(reviewApi.sendTaskFollowUp).toHaveBeenCalledTimes(1)
    expect(reviewApi.sendTaskFollowUp).toHaveBeenCalledWith(task.id, { message: CONTINUE_INTERRUPTED_MESSAGE, comments: [], parentRunId: 'run-local' })
  })

  it('a teammate\'s interrupted run (live update from another device) offers no Continue', async () => {
    const task = makeTask()
    // This device's latest run is an older, finished one with a kept worktree (and its own phase timings).
    const phases = { queuedMs: 0, preparingMs: 5_000, setupMs: 0, agentMs: 60_000, approvalWaitMs: 0, verifyingMs: 0, finishingMs: 1_000, totalMs: 66_000, live: false }
    reviewApi.fetchTaskRunState = vi.fn(async () => localRun('run-local-old', 'succeeded', { phases }))
    renderDetail({ task, onExecute: vi.fn() })
    await settle()
    emit('execution:progress', { taskId: task.id, status: 'error', message: 'Recovery required', runId: 'run-teammate', runSeq: 12, runState: 'recovery_required' }, { stream: 'cloud' })
    await settle()
    const run = screen.getByRole('region', { name: 'Agent run' })
    expect(within(run).getByRole('button', { name: /Run again/ })).toBeTruthy()
    expect(within(run).queryByRole('button', CONTINUE)).toBeNull()
    // Nor this device's older run's phase timings under the teammate's run.
    expect(within(run).queryByLabelText(/^Run took/)).toBeNull()
    // Run model + run-state query, then one re-read for the run on screen: still not this device's run.
    expect(reviewApi.fetchTaskRunState).toHaveBeenCalledTimes(3)
    expect(reviewApi.sendTaskFollowUp).not.toHaveBeenCalled()
  })

  it('an interrupted local run whose worktree expired, or no local run at all, offers no Continue', async () => {
    const expired = makeTask()
    reviewApi.fetchTaskRunState = vi.fn(async () => localRun('run-gone', 'abandoned', { workspaceExpired: { at: '2026-10-27T09:00:00.000Z', reason: 'ttl' } }))
    renderDetail({ task: expired, onExecute: vi.fn() })
    await settle()
    expect(screen.getAllByText('Abandoned').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', CONTINUE)).toBeNull()
    cleanup()

    const elsewhere = makeTask()
    reviewApi.fetchTaskRunState = vi.fn(async () => { throw new ApiError(404, 'No v2 run is recorded for this task on this device', 'RUN_NOT_FOUND') })
    renderDetail({ task: elsewhere, onExecute: vi.fn() })
    await settle()
    emit('execution:progress', { taskId: elsewhere.id, status: 'error', message: 'Recovery required', runId: 'run-elsewhere', runSeq: 3, runState: 'recovery_required' }, { stream: 'cloud' })
    await settle()
    expect(screen.getByRole('button', { name: /Run again/ })).toBeTruthy()
    expect(screen.queryByRole('button', CONTINUE)).toBeNull()
  })

  it('a refused Continue (FOLLOW_UP_RUN_MISMATCH) says so in plain words', async () => {
    const task = makeTask()
    reviewApi.fetchTaskRunState = vi.fn(async () => localRun('run-local', 'recovery_required'))
    reviewApi.sendTaskFollowUp = vi.fn(async () => {
      throw new ApiError(409, 'The run to continue is not the latest run of this task on this device', 'FOLLOW_UP_RUN_MISMATCH', { expected: 'run-local', latest: 'run-newer' })
    })
    vi.mocked(toast.error).mockClear()
    renderDetail({ task, onExecute: vi.fn() })
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', CONTINUE)) })
    await settle()
    expect(toast.error).toHaveBeenCalledWith('This run was started on another device, or a newer run exists here.', {
      description: 'Open the latest run, or start a new one. Nothing was changed.',
    })
    // Not stuck "continuing": the button is enabled again.
    expect(screen.getByRole('button', CONTINUE).hasAttribute('disabled')).toBe(false)
  })
})
