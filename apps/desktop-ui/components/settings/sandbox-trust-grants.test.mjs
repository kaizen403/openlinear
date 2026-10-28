import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchSandboxGrants: null, createSandboxGrant: null, revokeSandboxGrant: null, fetchProjects: null }))
vi.mock('@/lib/api/sandbox-grants', async (original) => ({
  ...(await original()),
  fetchSandboxGrants: (...args) => api.fetchSandboxGrants(...args),
  createSandboxGrant: (...args) => api.createSandboxGrant(...args),
  revokeSandboxGrant: (...args) => api.revokeSandboxGrant(...args),
}))
vi.mock('@/lib/api', async (original) => ({ ...(await original()), fetchProjects: (...args) => api.fetchProjects(...args) }))

const { ApiError } = await import('@/lib/api/fetch')
const { toast } = await import('sonner')
const { SandboxTrustGrantsCard, auditLine, draftProblems, grantIntro, timeLeft } = await import('./sandbox-trust-grants.tsx')

const NOW = Date.parse('2026-10-27T10:00:00.000Z')
const UNAVAILABLE = { state: 'unavailable', provider: 'macos-seatbelt', blockers: ['sandbox-exec: probe denied'], checkedAt: '2026-10-27T09:59:00.000Z', grantsApply: true }
const VERIFIED = { state: 'verified', provider: 'macos-seatbelt', blockers: [], checkedAt: '2026-10-27T09:59:00.000Z', grantsApply: false }

const GRANT = {
  id: 'tg_0123456789abcdef',
  projectId: 'p2',
  projectName: 'Beta',
  reason: 'Reviewed repository, sandbox broken by the OS update',
  paths: ['/repos/worktrees', '/repos/verify'],
  createdAt: '2026-10-27T09:00:00.000Z',
  expiresAt: '2026-10-28T09:00:00.000Z',
  revokedAt: null,
  lastUsedAt: '2026-10-27T09:30:00.000Z',
  useCount: 2,
}

const AUDIT = [
  { id: 'a2', at: '2026-10-27T09:30:00.000Z', event: 'used', grantId: GRANT.id, projectId: 'p2', projectName: 'Beta', actor: 'u1', runId: 'run-12345678-abcd', kind: 'agent', path: '/repos/worktrees/run-12345678-abcd' },
  { id: 'a1', at: '2026-10-27T09:00:00.000Z', event: 'created', grantId: GRANT.id, projectId: 'p2', projectName: 'Beta', actor: 'u1', runId: null, kind: null, path: null },
]

function response(overrides = {}) {
  return { sandbox: UNAVAILABLE, maxHours: 168, durations: [1, 24, 168], grants: [], audit: [], problem: null, ...overrides }
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(createElement(QueryClientProvider, { client }, createElement(SandboxTrustGrantsCard, { now: NOW })))
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchProjects = vi.fn(async () => [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }])
})
afterEach(() => cleanup())

describe('trust grant model (FE-03)', () => {
  it('only offers grants while the sandbox is unavailable', () => {
    expect(grantIntro(UNAVAILABLE)).toMatchObject({ canCreate: true, tone: 'warning', title: 'No verified sandbox: runs are blocked' })
    expect(grantIntro(VERIFIED)).toMatchObject({ canCreate: false, title: "Trust grants aren't needed" })
    for (const state of ['unknown', 'env-grant', 'disabled', 'invalid']) {
      expect(grantIntro({ ...UNAVAILABLE, state }).canCreate, state).toBe(false)
    }
  })

  it('requires a project, a 10–500 character reason, a listed duration and the confirmation', () => {
    expect(draftProblems({ projectId: '', reason: 'short', hours: 2, confirmed: false })).toEqual([
      'Choose a project.',
      'Give a reason of at least 10 characters.',
      'Choose how long the grant lasts.',
      "Confirm that runs of this project won't be isolated.",
    ])
    expect(draftProblems({ projectId: 'p1', reason: 'x'.repeat(501), hours: 24, confirmed: true })).toEqual(['Keep the reason under 500 characters.'])
    expect(draftProblems({ projectId: 'p1', reason: 'A reviewed repository', hours: 168, confirmed: true })).toEqual([])
  })

  it('formats time left and audit lines', () => {
    expect(timeLeft('2026-10-27T10:30:00.000Z', NOW)).toBe('in 30 min')
    expect(timeLeft('2026-10-27T09:00:00.000Z', NOW)).toBe('in 1 min')
    expect(timeLeft('2026-10-28T09:00:00.000Z', NOW)).toBe('in 23 h')
    expect(timeLeft('2026-11-03T10:00:00.000Z', NOW)).toBe('in 7 days')
    expect(auditLine(AUDIT[0])).toBe('Used for an agent run (run run-1234) · Beta')
    expect(auditLine({ ...AUDIT[0], kind: 'verification', runId: null, projectName: null })).toBe('Used for verification checks · p2')
    expect(auditLine(AUDIT[1])).toBe('Allowed · Beta')
    expect(auditLine({ ...AUDIT[1], event: 'expired' })).toBe('Expired · Beta')
  })
})

describe('SandboxTrustGrantsCard', () => {
  it('when the sandbox is unavailable: explains it, lists grants with expiry and Revoke, and shows recent activity', async () => {
    api.fetchSandboxGrants = vi.fn(async () => response({ grants: [GRANT], audit: AUDIT }))
    api.revokeSandboxGrant = vi.fn(async () => ({ ...GRANT, revokedAt: '2026-10-27T10:00:00.000Z' }))
    renderCard()
    expect(await screen.findByText('No verified sandbox: runs are blocked')).toBeTruthy()
    expect(screen.getByText('Why: sandbox-exec: probe denied')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText(/Expires in 23 h/)).toBeTruthy()
    expect(screen.getByText(/used 2 times/)).toBeTruthy()
    const activity = screen.getByRole('list', { name: 'Trust grant activity' })
    expect(within(activity).getByText('Used for an agent run (run run-1234) · Beta')).toBeTruthy()
    expect(within(activity).getByText('Allowed · Beta')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke the grant for Beta' }))
    await waitFor(() => expect(api.revokeSandboxGrant).toHaveBeenCalledWith(GRANT.id))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Revoked: Beta runs need the sandbox again; runs it started are being stopped'))
  })

  it('allows a project without the sandbox only after a reason, a duration and an explicit confirmation', async () => {
    api.fetchSandboxGrants = vi.fn(async () => response({ grants: [GRANT] }))
    api.createSandboxGrant = vi.fn(async (input) => ({ ...GRANT, id: 'tg_fedcba9876543210', projectId: input.projectId, projectName: input.projectName, expiresAt: '2026-11-03T10:00:00.000Z' }))
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'Allow runs without the sandbox for a project…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('The agent will run with your own permissions.')).toBeTruthy()
    const select = within(dialog).getByLabelText('Project')
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Alpha' })).toBeTruthy())
    // A project that already has a grant is not offered again.
    expect(within(select).queryByRole('option', { name: 'Beta' })).toBeNull()

    const allow = within(dialog).getByRole('button', { name: 'Allow without sandbox' })
    expect(allow.disabled).toBe(true)
    fireEvent.click(within(dialog).getByLabelText('I understand that runs of this project will not be isolated.'))
    fireEvent.click(allow)
    expect(within(dialog).getByRole('alert').textContent).toMatch(/Choose a project\.Give a reason of at least 10 characters\./)
    expect(api.createSandboxGrant).not.toHaveBeenCalled()

    fireEvent.change(select, { target: { value: 'p1' } })
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: '  Local fixture repo; sandbox broken  ' } })
    fireEvent.click(within(dialog).getByLabelText('7 days'))
    fireEvent.click(allow)
    await waitFor(() => expect(api.createSandboxGrant).toHaveBeenCalledWith({ projectId: 'p1', projectName: 'Alpha', reason: 'Local fixture repo; sandbox broken', hours: 168 }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast.success).toHaveBeenCalledWith('Alpha can run without the sandbox for 7 days')
    await waitFor(() => expect(api.fetchSandboxGrants.mock.calls.length).toBeGreaterThan(1))
  })

  it('shows the server\'s refusal in the dialog', async () => {
    api.fetchSandboxGrants = vi.fn(async () => response())
    api.createSandboxGrant = vi.fn(async () => {
      throw new ApiError(409, 'The sandbox is verified on this device, so runs are isolated and no trust grant is needed', 'TRUST_GRANT_NOT_NEEDED')
    })
    renderCard()
    expect(await screen.findByText('No project may run without the sandbox.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow runs without the sandbox for a project…' }))
    const dialog = await screen.findByRole('dialog')
    const select = within(dialog).getByLabelText('Project')
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Beta' })).toBeTruthy())
    fireEvent.change(select, { target: { value: 'p2' } })
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Reviewed repository only' } })
    fireEvent.click(within(dialog).getByLabelText('I understand that runs of this project will not be isolated.'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow without sandbox' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/no trust grant is needed/))
  })

  it('with a verified sandbox: says grants are not needed, offers none, and still lists existing ones with Revoke', async () => {
    api.fetchSandboxGrants = vi.fn(async () => response({ sandbox: VERIFIED, grants: [GRANT] }))
    renderCard()
    expect(await screen.findByText("Trust grants aren't needed")).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow runs without the sandbox for a project…' })).toBeNull()
    expect(screen.getByText('Existing grants (not used while the sandbox works)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Revoke the grant for Beta' })).toBeTruthy()
  })

  it('reports a grants store the sidecar ignored, and an unreachable sidecar', async () => {
    api.fetchSandboxGrants = vi.fn(async () => response({ problem: 'the trust grants file is accessible to other users' }))
    renderCard()
    expect(await screen.findByText('Stored grants are ignored: the trust grants file is accessible to other users.')).toBeTruthy()
    cleanup()
    api.fetchSandboxGrants = vi.fn(async () => { throw new Error('down') })
    renderCard()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
