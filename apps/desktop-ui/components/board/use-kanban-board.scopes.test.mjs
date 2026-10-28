// Board hook: team-only bulk scopes, delete-event dedupe, full detail on open.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const state = vi.hoisted(() => ({
  tasks: [],
  handlers: [],
  routes: new Map(),
  auth: {
    isAuthenticated: true,
    activeRepository: { id: 'repo-1', fullName: 'acme/app', defaultBranch: 'main' },
    refreshActiveRepository: () => {},
  },
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => state.auth }))
vi.mock('@/providers/sse-provider', () => ({
  useSSESubscription: (handler) => { state.handlers.push(handler) },
}))
vi.mock('@/lib/api/opencode', () => ({
  getSetupStatus: vi.fn(async () => ({ ready: true, providers: [] })),
  OpenCodeUnavailableError: class OpenCodeUnavailableError extends Error {},
}))
vi.mock('@/lib/execution-state-store', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, replaceExecutionLogs: vi.fn(actual.replaceExecutionLogs), clearExecutionProgress: vi.fn(actual.clearExecutionProgress) }
})
vi.mock('@/lib/api/fetch', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    apiFetch: vi.fn(async (path, init = {}) => {
      if (typeof path === 'string' && path.startsWith('/api/tasks?')) return { items: state.tasks }
      if (path === '/api/settings') return { taskDeletionMode: 'archive' }
      const route = state.routes.get(path)
      if (route) return route(init)
      return {}
    }),
  }
})

const { apiFetch, NetworkError } = await import('@/lib/api/fetch')
const { toast } = await import('sonner')
const { replaceExecutionLogs } = await import('@/lib/execution-state-store')
const { useKanbanBoard } = await import('./use-kanban-board.ts')

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function makeTask(n, overrides = {}) {
  return {
    id: ID(n),
    title: `Task ${n}`,
    description: null,
    priority: 'medium',
    status: 'todo',
    sessionId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    labels: [],
    executionStartedAt: null,
    executionPausedAt: null,
    executionElapsedMs: 0,
    executionProgress: null,
    prUrl: null,
    outcome: null,
    batchId: null,
    inboxRead: false,
    identifier: `KT-${n}`,
    number: n,
    dueDate: null,
    projectId: 'p1',
    teamId: 'team-1',
    archived: false,
    ...overrides,
  }
}

const teamOnly = (n, teamId = 'team-1') => makeTask(n, { projectId: null, teamId })

function mutationCalls() {
  return apiFetch.mock.calls.filter(([path]) => !(path.startsWith('/api/tasks?') || path === '/api/settings'))
}

async function renderBoard(props) {
  let renders = 0
  const hook = renderHook(() => {
    renders += 1
    return useKanbanBoard({ projects: [], ...props })
  })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return { ...hook, renders: () => renders }
}

function select(result, ...numbers) {
  for (const n of numbers) act(() => { result.current.toggleTaskSelect(ID(n)) })
}

/** Deliver one event to every distinct subscriber once, like the SSE provider. */
function emit(type, data) {
  for (const handler of new Set(state.handlers)) handler(type, data)
}

const bodies = () => mutationCalls().map(([path, init]) => [path, JSON.parse(init.body)])

beforeEach(() => {
  vi.clearAllMocks()
  state.handlers = []
  state.routes = new Map()
})

describe('team-only bulk actions', () => {
  it('sends a team-only selection as one request with teamId (no per-task fallback)', async () => {
    state.tasks = [teamOnly(1), teamOnly(2), teamOnly(3)]
    state.routes.set('/api/tasks/bulk-status', async (init) => {
      const { taskIds } = JSON.parse(init.body)
      return { updated: taskIds.map((id, i) => ({ ...teamOnly(i + 1), id, status: 'done' })), already: [], failed: [], status: 'done' }
    })
    const { result } = await renderBoard({ teamId: 'team-1' })
    select(result, 1, 2, 3)
    await act(async () => { await result.current.handleBulkChangeStatus('done') })

    expect(bodies()).toEqual([['/api/tasks/bulk-status', { teamId: 'team-1', status: 'done', taskIds: [ID(1), ID(2), ID(3)] }]])
    expect(result.current.tasks.every((task) => task.status === 'done')).toBe(true)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('groups a mixed selection into one request per scope', async () => {
    state.tasks = [makeTask(1), makeTask(2), teamOnly(3), teamOnly(4, 'team-2'), makeTask(5, { projectId: 'p2', teamId: 'team-9' })]
    state.routes.set('/api/tasks/bulk-archive', async (init) => {
      const { taskIds } = JSON.parse(init.body)
      return { archived: taskIds.map((id) => ({ id, identifier: null, title: 't', status: 'todo' })), failed: [], count: taskIds.length }
    })
    const { result } = await renderBoard({})
    select(result, 1, 2, 3, 4, 5)
    await act(async () => { await result.current.handleBulkDelete() })

    expect(bodies()).toEqual([
      ['/api/tasks/bulk-archive', { projectId: 'p1', taskIds: [ID(1), ID(2)] }],
      ['/api/tasks/bulk-archive', { projectId: 'p2', taskIds: [ID(5)] }],
      ['/api/tasks/bulk-archive', { teamId: 'team-1', taskIds: [ID(3)] }],
      ['/api/tasks/bulk-archive', { teamId: 'team-2', taskIds: [ID(4)] }],
    ])
    expect(result.current.tasks).toEqual([])
    expect(toast.success).toHaveBeenCalledWith('Archived 5 tasks')
  })

  it('rolls back a team request rejected with BULK_SCOPE_INVALID and shows the mapped copy', async () => {
    const { ApiError } = await import('@/lib/api/fetch')
    state.tasks = [teamOnly(1), teamOnly(2)]
    state.routes.set('/api/tasks/bulk-status', async () => {
      throw new ApiError(400, 'Provide exactly one of projectId or teamId', 'BULK_SCOPE_INVALID')
    })
    const { result } = await renderBoard({ teamId: 'team-1' })
    select(result, 1, 2)
    await act(async () => { await result.current.handleBulkChangeStatus('done') })

    expect(result.current.tasks.map((task) => task.status)).toEqual(['todo', 'todo'])
    const [title, options] = toast.error.mock.calls[0]
    expect(title).toBe("Couldn't move 2 tasks to Done")
    expect(options.description).toContain("These tasks couldn't be changed in one request.")
  })
})

describe('delete announcements (tasks:bulk-deleted + per-task task:deleted)', () => {
  beforeEach(() => {
    state.tasks = [makeTask(1), makeTask(2), makeTask(3), makeTask(4)]
  })

  it('removes once; the per-task announcements that follow write nothing and re-render nothing', async () => {
    const { result, renders } = await renderBoard({ projectId: 'p1' })
    select(result, 1, 3)
    act(() => { emit('tasks:bulk-deleted', { projectId: 'p1', taskIds: [ID(1), ID(2)], permanent: true }) })
    const afterBulk = result.current.tasks
    expect(afterBulk.map((task) => task.number)).toEqual([3, 4])
    expect([...result.current.selectedTaskIds]).toEqual([ID(3)])

    const rendersBefore = renders()
    act(() => {
      emit('task:deleted', { id: ID(1) })
      emit('task:deleted', { id: ID(2) })
    })
    expect(renders()).toBe(rendersBefore)
    expect(result.current.tasks).toBe(afterBulk)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('lands in the same state when both announcements arrive in one batch', async () => {
    const { result } = await renderBoard({ projectId: 'p1' })
    select(result, 2)
    act(() => {
      emit('tasks:bulk-deleted', { projectId: 'p1', taskIds: [ID(1), ID(2)], permanent: false })
      emit('task:deleted', { id: ID(1) })
      emit('task:deleted', { id: ID(2) })
    })
    expect(result.current.tasks.map((task) => task.number)).toEqual([3, 4])
    expect(result.current.selectedTaskIds.size).toBe(0)
  })

  it('still removes on a lone task:deleted (single delete by another client)', async () => {
    const { result } = await renderBoard({ projectId: 'p1' })
    await act(async () => { await result.current.handleTaskClick(ID(4)) })
    act(() => { emit('task:deleted', { id: ID(4) }) })
    expect(result.current.tasks.map((task) => task.number)).toEqual([1, 2, 3])
    expect(result.current.selectedTaskId).toBe(null)
  })

  it('handles team-scope bulk deletes (projectId: null) on a team board', async () => {
    state.tasks = [teamOnly(1), teamOnly(2)]
    const { result } = await renderBoard({ teamId: 'team-1' })
    act(() => { emit('tasks:bulk-deleted', { projectId: null, teamId: 'team-1', taskIds: [ID(1)], permanent: true }) })
    expect(result.current.tasks.map((task) => task.number)).toEqual([2])
  })
})

describe('full task detail on open', () => {
  // Distinct ids per test: the execution log store is a module singleton.
  beforeEach(() => {
    state.tasks = [makeTask(11), makeTask(12)]
  })

  it('fetches the full row once and falls back to its persisted logs when the sidecar has none', async () => {
    const persisted = [
      { timestamp: '2026-10-01T00:00:01.000Z', type: 'agent', message: 'Edited README' },
      { timestamp: 'bad', type: 'not-a-type', message: 'dropped' },
    ]
    state.routes.set(`/api/tasks/${ID(11)}`, async () => ({ ...makeTask(11), executionLogs: persisted }))
    state.routes.set(`/api/tasks/${ID(11)}/logs`, async () => { throw new NetworkError('sidecar offline') })
    const { result } = await renderBoard({ projectId: 'p1' })

    await act(async () => { await result.current.handleTaskClick(ID(11)) })
    expect(replaceExecutionLogs).toHaveBeenCalledWith(ID(11), [persisted[0]])

    await act(async () => { await result.current.handleTaskClick(ID(11)) })
    const detailCalls = apiFetch.mock.calls.filter(([path]) => path === `/api/tasks/${ID(11)}`)
    expect(detailCalls).toHaveLength(1)
  })

  it('prefers the sidecar history when it has one', async () => {
    const live = [{ timestamp: '2026-10-01T00:00:02.000Z', type: 'info', message: 'live' }]
    state.routes.set(`/api/tasks/${ID(12)}`, async () => ({ ...makeTask(12), executionLogs: [{ timestamp: 't', type: 'info', message: 'old' }] }))
    state.routes.set(`/api/tasks/${ID(12)}/logs`, async () => ({ logs: live }))
    const { result } = await renderBoard({ projectId: 'p1' })
    await act(async () => { await result.current.handleTaskClick(ID(12)) })
    expect(replaceExecutionLogs).toHaveBeenCalledTimes(1)
    expect(replaceExecutionLogs).toHaveBeenCalledWith(ID(12), live)
  })
})
