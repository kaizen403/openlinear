import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { TaskCard } from './task-card.tsx'

const task = (status, overrides = {}) => ({
  id: 't1',
  title: 'Task t1',
  description: null,
  priority: 'medium',
  status,
  sessionId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  labels: [],
  executionStartedAt: null,
  executionPausedAt: null,
  executionElapsedMs: 0,
  executionProgress: null,
  prUrl: null,
  outcome: null,
  batchId: null,
  inboxRead: false,
  identifier: 'KT-1',
  number: 1,
  dueDate: null,
  ...overrides,
})

const running = { taskId: 't1', status: 'executing', message: 'Working' }

// The render-count side of the fix (no extra bail-out render per card) is
// budgeted in lib/query/data-layer.bench.test.mjs (batched burst ≤ 1 per card).
describe('TaskCard cancel state', () => {
  it('a pending cancel ends when the task leaves in_progress (and a new run starts clean)', () => {
    const onCancel = () => new Promise(() => {})
    const view = render(createElement(TaskCard, { task: task('in_progress'), executionProgress: running, onCancel }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: /cancelling/i })).toBeTruthy()

    view.rerender(createElement(TaskCard, { task: task('cancelled'), executionProgress: undefined, onCancel }))
    view.rerender(createElement(TaskCard, { task: task('in_progress', { updatedAt: 'x' }), executionProgress: running, onCancel }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })
})
