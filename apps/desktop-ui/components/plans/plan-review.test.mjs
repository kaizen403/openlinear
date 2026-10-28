import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchPlan: null, approvePlan: null, runPlanTasks: null, setup: { ready: true, hasProvider: true, hasModel: true } }))
vi.mock('@/lib/api/plans', async (original) => ({
  ...(await original()),
  fetchPlan: (...args) => api.fetchPlan(...args),
  approvePlan: (...args) => api.approvePlan(...args),
  runPlanTasks: (...args) => api.runPlanTasks(...args),
}))
vi.mock('@/lib/api/opencode', () => ({ getSetupStatus: async () => api.setup }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

const { PlanReview } = await import('./plan-review.tsx')
const { describeApproval, orderedPlanTasks, planRunSelection, planWaves, plansAwaitingReview } = await import('@/lib/api/plans.ts')
const { createAppQueryClient } = await import('@/lib/query/client.ts')
const { maxBatchSizeOf } = await import('@/lib/query/resources.ts')

afterEach(() => { cleanup(); vi.clearAllMocks() })

function planView(overrides = {}) {
  return {
    id: 'plan-1',
    projectId: 'p1',
    title: 'Ship login',
    status: 'draft',
    latestRevision: 2,
    approvedRevision: null,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    revisions: [
      { number: 1, specHash: 'a', note: null, createdAt: '2026-10-27T00:00:00.000Z', createdById: 'u1', approvedAt: null },
      { number: 2, specHash: 'b', note: 'Added the UI', createdAt: '2026-10-27T01:00:00.000Z', createdById: 'u1', approvedAt: null },
    ],
    revision: {
      number: 2,
      spec: {
        summary: 'Users can sign in.',
        tasks: [
          { key: 'ui', title: 'Login form', blockedBy: ['api'] },
          { key: 'api', title: 'Login endpoint', acceptance: ['401 on a bad password'], estimate: 'm', risk: 'high' },
        ],
      },
      specHash: 'b',
      note: 'Added the UI',
      createdAt: '2026-10-27T01:00:00.000Z',
      approvedAt: null,
      order: ['api', 'ui'],
      errors: [],
      warnings: [{ code: 'NO_ACCEPTANCE', message: 'No acceptance checks, so "done" can\'t be verified: ui', keys: ['ui'] }],
      diff: { added: ['ui'], removed: [], changed: [{ key: 'api', fields: ['acceptance'] }] },
    },
    tasks: [],
    ...overrides,
  }
}

function renderReview(props = {}) {
  const client = createAppQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  return render(createElement(QueryClientProvider, { client }, createElement(PlanReview, { planId: 'plan-1', ...props })))
}

const created = (key, id, overrides = {}) => ({ key, id, identifier: `ENG-${id}`, title: key, status: 'todo', archived: false, running: false, ...overrides })

describe('plan helpers (FE-09)', () => {
  it('orders tasks blockers first and summarizes an approval', () => {
    expect(orderedPlanTasks(planView()).map((task) => task.key)).toEqual(['api', 'ui'])
    expect(describeApproval({ alreadyApproved: false, created: [{ key: 'a', taskId: 't', identifier: 'ENG-1' }, { key: 'b', taskId: 'u', identifier: 'ENG-2' }], updated: [], removed: [], skipped: [{ key: 'c', reason: 'deleted' }], dependencies: { added: 1, removed: 0 } }))
      .toBe('Created 2 issues, 1 blocker change, 1 skipped (deleted or moved).')
    expect(describeApproval({ alreadyApproved: true, created: [], updated: [], removed: [], skipped: [], dependencies: { added: 0, removed: 0 } })).toContain('already approved')
  })

  it('counts plans awaiting review', () => {
    const summary = (status, latestRevision, approvedRevision) => ({ id: `${status}${latestRevision}`, title: 't', status, latestRevision, approvedRevision, taskCount: 1, createdTaskCount: 0, doneTaskCount: 0, createdAt: '', updatedAt: '' })
    expect(plansAwaitingReview([summary('draft', 1, null), summary('approved', 2, 2), summary('approved', 3, 2), summary('archived', 2, 1)])).toBe(2)
  })

  it('groups tasks into waves that can run in parallel; loops go last', () => {
    const tasks = [
      { key: 'ui', title: 'UI', blockedBy: ['api'] },
      { key: 'api', title: 'API', blockedBy: ['schema'] },
      { key: 'schema', title: 'Schema' },
      { key: 'docs', title: 'Docs', blockedBy: ['schema'] },
      { key: 'x', title: 'X', blockedBy: ['y'] },
      { key: 'y', title: 'Y', blockedBy: ['x'] },
    ]
    expect(planWaves(tasks).map((wave) => wave.map((task) => task.key))).toEqual([['schema'], ['api', 'docs'], ['ui'], ['x', 'y']])
  })

  it('FE-10: runs unfinished issues blockers first, at most one batch (a closed prefix)', () => {
    const plan = planView({ approvedRevision: 2, tasks: [created('ui', '2'), created('api', '1')] })
    expect(planRunSelection(plan, 3)).toEqual({ taskIds: ['1', '2'], remaining: 0 })
    const partly = planView({ approvedRevision: 2, tasks: [created('ui', '2'), created('api', '1', { status: 'done' })] })
    expect(planRunSelection(partly, 3)).toEqual({ taskIds: ['2'], remaining: 0 })
    const busy = planView({ approvedRevision: 2, tasks: [created('ui', '2'), created('api', '1', { running: true })] })
    expect(planRunSelection(busy, 3).taskIds).toEqual(['2'])
    const many = planView({
      approvedRevision: 1,
      revision: { ...planView().revision, order: Array.from({ length: 25 }, (_, i) => `t${i}`), spec: { tasks: Array.from({ length: 25 }, (_, i) => ({ key: `t${i}`, title: `T${i}` })) } },
      tasks: Array.from({ length: 25 }, (_, i) => created(`t${i}`, String(i))),
    })
    expect(planRunSelection(many, 20)).toEqual({ taskIds: Array.from({ length: 20 }, (_, i) => String(i)), remaining: 5 })
    // The user's batch size (default 3, engine cap 20) bounds a run.
    expect([maxBatchSizeOf(undefined), maxBatchSizeOf({ maxBatchSize: 8 }), maxBatchSizeOf({ maxBatchSize: 50 }), maxBatchSizeOf({ maxBatchSize: 'x' })]).toEqual([3, 8, 20, 3])
    expect(planRunSelection(many, 3)).toEqual({ taskIds: ['0', '1', '2'], remaining: 22 })
  })
})

describe('PlanReview (FE-09)', () => {
  it('shows the tasks in blocker order with checks, estimates, warnings and what changed', async () => {
    api.fetchPlan = vi.fn(async () => planView())
    renderReview()
    await screen.findByRole('list', { name: 'Plan tasks' })
    // Waves: the endpoint has nothing to wait for; the form comes after it.
    expect(screen.getByRole('listitem', { name: 'Wave 1' }).textContent).toContain('Login endpoint')
    expect(screen.getByRole('listitem', { name: 'Wave 2' }).textContent).toContain('Login form')
    expect(screen.getByText('401 on a bad password')).toBeTruthy()
    expect(screen.getByText('M')).toBeTruthy()
    expect(screen.getByText('high risk')).toBeTruthy()
    expect(screen.getByText('new')).toBeTruthy()
    expect(screen.getByText('changed: acceptance')).toBeTruthy()
    expect(screen.getByText(/No acceptance checks, so "done" can't be verified: ui/)).toBeTruthy()
    expect(screen.getByText(/Against revision 1: 1 added, 1 changed, 0 removed/)).toBeTruthy()
  })

  it('approves the latest revision and reports what was created', async () => {
    api.fetchPlan = vi.fn(async () => planView())
    api.approvePlan = vi.fn(async () => ({
      approval: { alreadyApproved: false, created: [{ key: 'api', taskId: 't1', identifier: 'ENG-1' }, { key: 'ui', taskId: 't2', identifier: 'ENG-2' }], updated: [], removed: [], skipped: [], dependencies: { added: 1, removed: 0 } },
      plan: planView({ status: 'approved', approvedRevision: 2, tasks: [{ key: 'api', id: 't1', identifier: 'ENG-1', title: 'Login endpoint', status: 'todo', archived: false }] }),
    }))
    renderReview()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and create issues' }))
    await waitFor(() => expect(api.approvePlan).toHaveBeenCalledWith('plan-1', 2))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Plan approved (revision 2)', { description: 'Created 2 issues, 1 blocker change.' }))
    expect(await screen.findByRole('button', { name: 'Approved' })).toBeTruthy()
    expect(screen.getByText('ENG-1')).toBeTruthy()
  })

  it('blocks approval while the revision has problems', async () => {
    api.fetchPlan = vi.fn(async () => planView({ revision: { ...planView().revision, errors: [{ code: 'CYCLE', message: 'These tasks block each other in a loop: a, b', keys: ['a', 'b'] }] } }))
    renderReview()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve and create issues' }).disabled).toBe(true)
  })

  it('FE-10: "Run plan" asks first, then starts one batch and offers the board', async () => {
    api.fetchPlan = vi.fn(async () => planView({ status: 'approved', approvedRevision: 2, tasks: [created('ui', '2'), created('api', '1')] }))
    api.runPlanTasks = vi.fn(async () => ({ id: 'batch-1' }))
    const onRunStarted = vi.fn()
    renderReview({ onRunStarted })
    fireEvent.click(await screen.findByRole('button', { name: 'Run plan' }))
    expect(screen.getByText('Run 2 issues?')).toBeTruthy()
    expect(api.runPlanTasks).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(api.runPlanTasks).toHaveBeenCalledWith(['1', '2']))
    await waitFor(() => expect(toasts.success).toHaveBeenCalled())
    const [title, options] = toasts.success.mock.calls[0]
    expect(title).toBe('Running 2 issues')
    options.action.onClick()
    expect(onRunStarted).toHaveBeenCalledWith('p1')
  })

  it('FE-10: does not start a plan without a configured model', async () => {
    api.fetchPlan = vi.fn(async () => planView({ status: 'approved', approvedRevision: 2, tasks: [created('api', '1')] }))
    api.runPlanTasks = vi.fn()
    api.setup = { ready: false, hasProvider: true, hasModel: false }
    renderReview()
    fireEvent.click(await screen.findByRole('button', { name: 'Run plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalled())
    expect(toasts.error.mock.calls[0][0]).toContain('Pick a model')
    expect(api.runPlanTasks).not.toHaveBeenCalled()
    api.setup = { ready: true, hasProvider: true, hasModel: true }
  })

  it('edits the latest revision in place (Approve hidden while editing)', async () => {
    api.fetchPlan = vi.fn(async () => planView())
    renderReview()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('form', { name: 'Edit plan' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Edit plan' })).toBeNull()
    expect(screen.getByRole('list', { name: 'Plan tasks' })).toBeTruthy()
  })

  it('offers no approval on an older revision', async () => {
    api.fetchPlan = vi.fn(async (_id, revision) => (revision === 1
      ? planView({ revision: { ...planView().revision, number: 1, diff: null } })
      : planView()))
    renderReview()
    fireEvent.change(await screen.findByRole('combobox', { name: 'Revision' }), { target: { value: '1' } })
    expect(await screen.findByText(/only the latest \(2\) can be approved/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
  })
})
