import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ apiFetch: null }))
vi.mock('@/lib/api/fetch', async (original) => ({ ...(await original()), apiFetch: (...args) => api.apiFetch(...args) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { ApprovalModeCard, approvalModeOf } = await import('./approval-mode-card.tsx')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => cleanup())

describe('FE-04 approval mode setting', () => {
  it('reads the mode and saves the switch', async () => {
    expect(approvalModeOf({ approvalMode: 'ask' })).toBe('ask')
    expect(approvalModeOf({})).toBe('auto')
    let saved = 'auto'
    api.apiFetch = vi.fn(async (path, init) => {
      if (init?.method === 'PATCH') {
        saved = JSON.parse(init.body).approvalMode
        return { approvalMode: saved }
      }
      return { approvalMode: saved }
    })
    const client = createAppQueryClient()
    render(createElement(QueryClientProvider, { client }, createElement(ApprovalModeCard)))
    const toggle = await screen.findByRole('switch', { name: 'Ask me before the agent acts' })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(toggle)
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/api/settings', { method: 'PATCH', body: JSON.stringify({ approvalMode: 'ask' }) }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Ask me before the agent acts' }).getAttribute('aria-checked')).toBe('true'))
  })
})
