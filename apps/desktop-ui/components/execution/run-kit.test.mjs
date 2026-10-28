import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within, renderHook } from '@testing-library/react'
import { createElement } from 'react'

const { RunHeader, formatCost, formatBudget } = await import('./run-header.tsx')
const { RunControls, StopButton } = await import('./run-controls.tsx')
const { FileChangesList } = await import('./file-changes-list.tsx')
const { RunEmptyState, RunErrorState, RunLoadingState, RunRecoveryActions, RunRecoveryBanner } = await import('./run-states.tsx')
const { useStopControl } = await import('./use-stop-control.ts')
const { KIT_TEXT, TONE_TEXT, TONE_TINT_HEX, KIT_SURFACES_HEX } = await import('./tokens.ts')
const { foldRunEvents } = await import('@/lib/run-model/model.ts')
const { decodeExecutionEvent } = await import('@/lib/run-model/decode.ts')
const { legacySuccessRun, journalRun, journalEvent } = await import('@/lib/run-model/fixtures.mjs')
const { ApiError } = await import('@/lib/api/fetch.ts')

function fold(events) {
  return foldRunEvents(events.map(([type, data, meta]) => decodeExecutionEvent(type, data, meta, Date.parse('2026-10-25T10:00:00Z'))))
}

afterEach(() => cleanup())

describe('RunHeader', () => {
  it('shows phase, runner/model, elapsed, counters, and "Cost unknown" — never $0', () => {
    render(createElement(RunHeader, { snapshot: fold(legacySuccessRun()) }))
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(within(status).getByText('Succeeded')).toBeTruthy()
    expect(screen.getByText('OpenCode · Claude Sonnet 4.5')).toBeTruthy()
    expect(screen.getByTestId('run-cost').textContent).toBe('Cost unknown')
    expect(screen.queryByText(/\$0/)).toBeNull()
    expect(screen.getByText('4 tool calls')).toBeTruthy()
    expect(screen.getByText('1 file changed')).toBeTruthy()
    expect(screen.getByText('1 error')).toBeTruthy()
    expect(screen.getByText('openlinear/kt-12-fix-login')).toBeTruthy()
  })

  it('names the runner the attempt actually uses (run state ids → display names)', () => {
    const snapshot = { ...fold(legacySuccessRun()), runner: 'claude-code', model: null }
    render(createElement(RunHeader, { snapshot }))
    expect(screen.getByText('Claude Code')).toBeTruthy()
  })

  it('FE-08: shows spend against the run budget (tokens = input + output), never inventing a cost', () => {
    const tokens = { input: 30_000, output: 12_000, reasoning: 5_000, cacheRead: 100_000, cacheWrite: 0 }
    expect(formatBudget({ budget: null, cost: { status: 'unknown' }, tokens })).toBeNull()
    expect(formatBudget({ budget: { maxUsd: 2, maxTokens: null }, cost: { status: 'known', usd: 0.4217, basis: null }, tokens }).text).toBe('$0.42 of $2.00')
    expect(formatBudget({ budget: { maxUsd: 2, maxTokens: 200_000 }, cost: { status: 'unknown' }, tokens }).text).toBe('budget $2.00 (cost unknown) · 42k of 200k tokens')
    expect(formatBudget({ budget: { maxUsd: null, maxTokens: 50_000 }, cost: { status: 'unknown' }, tokens: null }).text).toBe('0 of 50k tokens')
  })

  it('formats a provider-reported cost, including a real zero', () => {
    expect(formatCost({ status: 'unknown' }).text).toBe('Cost unknown')
    expect(formatCost({ status: 'known', usd: 0.0123, basis: 'provider' })).toEqual({ text: '$0.0123', title: '$0.0123 (provider)' })
    expect(formatCost({ status: 'known', usd: 1.5, basis: null }).text).toBe('$1.50')
    expect(formatCost({ status: 'known', usd: 0, basis: 'provider' }).text).toBe('$0.00')

    const snapshot = fold([...journalRun(), journalEvent(18, { t: 'usage', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd: 0.42, basis: 'provider' }, messageId: 'm9' })])
    render(createElement(RunHeader, { snapshot }))
    expect(screen.getByTestId('run-cost').textContent).toBe('$0.42')
  })

  it('labels a lost stream and flags an unconfirmed stop', () => {
    const snapshot = { ...fold(legacySuccessRun().slice(0, 15)), phase: 'unknown', recovery: 'stream_lost' }
    render(createElement(RunHeader, { snapshot, stop: { status: 'unconfirmed', message: 'x', hint: null } }))
    expect(within(screen.getByRole('status')).getByText('Connection lost')).toBeTruthy()
    expect(screen.getByText('Stop unconfirmed')).toBeTruthy()
  })
})

describe('Stop control', () => {
  function useHarness(onStop, finished = false) {
    return useStopControl({ onStop, wasRunFinished: () => finished, resetKey: 'a' })
  }

  it('stop requested → stopped when the service confirms', async () => {
    let resolve
    const onStop = vi.fn(() => new Promise((r) => { resolve = r }))
    const { result } = renderHook(() => useHarness(onStop))
    act(() => result.current.request())
    expect(result.current.state.status).toBe('requested')
    act(() => result.current.request()) // double click while in flight
    expect(onStop).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(true) })
    expect(result.current.state).toMatchObject({ status: 'stopped', message: expect.stringContaining('confirmed it stopped') })
  })

  it('stop unconfirmed — retry, using the mapped API error', async () => {
    const onStop = vi.fn(async () => {
      throw new ApiError(400, 'Cancellation could not be confirmed; execution remains reserved', 'CANCEL_INCOMPLETE')
    })
    const { result } = renderHook(() => useHarness(onStop))
    await act(async () => { result.current.request() })
    expect(result.current.state.status).toBe('unconfirmed')
    expect(result.current.state.message).toMatch(/^Stop unconfirmed — Cancellation could not be confirmed/)
    expect(result.current.state.hint).toMatch(/Retry the stop/)
  })

  it('maps the board contract (`false`) to unconfirmed, or "already finished" when the run had ended', async () => {
    const live = renderHook(() => useHarness(async () => false, false))
    await act(async () => { live.result.current.request() })
    expect(live.result.current.state.status).toBe('unconfirmed')

    const ended = renderHook(() => useHarness(async () => false, true))
    await act(async () => { ended.result.current.request() })
    expect(ended.result.current.state.status).toBe('not_running')

    const notRunning = renderHook(() => useHarness(async () => { throw new ApiError(400, 'Task is not running') }))
    await act(async () => { notRunning.result.current.request() })
    expect(notRunning.result.current.state.status).toBe('not_running')
  })

  it('renders Stop → Stopping… → Retry stop with a polite status line', () => {
    const onRequest = vi.fn()
    const { rerender } = render(createElement(RunControls, { phase: 'running', stop: { status: 'idle', message: null, hint: null }, onRequest, canStop: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))
    expect(onRequest).toHaveBeenCalled()

    rerender(createElement(RunControls, { phase: 'cancelled', stop: { status: 'requested', message: 'Stop requested — waiting for the agent to confirm.', hint: null }, onRequest, canStop: true }))
    expect(screen.getByRole('button', { name: 'Stopping' }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Stop requested')

    rerender(createElement(RunControls, { phase: 'cancelled', stop: { status: 'unconfirmed', message: 'Stop unconfirmed — the agent may still be running.', hint: 'Retry the stop.' }, onRequest, canStop: true }))
    expect(screen.getByRole('button', { name: 'Retry stop' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Stop unconfirmed')

    rerender(createElement(RunControls, { phase: 'cancelled', stop: { status: 'stopped', message: 'Stopped — the agent confirmed it stopped.', hint: null }, onRequest, canStop: true }))
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Stopped')
  })

  it('offers no Stop for finished, queued or unstoppable runs', () => {
    const idle = { status: 'idle', message: null, hint: null }
    for (const phase of ['succeeded', 'queued', 'idle']) {
      const { container } = render(createElement(StopButton, { phase, stop: idle, onRequest: () => {}, canStop: true }))
      expect(container.querySelector('button')).toBeNull()
      cleanup()
    }
    const { container } = render(createElement(StopButton, { phase: 'running', stop: idle, onRequest: () => {}, canStop: false }))
    expect(container.querySelector('button')).toBeNull()
  })

  it('FE-06: a run waiting in the engine queue can be stopped; a start request still in flight cannot', () => {
    const idle = { status: 'idle', message: null, hint: null }
    const queued = render(createElement(StopButton, { phase: 'queued', phaseSource: 'journal', stop: idle, onRequest: () => {}, canStop: true }))
    expect(queued.getByRole('button', { name: 'Stop run' })).toBeTruthy()
    cleanup()
    const requested = render(createElement(StopButton, { phase: 'queued', phaseSource: 'request', stop: idle, onRequest: () => {}, canStop: true }))
    expect(requested.container.querySelector('button')).toBeNull()
    cleanup()
    for (const phase of ['verifying', 'compacting', 'awaiting_approval']) {
      const live = render(createElement(StopButton, { phase, phaseSource: 'journal', stop: idle, onRequest: () => {}, canStop: true }))
      expect(live.getByRole('button', { name: 'Stop run' }), phase).toBeTruthy()
      cleanup()
    }
  })
})

describe('RunRecoveryActions (FE-06)', () => {
  it('explains an unprovable outcome and offers inspect before run again', () => {
    const onInspect = vi.fn()
    const onRunAgain = vi.fn()
    render(createElement(RunRecoveryActions, { phase: 'recovery_required', onInspect, onRunAgain }))
    expect(screen.getByText('Recovery required')).toBeTruthy()
    expect(screen.getByText(/couldn't prove how the run ended/)).toBeTruthy()
    const buttons = screen.getAllByRole('button').map((button) => button.textContent)
    expect(buttons).toEqual(['Inspect the work', 'Run again'])
    fireEvent.click(screen.getByRole('button', { name: 'Inspect the work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    expect(onInspect).toHaveBeenCalledTimes(1)
    expect(onRunAgain).toHaveBeenCalledTimes(1)
  })

  it('W12: continue resumes the saved session between inspect and run again; busy while sending', () => {
    const onContinue = vi.fn()
    const { rerender } = render(createElement(RunRecoveryActions, { phase: 'recovery_required', onInspect: vi.fn(), onContinue, onRunAgain: vi.fn() }))
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Inspect the work', 'Continue where it stopped', 'Run again'])
    fireEvent.click(screen.getByRole('button', { name: 'Continue where it stopped' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
    rerender(createElement(RunRecoveryActions, { phase: 'recovery_required', onContinue, continuing: true }))
    expect(screen.getByRole('button', { name: 'Continue where it stopped' }).hasAttribute('disabled')).toBe(true)
  })

  it('abandoned has its own copy; without callbacks it only explains', () => {
    render(createElement(RunRecoveryActions, { phase: 'abandoned' }))
    expect(screen.getByText('Abandoned')).toBeTruthy()
    expect(screen.getByText(/lost authority over the run/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('FileChangesList and states', () => {
  it('lists touched files with A/M/D markers that are not colour-only', () => {
    const snapshot = fold(journalRun())
    render(createElement(FileChangesList, { files: snapshot.files }))
    const list = screen.getByRole('region', { name: 'Files changed' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'MModified:src/auth/login.ts',
      'AAdded:src/auth/cookie.ts',
      'DDeleted:src/auth/legacy.ts',
    ])
  })

  it('collapses long lists and reports overflow', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, change: 'modified', edits: i === 0 ? 3 : 1, lastAt: i }))
    render(createElement(FileChangesList, { files, overflow: 4 }))
    expect(screen.getAllByRole('listitem')).toHaveLength(8)
    expect(screen.getByText('+4 more not listed')).toBeTruthy()
    expect(screen.getByText('3 edits')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show all 12' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(12)
  })

  it('has empty, loading, error and recovery states', () => {
    const onRetry = vi.fn()
    render(createElement('div', null,
      createElement(RunEmptyState),
      createElement(RunLoadingState),
      createElement(RunErrorState, { message: "Couldn't reach OpenLinear.", hint: 'Check your connection and try again.', onRetry }),
      createElement(RunRecoveryBanner, { reason: 'service_restarted' }),
    ))
    expect(screen.getByText('No activity yet')).toBeTruthy()
    expect(screen.getByText('Loading activity…')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain("Couldn't reach OpenLinear.")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
    expect(screen.getByText('Recovery required')).toBeTruthy()
  })
})

describe('kit colour tokens', () => {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const channel = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const mix = (fg, bg, alpha) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)))

  it('every kit text colour is ≥ 4.5:1 on every surface it is drawn on', () => {
    const texts = [...Object.values(KIT_TEXT), ...Object.values(TONE_TEXT)]
    for (const surface of KIT_SURFACES_HEX) {
      for (const text of texts) {
        expect(contrast(hex(text.hex), hex(surface)), `${text.className} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('tone text stays ≥ 4.5:1 on its own tinted pill', () => {
    for (const [tone, tint] of Object.entries(TONE_TINT_HEX)) {
      const pill = mix(hex(tint), hex('#111111'), 0.1)
      expect(contrast(hex(TONE_TEXT[tone].hex), pill), tone).toBeGreaterThanOrEqual(4.5)
    }
  })
})
