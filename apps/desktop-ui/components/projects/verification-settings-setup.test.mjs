import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * W16a: "Setup before the agent starts" in the project's verification
 * settings — the same rows as checks (command, timeout, required, package
 * registries), saved with the settings, validated locally and by the server.
 */

const api = vi.hoisted(() => ({ fetchSettings: null, saveSettings: null, fetchGitHubApp: null }))

vi.mock('@/lib/api/verification', () => ({
  fetchProjectVerificationSettings: (...args) => api.fetchSettings(...args),
  saveProjectVerificationSettings: (...args) => api.saveSettings(...args),
  fetchProjectGitHubApp: (...args) => api.fetchGitHubApp(...args),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { toDraft, toBody, draftProblems, draftCheck, MAX_SETUP_STEPS } = await import('./verification-settings-model.ts')
const { VerificationSettingsSection } = await import('./verification-settings-section.tsx')
const { ApiError } = await import('@/lib/api/fetch.ts')

const STORED = {
  policy: 'warn',
  autoDetect: false,
  repositoryChecks: true,
  checks: [
    { id: 'unit', name: 'Unit tests', argv: ['/bin/sh', '-c', 'pnpm test'], cwd: '', timeoutMs: 600_000, network: { mode: 'none' }, required: true },
  ],
  setup: [
    { id: 'install', name: 'install', argv: ['/bin/sh', '-c', 'pnpm install --frozen-lockfile'], cwd: '', timeoutMs: 900_000, network: { mode: 'egress', hosts: [], registries: true }, required: true },
    { id: 'codegen', name: 'Generate clients', argv: ['pnpm', 'codegen'], cwd: 'packages/api', timeoutMs: 300_000, network: { mode: 'none' }, required: false },
  ],
}
const view = (settings = STORED) => ({ projectId: 'p1', configured: true, settings, checksHash: 'a'.repeat(64), setupHash: 'b'.repeat(64) })

describe('setup steps in the settings model', () => {
  it('round-trips stored steps like checks: shell lines as run, argument lists kept, registries and required kept', () => {
    const draft = toDraft(STORED)
    expect(draft.setup.map((step) => step.command)).toEqual(['pnpm install --frozen-lockfile', 'pnpm codegen'])
    const body = toBody(draft)
    expect(body.setup).toEqual([
      { id: 'install', name: 'install', run: 'pnpm install --frozen-lockfile', timeoutSeconds: 900, network: 'registries', required: true },
      { id: 'codegen', name: 'Generate clients', command: ['pnpm', 'codegen'], cwd: 'packages/api', timeoutSeconds: 300, network: 'none', required: false },
    ])
    expect(body.checks).toHaveLength(1)
  })

  it('an API without setup yields no steps, and the body then saves an explicit empty list', () => {
    const { setup: _setup, ...older } = STORED
    const draft = toDraft(older)
    expect(draft.setup).toEqual([])
    expect(toBody(draft).setup).toEqual([])
  })

  it('reports setup problems before saving, labelled as setup steps', () => {
    const draft = { ...toDraft(STORED), setup: [{ ...draftCheck(), timeoutSeconds: '99999' }] }
    expect(draftProblems(draft)).toEqual(['Setup step 1 needs a name.', 'Setup step 1 needs a command.', 'Setup step 1: the timeout must be 1–3600 seconds.'])
    const tooMany = { ...toDraft(STORED), setup: Array.from({ length: MAX_SETUP_STEPS + 1 }, () => ({ ...draftCheck(), name: 'x', command: 'true' })) }
    expect(draftProblems(tooMany)).toEqual([`At most ${MAX_SETUP_STEPS} setup steps are allowed.`])
  })
})

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(createElement(QueryClientProvider, { client }, createElement(VerificationSettingsSection, { projectId: 'p1' })))
}

describe('VerificationSettingsSection: setup before the agent starts', () => {
  beforeEach(() => {
    api.fetchSettings = vi.fn(async () => view())
    api.saveSettings = vi.fn(async (_id, body) => view({ ...STORED, policy: body.policy }))
    api.fetchGitHubApp = vi.fn(async () => ({
      projectId: 'p1', repository: null, configured: false, installed: null, suspended: null, installationId: null, account: null,
      repositorySelection: null, missingPermissions: [], installUrl: null, manageUrl: null, fallbackPolicy: 'user_oauth',
    }))
  })
  afterEach(() => cleanup())

  it('shows the stored steps with the check rows, edits and adds steps, and saves them with the settings', async () => {
    renderSection()
    expect(await screen.findByText('Setup before the agent starts')).toBeTruthy()
    expect(screen.getByLabelText('Setup step 1 name').value).toBe('install')
    expect(screen.getByLabelText('Setup step 2 command').value).toBe('pnpm codegen')
    expect(screen.getByText('2/10')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Setup step 1 command'), { target: { value: 'pnpm install --frozen-lockfile --prefer-offline' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add setup step' }))
    fireEvent.change(screen.getByLabelText('Setup step 3 name'), { target: { value: 'Prisma' } })
    fireEvent.change(screen.getByLabelText('Setup step 3 command'), { target: { value: 'pnpm db:generate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Generate clients' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save verification settings' }))

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
    const [projectId, body] = api.saveSettings.mock.calls[0]
    expect(projectId).toBe('p1')
    expect(body.setup).toEqual([
      { id: 'install', name: 'install', run: 'pnpm install --frozen-lockfile --prefer-offline', timeoutSeconds: 900, network: 'registries', required: true },
      { name: 'Prisma', run: 'pnpm db:generate', timeoutSeconds: 600, network: 'none', required: true },
    ])
    // Checks are saved untouched alongside.
    expect(body.checks).toEqual([{ id: 'unit', name: 'Unit tests', run: 'pnpm test', timeoutSeconds: 600, network: 'none', required: true }])
  })

  it('blocks an incomplete step locally and shows the server validation errors for setup', async () => {
    renderSection()
    await screen.findByLabelText('Setup step 1 name')
    fireEvent.click(screen.getByRole('button', { name: 'Add setup step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save verification settings' }))
    expect(await screen.findByText('Setup step 3 needs a name.')).toBeTruthy()
    expect(api.saveSettings).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove setup step 3' }))
    api.saveSettings = vi.fn(async () => {
      throw new ApiError(400, 'Invalid verification settings', 'VALIDATION_ERROR', { errors: ['setup[1].cwd must stay inside the checkout (no absolute path, no "..")'] })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save verification settings' }))
    expect(await screen.findByText(/setup\[1\]\.cwd must stay inside the checkout/)).toBeTruthy()
  })

  it('stops offering more steps at the limit', async () => {
    api.fetchSettings = vi.fn(async () => view({
      ...STORED,
      setup: Array.from({ length: MAX_SETUP_STEPS }, (_, index) => ({ ...STORED.setup[1], id: `s${index}`, name: `Step ${index}` })),
    }))
    renderSection()
    await screen.findByLabelText(`Setup step ${MAX_SETUP_STEPS} name`)
    expect(screen.queryByRole('button', { name: 'Add setup step' })).toBeNull()
  })
})
