/**
 * Home Chat UI for the round-7 contract: late-confirmed tool outcomes, the
 * server-side Dismiss states of a confirmation card, budget notices on a
 * reply and the monthly budget in the usage view.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@/components/markdown-view', () => ({
  MarkdownView: ({ body }) => createElement('div', { 'data-testid': 'markdown' }, body),
}))
vi.mock('@/lib/api/chat', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchModelUsage: vi.fn(),
}))

const { fetchModelUsage } = await import('@/lib/api/chat')
const { ConfirmationCard } = await import('./confirmation-card.tsx')
const { ToolCallCard } = await import('./tool-call-card.tsx')
const { ChatMessage } = await import('./chat-message.tsx')
const { ModelUsageReportView } = await import('./chat-usage-view.tsx')
const usageFormat = await import('./usage-format.ts')

const CODE = 'CONFIRM-7KQ2MX9P'

function confirmation(overrides = {}) {
  return {
    code: CODE,
    confirmationId: 'conf-1',
    toolCallId: 'call_1',
    toolName: 'bulk_update_issues',
    summary: 'Set status to done on 2 issues',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    preview: null,
    ...overrides,
  }
}

function budget(overrides = {}) {
  return {
    workspaceId: 'w1',
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    unknownCostPolicy: 'allow',
    costPriceable: true,
    workspace: { usd: null, tokens: null, state: 'unlimited', amountsVisible: true },
    user: { usd: { limit: 5, source: 'workspace', spent: 4.5, held: 0.05, remaining: 0.45, coverage: 'complete', uncountedCalls: 0 }, tokens: null, state: 'warning', amountsVisible: true },
    state: 'warning',
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ToolCallCard reconciliation', () => {
  it('shows that an interrupted write was confirmed later as applied', () => {
    render(createElement(ToolCallCard, {
      toolCall: { id: 'w', name: 'create_issue', arguments: '{}', status: 'completed', effect: 'write', message: 'Issue created', reconciled: { status: 'succeeded', after: 'TOOL_TIMEOUT', at: null } },
    }))
    expect(screen.getByText('Confirmed after the interruption: this change was applied.')).toBeTruthy()
    expect(document.querySelector('[data-tool-reconciled="succeeded"]')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
  })

  it('shows a late failure as not applied', () => {
    render(createElement(ToolCallCard, {
      toolCall: { id: 'w', name: 'update_issue', arguments: '{}', status: 'error', effect: 'write', reconciled: { status: 'failed', after: 'CLIENT_ABORTED', at: null } },
    }))
    expect(screen.getByText('Confirmed after the interruption: this change was not applied.')).toBeTruthy()
  })
})

describe('ConfirmationCard after Dismiss', () => {
  it('says the code was cancelled on the server', () => {
    render(createElement(ConfirmationCard, { confirmation: confirmation(), state: { phase: 'dismissed', revoke: 'done' } }))
    expect(screen.getByText('Dismissed. Nothing changed, and the code can no longer be used.')).toBeTruthy()
  })

  it('says when cancelling is still in flight', () => {
    render(createElement(ConfirmationCard, { confirmation: confirmation(), state: { phase: 'dismissed', revoke: 'pending' } }))
    expect(screen.getByText(/Cancelling the code/)).toBeTruthy()
  })

  it('warns that a code the server did not cancel still works until it expires', () => {
    render(createElement(ConfirmationCard, {
      confirmation: confirmation(),
      state: { phase: 'dismissed', revoke: 'failed', error: { code: 'NETWORK_ERROR', status: null, message: "Couldn't reach OpenLinear.", retryable: true } },
    }))
    expect(screen.getByText(/still works until/)).toBeTruthy()
    expect(screen.getByText(/Couldn't reach OpenLinear/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/did not cancel the code/)
  })
})

describe('ChatMessage budget notices', () => {
  it('renders each notice under the reply without hiding the answer', () => {
    render(createElement(ChatMessage, {
      message: {
        id: 'a1',
        role: 'assistant',
        content: 'Answer.',
        toolCalls: [],
        createdAt: new Date().toISOString(),
        notices: [{ code: 'CHAT_BUDGET_COST_UNKNOWN', status: null, message: 'This model has no configured price, so the USD chat budget cannot limit this reply.', retryable: false }],
      },
    }))
    expect(screen.getByTestId('markdown').textContent).toBe('Answer.')
    const notice = document.querySelector('[data-budget-notice="CHAT_BUDGET_COST_UNKNOWN"]')
    expect(notice?.textContent).toMatch(/no configured price/)
  })

  it('renders a stored failed turn with no text as an incomplete reply', () => {
    render(createElement(ChatMessage, {
      message: {
        id: 'a2',
        role: 'assistant',
        content: '',
        toolCalls: [],
        createdAt: new Date().toISOString(),
        incomplete: { reason: 'error', error: { code: 'LLM_PROVIDER_UNAVAILABLE', status: null, message: 'The model provider is unavailable right now.', retryable: true } },
      },
    }))
    expect(screen.getByRole('alert').textContent).toMatch(/unavailable/)
  })
})

describe('budget in the usage view', () => {
  it('formats the caller budget, held amounts and the reset date', () => {
    const copy = usageFormat.describeBudget(budget())
    expect(copy.label).toBe('Chat budget almost used up')
    expect(copy.lines).toEqual([
      'You: $4.50 of $5.00 used, $0.05 reserved by replies in progress',
      'Resets Nov 1.',
    ])
  })

  it('shows only the state of a workspace cap to members, marks unpriced spend as a lower bound, and explains unknown prices', () => {
    const copy = usageFormat.describeBudget(budget({
      costPriceable: false,
      workspace: { usd: null, tokens: null, state: 'exceeded', amountsVisible: false },
      user: { usd: { limit: 5, source: 'config', spent: 1, held: 0, remaining: 4, coverage: 'partial', uncountedCalls: 3 }, tokens: { limit: 100000, source: 'member', spent: 2500, held: 0, remaining: 97500, coverage: 'complete', uncountedCalls: 0 }, state: 'ok', amountsVisible: true },
      state: 'exceeded',
    }))
    expect(copy.label).toBe('Chat budget used up')
    expect(copy.lines).toEqual([
      'You: ≥ $1.00 of $5.00 used (3 calls without a price)',
      'You: 2.5k tokens of 100k tokens used',
      'Workspace: used up',
      "This model has no price, so spending caps can't limit replies; token caps still apply.",
      'Resets Nov 1.',
    ])
  })

  it('shows nothing when no cap applies', () => {
    expect(usageFormat.describeBudget(budget({ state: 'unlimited', user: { usd: null, tokens: null, state: 'unlimited', amountsVisible: true } }))).toBeNull()
  })

  it('renders the budget above the 30-day report', async () => {
    fetchModelUsage.mockResolvedValueOnce({
      since: '2026-09-26T00:00:00.000Z',
      days: 30,
      workspaceId: 'w1',
      surface: null,
      totals: { calls: 0, callsWithUsage: 0, callsWithoutUsage: 0, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, cacheHitRate: null, cost: { knownUsd: null, coverage: 'none', byBasis: { provider_reported: 0, estimated: 0, unknown: 0 } } },
      groups: [],
      budget: budget(),
    })
    render(createElement(ModelUsageReportView, { workspaceId: 'w1' }))
    expect(await screen.findByText('Chat budget almost used up')).toBeTruthy()
    expect(document.querySelector('[data-budget-state="warning"]')).toBeTruthy()
    expect(fetchModelUsage).toHaveBeenCalledWith({ days: 30, workspaceId: 'w1' })
  })
})
