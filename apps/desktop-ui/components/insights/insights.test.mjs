import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api/fetch', async (original) => ({ ...(await original()), apiFetch: (...args) => api.apiFetch(...args) }))

const insightsApi = await import('@/lib/api/insights.ts')
const { resolveApiTarget } = await import('@/lib/api/routes.ts')
const { InsightsView } = await import('./insights-view.tsx')
const { InsightsPanel, isEmptyInsights } = await import('./insights-panel.tsx')
const { DailyColumns, ProportionBar } = await import('./insights-charts.tsx')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => { cleanup(); vi.clearAllMocks() })

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const dates = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']

function group(key, overrides = {}) {
  return { key, runs: 1, succeeded: 1, failed: 0, cancelled: 0, recoveryRequired: 0, inProgress: 0, successRate: 1, medianMs: 10 * MINUTE, p90Ms: 10 * MINUTE, costUsd: 0.5, unknownCostRuns: 0, inputTokens: 0, outputTokens: 0, ...overrides }
}

function insights(overrides = {}) {
  const runDay = (date) => ({ date, runs: 0, succeeded: 0, failed: 0, cancelled: 0, recoveryRequired: 0, costUsd: null, unknownCostRuns: 0 })
  const base = {
    scope: { kind: 'project', id: 'p1', projects: 1 },
    range: { key: '7d', days: 7, since: '2026-10-21T00:00:00.000Z', until: '2026-10-27T12:00:00.000Z' },
    runs: {
      total: 6,
      outcomes: { succeeded: 1, failed: 1, cancelled: 1, recoveryRequired: 2, inProgress: 1 },
      finished: 5,
      successRate: 0.2,
      verification: { passed: 1, failed: 1, skipped: 1, unverified: 2, passRate: 0.5 },
      publication: { published: 1, rate: 0.2 },
      duration: { medianMs: 30 * MINUTE, p90Ms: 46 * MINUTE, samples: 5 },
      cost: { knownUsd: 0.85, runsWithCost: 3, unknownCostRuns: 2, coverage: 'partial' },
      tokens: { input: 1500, output: 300, cachedInput: 0, cacheWrite: 0, reasoning: 0, runsWithTokens: 2 },
      byRunner: [group('opencode', { runs: 4, successRate: 0.3333, unknownCostRuns: 1, costUsd: 0.75 }), group('claude-code', { costUsd: null, unknownCostRuns: 1 })],
      byModel: [group('anthropic/claude-sonnet', { runs: 4 }), group('(other)')],
      daily: dates.map((date) => (date === '2026-10-25'
        ? { ...runDay(date), runs: 2, succeeded: 1, failed: 1, costUsd: 0.5, unknownCostRuns: 1 }
        : date === '2026-10-27' ? { ...runDay(date), runs: 1 } : runDay(date))),
    },
    delivery: {
      created: 13,
      completed: 2,
      completedUntracked: 1,
      cycleTime: { medianMs: 4 * DAY, p90Ms: 4.8 * DAY, samples: 2 },
      openNow: 8,
      blockedNow: 2,
      plans: { approvals: 2, plansApproved: 1, awaitingReview: 2 },
      daily: dates.map((date) => ({ date, created: date === '2026-10-26' ? 3 : 0, completed: date === '2026-10-26' ? 1 : 0 })),
    },
    notes: { unknownCostRuns: 'Finished runs with no recorded cost. Never counted as $0.' },
  }
  return { ...base, ...overrides }
}

function emptyInsights() {
  const doc = insights()
  return {
    ...doc,
    runs: {
      ...doc.runs, total: 0, finished: 0, successRate: null, byRunner: [], byModel: [],
      outcomes: { succeeded: 0, failed: 0, cancelled: 0, recoveryRequired: 0, inProgress: 0 },
      verification: { passed: 0, failed: 0, skipped: 0, unverified: 0, passRate: null },
      publication: { published: 0, rate: null },
      duration: { medianMs: null, p90Ms: null, samples: 0 },
      cost: { knownUsd: 0, runsWithCost: 0, unknownCostRuns: 0, coverage: 'none' },
      daily: doc.runs.daily.map((day) => ({ ...day, runs: 0, succeeded: 0, failed: 0, costUsd: null, unknownCostRuns: 0 })),
    },
    delivery: {
      ...doc.delivery, created: 0, completed: 0, completedUntracked: 0, openNow: 0, blockedNow: 0,
      cycleTime: { medianMs: null, p90Ms: null, samples: 0 },
      plans: { approvals: 0, plansApproved: 0, awaitingReview: 0 },
      daily: doc.delivery.daily.map((day) => ({ ...day, created: 0, completed: 0 })),
    },
  }
}

function tile(label) {
  return screen.getByText(label, { selector: 'div' }).parentElement
}

function renderWithClient(element) {
  const client = createAppQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  return render(createElement(QueryClientProvider, { client }, element))
}

describe('insights API module (W15b)', () => {
  it('requests the project and workspace documents with the range, on the cloud API', async () => {
    api.apiFetch.mockResolvedValue(insights())
    await insightsApi.fetchInsights({ kind: 'project', id: 'p 1' }, '90d')
    await insightsApi.fetchInsights({ kind: 'workspace', id: 'w1' }, '7d')
    expect(api.apiFetch.mock.calls.map((call) => call[0])).toEqual(['/api/projects/p%201/insights?range=90d', '/api/workspaces/w1/insights?range=7d'])
    expect(resolveApiTarget('/api/projects/p1/insights?range=7d')).toBe('cloud')
    expect(resolveApiTarget('/api/workspaces/w1/insights')).toBe('cloud')
  })

  it('keys documents under their project or workspace scope', () => {
    expect(insightsApi.insightsKeys.forScope({ kind: 'project', id: 'p1' }, '30d')).toEqual(['ol', 'project', 'p1', 'insights', '30d'])
    expect(insightsApi.insightsKeys.forScope({ kind: 'workspace', id: 'w1' }, '7d')).toEqual(['ol', 'ws', 'w1', 'insights', '7d'])
  })

  it('formats rates, money, durations and UTC days', () => {
    expect(insightsApi.formatRate(null)).toBe('—')
    expect(insightsApi.formatRate(0.3333)).toBe('33%')
    expect(insightsApi.formatUsd(0)).toBe('$0.00')
    expect(insightsApi.formatUsd(0.85)).toBe('$0.850')
    expect(insightsApi.formatUsd(12.5)).toBe('$12.50')
    expect(insightsApi.formatKnownCost(0.85, 3)).toBe('$0.850')
    expect(insightsApi.formatKnownCost(null, 2)).toBe('unknown')
    expect(insightsApi.formatKnownCost(null, 0)).toBe('—')
    expect(insightsApi.formatDuration(null)).toBe('—')
    expect(insightsApi.formatDuration(45_000)).toBe('45 s')
    expect(insightsApi.formatDuration(46 * MINUTE)).toBe('46 min')
    expect(insightsApi.formatDuration(4.8 * DAY)).toBe('4.8 d')
    expect(insightsApi.formatDuration(90 * MINUTE)).toBe('1.5 h')
    expect(insightsApi.formatDay('2026-10-21')).toBe('Oct 21')
    expect(insightsApi.formatCount(12_900)).toBe('12.9K')
  })
})

describe('insights charts (W15b)', () => {
  it('gives the daily chart a text summary, a labelled legend, tooltips and a table view', () => {
    render(createElement(DailyColumns, {
      title: 'Created and completed per day',
      dates,
      mode: 'grouped',
      series: [
        { key: 'created', label: 'Created', swatch: 'bg-info', values: [0, 0, 0, 0, 0, 3, 0] },
        { key: 'completed', label: 'Completed', swatch: 'bg-success', values: [0, 0, 0, 0, 0, 1, 0] },
      ],
    }))
    const chart = screen.getByRole('img', { name: /Created and completed per day/ })
    expect(chart.getAttribute('aria-label')).toBe('Created and completed per day: 3 created, 1 completed over 7 days; busiest Oct 26 (3).')
    expect(chart.querySelector('[data-day="2026-10-26"]').getAttribute('title')).toBe('Oct 26: 3 created, 1 completed')
    const legend = screen.getAllByRole('listitem').map((item) => item.textContent)
    expect(legend).toEqual(['Created3', 'Completed1'])
    const table = screen.getByRole('table')
    const row = within(table).getByRole('row', { name: /Oct 26/ })
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['3', '1'])
  })

  it('shows per-day text (e.g. an unknown cost) instead of a $0 value, and does not call unknown-only days empty', () => {
    render(createElement(DailyColumns, {
      title: 'Known cost per day',
      dates,
      mode: 'stacked',
      format: insightsApi.formatUsd,
      series: [{ key: 'cost', label: 'Cost', swatch: 'bg-info', values: [0, 0, 0, 0, 0, 0, 0], text: ['—', '—', '—', '—', 'unknown', '—', '—'] }],
      extra: { label: 'Runs with unknown cost', values: [0, 0, 0, 0, 2, 0, 0] },
    }))
    const chart = screen.getByRole('img')
    expect(chart.getAttribute('aria-label')).toBe('Known cost per day: nothing recorded in the last 7 days; 2 runs with unknown cost.')
    expect(chart.querySelector('[data-day="2026-10-25"]').getAttribute('title')).toBe('Oct 25: unknown cost, 2 runs with unknown cost')
    const row = within(screen.getByRole('table')).getByRole('row', { name: /Oct 25/ })
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['unknown', '2'])
    expect(screen.queryByText('Nothing in this range.')).toBeNull()
  })

  it('says when a range is empty', () => {
    render(createElement(DailyColumns, { title: 'Runs per day', dates, mode: 'stacked', series: [{ key: 'a', label: 'Runs', swatch: 'bg-info', values: [0, 0, 0, 0, 0, 0, 0] }] }))
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Runs per day: nothing in the last 7 days.')
    expect(screen.getByText('Nothing in this range.')).toBeTruthy()
    // A single series needs no legend.
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('describes the outcome bar in words', () => {
    render(createElement(ProportionBar, {
      label: 'Run outcomes',
      parts: [
        { key: 's', label: 'Succeeded', swatch: 'bg-success', value: 3 },
        { key: 'f', label: 'Failed', swatch: 'bg-danger', value: 1 },
        { key: 'c', label: 'Cancelled', swatch: 'bg-status-cancelled', value: 0 },
      ],
    }))
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Run outcomes: 3 succeeded (75%), 1 failed (25%)')
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Succeeded3 · 75%', 'Failed1 · 25%', 'Cancelled0 · 0%'])
  })
})

describe('insights view (W15b)', () => {
  it('shows run tiles with rates, recovery and explicit unknown cost', () => {
    render(createElement(InsightsView, { insights: insights() }))
    expect(tile('Runs').textContent).toContain('5 finished · 1 in progress')
    expect(tile('Success rate').textContent).toBe('Success rate20%1 of 5 finished2 runs need recovery')
    expect(tile('Verification pass rate').textContent).toContain('50%1 passed · 1 failed · 2 unverified')
    expect(tile('Pull request rate').textContent).toContain('20%1 pull request')
    expect(tile('Run duration (median)').textContent).toContain('30 minp90 46 min')
    expect(tile('Known cost').textContent).toBe('Known cost$0.850from 3 runs with a price2 runs with no recorded price are not included')
  })

  it('lists runners and models with unknown-cost runs next to the known cost', () => {
    render(createElement(InsightsView, { insights: insights() }))
    const runners = screen.getByRole('table', { name: 'By runner' })
    const opencode = within(runners).getByRole('row', { name: /opencode/ })
    expect(opencode.textContent).toContain('33%')
    expect(opencode.textContent).toContain('$0.750+ 1 unknown')
    // No claude-code run recorded a price: "unknown", never "$0.00".
    const claude = within(runners).getByRole('row', { name: /claude-code/ })
    expect(claude.textContent).toContain('unknown')
    expect(claude.textContent).not.toContain('$')
    expect(within(screen.getByRole('table', { name: 'By model' })).getByRole('row', { name: /\(other\)/ })).toBeTruthy()
  })

  it('shows delivery, the untracked done issues and how numbers are counted', () => {
    render(createElement(InsightsView, { insights: insights() }))
    expect(tile('Created').textContent).toBe('Created13')
    expect(tile('Completed').textContent).toBe('Completed21 more issue done without a recorded date')
    expect(tile('Cycle time (median)').textContent).toBe('Cycle time (median)4 dp90 4.8 d · created to done')
    expect(tile('Blocked now').textContent).toBe('Blocked now2of 8 open issues')
    expect(tile('Plans approved').textContent).toBe('Plans approved12 approvals · 2 awaiting review')
    expect(screen.getByText('How these numbers are counted')).toBeTruthy()
    expect(screen.getByText('Finished runs with no recorded cost. Never counted as $0.')).toBeTruthy()
    expect(screen.getByRole('img', { name: /^Run outcomes: 1 succeeded \(17%\)/ })).toBeTruthy()
  })

  it('names the project count for a workspace and replaces run charts when nothing ran', () => {
    const doc = emptyInsights()
    render(createElement(InsightsView, { insights: { ...doc, scope: { kind: 'workspace', id: 'w1', projects: 3 } } }))
    expect(screen.getByText(/across 3 projects/)).toBeTruthy()
    expect(screen.getByText('No agent runs in the last 7 days.')).toBeTruthy()
    expect(screen.queryByRole('table', { name: 'By runner' })).toBeNull()
    expect(tile('Known cost').textContent).toBe('Known cost—No run recorded a price')
  })

  it('reads "unknown" for the known-cost tile and days when runs recorded no price', () => {
    const doc = insights()
    const unpriced = {
      ...doc,
      runs: {
        ...doc.runs,
        cost: { knownUsd: 0, runsWithCost: 0, unknownCostRuns: 5, coverage: 'none' },
        daily: doc.runs.daily.map((day) => ({ ...day, costUsd: null })),
      },
    }
    render(createElement(InsightsView, { insights: unpriced }))
    expect(tile('Known cost').textContent).toBe('Known costunknownNo run recorded a price5 runs with no recorded price are not included')
    const costChart = screen.getByRole('img', { name: /^Known cost per day/ })
    expect(costChart.querySelector('[data-day="2026-10-25"]').getAttribute('title')).toBe('Oct 25: unknown cost, 1 runs with unknown cost')
    expect(costChart.querySelector('[data-day="2026-10-21"]').getAttribute('title')).toBe('Oct 21: — cost')
  })
})

describe('insights panel (W15b)', () => {
  it('loads the default range, then switches range with the radio group', async () => {
    api.apiFetch.mockImplementation(async (path) => insights({ range: { key: path.endsWith('90d') ? '90d' : '30d', days: path.endsWith('90d') ? 90 : 30, since: '', until: '2026-10-27T12:00:00.000Z' } }))
    renderWithClient(createElement(InsightsPanel, { scope: { kind: 'project', id: 'p1' } }))
    expect(screen.getByLabelText('Loading insights')).toBeTruthy()
    await screen.findByText('Agent runs')
    expect(api.apiFetch).toHaveBeenCalledWith('/api/projects/p1/insights?range=30d')
    expect(screen.getByRole('radio', { name: '30 days' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: '90 days' }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/api/projects/p1/insights?range=90d'))
    await screen.findByText(/Runs started in the last 90 days/)
    expect(screen.getByRole('radio', { name: '90 days' }).getAttribute('aria-checked')).toBe('true')
  })

  it('shows an error with a retry', async () => {
    api.apiFetch.mockRejectedValueOnce(new Error('boom'))
    renderWithClient(createElement(InsightsPanel, { scope: { kind: 'workspace', id: 'w1' } }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('boom')
    api.apiFetch.mockResolvedValueOnce(insights())
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByText('Agent runs')
    expect(api.apiFetch).toHaveBeenLastCalledWith('/api/workspaces/w1/insights?range=30d')
  })

  it('shows an empty state when nothing happened and nothing is open', async () => {
    expect(isEmptyInsights(insights())).toBe(false)
    expect(isEmptyInsights(emptyInsights())).toBe(true)
    api.apiFetch.mockResolvedValue(emptyInsights())
    renderWithClient(createElement(InsightsPanel, { scope: { kind: 'project', id: 'p1' }, initialRange: '7d' }))
    await screen.findByText('Nothing to show for the last 7 days')
    expect(screen.queryByText('Agent runs')).toBeNull()
  })
})
