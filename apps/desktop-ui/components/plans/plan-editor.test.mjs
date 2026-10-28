import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ revisePlan: null, createPlan: null }))
vi.mock('@/lib/api/plans', async (original) => ({
  ...(await original()),
  revisePlan: (...args) => api.revisePlan(...args),
  createPlan: (...args) => api.createPlan(...args),
}))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

const { NewPlanForm, PlanEditor, draftsToSpec } = await import('./plan-editor.tsx')
const { ApiError } = await import('@/lib/api/fetch.ts')
const { nextPlanTaskKey, planIssuesFromError } = await import('@/lib/api/plans.ts')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => { cleanup(); vi.clearAllMocks() })

const PLAN = {
  id: 'plan-1', projectId: 'p1', title: 'Login', status: 'draft', latestRevision: 1, approvedRevision: null,
  createdAt: '', updatedAt: '', revisions: [],
  revision: {
    number: 1, specHash: 'h', note: null, createdAt: '', approvedAt: null, order: ['api'], errors: [], warnings: [], diff: null,
    spec: { summary: 'Sign in', tasks: [{ key: 'api', title: 'Login endpoint', acceptance: ['401 on bad password'], estimate: 'm' }] },
  },
  tasks: [],
}

function renderEditor(props = {}) {
  const client = createAppQueryClient()
  const onSaved = vi.fn()
  const onCancel = vi.fn()
  render(createElement(QueryClientProvider, { client }, createElement(PlanEditor, { plan: PLAN, onSaved, onCancel, ...props })))
  return { onSaved, onCancel }
}

describe('plan editing (FE-09)', () => {
  it('turns drafts into a spec (trimmed, empty fields dropped, blockers deduplicated) and picks free keys', () => {
    expect(draftsToSpec(' ', [{ key: 'a', title: ' A ', description: '', priority: '', estimate: '', acceptance: 'x\n\n y ', blockedBy: 'b, b ,', isNew: true }]))
      .toEqual({ tasks: [{ key: 'a', title: 'A', acceptance: ['x', 'y'], blockedBy: ['b'] }] })
    expect(nextPlanTaskKey([{ key: 'task-2', title: 'x' }])).toBe('task-3')
    expect(planIssuesFromError(new ApiError(400, 'bad', 'PLAN_INVALID', { issues: [{ code: 'CYCLE', message: 'loop', keys: ['a'] }] }))).toEqual([{ code: 'CYCLE', message: 'loop', keys: ['a'] }])
    expect(planIssuesFromError(new ApiError(400, 'bad', 'VALIDATION_ERROR'))).toEqual([])
  })

  it('edits a task, adds one that waits on it, and saves the next revision from the latest', async () => {
    const next = { ...PLAN, latestRevision: 2, revision: { ...PLAN.revision, number: 2 } }
    api.revisePlan = vi.fn(async () => ({ unchanged: false, plan: next }))
    const { onSaved } = renderEditor()
    const first = screen.getByRole('listitem', { name: 'Task api' })
    fireEvent.change(within(first).getByRole('textbox', { name: 'Title' }), { target: { value: 'Login endpoint v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    const added = screen.getByRole('listitem', { name: 'Task task-2' })
    fireEvent.change(within(added).getByRole('textbox', { name: 'Title' }), { target: { value: 'Login form' } })
    fireEvent.change(within(added).getByRole('textbox', { name: 'Blocked by' }), { target: { value: 'api' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Revision note' }), { target: { value: 'Add the form' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 2' }))
    await waitFor(() => expect(api.revisePlan).toHaveBeenCalledWith('plan-1', {
      baseRevision: 1,
      note: 'Add the form',
      spec: {
        summary: 'Sign in',
        tasks: [
          { key: 'api', title: 'Login endpoint v2', acceptance: ['401 on bad password'], estimate: 'm' },
          { key: 'task-2', title: 'Login form', blockedBy: ['api'] },
        ],
      },
    }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(next))
    expect(toasts.success).toHaveBeenCalledWith('Saved revision 2', expect.anything())
  })

  it('shows the problems the server found instead of saving', async () => {
    api.revisePlan = vi.fn(async () => { throw new ApiError(400, 'The plan has a problem', 'PLAN_INVALID', { issues: [{ code: 'UNKNOWN_BLOCKER', message: 'Blocked by tasks that are not in the plan: api → ghost', keys: ['api'] }] }) })
    const { onSaved } = renderEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'Blocked by' }), { target: { value: 'ghost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 2' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Blocked by tasks that are not in the plan: api → ghost')).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('cannot save a task without a title', () => {
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    expect(screen.getByRole('button', { name: 'Save as revision 2' }).disabled).toBe(true)
  })
})

describe('new plan (FE-09)', () => {
  it('needs a title and a titled task, then creates a draft with one key per form (retries reuse it)', async () => {
    let calls = 0
    api.createPlan = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new ApiError(503, 'down', 'SERVICE_UNAVAILABLE')
      return { ...PLAN, id: 'plan-new' }
    })
    const onCreated = vi.fn()
    const client = createAppQueryClient()
    render(createElement(QueryClientProvider, { client }, createElement(NewPlanForm, { projectId: 'p1', onCreated, onCancel: vi.fn() })))
    const submit = screen.getByRole('button', { name: 'Create draft plan' })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Plan title' }), { target: { value: 'Billing' } })
    expect(submit.disabled).toBe(true)
    const row = screen.getByRole('listitem', { name: 'Task task-1' })
    fireEvent.change(within(row).getByRole('textbox', { name: 'Title' }), { target: { value: 'Invoice table' } })
    fireEvent.click(submit)
    await waitFor(() => expect(api.createPlan).toHaveBeenCalledTimes(1))
    fireEvent.click(submit)
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-new' })))
    const [first, second] = api.createPlan.mock.calls
    expect(first[0]).toBe('p1')
    expect(first[1]).toEqual({ title: 'Billing', spec: { tasks: [{ key: 'task-1', title: 'Invoice table' }] } })
    expect(second[2]).toBe(first[2])
  })
})

