import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { TaskCard } from './task-card.tsx'

// Regression coverage for T4: TaskCard's memo comparator used to ignore all
// function props, including the difference between `onExecute` being present
// vs. undefined — so when the parent's `canExecute` flipped false -> true,
// the memoized card never re-rendered and the Execute button never appeared.
// The fix adds an explicit `canExecute` prop that IS compared, decoupled from
// the (still intentionally uncompared, since it's parent-unstable) `onExecute`
// function reference.

function inProgressTask(id = 't1') {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    priority: 'medium',
    status: 'in_progress',
    sessionId: null,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    labels: [],
    executionStartedAt: null,
    executionPausedAt: null,
    executionElapsedMs: 0,
    executionProgress: null,
    prUrl: null,
    outcome: null,
    batchId: null,
    inboxRead: false,
    identifier: null,
    number: null,
    dueDate: null,
  }
}

describe('TaskCard canExecute reactivity', () => {
  it('shows the Execute button once canExecute flips from false to true, with all other props unchanged', () => {
    const task = inProgressTask()
    // Stable across renders on purpose — this mirrors the parent NOT
    // memoizing its handlers, which is what broke the old comparator.
    const onExecute = vi.fn()

    const { container, rerender } = render(
      createElement(TaskCard, { task, onExecute, canExecute: false })
    )
    expect(container.querySelector('button[aria-label="Execute task"]')).toBeNull()

    rerender(createElement(TaskCard, { task, onExecute, canExecute: true }))
    expect(container.querySelector('button[aria-label="Execute task"]')).not.toBeNull()
  })

  it('hides the Execute button again once canExecute flips back to false', () => {
    const task = inProgressTask('t2')
    const onExecute = () => {}

    const { container, rerender } = render(
      createElement(TaskCard, { task, onExecute, canExecute: true })
    )
    expect(container.querySelector('button[aria-label="Execute task"]')).not.toBeNull()

    rerender(createElement(TaskCard, { task, onExecute, canExecute: false }))
    expect(container.querySelector('button[aria-label="Execute task"]')).toBeNull()
  })

  it('does not render the Execute button at all when canExecute is true but onExecute is absent', () => {
    const task = inProgressTask('t3')
    const { container } = render(createElement(TaskCard, { task, canExecute: true }))
    expect(container.querySelector('button[aria-label="Execute task"]')).toBeNull()
  })
})
