import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within, waitFor } from '@testing-library/react'
import { createElement } from 'react'

const sse = vi.hoisted(() => ({ listeners: new Set() }))
const api = vi.hoisted(() => ({ fetchTaskDiff: vi.fn(), fetchTaskRunState: vi.fn(), sendTaskFollowUp: vi.fn() }))

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
    useSSEStatus: () => ({ isConnected: true, isReconnecting: false }),
  }
})
vi.mock('@/components/comments-thread', () => ({ CommentsThread: () => null }))
vi.mock('@/lib/api/tasks', () => ({ fetchExecutionLogs: vi.fn(async () => ({ logs: [] })) }))
vi.mock('@/lib/api/review', () => api)

const { TaskDetailView } = await import('../task-detail-view.tsx')
const { ApiError } = await import('@/lib/api/fetch.ts')
const { sampleDiff, installDiffViewport, restoreDiffViewport } = await import('./fixtures.mjs')

let counter = 0
function makeTask(overrides = {}) {
  counter += 1
  return {
    id: `detail-review-${counter}`,
    title: 'Rate-limit refresh',
    description: null,
    priority: 'medium',
    status: 'done',
    sessionId: null,
    createdAt: '2026-10-25T09:00:00.000Z',
    updatedAt: '2026-10-25T10:00:00.000Z',
    labels: [],
    executionStartedAt: '2026-10-25T10:00:00.000Z',
    executionPausedAt: null,
    executionElapsedMs: 60_000,
    executionProgress: 100,
    prUrl: 'https://github.com/o/r/compare/main...openlinear/kt-12',
    outcome: '3 files changed, 5 tools executed',
    batchId: null,
    inboxRead: false,
    identifier: 'KT-12',
    number: 12,
    dueDate: null,
    ...overrides,
  }
}

beforeEach(() => {
  installDiffViewport(500)
  sse.listeners.clear()
  window.localStorage.clear()
  api.fetchTaskDiff.mockReset().mockResolvedValue(sampleDiff())
  api.fetchTaskRunState.mockReset().mockRejectedValue(new ApiError(404, 'none', 'RUN_NOT_FOUND'))
  api.sendTaskFollowUp.mockReset().mockResolvedValue({ runId: 'run-2', attemptId: 'att-2', state: 'queued' })
})
afterEach(() => {
  cleanup()
  restoreDiffViewport()
})

describe('Task detail ↔ review tab', () => {
  it('the Review changes tab mounts the review panel on demand; Details keeps the run view mounted', async () => {
    const onClose = vi.fn()
    render(createElement(TaskDetailView, { task: makeTask(), open: true, onClose }))
    expect(api.fetchTaskDiff).not.toHaveBeenCalled()
    const tabs = screen.getByRole('tablist', { name: 'Task views' })
    const review = within(tabs).getByRole('tab', { name: 'Review changes' })
    expect(review.getAttribute('aria-selected')).toBe('false')
    fireEvent.click(review)
    expect(review.getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('tree', { name: 'Changed files' })).toBeTruthy()
    // The details panel (and its run section) stays in the DOM, hidden.
    expect(document.getElementById('task-detail-panel-details').hidden).toBe(true)
    // Arrow keys move between tabs.
    act(() => review.focus())
    fireEvent.keyDown(review, { key: 'ArrowLeft' })
    expect(within(tabs).getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(within(tabs).getByRole('tab', { name: 'Details' }))
  })

  it('Escape inside a comment editor cancels the editor, not the sheet', async () => {
    const onClose = vi.fn()
    render(createElement(TaskDetailView, { task: makeTask(), open: true, onClose }))
    fireEvent.click(screen.getByRole('tab', { name: 'Review changes' }))
    await screen.findByRole('tree', { name: 'Changed files' })
    const row = document.querySelector('[data-row-key="l:apps/api/src/routes/auth.ts:0:3"]')
    act(() => row.focus())
    fireEvent.keyDown(row, { key: 'c' })
    const editor = await screen.findByRole('textbox', { name: /^New comment on/ })
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: /^New comment on/ })).toBeNull()
  })

  it('a sent follow-up switches back to Details and shows the run as queued', async () => {
    render(createElement(TaskDetailView, { task: makeTask(), open: true, onClose: vi.fn() }))
    fireEvent.click(screen.getByRole('tab', { name: 'Review changes' }))
    await screen.findByRole('tree', { name: 'Changed files' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to the agent' }), { target: { value: 'Use a per-user key.' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))
    })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true'))
    expect(api.sendTaskFollowUp).toHaveBeenCalledWith(expect.stringMatching(/^detail-review-/), { message: 'Use a per-user key.' })
    const details = document.getElementById('task-detail-panel-details')
    expect(details.hidden).toBe(false)
    expect(within(details).getAllByText('Queued').length).toBeGreaterThan(0)
  })
})
