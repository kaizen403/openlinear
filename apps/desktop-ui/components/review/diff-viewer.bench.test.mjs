/**
 * Large-diff rendering: an always-on bounded-DOM guard for a 5,000-line diff,
 * plus an opt-in benchmark (REVIEW_BENCH=1) that prints timings.
 *
 *   REVIEW_BENCH=1 pnpm --filter @openlinear/desktop-ui exec vitest run components/review/diff-viewer.bench.test.mjs
 *   # REVIEW_BENCH_LINES=20000 to scale up
 *
 * jsdom + React dev build on a shared machine: compare runs with each other only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup, fireEvent, screen } from '@testing-library/react'
import { createElement } from 'react'

const api = vi.hoisted(() => ({ fetchTaskDiff: vi.fn(), fetchTaskRunState: vi.fn(), sendTaskFollowUp: vi.fn() }))
vi.mock('@/providers/sse-provider', () => ({ useSSESubscription() {}, useSSEStatus: () => ({ isConnected: true, isReconnecting: false }) }))
vi.mock('@/lib/api/review', () => api)

const { TaskReviewPanel } = await import('./review-panel.tsx')
const { normalizeTaskDiff } = await import('./model/normalize.ts')
const { buildDiffRows } = await import('./model/rows.ts')
const { ApiError } = await import('@/lib/api/fetch.ts')
const { largeDiff, installDiffViewport, restoreDiffViewport, memoryStorage } = await import('./fixtures.mjs')

const BENCH = process.env.REVIEW_BENCH === '1'
const LINES = Number(process.env.REVIEW_BENCH_LINES ?? 5000)

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

function stats(values) {
  return { p50: +percentile(values, 50).toFixed(2), p95: +percentile(values, 95).toFixed(2), max: +Math.max(...values).toFixed(2) }
}

async function mountLarge(lines) {
  const raw = largeDiff({ fileCount: Math.max(1, Math.round(lines / 500)), linesPerFile: Math.min(500, lines), hunkSize: 50 })
  api.fetchTaskDiff.mockResolvedValue(raw)
  api.fetchTaskRunState.mockRejectedValue(new ApiError(404, 'none', 'RUN_NOT_FOUND'))
  const started = performance.now()
  render(createElement(TaskReviewPanel, { task: { id: `bench-${lines}`, status: 'done', outcome: null, prUrl: null, batchId: null }, phase: 'succeeded', storage: memoryStorage() }))
  await screen.findByRole('tree', { name: 'Changed files' })
  const mountMs = performance.now() - started
  const scroller = document.querySelector('[data-review-diff-scroller]')
  return { raw, scroller, mountMs }
}

function measureDom(scroller) {
  return { rows: scroller.querySelectorAll('[data-row-key]').length, nodes: scroller.querySelectorAll('*').length }
}

beforeEach(() => installDiffViewport(720, 1000))
afterEach(() => {
  cleanup()
  restoreDiffViewport()
})

describe('large diff rendering', () => {
  it('5,000 changed lines render a bounded DOM while scrolling and navigating', async () => {
    const { scroller } = await mountLarge(5000)
    const initial = measureDom(scroller)
    expect(initial.rows).toBeGreaterThan(20)
    expect(initial.rows).toBeLessThanOrEqual(80)
    expect(initial.nodes).toBeLessThan(2500)

    let maxRows = initial.rows
    let maxNodes = initial.nodes
    const total = Number.parseFloat(scroller.firstElementChild.style.height)
    expect(total).toBeGreaterThan(5000 * 20)
    for (const fraction of [0.25, 0.5, 0.75, 0.999]) {
      act(() => {
        scroller.scrollTop = total * fraction
        fireEvent.scroll(scroller)
      })
      const dom = measureDom(scroller)
      maxRows = Math.max(maxRows, dom.rows)
      maxNodes = Math.max(maxNodes, dom.nodes)
    }
    // Jump through hunks with the keyboard: the focused row is always rendered, the DOM stays bounded.
    const header = scroller.querySelector('[data-row-key][tabindex="0"]')
    act(() => header.focus())
    for (let i = 0; i < 30; i++) act(() => fireEvent.keyDown(document.activeElement, { key: 'n' }))
    expect(document.activeElement.getAttribute('data-row-key')).toBe('h:src/module-002/file.ts:9')
    expect(document.activeElement.getAttribute('data-hunk-header')).toBe('')
    const after = measureDom(scroller)
    maxRows = Math.max(maxRows, after.rows)
    maxNodes = Math.max(maxNodes, after.nodes)
    expect(maxRows).toBeLessThanOrEqual(80)
    expect(maxNodes).toBeLessThan(2500)
  })

  it.skipIf(!BENCH)('benchmark', async () => {
    const raw = largeDiff({ fileCount: Math.max(1, Math.round(LINES / 500)), linesPerFile: Math.min(500, LINES) })
    const normalizeRuns = []
    const buildRuns = []
    for (let i = 0; i < 10; i++) {
      let t = performance.now()
      const diff = normalizeTaskDiff(raw)
      normalizeRuns.push(performance.now() - t)
      t = performance.now()
      buildDiffRows({ files: diff.files, mode: i % 2 ? 'split' : 'unified' })
      buildRuns.push(performance.now() - t)
    }
    const { scroller, mountMs } = await mountLarge(LINES)
    const total = Number.parseFloat(scroller.firstElementChild.style.height)
    const scrollRuns = []
    const nodeCounts = []
    for (let i = 1; i <= 60; i++) {
      const t = performance.now()
      act(() => {
        scroller.scrollTop = (total * i) / 61
        fireEvent.scroll(scroller)
      })
      scrollRuns.push(performance.now() - t)
      nodeCounts.push(measureDom(scroller).nodes)
    }
    const header = scroller.querySelector('[data-row-key][tabindex="0"]')
    act(() => header.focus())
    const navRuns = []
    for (let i = 0; i < 40; i++) {
      const t = performance.now()
      act(() => fireEvent.keyDown(document.activeElement, { key: i % 4 === 3 ? 'j' : 'n' }))
      navRuns.push(performance.now() - t)
    }
    const toggle = performance.now()
    act(() => fireEvent.click(screen.getByRole('button', { name: 'split' })))
    const toggleMs = performance.now() - toggle
    const report = {
      lines: LINES,
      normalizeMs: stats(normalizeRuns),
      buildRowsMs: stats(buildRuns),
      mountMs: +mountMs.toFixed(1),
      scrollFrameMs: stats(scrollRuns),
      keyboardNavMs: stats(navRuns),
      splitToggleMs: +toggleMs.toFixed(1),
      maxDomNodes: Math.max(...nodeCounts),
    }
    console.log(`[review bench] ${JSON.stringify(report)}`)
    expect(report.maxDomNodes).toBeLessThan(2500)
  }, 120_000)
})
