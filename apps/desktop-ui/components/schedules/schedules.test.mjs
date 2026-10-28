import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({
  createSchedule: vi.fn(), updateSchedule: vi.fn(), pauseSchedule: vi.fn(), resumeSchedule: vi.fn(), runScheduleNow: vi.fn(), deleteSchedule: vi.fn(),
}))
vi.mock('@/lib/api/schedules', async (original) => ({
  ...(await original()),
  createSchedule: (...args) => api.createSchedule(...args),
  updateSchedule: (...args) => api.updateSchedule(...args),
  pauseSchedule: (...args) => api.pauseSchedule(...args),
  resumeSchedule: (...args) => api.resumeSchedule(...args),
  runScheduleNow: (...args) => api.runScheduleNow(...args),
  deleteSchedule: (...args) => api.deleteSchedule(...args),
}))
vi.mock('@/lib/api/teams', () => ({ fetchTeams: async () => [{ id: 't1', name: 'Core' }] }))
vi.mock('@/lib/api/comments', () => ({ fetchTeamMembers: async () => [{ userId: 'u-ana', user: { username: 'ana' } }, { userId: 'u-bo', user: { username: 'bo' } }] }))
vi.mock('@/lib/query/resources', async (original) => ({
  ...(await original()),
  projectLabelsQuery: (projectId) => ({ queryKey: ['ol', 'project', projectId, 'labels'], queryFn: async () => [{ id: 'l-bug', name: 'bug', color: '#f00', priority: 0 }, { id: 'l-ops', name: 'ops', color: '#0f0', priority: 1 }] }),
}))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

const { ScheduleForm, draftToInput, emptyDraft } = await import('./schedule-form.tsx')
const { ScheduleList } = await import('./schedule-list.tsx')
const { describeCadence, formatLocalDateTime, nextRunText, pauseReasonText, scheduleBody } = await import('@/lib/api/schedules.ts')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => { cleanup(); vi.clearAllMocks() })

function schedule(overrides = {}) {
  return {
    id: 's1', projectId: 'p1', title: 'Weekly triage', description: null, priority: 'medium', labelIds: [], assigneeId: null,
    cadence: 'weekly', weekday: 1, dayOfMonth: null, hour: 9, minute: 0, timezone: 'Europe/Berlin',
    cadenceText: 'Every Monday at 09:00 (Europe/Berlin)', nextRunAt: '2026-11-02T08:00:00.000Z', lastRunAt: null, pausedAt: null, pauseReason: null,
    ownerId: 'u1', createdById: 'u1', createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
    ...overrides,
  }
}

function renderWith(element) {
  const client = createAppQueryClient()
  return render(createElement(QueryClientProvider, { client }, element))
}

describe('recurring issues helpers (FE-14)', () => {
  it('describes cadences, naming the zone only when it is not the device zone', () => {
    expect(describeCadence(schedule(), 'Europe/Berlin')).toBe('Every Monday at 09:00')
    expect(describeCadence(schedule(), 'America/New_York')).toBe('Every Monday at 09:00 (Europe/Berlin)')
    expect(describeCadence(schedule({ cadence: 'weekdays', weekday: null, minute: 5 }), 'UTC')).toBe('Every weekday at 09:05 (Europe/Berlin)')
    expect(describeCadence(schedule({ cadence: 'monthly', weekday: null, dayOfMonth: 3, timezone: 'UTC' }), 'UTC')).toBe('Monthly on the 3rd at 09:00')
  })

  it('shows the next run in local time, or Paused, and explains automatic pauses', () => {
    expect(nextRunText(schedule(), 'Europe/Berlin')).toBe('Next: Mon, Nov 2, 09:00')
    expect(nextRunText(schedule(), 'America/New_York')).toBe('Next: Mon, Nov 2, 03:00')
    expect(nextRunText(schedule({ pausedAt: '2026-10-27T00:00:00.000Z' }))).toBe('Paused')
    expect(pauseReasonText(null)).toBeNull()
    expect(pauseReasonText('owner_lost_access')).toContain('Resuming makes you the owner')
  })

  it('sends only the day field its cadence uses, and parses the form time', () => {
    const base = { title: 'T', description: null, priority: 'low', labelIds: [], assigneeId: null, hour: 9, minute: 0, timezone: 'UTC' }
    expect(scheduleBody({ ...base, cadence: 'daily', weekday: 3, dayOfMonth: 4 })).toEqual({ ...base, cadence: 'daily' })
    expect(scheduleBody({ ...base, cadence: 'weekly', weekday: 3, dayOfMonth: 4 })).toEqual({ ...base, cadence: 'weekly', weekday: 3 })
    expect(draftToInput({ ...emptyDraft('UTC'), title: ' Standup ', cadence: 'monthly', dayOfMonth: 15, time: '07:45' })).toEqual({
      title: 'Standup', description: null, priority: 'medium', labelIds: [], assigneeId: null, cadence: 'monthly', dayOfMonth: 15, hour: 7, minute: 45, timezone: 'UTC',
    })
    expect(draftToInput({ ...emptyDraft('UTC'), title: '' })).toBeNull()
    expect(draftToInput({ ...emptyDraft('UTC'), title: 'x', time: '' })).toBeNull()
  })
})

describe('schedule form (FE-14)', () => {
  it('creates a weekly schedule with labels and an assignee, keyed for retries', async () => {
    api.createSchedule.mockResolvedValue(schedule({ id: 's9' }))
    const onSaved = vi.fn()
    renderWith(createElement(ScheduleForm, { projectId: 'p1', onSaved, onCancel: vi.fn() }))
    const submit = screen.getByRole('button', { name: 'Create schedule' })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: /Issue title/ }), { target: { value: 'Dependency updates {date}' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'weekly' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'On' }), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('At'), { target: { value: '16:30' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Time zone' }), { target: { value: 'UTC' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), { target: { value: 'high' } })
    await waitFor(() => expect(screen.getByRole('option', { name: 'bo' })).toBeTruthy())
    fireEvent.change(screen.getByRole('combobox', { name: 'Assignee' }), { target: { value: 'u-bo' } })
    fireEvent.click(await screen.findByRole('checkbox', { name: /ops/ }))
    expect(screen.getByText(/Every Thursday at 16:30/)).toBeTruthy()
    fireEvent.click(submit)
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalledTimes(1))
    const [projectId, body, key] = api.createSchedule.mock.calls[0]
    expect(projectId).toBe('p1')
    expect(body).toEqual({
      title: 'Dependency updates {date}', description: null, priority: 'high', labelIds: ['l-ops'], assigneeId: 'u-bo',
      cadence: 'weekly', weekday: 4, hour: 16, minute: 30, timezone: 'UTC',
    })
    expect(key).toEqual(expect.any(String))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(toasts.success).toHaveBeenCalledWith('Schedule created', expect.anything())
  })

  it('edits a schedule, dropping a label that no longer exists', async () => {
    api.updateSchedule.mockResolvedValue(schedule({ title: 'Daily triage', cadence: 'daily', weekday: null }))
    renderWith(createElement(ScheduleForm, { projectId: 'p1', schedule: schedule({ labelIds: ['l-bug', 'l-gone'], assigneeId: 'u-ana' }), onSaved: vi.fn(), onCancel: vi.fn() }))
    await screen.findByRole('checkbox', { name: /bug/ })
    fireEvent.change(screen.getByRole('textbox', { name: /Issue title/ }), { target: { value: 'Daily triage' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'daily' } })
    expect(screen.queryByRole('combobox', { name: 'On' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledWith('s1', {
      title: 'Daily triage', description: null, priority: 'medium', labelIds: ['l-bug'], assigneeId: 'u-ana',
      cadence: 'daily', hour: 9, minute: 0, timezone: 'Europe/Berlin',
    }))
    expect(toasts.success).toHaveBeenCalledWith('Schedule saved', expect.anything())
  })
})

describe('schedule list (FE-14)', () => {
  it('shows cadence and next run, and runs, pauses, resumes and deletes (with a confirm)', async () => {
    api.runScheduleNow.mockResolvedValue({ created: true, occurrence: { task: { identifier: 'ENG-7', title: 'Weekly triage' } }, schedule: schedule() })
    api.pauseSchedule.mockResolvedValue(schedule({ pausedAt: '2026-10-27T10:00:00.000Z' }))
    api.resumeSchedule.mockResolvedValue(schedule())
    api.deleteSchedule.mockResolvedValue(undefined)
    const onEdit = vi.fn()
    const paused = schedule({ id: 's2', title: 'Orphaned report', pausedAt: '2026-10-27T10:00:00.000Z', pauseReason: 'owner_lost_access' })
    renderWith(createElement(ScheduleList, { schedules: [schedule(), paused], onEdit }))

    const first = screen.getByRole('listitem', { name: 'Schedule Weekly triage' })
    expect(within(first).getByText(`Next: ${formatLocalDateTime('2026-11-02T08:00:00.000Z')}`)).toBeTruthy()
    const second = screen.getByRole('listitem', { name: 'Schedule Orphaned report' })
    expect(within(second).getByText('Paused')).toBeTruthy()
    expect(within(second).getByText(/its owner can no longer create issues/)).toBeTruthy()

    fireEvent.click(within(first).getByRole('button', { name: 'Create an issue from Weekly triage now' }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Created ENG-7'))
    fireEvent.click(within(first).getByRole('button', { name: 'Pause Weekly triage' }))
    await waitFor(() => expect(api.pauseSchedule).toHaveBeenCalledWith('s1'))
    fireEvent.click(within(second).getByRole('button', { name: 'Resume Orphaned report' }))
    await waitFor(() => expect(api.resumeSchedule).toHaveBeenCalledWith('s2'))
    fireEvent.click(within(first).getByRole('button', { name: 'Edit Weekly triage' }))
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))

    fireEvent.click(within(first).getByRole('button', { name: 'Delete Weekly triage' }))
    expect(api.deleteSchedule).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete schedule' }))
    await waitFor(() => expect(api.deleteSchedule).toHaveBeenCalledWith('s1'))
    expect(toasts.success).toHaveBeenCalledWith('Schedule deleted', { description: 'Issues it already created are kept.' })
  })
})
