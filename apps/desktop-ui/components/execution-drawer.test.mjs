import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@/providers/sse-provider', () => ({
  useSSESubscription: () => {},
  useSSEStatus: () => ({ isConnected: true, isReconnecting: false }),
}))
vi.mock('@/lib/api/tasks', () => ({ fetchExecutionLogs: vi.fn(async () => ({ logs: [] })) }))

const { ExecutionDrawer } = await import('./execution-drawer.tsx')
const { legacySuccessRun, legacyHistory, PR_URL, COMPARE_URL } = await import('@/lib/run-model/fixtures.mjs')
const { installViewport, restoreViewport } = await import('./execution/test-helpers.mjs')

const logs = legacyHistory(legacySuccessRun())

beforeEach(() => installViewport(320))
afterEach(() => {
  cleanup()
  restoreViewport()
})

function renderDrawer(props = {}) {
  const onClose = vi.fn()
  render(createElement(ExecutionDrawer, {
    task: { id: 'drawer-task-1', title: 'Fix the login redirect' },
    logs,
    progress: { taskId: 'drawer-task-1', status: 'done', message: 'Pull request created', prUrl: PR_URL, isCompareLink: false },
    open: true,
    onClose,
    ...props,
  }))
  return { onClose }
}

describe('ExecutionDrawer', () => {
  it('is a labelled modal sheet showing the run instead of a raw log', () => {
    renderDrawer()
    const dialog = screen.getByRole('dialog', { name: 'Fix the login redirect' })
    expect(within(dialog).getByText('Task drawer-t')).toBeTruthy()
    expect(within(dialog).getByRole('feed', { name: 'Run timeline' })).toBeTruthy()
    expect(within(dialog).getAllByText('Succeeded').length).toBeGreaterThan(0)
    // W01: only a /pull/<n> URL is a confirmed PR.
    const outcome = within(dialog).getByRole('region', { name: 'Execution outcome' })
    expect(within(outcome).getByRole('button', { name: /View pull request/ })).toBeTruthy()
  })

  it('labels a compare link as branch evidence, never as a PR', () => {
    // Without the "Pull request created" line: only the pushed branch is known.
    renderDrawer({ logs: logs.slice(0, -1), progress: { taskId: 'drawer-task-1', status: 'done', message: 'Done', prUrl: COMPARE_URL, isCompareLink: true } })
    const outcome = screen.getByRole('region', { name: 'Execution outcome' })
    expect(within(outcome).getByText('Branch pushed — no pull request confirmed')).toBeTruthy()
    expect(within(outcome).queryByRole('button', { name: /View pull request/ })).toBeNull()
    expect(within(outcome).getByRole('button', { name: /Open branch comparison/ })).toBeTruthy()
  })

  it('stops a live run with an awaited, reported outcome and closes on Escape', async () => {
    const onCancel = vi.fn(async () => true)
    const { onClose } = renderDrawer({
      logs: logs.slice(0, 12),
      progress: { taskId: 'drawer-task-1', status: 'executing', message: 'Running: bash' },
      onCancel,
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop run' })) })
    expect(onCancel).toHaveBeenCalledWith('drawer-task-1')
    expect(screen.getByText('Stopped — the agent confirmed it stopped.')).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    render(createElement(ExecutionDrawer, { task: null, logs: [], open: false, onClose: () => {} }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
