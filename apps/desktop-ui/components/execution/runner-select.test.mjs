import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchRunnerCatalogue: null }))
vi.mock('@/lib/api/runners', async (original) => ({
  ...(await original()),
  fetchRunnerCatalogue: (...args) => api.fetchRunnerCatalogue(...args),
}))

const { runnerOptions, selectionProblem, RunnerSelect } = await import('./runner-select.tsx')

const CATALOGUE = {
  engine: 'v2',
  defaultRunner: 'opencode',
  sandbox: { mode: 'enforce', verified: true, provider: 'seatbelt', blockers: [] },
  checkedAt: '2026-10-27T00:00:00.000Z',
  runners: [
    { id: 'opencode', label: 'OpenCode', available: true, executable: true, reason: null, version: '1.2.3', auth: 'ok', features: null },
    { id: 'claude-code', label: 'Claude Code', available: false, executable: false, reason: 'Not signed in to Claude Code on this device', version: 'v2.0.1', auth: 'missing', features: null },
    { id: 'codex', label: 'Codex', available: true, executable: true, reason: null, version: null, auth: 'ok', features: null },
  ],
}

afterEach(() => cleanup())

describe('runner picker model (FE-02)', () => {
  it('offers every runner, disabling the ones this device cannot run, with the reason', () => {
    expect(runnerOptions(CATALOGUE)).toEqual([
      { id: 'opencode', label: 'OpenCode', detail: 'v1.2.3', disabled: false, reason: null },
      { id: 'claude-code', label: 'Claude Code', detail: 'v2.0.1', disabled: true, reason: 'Not signed in to Claude Code on this device' },
      { id: 'codex', label: 'Codex', detail: null, disabled: false, reason: null },
    ])
    // A runner the service didn't report is not offered as runnable.
    expect(runnerOptions({ ...CATALOGUE, runners: CATALOGUE.runners.slice(0, 1) })[2]).toMatchObject({ id: 'codex', disabled: true, reason: 'Not reported by the execution service' })
  })

  it('without a reachable service, every runner is offered (availability unknown)', () => {
    expect(runnerOptions(null).every((option) => !option.disabled)).toBe(true)
  })

  it('flags a stored choice that can no longer run; inherited or runnable choices are fine', () => {
    const options = runnerOptions(CATALOGUE)
    expect(selectionProblem('claude-code', options)).toBe('Not signed in to Claude Code on this device')
    expect(selectionProblem('codex', options)).toBeNull()
    expect(selectionProblem(null, options)).toBeNull()
  })
})

function renderSelect(props) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(createElement(QueryClientProvider, { client }, createElement(RunnerSelect, { onChange: () => {}, ...props })))
}

describe('RunnerSelect', () => {
  it('shows the inherited choice and warns when the stored runner is unavailable', async () => {
    api.fetchRunnerCatalogue = vi.fn(async () => CATALOGUE)
    renderSelect({ value: 'claude-code', inheritLabel: 'Project default (OpenCode)' })
    expect(await screen.findByRole('note')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toMatch(/Not signed in to Claude Code on this device\. Runs of this task will fail/)
    expect(screen.getByRole('combobox', { name: 'Agent' }).textContent).toContain('Claude Code')
  })

  it('says availability is unknown when the execution service is unreachable', async () => {
    api.fetchRunnerCatalogue = vi.fn(async () => { throw new Error('sidecar down') })
    renderSelect({ value: null, inheritLabel: 'Project default (OpenCode)' })
    expect(await screen.findByText(/Availability unknown/)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Agent' }).textContent).toContain('Project default (OpenCode)')
  })
})
