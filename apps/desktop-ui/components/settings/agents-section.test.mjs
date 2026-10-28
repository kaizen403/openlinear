import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchRunnerCatalogue: null, fetchSandboxGrants: null }))
vi.mock('@/lib/api/runners', async (original) => ({ ...(await original()), fetchRunnerCatalogue: (...args) => api.fetchRunnerCatalogue(...args) }))
vi.mock('@/lib/api/sandbox-grants', async (original) => ({ ...(await original()), fetchSandboxGrants: (...args) => api.fetchSandboxGrants(...args) }))

const { AgentsSection, featureSummary, sandboxSummary } = await import('./agents-section.tsx')

const CATALOGUE = {
  engine: 'v2',
  defaultRunner: 'opencode',
  checkedAt: '2026-10-27T10:00:00.000Z',
  sandbox: { mode: 'enforce', verified: true, provider: 'macos-seatbelt', blockers: [] },
  runners: [
    { id: 'opencode', label: 'OpenCode', available: true, executable: true, reason: null, version: '1.2.3', auth: 'ok', features: { resume: 'native-session', approvals: 'policy-only', interrupt: 'server-abort', modelDiscovery: 'live' } },
    { id: 'claude-code', label: 'Claude Code', available: false, executable: false, reason: 'Not signed in to Claude Code on this device', version: '2.0.1', auth: 'missing', features: null },
  ],
}

const GRANTS_VERIFIED = { sandbox: { state: 'verified', provider: 'macos-seatbelt', blockers: [], checkedAt: '2026-10-27T10:00:00.000Z', grantsApply: false }, maxHours: 168, durations: [1, 24, 168], grants: [], audit: [], problem: null }

beforeEach(() => {
  api.fetchSandboxGrants = vi.fn(async () => GRANTS_VERIFIED)
})
afterEach(() => cleanup())

describe('agents section model (FE-15)', () => {
  it('summarizes features in plain words', () => {
    expect(featureSummary(CATALOGUE.runners[0])).toEqual(['Continues sessions in follow-ups', 'Approvals decided by policy', 'Stop via server', 'Lists its models'])
    expect(featureSummary(CATALOGUE.runners[1])).toEqual([])
  })

  it('describes the sandbox state, never as safe when it is not', () => {
    expect(sandboxSummary(CATALOGUE.sandbox)).toMatchObject({ ok: true, title: 'Sandbox verified (macos-seatbelt)' })
    expect(sandboxSummary({ mode: 'enforce', verified: false, provider: null, blockers: ['bwrap missing'] })).toEqual({ ok: false, title: 'Sandbox unavailable', detail: 'bwrap missing' })
    expect(sandboxSummary({ mode: 'trusted-host', verified: null, provider: null, blockers: [] })).toMatchObject({ ok: false, title: 'Trusted-host mode' })
    expect(sandboxSummary({ mode: 'invalid', verified: null, provider: null, blockers: ['Unknown OPENLINEAR_SANDBOX_MODE "x"'] })).toMatchObject({ ok: false, title: 'Sandbox misconfigured' })
  })

  it('FE-03: uses the live sandbox check and tells project grants apart from trusted-host mode', () => {
    const unchecked = { mode: 'enforce', verified: null, provider: null, blockers: [] }
    expect(sandboxSummary(unchecked, GRANTS_VERIFIED)).toMatchObject({ ok: true, title: 'Sandbox verified (macos-seatbelt)' })
    const unavailable = { ...GRANTS_VERIFIED, sandbox: { ...GRANTS_VERIFIED.sandbox, state: 'unavailable', blockers: ['probe denied'], grantsApply: true } }
    expect(sandboxSummary(unchecked, unavailable)).toEqual({ ok: false, title: 'Sandbox unavailable', detail: 'probe denied' })
    // With an active project grant the catalogue reports trusted-host; the headline stays "unavailable".
    expect(sandboxSummary({ mode: 'trusted-host', verified: false, provider: null, blockers: [] }, { ...unavailable, grants: [{ id: 'tg_1' }] }))
      .toEqual({ ok: false, title: 'Sandbox unavailable', detail: 'Runs are refused, except for the projects you allowed below to run without the sandbox.' })
  })
})

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(createElement(QueryClientProvider, { client }, createElement(AgentsSection)))
}

describe('AgentsSection', () => {
  it('lists the runners with versions, sign-in state and the reason one cannot run; re-checks on demand', async () => {
    api.fetchRunnerCatalogue = vi.fn(async () => CATALOGUE)
    renderSection()
    expect(await screen.findByText('Sandbox verified (macos-seatbelt)')).toBeTruthy()
    expect(screen.getByText('v1.2.3')).toBeTruthy()
    expect(screen.getByText('Not signed in')).toBeTruthy()
    expect(screen.getByText('Not signed in to Claude Code on this device')).toBeTruthy()
    expect(screen.getAllByText("Can't run tasks")).toHaveLength(1)
    expect(await screen.findByText("Trust grants aren't needed")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(api.fetchRunnerCatalogue).toHaveBeenCalledWith({ refresh: true }))
    await waitFor(() => expect(api.fetchSandboxGrants.mock.calls.length).toBeGreaterThan(1))
  })

  it('FE-03: an unavailable sandbox blocks runs and offers a project grant', async () => {
    api.fetchRunnerCatalogue = vi.fn(async () => ({ ...CATALOGUE, sandbox: { mode: 'enforce', verified: null, provider: null, blockers: [] } }))
    api.fetchSandboxGrants = vi.fn(async () => ({ ...GRANTS_VERIFIED, sandbox: { state: 'unavailable', provider: null, blockers: ['no sandbox provider for platform win32'], checkedAt: null, grantsApply: true } }))
    renderSection()
    expect(await screen.findByText('No verified sandbox: runs are blocked')).toBeTruthy()
    expect(screen.getByText('Sandbox unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow runs without the sandbox for a project…' })).toBeTruthy()
  })

  it('says so when the execution service is not reachable', async () => {
    api.fetchRunnerCatalogue = vi.fn(async () => { throw new Error('down') })
    renderSection()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
