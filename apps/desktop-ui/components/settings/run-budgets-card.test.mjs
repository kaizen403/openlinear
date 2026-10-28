import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ apiFetch: null }))
vi.mock('@/lib/api/fetch', async (original) => ({ ...(await original()), apiFetch: (...args) => api.apiFetch(...args) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { parseBudgets, budgetDraftFrom, RunBudgetsCard } = await import('./run-budgets-card.tsx')

describe('run budgets model (W15a)', () => {
  it('parses dollars and token counts; empty means no limit', () => {
    expect(parseBudgets({ cost: '$2.50', tokens: '200,000' })).toEqual({ ok: true, body: { maxRunCostUsd: 2.5, maxRunTokens: 200_000 } })
    expect(parseBudgets({ cost: '', tokens: ' ' })).toEqual({ ok: true, body: { maxRunCostUsd: null, maxRunTokens: null } })
  })

  it('refuses what the API would refuse', () => {
    expect(parseBudgets({ cost: '0', tokens: '' })).toMatchObject({ ok: false, problems: [expect.stringContaining('more than $0')] })
    expect(parseBudgets({ cost: '20000', tokens: '' }).ok).toBe(false)
    expect(parseBudgets({ cost: 'abc', tokens: '' }).ok).toBe(false)
    expect(parseBudgets({ cost: '', tokens: '999' })).toMatchObject({ ok: false, problems: [expect.stringContaining('1,000')] })
    expect(parseBudgets({ cost: '', tokens: '1500.5' }).ok).toBe(false)
  })

  it('shows stored limits', () => {
    expect(budgetDraftFrom({ maxRunCostUsd: 1.25, maxRunTokens: null })).toEqual({ cost: '1.25', tokens: '' })
    expect(budgetDraftFrom(undefined)).toEqual({ cost: '', tokens: '' })
  })
})

describe('RunBudgetsCard', () => {
  beforeEach(() => {
    api.apiFetch = vi.fn(async (_path, init) => {
      if (init?.method === 'PATCH') return { ...JSON.parse(init.body), parallelLimit: 3 }
      return { parallelLimit: 3, maxRunCostUsd: 1.25, maxRunTokens: null }
    })
  })
  afterEach(() => cleanup())

  function renderCard() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(createElement(QueryClientProvider, { client }, createElement(RunBudgetsCard)))
  }

  it('loads the stored limits and saves only the budget fields', async () => {
    renderCard()
    const cost = await screen.findByLabelText('Max cost per run (USD)')
    await waitFor(() => expect(cost.value).toBe('1.25'))
    fireEvent.change(screen.getByLabelText('Max tokens per run'), { target: { value: '250000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save run budgets' }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PATCH' })))
    const patch = api.apiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(patch[1].body)).toEqual({ maxRunCostUsd: 1.25, maxRunTokens: 250_000 })
  })

  it('blocks an invalid limit before saving', async () => {
    renderCard()
    await screen.findByLabelText('Max cost per run (USD)')
    fireEvent.change(screen.getByLabelText('Max tokens per run'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save run budgets' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(api.apiFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })
})
