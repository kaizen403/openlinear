import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { createElement } from 'react'

const { BatchProgress } = await import('./batch-progress.tsx')
const { ExecutionOutcomePanel } = await import('./execution-outcome-panel.tsx')
const { describeTaskExecution } = await import('./execution-outcome.ts')

const PR = 'https://github.com/acme/app/pull/7'
const COMPARE = 'https://github.com/acme/app/compare/main...openlinear%2Fbatch-b1'

function members(...statuses) {
  return statuses.map((status, index) => ({
    taskId: `t${index + 1}`,
    title: `Task ${index + 1}`,
    status,
    branch: `openlinear/b1/t${index + 1}`,
  }))
}

function renderBatch(overrides = {}) {
  const props = {
    batchId: 'b1',
    status: 'running',
    mode: 'parallel',
    tasks: members('completed', 'running'),
    prUrl: null,
    publication: null,
    onCancel: vi.fn(async () => true),
    onDismiss: vi.fn(),
    ...overrides,
  }
  render(createElement(BatchProgress, props))
  return props
}

function expand() {
  fireEvent.click(screen.getByRole('button', { expanded: false }))
}

afterEach(() => cleanup())

describe('BatchProgress (W01)', () => {
  it('shows a member committed during a running batch as ready to publish, not done', () => {
    renderBatch()
    expect(screen.getByText('Parallel Execution: 1/2 ready to publish')).toBeTruthy()
    expand()
    expect(screen.getByText('Ready to publish')).toBeTruthy()
    expect(screen.queryByText('Done')).toBeNull()
    expect(screen.queryByText('Published')).toBeNull()
  })

  it('treats a running member whose task row records the local commit as ready', () => {
    renderBatch({ tasks: members('running', 'running'), readyTaskIds: new Set(['t2']) })
    expect(screen.getByText('Parallel Execution: 1/2 ready to publish')).toBeTruthy()
  })

  it('offers the confirmed pull request only when the batch completed with a /pull/ URL', () => {
    renderBatch({ status: 'completed', prUrl: PR, tasks: members('completed', 'completed'), publication: { phase: 'completed' } })
    expect(screen.getByRole('button', { name: /Open PR/ })).toBeTruthy()
    expect(screen.getByText('Parallel Execution: Pull request opened')).toBeTruthy()
    expect(within(screen.getByRole('status')).getByText('Pull request opened')).toBeTruthy()
  })

  it('shows failed publication with branch evidence, the error and the receipt — never as a PR', () => {
    renderBatch({
      status: 'failed',
      prUrl: null,
      tasks: [{ ...members('failed')[0], error: 'Merge conflict' }],
      publication: { phase: 'failed', branchUrl: COMPARE, error: 'GitHub rejected the pull request', receiptPath: '/repos/.receipts/batch-b1.json' },
    })
    expect(screen.queryByRole('button', { name: /Open PR/ })).toBeNull()
    const status = screen.getByRole('status')
    expect(within(status).getByText('Publication failed — branch pushed')).toBeTruthy()
    expect(within(status).getByText('GitHub rejected the pull request')).toBeTruthy()
    expect(within(status).getByRole('button', { name: /Open pushed branch \(no pull request\)/ })).toBeTruthy()
    expect(within(status).getByText('/repos/.receipts/batch-b1.json')).toBeTruthy()
    expand()
    expect(screen.getByText('Merge conflict')).toBeTruthy()
    expect(screen.getByText('openlinear/b1/t1')).toBeTruthy()
  })

  it('shows an unconfirmed stop with a retry that calls cancel again', async () => {
    const props = renderBatch({
      status: 'cancelled',
      prUrl: PR,
      tasks: [{ ...members('cancelled')[0], cancelUnconfirmed: true }],
      publication: { phase: 'cancelled', error: 'Provider abort could not be confirmed' },
    })
    expect(screen.getByText('Cancelled — the pull request was still opened')).toBeTruthy()
    expect(screen.getByText(/stop wasn't confirmed for 1 task/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Retry stop/ })) })
    expect(props.onCancel).toHaveBeenCalledWith('b1')
  })

  it('re-enables Cancel when the sidecar did not accept the stop', async () => {
    const props = renderBatch({ onCancel: vi.fn(async () => false) })
    const cancel = screen.getByRole('button', { name: /Cancel/ })
    await act(async () => { fireEvent.click(cancel) })
    expect(props.onCancel).toHaveBeenCalledWith('b1')
    expect(screen.getByRole('button', { name: /Cancel/ }).hasAttribute('disabled')).toBe(false)
  })
})

describe('ExecutionOutcomePanel', () => {
  it('renders a confirmed pull request', () => {
    render(createElement(ExecutionOutcomePanel, { outcome: describeTaskExecution({ status: 'done', prUrl: PR, outcome: null, batchId: null }) }))
    expect(screen.getByRole('button', { name: /View pull request/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /branch comparison/i })).toBeNull()
  })

  it('renders branch evidence with a PR check', async () => {
    const onCheckPullRequest = vi.fn(async () => {})
    render(createElement(ExecutionOutcomePanel, {
      outcome: describeTaskExecution({ status: 'done', prUrl: COMPARE, outcome: null, batchId: null }),
      onCheckPullRequest,
    }))
    expect(screen.getByText('Branch pushed — no pull request confirmed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /View pull request/ })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Check for pull request/ })) })
    expect(onCheckPullRequest).toHaveBeenCalledTimes(1)
  })

  it('renders retained work for a failed run', () => {
    render(createElement(ExecutionOutcomePanel, {
      outcome: describeTaskExecution({
        status: 'cancelled',
        prUrl: null,
        batchId: null,
        outcome: 'Agent event stream ended unexpectedly. Work retained on openlinear/3f2a9c1d at /tmp/repos/app/3f2a9c1d',
      }),
    }))
    expect(screen.getByText('Run failed — work retained')).toBeTruthy()
    expect(screen.getByText('openlinear/3f2a9c1d')).toBeTruthy()
    expect(screen.getByText('/tmp/repos/app/3f2a9c1d')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy workspace path' })).toBeTruthy()
  })
})
