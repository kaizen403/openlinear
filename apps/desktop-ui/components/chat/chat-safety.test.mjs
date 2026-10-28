/**
 * Home Chat UI for the tool-safety / metering backend: confirmation card,
 * effect-aware tool rows, incomplete turns with Retry, usage copy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen, cleanup, act } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@/components/markdown-view', () => ({
  MarkdownView: ({ body }) => createElement('div', { 'data-testid': 'markdown' }, body),
}))

const { ConfirmationCard } = await import('./confirmation-card.tsx')
const { ToolCallCard } = await import('./tool-call-card.tsx')
const { ChatMessage } = await import('./chat-message.tsx')
const { TurnUsageFooter } = await import('./turn-usage.tsx')
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
    preview: {
      kind: 'status_change',
      status: 'done',
      issues: [
        { id: 'i1', identifier: 'KT-1', title: 'First issue', status: 'todo' },
        { id: 'i2', identifier: 'KT-2', title: 'Second issue', status: 'in_progress' },
      ],
      unchangedCount: 1,
      notFound: ['KT-9'],
      wholeProject: false,
      argumentsText: null,
    },
    ...overrides,
  }
}

function controls(overrides = {}) {
  return {
    status: 'idle',
    confirmations: {},
    confirm: vi.fn(() => true),
    dismissConfirmation: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ConfirmationCard', () => {
  it('shows exactly what will change: the count, each issue, the target status and the expiry', () => {
    render(createElement(ConfirmationCard, { confirmation: confirmation(), state: { phase: 'pending' }, onConfirm: vi.fn(), onDismiss: vi.fn() }))

    expect(screen.getByRole('heading', { name: 'Set status to done on 2 issues' })).toBeTruthy()
    const list = screen.getByRole('list', { name: '2 affected issues' })
    expect(list.querySelectorAll('li')).toHaveLength(2)
    expect(list.textContent).toContain('KT-1')
    expect(list.textContent).toContain('in progress')
    expect(screen.getByText(/1 selected issue already has this status/)).toBeTruthy()
    expect(screen.getByText(/Not found, skipped: KT-9/)).toBeTruthy()
    expect(screen.getByText(/Expires at .* \(in 10 min\)/)).toBeTruthy()
    expect(screen.getByText(CODE)).toBeTruthy()
  })

  it('Confirm sends exactly this card code, once', () => {
    const onConfirm = vi.fn(() => true)
    render(createElement(ConfirmationCard, { confirmation: confirmation(), state: { phase: 'pending' }, onConfirm, onDismiss: vi.fn() }))

    const button = screen.getByRole('button', { name: 'Confirm' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(CODE)
  })

  it('Dismiss reports the code and sends nothing', () => {
    const onConfirm = vi.fn(() => true)
    const onDismiss = vi.fn()
    render(createElement(ConfirmationCard, { confirmation: confirmation(), state: { phase: 'pending' }, onConfirm, onDismiss }))

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(onDismiss).toHaveBeenCalledWith(CODE)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('is disabled while a reply streams', () => {
    render(createElement(ConfirmationCard, { confirmation: confirmation(), state: { phase: 'pending' }, busy: true, onConfirm: vi.fn(), onDismiss: vi.fn() }))
    expect(screen.getByRole('button', { name: 'Confirm' }).disabled).toBe(true)
    expect(screen.getByText('Available when the reply finishes.')).toBeTruthy()
  })

  it('an expired card offers no Confirm and says so clearly', () => {
    render(createElement(ConfirmationCard, {
      confirmation: confirmation({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      state: { phase: 'pending' },
      onConfirm: vi.fn(),
      onDismiss: vi.fn(),
    }))

    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(screen.getByText(/Expired at .*Nothing changed; ask the assistant for a fresh preview/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Confirmation expired. Nothing changed.')
  })

  it('expires while open', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn(() => true)
    render(createElement(ConfirmationCard, {
      confirmation: confirmation({ expiresAt: new Date(Date.now() + 2000).toISOString() }),
      state: { phase: 'pending' },
      onConfirm,
    }))
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Confirmation expired. Nothing changed.')
  })

  it('renders a server refusal with its mapped copy and no Confirm', () => {
    render(createElement(ConfirmationCard, {
      confirmation: confirmation(),
      state: {
        phase: 'rejected',
        via: 'button',
        error: { code: 'CONFIRMATION_STALE', status: 0, message: 'The issues changed after this preview was made.', hint: 'Nothing changed. Ask the assistant for a fresh preview, then confirm that one.', retryable: false },
      },
      onConfirm: vi.fn(),
    }))

    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(screen.getByText(/The issues changed after this preview was made\. Nothing changed/)).toBeTruthy()
  })

  it('without actions it still offers the typed code', () => {
    render(createElement(ConfirmationCard, { confirmation: confirmation(), interactive: false }))
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/To confirm, reply with/)).toBeTruthy()
  })

  it('shows the confirmed outcome', () => {
    render(createElement(ConfirmationCard, { confirmation: confirmation(), state: { phase: 'confirmed', outcome: 'Issues updated' } }))
    expect(screen.getByText('Confirmed: Issues updated')).toBeTruthy()
  })
})

describe('ToolCallCard', () => {
  it('labels each row with its effect and status', () => {
    const rows = [
      { id: 'a', name: 'list_issues', arguments: '{}', status: 'completed', effect: 'read' },
      { id: 'b', name: 'create_issue', arguments: '{}', status: 'in_progress', effect: 'write' },
      { id: 'c', name: 'archive_issues', arguments: '{}', status: 'needs_confirmation', effect: 'destructive' },
      { id: 'd', name: 'update_issue', arguments: '{}', status: 'error', effect: 'write', error: { code: 'VALIDATION_ERROR', status: 0, message: 'title: Required', retryable: false } },
    ]
    const { container } = render(createElement('div', null, rows.map((toolCall) => createElement(ToolCallCard, { key: toolCall.id, toolCall }))))

    const text = container.textContent
    expect(text).toContain('List Issues')
    expect(text).toContain('Read')
    expect(text).toContain('Done')
    expect(text).toContain('Write')
    expect(text).toContain('Running')
    expect(text).toContain('Destructive')
    expect(text).toContain('Needs confirmation')
    expect(text).toContain('Failed')
    expect(container.querySelector('[data-tool-effect="destructive"]')).toBeTruthy()
  })

  it('always shows an unknown outcome with what to do', () => {
    render(createElement(ToolCallCard, {
      toolCall: {
        id: 'w',
        name: 'create_issue',
        arguments: '{}',
        status: 'unknown',
        effect: 'write',
        code: 'TOOL_OUTCOME_UNKNOWN',
        error: { code: 'TOOL_OUTCOME_UNKNOWN', status: 0, message: 'This action was interrupted, so it may or may not have been applied.', hint: 'Check the affected issues before trying it again.', retryable: false },
      },
    }))

    expect(screen.getByText('Outcome unknown')).toBeTruthy()
    expect(screen.getByText(/may or may not have been applied\. Check the affected issues/)).toBeTruthy()
  })

  it('expands input and result from the keyboard-operable header', () => {
    render(createElement(ToolCallCard, { toolCall: { id: 'r', name: 'get_issue', arguments: '{"id":"x"}', status: 'completed', effect: 'read', result: '{"title":"T"}' } }))
    const toggle = screen.getByRole('button', { name: /Get Issue/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('{"id":"x"}')).toBeTruthy()
  })

  it('renders the confirmation card under its row, wired to the controls', () => {
    const turnControls = controls({ confirmations: { [CODE]: { phase: 'pending' } } })
    render(createElement(ToolCallCard, {
      toolCall: { id: 'call_1', name: 'bulk_update_issues', arguments: '{}', status: 'needs_confirmation', effect: 'destructive', confirmation: confirmation() },
      controls: turnControls,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(turnControls.confirm).toHaveBeenCalledWith(CODE)
  })
})

describe('ChatMessage', () => {
  it('keeps partial text visibly incomplete with the error and a Retry action', () => {
    const turnControls = controls()
    render(createElement(ChatMessage, {
      message: {
        id: 'turn-1:assistant',
        role: 'assistant',
        content: 'Here is the pla',
        toolCalls: [],
        createdAt: new Date().toISOString(),
        live: true,
        retry: 'available',
        incomplete: {
          reason: 'error',
          error: { code: 'LLM_STREAM_TRUNCATED', status: 0, message: 'The reply was cut off before it finished.', hint: 'Retry to get a complete answer.', retryable: true },
        },
      },
      controls: turnControls,
    }))

    expect(screen.getByTestId('markdown').textContent).toBe('Here is the pla')
    expect(screen.getByText('Incomplete: the reply failed before it finished')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('The reply was cut off before it finished.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(turnControls.retry).toHaveBeenCalledWith('turn-1:assistant')
  })

  it('warns that changes already ran before retrying', () => {
    render(createElement(ChatMessage, {
      message: {
        id: 't:assistant',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'w', name: 'create_issue', arguments: '{}', status: 'completed', effect: 'write' }],
        createdAt: new Date().toISOString(),
        retry: 'available',
        incomplete: { reason: 'error', error: { code: 'TURN_TIMEOUT', status: 0, message: 'This reply hit the time limit for one turn.', retryable: false } },
      },
      controls: controls(),
    }))
    expect(screen.getByText(/Some actions in this reply already ran/)).toBeTruthy()
  })

  it('does not offer Retry without controls', () => {
    render(createElement(ChatMessage, {
      message: { id: 'x', role: 'assistant', content: 'part', toolCalls: [], createdAt: '', retry: 'available', incomplete: { reason: 'stopped' } },
    }))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByText('You stopped this reply before it finished.')).toBeTruthy()
  })

  it('shows per-turn usage with an unknown cost as unknown, never $0', () => {
    render(createElement(ChatMessage, {
      message: {
        id: 'u',
        role: 'assistant',
        content: 'ok',
        toolCalls: [],
        createdAt: '',
        usage: { modelCalls: 1, coverage: 'complete', inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cacheReadTokens: 1000, cacheWriteTokens: null, reasoningTokens: null, costUsd: null, costBasis: 'unknown' },
      },
    }))
    const summary = document.querySelector('details > summary')
    expect(summary.textContent).toContain('1.3k tokens · 1.0k cached · cost unknown')
    expect(summary.closest('details').textContent).not.toContain('$0')
  })
})

describe('usage copy', () => {
  it('formats costs: unknown, reported, estimated, a known zero', () => {
    expect(usageFormat.formatTurnCost({ costUsd: null, costBasis: 'unknown' })).toBe('cost unknown')
    expect(usageFormat.formatTurnCost({})).toBe('cost unknown')
    expect(usageFormat.formatTurnCost({ costUsd: 0.0123, costBasis: 'provider_reported' })).toBe('$0.0123')
    expect(usageFormat.formatTurnCost({ costUsd: 1.5, costBasis: 'estimated' })).toBe('≈ $1.50')
    expect(usageFormat.formatTurnCost({ costUsd: 0.5, costBasis: 'mixed' })).toBe('≈ $0.50')
    expect(usageFormat.formatTurnCost({ costUsd: 0, costBasis: 'provider_reported' })).toBe('$0.00')
    // A tiny known cost is never rounded down to a zero.
    expect(usageFormat.formatTurnCost({ costUsd: 0.00002, costBasis: 'provider_reported' })).toBe('< $0.0001')
  })

  it('formats token counts compactly', () => {
    expect(usageFormat.formatTokenCount(950)).toBe('950')
    expect(usageFormat.formatTokenCount(1234)).toBe('1.2k')
    expect(usageFormat.formatTokenCount(45_678)).toBe('46k')
    expect(usageFormat.formatTokenCount(1_234_567)).toBe('1.23M')
  })

  it('describes a session total as a lower bound when some cost or usage is missing', () => {
    const copy = usageFormat.describeSessionUsage({
      turns: 2,
      turnsWithoutUsage: 1,
      inputTokens: 1500,
      outputTokens: 250,
      totalTokens: 1750,
      cacheReadTokens: 1200,
      knownCostUsd: 0.0021,
      costIncomplete: true,
      costEstimated: true,
      tokensIncomplete: false,
    })
    expect(copy.label).toBe('≥ 1.8k tokens · ≥ $0.0021 (some cost unknown)')
    expect(copy.lines.join(' ')).toContain('1 reply reported no usage')
  })

  it('reports cost from /api/usage/models without inventing zero', () => {
    const base = { calls: 3, callsWithUsage: 3, callsWithoutUsage: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, cacheHitRate: null }
    expect(usageFormat.describeReportCost({ ...base, cost: { knownUsd: null, coverage: 'none', byBasis: { provider_reported: 0, estimated: 0, unknown: 3 } } })).toBe('cost unknown')
    expect(usageFormat.describeReportCost({ ...base, cost: { knownUsd: 0.5, coverage: 'partial', byBasis: { provider_reported: 2, estimated: 0, unknown: 1 } } })).toBe('≥ $0.50 (1 call with unknown cost)')
    expect(usageFormat.describeReportCost({ ...base, cost: { knownUsd: 0.5, coverage: 'complete', byBasis: { provider_reported: 0, estimated: 3, unknown: 0 } } })).toBe('≈ $0.50')
  })

  it('turn footer expands to the full breakdown', () => {
    const { container } = render(createElement(TurnUsageFooter, {
      usage: { modelCalls: 2, coverage: 'partial', inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, reasoningTokens: 5, costUsd: 0.001, costBasis: 'estimated' },
    }))
    const text = container.textContent
    expect(text).toContain('120 tokens · ≈ $0.001')
    expect(text).toContain('Input 100 tokens (0 read from cache)')
    expect(text).toContain('Output 20 tokens (5 reasoning)')
    expect(text).toContain('some did not report usage')
    expect(text).toContain('estimated from the configured price list')
  })
})
