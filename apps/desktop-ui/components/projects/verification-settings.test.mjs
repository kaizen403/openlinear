import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchSettings: null, saveSettings: null, fetchGitHubApp: null }))

vi.mock('@/lib/api/verification', () => ({
  fetchProjectVerificationSettings: (...args) => api.fetchSettings(...args),
  saveProjectVerificationSettings: (...args) => api.saveSettings(...args),
  fetchProjectGitHubApp: (...args) => api.fetchGitHubApp(...args),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { toDraft, toBody, draftProblems, draftCheck, serverProblems } = await import('./verification-settings-model.ts')
const { VerificationSettingsSection } = await import('./verification-settings-section.tsx')
const { ApiError } = await import('@/lib/api/fetch.ts')

const STORED = {
  policy: 'require-pass',
  autoDetect: false,
  repositoryChecks: true,
  checks: [
    { id: 'typecheck', name: 'Typecheck', argv: ['/bin/sh', '-c', 'pnpm typecheck'], cwd: '', timeoutMs: 600_000, network: { mode: 'none' }, required: true },
    { id: 'unit', name: 'Unit tests', argv: ['pnpm', 'test', '--', 'a b'], cwd: 'packages/core', timeoutMs: 300_000, network: { mode: 'egress', hosts: ['example.com'], registries: true }, required: false },
  ],
}
const view = (settings = STORED) => ({ projectId: 'p1', configured: true, settings, checksHash: 'a'.repeat(64) })

describe('verification settings model', () => {
  it('round-trips stored checks: shell lines as run, argument lists untouched unless edited, network and cwd kept', () => {
    const draft = toDraft(STORED)
    expect(draft.checks.map((check) => check.command)).toEqual(['pnpm typecheck', 'pnpm test -- "a b"'])
    const body = toBody(draft)
    expect(body.checks[0]).toEqual({ id: 'typecheck', name: 'Typecheck', run: 'pnpm typecheck', timeoutSeconds: 600, network: 'none', required: true })
    expect(body.checks[1]).toEqual({ id: 'unit', name: 'Unit tests', command: ['pnpm', 'test', '--', 'a b'], cwd: 'packages/core', timeoutSeconds: 300, network: { allow: ['example.com'], registries: true }, required: false })

    const edited = { ...draft, checks: [draft.checks[0], { ...draft.checks[1], command: 'pnpm test:unit' }] }
    expect(toBody(edited).checks[1]).toMatchObject({ run: 'pnpm test:unit' })
    expect(toBody(edited).checks[1].command).toBeUndefined()
  })

  it('reports what the server would reject before saving', () => {
    const draft = { policy: 'warn', autoDetect: false, repositoryChecks: true, checks: [{ ...draftCheck(), timeoutSeconds: '0' }], setup: [] }
    expect(draftProblems(draft)).toEqual(['Check 1 needs a name.', 'Check 1 needs a command.', 'Check 1: the timeout must be 1–3600 seconds.'])
    expect(serverProblems({ errors: ['checks[0].cwd must stay inside the checkout', 3] })).toEqual(['checks[0].cwd must stay inside the checkout'])
    expect(serverProblems(null)).toEqual([])
  })
})

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(createElement(QueryClientProvider, { client }, createElement(VerificationSettingsSection, { projectId: 'p1' })))
}

describe('VerificationSettingsSection', () => {
  beforeEach(() => {
    api.fetchSettings = vi.fn(async () => view())
    api.saveSettings = vi.fn(async (_id, body) => view({ ...STORED, policy: body.policy }))
    api.fetchGitHubApp = vi.fn(async () => ({
      projectId: 'p1', repository: 'acme/app', configured: true, installed: false, suspended: null, installationId: null, account: null,
      repositorySelection: null, missingPermissions: [], installUrl: 'https://github.com/apps/openlinear/installations/new', manageUrl: null, fallbackPolicy: 'user_oauth',
    }))
  })
  afterEach(() => cleanup())

  it('loads the stored settings, edits a check and saves the exact body', async () => {
    renderSection()
    const name = await screen.findByLabelText('Check 1 name')
    expect(name.value).toBe('Typecheck')
    expect(screen.getByText(/Publish only when every required check passes/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Check 1 command'), { target: { value: 'pnpm -r typecheck' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save verification settings' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
    const [projectId, body] = api.saveSettings.mock.calls[0]
    expect(projectId).toBe('p1')
    expect(body.policy).toBe('require-pass')
    expect(body.checks[0]).toMatchObject({ name: 'Typecheck', run: 'pnpm -r typecheck' })
    expect(body.checks[1].command).toEqual(['pnpm', 'test', '--', 'a b'])
  })

  it('shows the server validation errors, and turns read-only for non-admins', async () => {
    api.saveSettings = vi.fn(async () => { throw new ApiError(400, 'Invalid verification settings', 'VALIDATION_ERROR', { errors: ['checks[0].cwd must stay inside the checkout (no absolute path, no "..")'] }) })
    renderSection()
    await screen.findByLabelText('Check 1 name')
    fireEvent.click(screen.getByRole('button', { name: 'Save verification settings' }))
    expect(await screen.findByText(/must stay inside the checkout/)).toBeTruthy()

    api.saveSettings = vi.fn(async () => { throw new ApiError(403, 'role required', 'OWNERSHIP_REQUIRED', { requiredRoles: ['owner', 'admin'] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Save verification settings' }))
    expect(await screen.findByText('Only workspace owners and admins can change these settings.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save verification settings' })).toBeNull()
  })

  it('blocks an invalid draft locally and adds checks up to the limit', async () => {
    renderSection()
    await screen.findByLabelText('Check 1 name')
    fireEvent.click(screen.getByRole('button', { name: 'Add check' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save verification settings' }))
    expect(await screen.findByText('Check 3 needs a name.')).toBeTruthy()
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('surfaces the GitHub App install state for the repository', async () => {
    renderSection()
    expect(await screen.findByText(/isn't installed on acme\/app\. Runs use your own GitHub sign-in until it is\./)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
  })
})
