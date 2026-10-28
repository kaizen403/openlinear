import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchMyApprovals: null, decideApproval: null }))
vi.mock('@/lib/api/approvals', async (original) => ({
  ...(await original()),
  fetchMyApprovals: (...args) => api.fetchMyApprovals(...args),
  decideApproval: (...args) => api.decideApproval(...args),
}))
vi.mock('@/providers/sse-provider', () => ({ useSSESubscription: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { ApprovalInbox } = await import('./approval-inbox.tsx')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => cleanup())

function show() {
  const client = createAppQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  return render(createElement(QueryClientProvider, { client }, createElement(ApprovalInbox)))
}

describe('FE-04 approval inbox', () => {
  it('lists requests across tasks and answers them in place', async () => {
    api.fetchMyApprovals = vi.fn(async () => [{ id: 'ap-2', runId: 'r', taskId: 't9', taskTitle: 'Fix login', tool: 'edit', detail: 'src/auth.ts', digest: 'e'.repeat(64), requestedAt: Date.now(), expiresAt: Date.now() + 60_000 }])
    api.decideApproval = vi.fn(async () => ({ decision: 'deny', by: 'user' }))
    show()
    expect(await screen.findByText(/in “Fix login”/)).toBeTruthy()
    expect(screen.getByText('Waiting for your approval · 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(api.decideApproval).toHaveBeenCalledWith('t9', 'ap-2', { decision: 'deny', digest: 'e'.repeat(64) }))
  })

  it('stays out of the way when nothing waits or the local service is unreachable', async () => {
    api.fetchMyApprovals = vi.fn(async () => { throw new Error('sidecar down') })
    const { container } = show()
    await waitFor(() => expect(api.fetchMyApprovals).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
