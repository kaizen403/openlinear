import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchApprovals: null, decideApproval: null }))
vi.mock('@/lib/api/approvals', async (original) => ({
  ...(await original()),
  fetchApprovals: (...args) => api.fetchApprovals(...args),
  decideApproval: (...args) => api.decideApproval(...args),
}))
const sse = vi.hoisted(() => ({ handler: null }))
vi.mock('@/providers/sse-provider', () => ({ useSSESubscription: (handler) => { sse.handler = handler } }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

const { ApprovalRequests } = await import('./approval-requests.tsx')
const { expiresIn } = await import('@/lib/api/approvals.ts')
const { ApiError } = await import('@/lib/api/fetch.ts')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => { cleanup(); vi.clearAllMocks() })

const PENDING = { id: 'ap-1', runId: 'run-1', taskId: 't1', tool: 'bash', detail: 'rm -rf build', digest: 'd'.repeat(64), requestedAt: Date.now(), expiresAt: Date.now() + 14 * 60_000 }

function show(active = true) {
  const client = createAppQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  return render(createElement(QueryClientProvider, { client }, createElement(ApprovalRequests, { taskId: 't1', active })))
}

describe('FE-04 approval requests', () => {
  it('formats the deadline', () => {
    expect(expiresIn(10_000 + 14 * 60_000, 10_000)).toBe('expires in 14 min')
    expect(expiresIn(10_000 + 30_000, 10_000)).toBe('expires in 30 s')
    expect(expiresIn(10_000, 10_000)).toBe('expired')
  })

  it('shows what the agent wants to run and sends the decision with the digest shown', async () => {
    api.fetchApprovals = vi.fn(async () => [PENDING])
    api.decideApproval = vi.fn(async () => ({ decision: 'allow', by: 'user' }))
    show()
    expect(await screen.findByText('rm -rf build')).toBeTruthy()
    expect(screen.getByText(/expires in 14 min/)).toBeTruthy()
    api.fetchApprovals = vi.fn(async () => [])
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(api.decideApproval).toHaveBeenCalledWith('t1', 'ap-1', { decision: 'allow', digest: PENDING.digest }))
    await waitFor(() => expect(screen.queryByText('rm -rf build')).toBeNull())
    expect(toasts.success).toHaveBeenCalledWith('Allowed; the agent continues')
  })

  it('"Allow for this run" sends the run scope and says the tool won\'t ask again', async () => {
    api.fetchApprovals = vi.fn(async () => [PENDING])
    api.decideApproval = vi.fn(async () => ({ decision: 'allow', scope: 'run', by: 'user' }))
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Allow for this run' }))
    await waitFor(() => expect(api.decideApproval).toHaveBeenCalledWith('t1', 'ap-1', { decision: 'allow', scope: 'run', digest: PENDING.digest }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Allowed; bash won't ask again in this run"))
  })

  it('refreshes instead of applying a stale decision', async () => {
    api.fetchApprovals = vi.fn(async () => [PENDING])
    api.decideApproval = vi.fn(async () => { throw new ApiError(404, 'gone', 'APPROVAL_NOT_FOUND') })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalled())
    expect(toasts.error.mock.calls[0][0]).toBe('That approval request was already answered or has expired.')
    await waitFor(() => expect(api.fetchApprovals.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('asks nothing while the task is not running, and refetches on approval events', async () => {
    api.fetchApprovals = vi.fn(async () => [PENDING])
    const { container } = show(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(api.fetchApprovals).not.toHaveBeenCalled()
    expect(container.textContent).toBe('')
    cleanup()
    show(true)
    await screen.findByText('rm -rf build')
    const before = api.fetchApprovals.mock.calls.length
    sse.handler('approval:changed', { taskId: 't1' }, {})
    await waitFor(() => expect(api.fetchApprovals.mock.calls.length).toBeGreaterThan(before))
  })
})
