import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({
  fetchProjectWebhooks: vi.fn(), createProjectWebhook: vi.fn(), updateWebhook: vi.fn(), deleteWebhook: vi.fn(), rotateWebhookSecret: vi.fn(),
  pingWebhook: vi.fn(), fetchWebhookDeliveries: vi.fn(), fetchWebhookDelivery: vi.fn(), redeliverWebhookDelivery: vi.fn(),
  fetchWorkspaceWebhooks: vi.fn(), createWorkspaceWebhook: vi.fn(),
}))
vi.mock('@/lib/api/webhooks', async (original) => {
  const actual = await original()
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, key in api ? (...args) => api[key](...args) : value]))
})
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
const workspaceState = vi.hoisted(() => ({ current: { activeWorkspace: null, workspaces: [], isLoading: false } }))
vi.mock('@/hooks/use-workspace', () => ({ useWorkspace: () => workspaceState.current }))

const { WebhooksSection, WorkspaceWebhooksSection } = await import('./webhooks-section.tsx')
const { WorkspaceWebhooksSettings } = await import('./workspace-webhooks-settings.tsx')
const { draftToWebhookInput, emptyWebhookDraft } = await import('./webhook-form.tsx')
const webhooks = await import('@/lib/api/webhooks.ts')
const { resolveApiTarget } = await import('@/lib/api/routes.ts')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => { cleanup(); vi.clearAllMocks() })

function hook(overrides = {}) {
  return {
    id: 'w1', scope: 'project', projectId: 'p1', workspaceId: null, url: 'https://hooks.example.com/openlinear', urlDisplay: 'https://hooks.example.com/…',
    description: 'CI bridge', eventTypes: ['issue.created', 'run.failed'], secretPrefix: 'whsec_AbCd', previousSecretExpiresAt: null,
    active: true, disabledAt: null, disabledReason: null, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null,
    ownerId: 'u1', createdById: 'u1', createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
    ...overrides,
  }
}

function list(items, canManage = true) {
  return { items, canManage, eventTypes: webhooks.WEBHOOK_EVENT_TYPES, limits: { endpoints: 10, maxAttempts: 6, retryDelaysMs: [60000] } }
}

function delivery(overrides = {}) {
  return {
    id: 'd1', eventId: 'evt_1:issue.created', eventType: 'issue.created', status: 'failed', attempts: 6, maxAttempts: 6, nextAttemptAt: null, inFlight: false,
    lastAttemptAt: '2026-10-27T10:00:00.000Z', lastStatusCode: 500, lastError: 'HTTP 500', lastDurationMs: 12, deliveredAt: null, redeliveries: 0, createdAt: '2026-10-27T09:00:00.000Z',
    ...overrides,
  }
}

function renderSection(element = createElement(WebhooksSection, { projectId: 'p1' })) {
  const client = createAppQueryClient()
  return render(createElement(QueryClientProvider, { client }, element))
}

describe('webhook helpers (FE-14)', () => {
  it('builds the request body only for a sendable draft', () => {
    expect(draftToWebhookInput({ ...emptyWebhookDraft(), url: ' https://example.com/h ', description: '  ' })).toEqual({
      url: 'https://example.com/h', description: null, eventTypes: ['issue.created', 'issue.done', 'run.failed'], format: 'openlinear',
    })
    // A format only takes its receiver's URL; the digest sends its hour and zone.
    expect(draftToWebhookInput({ ...emptyWebhookDraft(), url: 'https://example.com/h', format: 'slack' })).toBeNull()
    expect(draftToWebhookInput({ ...emptyWebhookDraft('Europe/Berlin'), url: 'https://hooks.slack.com/services/T/B/X', format: 'slack', eventTypes: ['digest.daily'], digestHour: 18 })).toEqual({
      url: 'https://hooks.slack.com/services/T/B/X', description: null, eventTypes: ['digest.daily'], format: 'slack', digestHour: 18, digestTimezone: 'Europe/Berlin',
    })
    expect(webhooks.webhookUrlHint('https://discord.com/channels/1', 'discord')).toMatch(/Discord channel webhook URL/)
    expect(webhooks.webhookUrlHint('https://discordapp.com/api/webhooks/1/x', 'discord')).toBeNull()
    expect(webhooks.digestScheduleText(hook({ eventTypes: ['digest.daily'], digestHour: 7, digestTimezone: 'Asia/Tokyo' }))).toBe('Daily digest at 07:00 (Asia/Tokyo)')
    expect(webhooks.digestScheduleText(hook({ digestHour: 7 }))).toBeNull()
    expect(webhooks.webhookFormatOf(hook())).toBe('openlinear')
    expect(webhooks.timeZoneOptions('Mars/Base')[0]).toBe('UTC')
    expect(webhooks.timeZoneOptions('Mars/Base')).toContain('Mars/Base')
    expect(draftToWebhookInput({ ...emptyWebhookDraft(), url: 'http://example.com/h' })).toBeNull()
    expect(draftToWebhookInput({ ...emptyWebhookDraft(), url: 'https://example.com/h', eventTypes: [] })).toBeNull()
    expect(webhooks.webhookUrlHint('https://user:pw@example.com')).toMatch(/user name/)
  })

  it('words delivery states and why a webhook is off', () => {
    const at = (iso) => `at:${iso}`
    expect(webhooks.deliveryStatusText(delivery({ status: 'succeeded' }), at)).toBe('Delivered')
    expect(webhooks.deliveryStatusText(delivery({ status: 'pending', attempts: 2, nextAttemptAt: '2026-10-27T10:05:00.000Z' }), at)).toBe('Retry at at:2026-10-27T10:05:00.000Z')
    expect(webhooks.deliveryStatusText(delivery({ status: 'pending', attempts: 0, nextAttemptAt: '2026-10-27T10:05:00.000Z' }), at)).toBe('Queued')
    expect(webhooks.deliveryStatusText(delivery({ status: 'pending', inFlight: true }), at)).toBe('Sending…')
    expect(webhooks.deliveryStatusText(delivery({ status: 'abandoned' }), at)).toBe('Not sent (webhook off)')
    expect(webhooks.disabledReasonText(hook())).toBeNull()
    expect(webhooks.disabledReasonText(hook({ active: false, disabledReason: 'consecutive_failures' }))).toMatch(/20 failed deliveries/)
    expect(webhooks.disabledReasonText(hook({ active: false, disabledReason: 'owner_lost_access' }))).toMatch(/makes you its owner/)
    expect(webhooks.eventTypeLabel('ping')).toBe('Test ping')
    expect(webhooks.prettyPayload('{"a":1}')).toBe('{\n  "a": 1\n}')
  })

  it('sends every webhook call to the cloud API, never the sidecar', () => {
    for (const path of ['/api/projects/p1/webhooks', '/api/webhooks/w1', '/api/webhooks/w1/ping', '/api/webhooks/w1/rotate-secret', '/api/webhooks/w1/deliveries?limit=20', '/api/webhooks/w1/deliveries/d1/redeliver']) {
      expect(resolveApiTarget(path)).toBe('cloud')
    }
  })
})

describe('webhooks section (FE-14)', () => {
  it('adds a webhook (keyed) and shows the secret once with a copy button', async () => {
    api.fetchProjectWebhooks.mockResolvedValue(list([]))
    api.createProjectWebhook.mockResolvedValue({ ...hook({ id: 'w9' }), secret: 'whsec_supersecretvalue' })
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Add webhook' }))
    const form = screen.getByRole('form', { name: 'Add webhook' })
    const submit = within(form).getByRole('button', { name: 'Add webhook' })
    fireEvent.change(within(form).getByLabelText('Payload URL'), { target: { value: 'http://example.com/hook' } })
    expect(within(form).getByRole('alert').textContent).toMatch(/https:\/\//)
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(form).getByLabelText('Payload URL'), { target: { value: 'https://example.com/hook' } })
    fireEvent.change(within(form).getByLabelText('Description (optional)'), { target: { value: 'Deploy bot' } })
    fireEvent.click(within(form).getByRole('checkbox', { name: /Issue done/ }))
    fireEvent.click(within(form).getByRole('checkbox', { name: /Plan approved/ }))
    fireEvent.click(submit)
    await waitFor(() => expect(api.createProjectWebhook).toHaveBeenCalledTimes(1))
    const [projectId, body, key] = api.createProjectWebhook.mock.calls[0]
    expect(projectId).toBe('p1')
    expect(body).toEqual({ url: 'https://example.com/hook', description: 'Deploy bot', eventTypes: ['issue.created', 'run.failed', 'plan.approved'], format: 'openlinear' })
    expect(key).toEqual(expect.any(String))

    const notice = await screen.findByRole('region', { name: 'Signing secret' })
    expect(within(notice).getByLabelText('Secret value').value).toBe('whsec_supersecretvalue')
    fireEvent.click(within(notice).getByRole('button', { name: 'Copy secret' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('whsec_supersecretvalue'))
    fireEvent.click(within(notice).getByRole('button', { name: "I've saved it" }))
    expect(screen.queryByRole('region', { name: 'Signing secret' })).toBeNull()
  })

  it('shows a refused URL from the server inline', async () => {
    api.fetchProjectWebhooks.mockResolvedValue(list([]))
    const { ApiError } = await import('@/lib/api/fetch.ts')
    api.createProjectWebhook.mockRejectedValue(new ApiError(400, 'The URL points at a private, loopback, link-local or reserved address', 'WEBHOOK_URL_INVALID', { field: 'url', reason: 'forbidden_address' }))
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Add webhook' }))
    const form = screen.getByRole('form', { name: 'Add webhook' })
    fireEvent.change(within(form).getByLabelText('Payload URL'), { target: { value: 'https://10.0.0.1/hook' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add webhook' }))
    expect((await within(form).findByRole('alert')).textContent).toMatch(/private, loopback.*public HTTPS addresses/)
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('pings, turns off, rotates (with a confirm) and deletes (with a confirm)', async () => {
    api.fetchProjectWebhooks.mockResolvedValue(list([hook()]))
    api.pingWebhook.mockResolvedValue({ ...delivery({ id: 'd-ping', eventType: 'ping', status: 'succeeded', attempts: 1, maxAttempts: 1, lastStatusCode: 200, lastDurationMs: 42 }), payload: '{}', lastResponseExcerpt: 'ok' })
    api.updateWebhook.mockResolvedValue(hook({ active: false, disabledAt: '2026-10-27T10:00:00.000Z', disabledReason: 'manual' }))
    api.rotateWebhookSecret.mockResolvedValue({ ...hook({ secretPrefix: 'whsec_Zz99' }), secret: 'whsec_rotatedvalue' })
    api.deleteWebhook.mockResolvedValue(undefined)
    renderSection()
    const row = await screen.findByRole('listitem', { name: 'Webhook CI bridge' })
    expect(within(row).getByText('https://hooks.example.com/openlinear')).toBeTruthy()
    expect(within(row).getByText(/Issue created, Agent run failed · secret whsec_AbCd…/)).toBeTruthy()

    fireEvent.click(within(row).getByRole('button', { name: 'Send a test ping to CI bridge' }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Test ping delivered (200, 42 ms)'))

    fireEvent.click(within(row).getByRole('switch', { name: 'Send events to CI bridge' }))
    await waitFor(() => expect(api.updateWebhook).toHaveBeenCalledWith('w1', { active: false }))
    expect(toasts.success).toHaveBeenCalledWith('Webhook turned off', undefined)

    fireEvent.click(within(row).getByRole('button', { name: 'Rotate the secret of CI bridge' }))
    expect(api.rotateWebhookSecret).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate secret' }))
    await waitFor(() => expect(api.rotateWebhookSecret).toHaveBeenCalledWith('w1'))
    const notice = await screen.findByRole('region', { name: 'Signing secret' })
    expect(within(notice).getByText('New signing secret')).toBeTruthy()
    expect(within(notice).getByLabelText('Secret value').value).toBe('whsec_rotatedvalue')

    fireEvent.click(within(row).getByRole('button', { name: 'Delete CI bridge' }))
    expect(api.deleteWebhook).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete webhook' }))
    await waitFor(() => expect(api.deleteWebhook).toHaveBeenCalledWith('w1'))
    expect(toasts.success).toHaveBeenCalledWith('Webhook deleted')
  })

  it('edits a webhook without resending what did not change', async () => {
    api.fetchProjectWebhooks.mockResolvedValue(list([hook()]))
    api.updateWebhook.mockResolvedValue(hook({ eventTypes: ['issue.created'] }))
    renderSection()
    const row = await screen.findByRole('listitem', { name: 'Webhook CI bridge' })
    fireEvent.click(within(row).getByRole('button', { name: 'Edit CI bridge' }))
    const form = screen.getByRole('form', { name: 'Edit webhook' })
    expect(within(form).getByLabelText('Payload URL').value).toBe('https://hooks.example.com/openlinear')
    fireEvent.click(within(form).getByRole('checkbox', { name: /Agent run failed/ }))
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.updateWebhook).toHaveBeenCalledWith('w1', { url: 'https://hooks.example.com/openlinear', description: 'CI bridge', eventTypes: ['issue.created'], format: 'openlinear' }))
    expect(toasts.success).toHaveBeenCalledWith('Webhook saved')
  })

  it('lists deliveries with status, response and attempts, shows the body, and redelivers', async () => {
    api.fetchProjectWebhooks.mockResolvedValue(list([hook()]))
    api.fetchWebhookDeliveries.mockImplementation(async (_id, options) => (options.cursor === 'c2'
      ? { items: [delivery({ id: 'd4', status: 'succeeded', attempts: 1, lastStatusCode: 200, lastError: null })], nextCursor: null }
      : options.status === 'failed' ? { items: [delivery()], nextCursor: null } : {
      items: [
        delivery(),
        delivery({ id: 'd2', eventType: 'run.failed', status: 'pending', attempts: 2, nextAttemptAt: '2026-10-27T10:35:00.000Z', lastStatusCode: 502 }),
        delivery({ id: 'd3', status: 'succeeded', attempts: 1, lastStatusCode: 200, lastError: null }),
      ],
      nextCursor: 'c2',
    }))
    api.fetchWebhookDelivery.mockResolvedValue({ ...delivery(), payload: '{"id":"d1","type":"issue.created"}', lastResponseExcerpt: 'Internal error' })
    api.redeliverWebhookDelivery.mockResolvedValue({ ...delivery({ status: 'succeeded', attempts: 1, lastStatusCode: 200, redeliveries: 1 }), payload: '{}', lastResponseExcerpt: 'ok' })
    renderSection()
    const row = await screen.findByRole('listitem', { name: 'Webhook CI bridge' })
    fireEvent.click(within(row).getByRole('button', { name: 'Deliveries of CI bridge' }))
    const table = await within(row).findByRole('table', { name: 'Deliveries' })
    expect(api.fetchWebhookDeliveries).toHaveBeenCalledWith('w1', { cursor: null, limit: 20 })
    const failed = within(table).getAllByRole('row', { name: 'Delivery Issue created' })[0]
    expect(within(failed).getByText('Failed')).toBeTruthy()
    expect(within(failed).getByText('500')).toBeTruthy()
    expect(within(failed).getByText('6/6')).toBeTruthy()
    const retrying = within(table).getByRole('row', { name: 'Delivery Agent run failed' })
    expect(within(retrying).getByText(`Retry at ${webhooks.formatTime('2026-10-27T10:35:00.000Z')}`)).toBeTruthy()
    expect(within(retrying).getByText('2/6')).toBeTruthy()

    fireEvent.click(within(failed).getByRole('button', { name: 'Show the body of Issue created' }))
    expect((await screen.findByLabelText('Request body')).textContent).toBe('{\n  "id": "d1",\n  "type": "issue.created"\n}')
    expect(screen.getByLabelText('Last response').textContent).toMatch(/Internal error/)

    fireEvent.click(within(failed).getByRole('button', { name: 'Redeliver Issue created' }))
    await waitFor(() => expect(api.redeliverWebhookDelivery).toHaveBeenCalledWith('w1', 'd1'))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Redelivered (200)'))

    fireEvent.click(within(row).getByRole('button', { name: 'Load older deliveries' }))
    await waitFor(() => expect(api.fetchWebhookDeliveries).toHaveBeenCalledWith('w1', { cursor: 'c2', limit: 20 }))
    await waitFor(() => expect(within(table).getAllByRole('row', { name: 'Delivery Issue created' })).toHaveLength(3))
    expect(within(row).queryByRole('button', { name: 'Load older deliveries' })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Failed' }))
    await waitFor(() => expect(api.fetchWebhookDeliveries).toHaveBeenCalledWith('w1', { cursor: null, limit: 20, status: 'failed' }))
  })

  it('is read-only for people who cannot manage webhooks, and explains automatic shut-offs', async () => {
    api.fetchProjectWebhooks.mockResolvedValue(list([hook({ url: null, description: null, active: false, disabledAt: '2026-10-27T10:00:00.000Z', disabledReason: 'consecutive_failures' })], false))
    api.fetchWebhookDeliveries.mockResolvedValue({ items: [delivery()], nextCursor: null })
    renderSection()
    const row = await screen.findByRole('listitem', { name: 'Webhook https://hooks.example.com/…' })
    expect(within(row).getByRole('note').textContent).toMatch(/20 failed deliveries/)
    expect(screen.queryByRole('button', { name: 'Add webhook' })).toBeNull()
    expect(within(row).queryByRole('switch')).toBeNull()
    expect(within(row).queryByRole('button', { name: /Test ping|Edit|Rotate|Delete/ })).toBeNull()
    expect(screen.getByText(/Only workspace owners and admins can change webhooks/)).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Deliveries of https://hooks.example.com/…' }))
    const table = await within(row).findByRole('table', { name: 'Deliveries' })
    expect(within(table).queryByRole('button', { name: /Redeliver/ })).toBeNull()
  })
})

describe('webhook formats and the daily digest (FE-14 follow-up)', () => {
  it('adds a Slack webhook with a daily digest at a chosen hour and zone, and says Slack ignores the secret', async () => {
    api.fetchProjectWebhooks.mockResolvedValue(list([]))
    api.createProjectWebhook.mockResolvedValue({ ...hook({ id: 'w7', format: 'slack' }), secret: 'whsec_slackvalue' })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Add webhook' }))
    const form = screen.getByRole('form', { name: 'Add webhook' })
    fireEvent.click(within(form).getByRole('radio', { name: /Slack/ }))
    const url = within(form).getByLabelText('Slack webhook URL')
    expect(url.getAttribute('placeholder')).toBe('https://hooks.slack.com/services/…')
    fireEvent.change(url, { target: { value: 'https://example.com/hook' } })
    expect(within(form).getByRole('alert').textContent).toMatch(/Slack incoming webhook URL/)
    fireEvent.change(url, { target: { value: 'https://hooks.slack.com/services/T/B/X' } })
    expect(within(form).queryByLabelText('Send at')).toBeNull()
    fireEvent.click(within(form).getByRole('checkbox', { name: /Daily digest/ }))
    fireEvent.change(within(form).getByLabelText('Send at'), { target: { value: '18' } })
    fireEvent.change(within(form).getByLabelText('Time zone'), { target: { value: 'Europe/Berlin' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add webhook' }))
    await waitFor(() => expect(api.createProjectWebhook).toHaveBeenCalledTimes(1))
    expect(api.createProjectWebhook.mock.calls[0][1]).toEqual({
      url: 'https://hooks.slack.com/services/T/B/X', description: null, eventTypes: ['issue.created', 'issue.done', 'run.failed', 'digest.daily'],
      format: 'slack', digestHour: 18, digestTimezone: 'Europe/Berlin',
    })
    const notice = await screen.findByRole('region', { name: 'Signing secret' })
    expect(within(notice).getByRole('note').textContent).toMatch(/Slack doesn't check signatures/)
  })

  it('shows the format and the digest time of a webhook', async () => {
    api.fetchProjectWebhooks.mockResolvedValue(list([hook({ format: 'discord', eventTypes: ['digest.daily'], digestHour: 9, digestTimezone: 'Europe/Berlin', digestNextAt: '2026-10-28T08:00:00.000Z' })]))
    renderSection()
    const row = await screen.findByRole('listitem', { name: 'Webhook CI bridge' })
    expect(within(row).getByText('Discord')).toBeTruthy()
    expect(within(row).getByText(`Daily digest at 09:00 (Europe/Berlin) · next ${webhooks.formatTime('2026-10-28T08:00:00.000Z')}`)).toBeTruthy()
  })

  it('manages workspace webhooks with the same components', async () => {
    api.fetchWorkspaceWebhooks.mockResolvedValue(list([]))
    api.createWorkspaceWebhook.mockResolvedValue({ ...hook({ id: 'w8', scope: 'workspace', projectId: null, workspaceId: 'ws1' }), secret: 'whsec_wsvalue' })
    renderSection(createElement(WorkspaceWebhooksSection, { workspaceId: 'ws1' }))
    expect(await screen.findByRole('heading', { name: 'Workspace webhooks' })).toBeTruthy()
    expect(screen.getByText(/every project in this workspace/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Add webhook' }))
    const form = screen.getByRole('form', { name: 'Add webhook' })
    fireEvent.change(within(form).getByLabelText('Payload URL'), { target: { value: 'https://example.com/all' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add webhook' }))
    await waitFor(() => expect(api.createWorkspaceWebhook).toHaveBeenCalledWith('ws1', expect.objectContaining({ url: 'https://example.com/all', format: 'openlinear' }), expect.any(String)))
    expect(api.createProjectWebhook).not.toHaveBeenCalled()
    expect(api.fetchWorkspaceWebhooks).toHaveBeenCalledWith('ws1')
    expect(resolveApiTarget('/api/workspaces/ws1/webhooks')).toBe('cloud')
  })

  it('opens Settings → Webhooks on the active workspace and switches workspaces', async () => {
    workspaceState.current = {
      activeWorkspace: { id: 'ws1', name: 'Acme' },
      workspaces: [{ id: 'ws1', name: 'Acme' }, { id: 'ws2', name: 'Side project' }],
      isLoading: false,
    }
    api.fetchWorkspaceWebhooks.mockImplementation(async (id) => list(id === 'ws2' ? [hook({ id: 'w2', scope: 'workspace', projectId: null, workspaceId: 'ws2', description: 'Side hook' })] : []))
    renderSection(createElement(WorkspaceWebhooksSettings))
    await waitFor(() => expect(api.fetchWorkspaceWebhooks).toHaveBeenCalledWith('ws1'))
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws2' } })
    expect(await screen.findByRole('listitem', { name: 'Webhook Side hook' })).toBeTruthy()
    expect(api.fetchWorkspaceWebhooks).toHaveBeenCalledWith('ws2')
  })
})
