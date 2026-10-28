// Run timeline benchmark (opt-in): streams 10,000 recorded-shape execution
// log events through the run model into the real RunTimeline and measures
// per-event fold time, per-frame React commit time and the DOM it leaves.
//
//   EXECUI_BENCH=1 pnpm --filter @openlinear/desktop-ui exec vitest run components/execution/run-timeline.bench.test.mjs
//
// Optional: EXECUI_BENCH_EVENTS=10000  EXECUI_BENCH_PER_FRAME=8 (events folded per animation frame)
//           EXECUI_BENCH_BEFORE=/abs/path/execution-drawer.tsx (base-tree drawer, for the "before" DOM size)
// Without EXECUI_BENCH the suite is skipped. Prints one `EXECUI_BENCH_RESULT {json}` line.
// Numbers are jsdom + React dev build: compare runs on the same machine only.
import { describe, it, expect, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createElement, Profiler, useState, useEffect } from 'react'

const BENCH = process.env.EXECUI_BENCH === '1'
const EVENTS = Number(process.env.EXECUI_BENCH_EVENTS ?? 10_000)
const PER_FRAME = Number(process.env.EXECUI_BENCH_PER_FRAME ?? 8)
const BEFORE = process.env.EXECUI_BENCH_BEFORE ?? ''

const { RunModel } = await import('@/lib/run-model/model.ts')
const { decodeExecutionEvent } = await import('@/lib/run-model/decode.ts')
const { chattyRun, TASK_ID } = await import('@/lib/run-model/fixtures.mjs')
const { RunTimeline } = await import('./run-timeline.tsx')
const { installViewport, restoreViewport } = await import('./test-helpers.mjs')

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

afterEach(() => {
  cleanup()
  restoreViewport()
})

describe.skipIf(!BENCH)('run timeline benchmark', () => {
  it(`streams ${EVENTS} log events with bounded DOM and flat per-event cost`, async () => {
    installViewport(480, 860)
    const events = chattyRun(EVENTS).map(([type, data, meta]) => decodeExecutionEvent(type, data, meta, Date.now()))
    const model = new RunModel({ taskId: TASK_ID })
    let push = () => {}
    const commits = []
    function Harness() {
      const [snapshot, setSnapshot] = useState(() => model.getSnapshot())
      useEffect(() => { push = () => setSnapshot(model.getSnapshot()) }, [])
      return createElement(Profiler, { id: 'timeline', onRender: (_id, _phase, actualDuration) => commits.push(actualDuration) },
        createElement('div', { style: { height: 480 } },
          createElement(RunTimeline, { entries: snapshot.entries, droppedEntries: snapshot.droppedEntries, live: true, className: 'h-full' })))
    }
    const { container } = render(createElement(Harness))

    const foldTimes = []
    const frameWall = []
    let maxArticles = 0
    let maxNodes = 0
    for (let start = 0; start < events.length; start += PER_FRAME) {
      const t0 = performance.now()
      for (let i = start; i < Math.min(events.length, start + PER_FRAME); i++) {
        const before = performance.now()
        model.apply(events[i])
        foldTimes.push(performance.now() - before)
      }
      act(() => push())
      frameWall.push(performance.now() - t0)
      if ((start / PER_FRAME) % 25 === 0) {
        maxArticles = Math.max(maxArticles, container.querySelectorAll('article').length)
        maxNodes = Math.max(maxNodes, container.querySelectorAll('*').length)
      }
    }
    const snapshot = model.getSnapshot()
    const finalArticles = container.querySelectorAll('article').length
    const finalNodes = container.querySelectorAll('*').length

    let before = null
    if (BEFORE) {
      const { ExecutionDrawer } = await import(/* @vite-ignore */ BEFORE)
      // The old drawer rendered every stored line (the store caps at 2,000).
      const logs = events.filter((event) => event.kind === 'log').slice(-2_000).map((event) => event.entry)
      cleanup()
      Element.prototype.scrollIntoView ??= () => {} // the old drawer scrolled on every append
      const t0 = performance.now()
      const view = render(createElement(ExecutionDrawer, { task: { id: TASK_ID, title: 'Bench', description: null, priority: 'medium', status: 'in_progress', sessionId: null, createdAt: '', updatedAt: '', labels: [] }, logs, open: true, onClose: () => {} }))
      before = { logs: logs.length, mountMs: round(performance.now() - t0), domNodes: view.container.querySelectorAll('*').length }
    }

    const result = {
      events: EVENTS,
      perFrame: PER_FRAME,
      frames: frameWall.length,
      foldMs: { p50: round(percentile(foldTimes, 50)), p95: round(percentile(foldTimes, 95)), p99: round(percentile(foldTimes, 99)), max: round(Math.max(...foldTimes)) },
      frameWallMs: { p50: round(percentile(frameWall, 50)), p95: round(percentile(frameWall, 95)), max: round(Math.max(...frameWall)) },
      commitMs: { p50: round(percentile(commits, 50)), p95: round(percentile(commits, 95)), max: round(Math.max(...commits)) },
      dom: { maxArticles, maxNodes, finalArticles, finalNodes },
      model: { entries: snapshot.entries.length, dropped: snapshot.droppedEntries, tools: snapshot.counters.tools, files: snapshot.counters.filesChanged },
      before,
    }
    console.log(`EXECUI_BENCH_RESULT ${JSON.stringify(result)}`)

    expect(snapshot.entries.length).toBeLessThanOrEqual(1_500)
    expect(maxArticles).toBeLessThanOrEqual(60)
    expect(maxNodes).toBeLessThanOrEqual(1_500)
    // Per-event fold cost: generous bounds for jsdom on a shared machine.
    expect(result.foldMs.p95).toBeLessThan(0.25)
    expect(result.foldMs.p99).toBeLessThan(1)
  }, 600_000)
})
