import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement } from 'react'

const { RunKnowledgeNote, RunPhaseBreakdown, phaseSegments } = await import('./run-phases.tsx')
const { normalizeRunState } = await import('@/components/review/model/normalize.ts')

afterEach(() => cleanup())

const PHASES = { queuedMs: 0, preparingMs: 13_000, setupMs: 7_000, agentMs: 65_000, approvalWaitMs: 10_000, verifyingMs: 15_000, finishingMs: 5_000, totalMs: 100_000, live: false }

describe('W15 run phase breakdown', () => {
  it('lists the phases that took time, with setup and approval wait called out', () => {
    expect(phaseSegments(PHASES).map((segment) => [segment.label, segment.ms, segment.detail])).toEqual([
      ['Preparing', 13_000, 'setup 7s'],
      ['Agent', 65_000, 'waiting for you 10s'],
      ['Verifying', 15_000, null],
      ['Publishing', 5_000, null],
    ])
    render(createElement(RunPhaseBreakdown, { phases: PHASES }))
    expect(screen.getByLabelText('Run took 1m 40s')).toBeTruthy()
    expect(screen.getByText('1m 40s total')).toBeTruthy()
    expect(screen.getByText(/Agent 1m 5s/)).toBeTruthy()
    expect(screen.getByText('(waiting for you 10s)')).toBeTruthy()
  })

  it('renders nothing for an instant run', () => {
    const { container } = render(createElement(RunPhaseBreakdown, { phases: { ...PHASES, preparingMs: 0, setupMs: 0, agentMs: 500, approvalWaitMs: 0, verifyingMs: 0, finishingMs: 0, totalMs: 500 } }))
    expect(container.textContent).toBe('')
  })

  it('W19b: names the knowledge revisions the run was given; nothing when none', () => {
    render(createElement(RunKnowledgeNote, { entries: [{ id: 'k1', version: 3, title: 'Use pnpm' }, { id: 'k2', version: 1, title: 'Before a PR' }] }))
    expect(screen.getByText(/Given 2 project knowledge entries/)).toBeTruthy()
    expect(screen.getByText('Use pnpm (v3), Before a PR (v1)')).toBeTruthy()
    cleanup()
    const { container } = render(createElement(RunKnowledgeNote, { entries: [] }))
    expect(container.textContent).toBe('')
    const base = { run: { runId: 'r1', state: 'succeeded', attemptId: 'a1', lastSeq: 1, relayAckSeq: 1, terminal: null, effects: [] } }
    expect(normalizeRunState({ run: { ...base.run, knowledge: [{ id: 'k1', version: 3, kind: 'convention', title: 'Use pnpm' }, { id: 'x' }, 'junk'] } })?.knowledge)
      .toEqual([{ id: 'k1', version: 3, kind: 'convention', title: 'Use pnpm' }])
  })

  it('reads phases from the run state, null when an older sidecar has none or sends junk', () => {
    const base = { run: { runId: 'r1', state: 'succeeded', attemptId: 'a1', lastSeq: 1, relayAckSeq: 1, terminal: null, effects: [] } }
    expect(normalizeRunState({ run: { ...base.run, phases: PHASES } })?.phases).toEqual(PHASES)
    expect(normalizeRunState(base)?.phases).toBeNull()
    expect(normalizeRunState({ run: { ...base.run, phases: { ...PHASES, agentMs: -1 } } })?.phases).toBeNull()
  })
})
