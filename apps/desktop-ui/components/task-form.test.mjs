import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@/lib/api/fetch', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, apiFetch: vi.fn() }
})
vi.mock('@/providers/teams-provider', () => ({ useTeams: () => ({ teams: [] }) }))
vi.mock('@/hooks/use-project', () => ({ useProject: () => ({ activeProject: null }) }))
vi.mock('@/hooks/use-team-members', () => ({ useTeamMembers: () => ({ members: [] }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('@/components/label-picker', () => ({ LabelPicker: () => null }))
vi.mock('@/components/ui/date-picker', () => ({ DatePicker: () => null }))
vi.mock('@/components/task-form-model-selector', () => ({ TaskFormModelSelector: () => null }))
vi.mock('@/components/ui/assignee-picker', () => ({ AssigneePicker: () => null }))
// FE-11 duplicate hints fetch on their own (debounced); not part of the create contract under test.
vi.mock('@/components/similar-issues-hint', () => ({ SimilarIssuesHint: () => null }))

const { apiFetch, ApiError } = await import('@/lib/api/fetch')
const { toast } = await import('sonner')
const { TaskFormDialog } = await import('./task-form.tsx')

function renderForm() {
  const onSuccess = vi.fn()
  const onOpenChange = vi.fn()
  render(createElement(TaskFormDialog, { open: true, onOpenChange, onSuccess, defaultProjectId: 'p1', projects: [] }))
  return { onSuccess, onOpenChange }
}

function submitWithTitle(title) {
  fireEvent.change(screen.getByPlaceholderText('Issue title'), { target: { value: title } })
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
}

const keyOf = (call) => call[1].headers['Idempotency-Key']

describe('TaskFormDialog idempotency (W04a)', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it('reuses the draft key when the same values are submitted again, and changes it when they change', async () => {
    apiFetch.mockRejectedValueOnce(new ApiError(500, 'Internal server error', 'INTERNAL_ERROR'))
    apiFetch.mockRejectedValueOnce(new ApiError(500, 'Internal server error', 'INTERNAL_ERROR'))
    apiFetch.mockResolvedValueOnce({ id: 't9', title: 'Changed title' })
    const { onSuccess } = renderForm()

    submitWithTitle('Write the docs')
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Task' }).hasAttribute('disabled')).toBe(false))
    expect(toast.error).toHaveBeenCalledWith('Internal server error', { description: 'Try again shortly.' })

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Task' }).hasAttribute('disabled')).toBe(false))

    submitWithTitle('Changed title')
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ id: 't9', title: 'Changed title' }))

    const calls = apiFetch.mock.calls
    expect(calls.map((call) => call[0])).toEqual(['/api/tasks', '/api/tasks', '/api/tasks'])
    expect(keyOf(calls[0])).toMatch(/^[0-9a-f-]{36}$/)
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]))
    expect(keyOf(calls[2])).not.toBe(keyOf(calls[0]))
    expect(JSON.parse(calls[2][1].body)).toMatchObject({ title: 'Changed title', projectId: 'p1', status: 'todo' })
  })

  it('shows the mapped conflict message and uses a fresh key next time', async () => {
    apiFetch.mockRejectedValueOnce(new ApiError(409, 'Idempotency-Key was already used with a different request', 'IDEMPOTENCY_CONFLICT'))
    apiFetch.mockResolvedValueOnce({ id: 't10', title: 'Same' })
    renderForm()

    submitWithTitle('Same')
    await waitFor(() => expect(screen.getByText(/already submitted with different details/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    expect(keyOf(apiFetch.mock.calls[1])).not.toBe(keyOf(apiFetch.mock.calls[0]))
  })
})
