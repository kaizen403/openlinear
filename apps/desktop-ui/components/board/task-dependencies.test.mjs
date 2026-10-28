import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchTaskDependencies: null, addTaskBlocker: null, removeTaskBlocker: null, searchBlockerCandidates: null }))
vi.mock('@/lib/api/task-dependencies', async (original) => ({
  ...(await original()),
  fetchTaskDependencies: (...args) => api.fetchTaskDependencies(...args),
  addTaskBlocker: (...args) => api.addTaskBlocker(...args),
  removeTaskBlocker: (...args) => api.removeTaskBlocker(...args),
  searchBlockerCandidates: (...args) => api.searchBlockerCandidates(...args),
}))

const { isTaskBlocked, blockedTaskIdsOf, blockerSummary, readyToRun } = await import('./blocked.ts')
const { TaskDependenciesSection } = await import('./task-dependencies.tsx')
const { applyDependencyChange } = await import('@/lib/query/task-cache.ts')
const { applySseEventToCache, createBridgeState } = await import('@/lib/query/sse-bridge.ts')
const { createAppQueryClient } = await import('@/lib/query/client.ts')
const { boardTaskScope, queryKeys } = await import('@/lib/query/keys.ts')

// cmdk (the blocker picker) measures its list.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
Element.prototype.scrollIntoView ??= function scrollIntoView() {}

afterEach(() => cleanup())

const row = (id, overrides = {}) => ({ id, status: 'todo', blockedByIds: [], openBlockerCount: 0, ...overrides })

describe('W17a blocked state on the board', () => {
  it('judges blockers on the board by their live status, others by the server count; only open work is blocked', () => {
    const tasks = new Map([['a', row('a')], ['done', row('done', { status: 'done' })]])
    const lookup = (id) => tasks.get(id)
    expect(isTaskBlocked(row('x', { blockedByIds: ['a'], openBlockerCount: 1 }), lookup)).toBe(true)
    expect(isTaskBlocked(row('x', { blockedByIds: ['done'], openBlockerCount: 1 }), lookup)).toBe(false)
    expect(isTaskBlocked(row('x', { blockedByIds: ['elsewhere'], openBlockerCount: 1 }), lookup)).toBe(true)
    expect(isTaskBlocked(row('x', { blockedByIds: ['elsewhere'], openBlockerCount: 0 }), lookup)).toBe(false)
    expect(isTaskBlocked(row('x', { status: 'done', blockedByIds: ['a'], openBlockerCount: 1 }), lookup)).toBe(false)
    expect(isTaskBlocked(row('x'), lookup)).toBe(false)
    const list = [row('a'), row('b', { blockedByIds: ['a'], openBlockerCount: 1 })]
    expect([...blockedTaskIdsOf(list, new Map(list.map((task) => [task.id, task])))]).toEqual(['b'])
    const byId = new Map([['a', { ...row('a'), identifier: 'ENG-1' }], ['c', { ...row('c'), identifier: 'ENG-3' }], ['d', { ...row('d', { status: 'done' }), identifier: 'ENG-4' }]])
    expect(blockerSummary(row('x', { blockedByIds: ['a', 'c', 'd'], openBlockerCount: 2 }), byId)).toBe('ENG-1, ENG-3')
    expect(blockerSummary(row('x', { blockedByIds: ['a', 'elsewhere'], openBlockerCount: 2 }), byId)).toBe('ENG-1 and 1 more')
    expect(blockerSummary(row('x', { blockedByIds: [], openBlockerCount: 0 }), byId)).toBeNull()
    // Run ready: open, unblocked, not running; high priority first, then oldest; within the batch size.
    const task = (id, extra) => ({ ...row(id), priority: 'medium', createdAt: '2026-10-01T00:00:00Z', sessionId: null, archived: false, ...extra })
    const candidates = [
      task('old-medium', { createdAt: '2026-09-01T00:00:00Z' }),
      task('high', { priority: 'high' }),
      task('blocked', { priority: 'high' }),
      task('running', { status: 'in_progress', sessionId: 'ses' }),
      task('staged', { status: 'in_progress', priority: 'low' }),
      task('done', { status: 'done', priority: 'high' }),
      task('medium'),
    ]
    expect(readyToRun(candidates, new Set(['blocked']), 3).map((t) => t.id)).toEqual(['high', 'old-medium', 'medium'])
    expect(readyToRun(candidates, new Set(['blocked']), 10).map((t) => t.id)).toEqual(['high', 'old-medium', 'medium', 'staged'])
  })

  it('applies task:dependencies to cached lists (idempotent) and refreshes both tasks\' dependency queries', async () => {
    const list = [row('a'), row('b'), row('c', { status: 'done' })]
    const added = applyDependencyChange(list, { taskId: 'b', dependsOnTaskId: 'a', kind: 'added' }).next
    expect(added[1]).toMatchObject({ blockedByIds: ['a'], openBlockerCount: 1 })
    expect(applyDependencyChange(added, { taskId: 'b', dependsOnTaskId: 'a', kind: 'added' }).next).toBe(added)
    const doneBlocker = applyDependencyChange(added, { taskId: 'b', dependsOnTaskId: 'c', kind: 'added' }).next
    expect(doneBlocker[1]).toMatchObject({ blockedByIds: ['a', 'c'], openBlockerCount: 1 })
    expect(applyDependencyChange(doneBlocker, { taskId: 'b', dependsOnTaskId: 'a', kind: 'removed' }).next[1]).toMatchObject({ blockedByIds: ['c'], openBlockerCount: 0 })

    const client = createAppQueryClient()
    const state = createBridgeState(client, { windowMs: 5 })
    const key = queryKeys.tasks.list(boardTaskScope('p1', null))
    client.setQueryData(key, list)
    client.setQueryData(queryKeys.tasks.dependencies('b'), { blockedBy: [], blocking: [] })
    applySseEventToCache(client, 'task:dependencies', { taskId: 'b', dependsOnTaskId: 'a', change: 'added' }, { stream: 'cloud', id: null }, state)
    expect(client.getQueryData(key)[1]).toMatchObject({ blockedByIds: ['a'], openBlockerCount: 1 })
    await vi.waitFor(() => expect(client.getQueryState(queryKeys.tasks.dependencies('b')).isInvalidated).toBe(true))
    state.invalidator.dispose()
    client.clear()
  })
})

function renderSection(projectId = 'p1') {
  const client = createAppQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  const view = render(createElement(QueryClientProvider, { client }, createElement(TaskDependenciesSection, { taskId: 't1', projectId })))
  return { client, view }
}

const DEPS = {
  blockedBy: [
    { id: 'b1', identifier: 'ENG-1', title: 'Schema first', status: 'todo', archived: false, resolved: false },
    { id: 'b2', identifier: 'ENG-2', title: 'Old spike', status: 'done', archived: false, resolved: true },
  ],
  blocking: [{ id: 'd1', identifier: 'ENG-9', title: 'Ship it', status: 'todo', archived: false, resolved: false }],
}

describe('TaskDependenciesSection', () => {
  it('lists blockers (open ones counted) and what this task blocks', async () => {
    api.fetchTaskDependencies = vi.fn(async () => DEPS)
    renderSection()
    expect(await screen.findByText('Blocked by 1 unfinished task')).toBeTruthy()
    expect(screen.getByText('Schema first')).toBeTruthy()
    expect(screen.getByLabelText('Done')).toBeTruthy()
    expect(screen.getByText('Blocking')).toBeTruthy()
    expect(screen.getByText('Ship it')).toBeTruthy()
    // Only blockers can be removed from here.
    expect(screen.getAllByRole('button', { name: /^Remove blocker/ })).toHaveLength(2)
  })

  it('removes a blocker and patches the board row', async () => {
    api.fetchTaskDependencies = vi.fn(async () => DEPS)
    api.removeTaskBlocker = vi.fn(async () => undefined)
    const { client } = renderSection()
    const key = queryKeys.tasks.list(boardTaskScope('p1', null))
    client.setQueryData(key, [row('t1', { blockedByIds: ['b1', 'b2'], openBlockerCount: 1 })])
    fireEvent.click(await screen.findByRole('button', { name: 'Remove blocker ENG-1' }))
    await waitFor(() => expect(api.removeTaskBlocker).toHaveBeenCalledWith('t1', 'b1'))
    await waitFor(() => expect(screen.queryByText('Schema first')).toBeNull())
    expect(client.getQueryData(key)[0]).toMatchObject({ blockedByIds: ['b2'], openBlockerCount: 0 })
  })

  it('adds a blocker picked from the project', async () => {
    api.fetchTaskDependencies = vi.fn(async () => ({ blockedBy: [], blocking: [] }))
    api.searchBlockerCandidates = vi.fn(async () => [{ id: 'c1', identifier: 'ENG-3', title: 'Auth API', status: 'todo' }])
    api.addTaskBlocker = vi.fn(async () => ({ created: true, blockedBy: [{ id: 'c1', identifier: 'ENG-3', title: 'Auth API', status: 'todo', archived: false, resolved: false }], blocking: [] }))
    renderSection()
    expect(await screen.findByText('Not blocked by anything.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add a blocker' }))
    fireEvent.click(await screen.findByText('Auth API'))
    await waitFor(() => expect(api.addTaskBlocker).toHaveBeenCalledWith('t1', 'c1'))
    expect(api.searchBlockerCandidates).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', taskId: 't1', exclude: [] }))
    expect(await screen.findByText('Blocked by 1 unfinished task')).toBeTruthy()
  })

  it('FE-10: offers "Run with blockers" only while a blocker is unfinished', async () => {
    api.fetchTaskDependencies = vi.fn(async () => DEPS)
    const onRunWithBlockers = vi.fn()
    const client = createAppQueryClient()
    render(createElement(QueryClientProvider, { client }, createElement(TaskDependenciesSection, { taskId: 't1', projectId: 'p1', onRunWithBlockers })))
    fireEvent.click(await screen.findByRole('button', { name: 'Run with blockers' }))
    expect(onRunWithBlockers).toHaveBeenCalledTimes(1)
    cleanup()

    api.fetchTaskDependencies = vi.fn(async () => ({ blockedBy: [DEPS.blockedBy[1]], blocking: [] }))
    render(createElement(QueryClientProvider, { client: createAppQueryClient() }, createElement(TaskDependenciesSection, { taskId: 't1', projectId: 'p1', onRunWithBlockers })))
    expect(await screen.findByText('Blocked by (all done)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Run with blockers' })).toBeNull()
  })

  it('explains that project-less tasks cannot have blockers', async () => {
    api.fetchTaskDependencies = vi.fn(async () => ({ blockedBy: [], blocking: [] }))
    renderSection(null)
    expect(await screen.findByText('Only tasks in a project can have blockers.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add a blocker' })).toBeNull()
  })
})
