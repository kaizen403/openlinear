import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const state = vi.hoisted(() => ({
  tasks: [],
  deletionMode: 'archive',
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
vi.mock('@/lib/api/fetch', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    apiFetch: vi.fn(async (path, init = {}) => {
      if (typeof path === 'string' && path.startsWith('/api/tasks?')) return { items: state.tasks }
      if (path === '/api/settings') return { taskDeletionMode: state.deletionMode }
      const route = state.routes.get(path)
      if (route) return route(init)
      return {}
    }),
  }
})

const { apiFetch, ApiError, NetworkError } = await import('@/lib/api/fetch')
const { toast } = await import('sonner')
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

/** Calls other than the initial board load (task list + settings). */
function mutationCalls() {
  return apiFetch.mock.calls.filter(([path]) => !(path.startsWith('/api/tasks?') || path === '/api/settings'))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function renderBoard() {
  const hook = renderHook(() => useKanbanBoard({ projectId: 'p1', projects: [] }))
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  await waitFor(() => expect(hook.result.current.taskDeletionMode).toBe(state.deletionMode))
  return hook
}

function select(result, ...numbers) {
  for (const n of numbers) act(() => { result.current.toggleTaskSelect(ID(n)) })
}

const statusOf = (result, n) => result.current.tasks.find((task) => task.id === ID(n))?.status

describe('useKanbanBoard bulk actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tasks = [makeTask(1), makeTask(2), makeTask(3), makeTask(4, { status: 'done' })]
    state.deletionMode = 'archive'
    state.handlers = []
    state.routes = new Map()
  })

  it('changes status with exactly one bulk-status request, optimistic first', async () => {
    const response = deferred()
    state.routes.set('/api/tasks/bulk-status', () => response.promise)
    const { result } = await renderBoard()
    select(result, 1, 2, 3)

    let pending
    act(() => { pending = result.current.handleBulkChangeStatus('done') })
    expect([1, 2, 3].map((n) => statusOf(result, n))).toEqual(['done', 'done', 'done'])
    expect(result.current.selectedTaskIds.size).toBe(0)

    response.resolve({
      updated: [1, 2, 3].map((n) => makeTask(n, { status: 'done', updatedAt: '2026-10-02T00:00:00.000Z' })),
      already: [],
      failed: [],
      status: 'done',
    })
    await act(async () => { await pending })

    expect(mutationCalls()).toEqual([[
      '/api/tasks/bulk-status',
      { method: 'PATCH', body: JSON.stringify({ projectId: 'p1', status: 'done', taskIds: [ID(1), ID(2), ID(3)] }) },
    ]])
    expect(result.current.tasks.find((task) => task.id === ID(2)).updatedAt).toBe('2026-10-02T00:00:00.000Z')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('rolls back only the failed items, keeps them selected and lists them', async () => {
    state.routes.set('/api/tasks/bulk-status', async () => ({
      updated: [makeTask(1, { status: 'done' })],
      already: [],
      failed: [{ id: ID(2), error: 'Issue was not found in the selected project' }],
      status: 'done',
    }))
    const { result } = await renderBoard()
    select(result, 1, 2)
    await act(async () => { await result.current.handleBulkChangeStatus('done') })

    expect(mutationCalls()).toHaveLength(1)
    expect(statusOf(result, 1)).toBe('done')
    expect(statusOf(result, 2)).toBe('todo')
    expect([...result.current.selectedTaskIds]).toEqual([ID(2)])
    expect(toast.error).toHaveBeenCalledWith("Couldn't move 1 of 2 tasks to Done", {
      description: "KT-2: Issue was not found in the selected project It's still selected so you can retry.",
    })
  })

  it('rolls everything back on a rejected request and maps the error code', async () => {
    state.routes.set('/api/tasks/bulk-status', async () => {
      throw new ApiError(403, 'Required role is missing', 'OWNERSHIP_REQUIRED', { resourceType: 'project' })
    })
    const { result } = await renderBoard()
    select(result, 1, 2)
    await act(async () => { await result.current.handleBulkChangeStatus('cancelled') })

    expect([1, 2].map((n) => statusOf(result, n))).toEqual(['todo', 'todo'])
    const [title, options] = toast.error.mock.calls[0]
    expect(title).toBe("Couldn't move 2 tasks to Cancelled")
    expect(options.description).toContain("You don't have permission to change this project.")
  })

  it('archives with one bulk-archive request and restores failures in place', async () => {
    state.routes.set('/api/tasks/bulk-archive', async () => ({
      archived: [{ id: ID(1), identifier: 'KT-1', title: 'Task 1', status: 'todo' }],
      failed: [{ id: ID(3), error: 'Issue was not found in the selected project' }],
      count: 1,
    }))
    const { result } = await renderBoard()
    select(result, 1, 3)
    await act(async () => { await result.current.handleBulkDelete() })

    expect(mutationCalls()).toEqual([[
      '/api/tasks/bulk-archive',
      { method: 'POST', body: JSON.stringify({ projectId: 'p1', taskIds: [ID(1), ID(3)] }) },
    ]])
    expect(result.current.tasks.map((task) => task.number)).toEqual([2, 3, 4])
    expect(toast.error).toHaveBeenCalledWith("Couldn't archive 1 of 2 tasks", expect.any(Object))
  })

  it('deletes permanently with one bulk-delete request in delete mode', async () => {
    state.deletionMode = 'delete'
    state.routes.set('/api/tasks/bulk-delete', async () => ({ deleted: [ID(1), ID(2)], failed: [], permanent: true }))
    const { result } = await renderBoard()
    select(result, 1, 2)
    await act(async () => { await result.current.handleBulkDelete() })

    expect(mutationCalls()).toEqual([[
      '/api/tasks/bulk-delete',
      { method: 'POST', body: JSON.stringify({ projectId: 'p1', taskIds: [ID(1), ID(2)], permanent: true }) },
    ]])
    expect(result.current.tasks.map((task) => task.number)).toEqual([3, 4])
    expect(toast.success).toHaveBeenCalledWith('Deleted 2 tasks')
  })

  it('moves selected todos to In Progress with one request', async () => {
    state.routes.set('/api/tasks/bulk-status', async () => ({ updated: [], already: [], failed: [], status: 'in_progress' }))
    const { result } = await renderBoard()
    select(result, 1, 2, 4)
    await act(async () => { await result.current.handleBatchMoveToInProgress() })

    expect(mutationCalls()).toEqual([[
      '/api/tasks/bulk-status',
      { method: 'PATCH', body: JSON.stringify({ projectId: 'p1', status: 'in_progress', taskIds: [ID(1), ID(2)] }) },
    ]])
  })

  it('uses the single-task endpoint for the open task shortcut', async () => {
    state.routes.set(`/api/tasks/${ID(1)}`, async () => makeTask(1, { status: 'done' }))
    const { result } = await renderBoard()
    await act(async () => { await result.current.handleBulkChangeStatus('done', [ID(1)]) })
    expect(mutationCalls()).toEqual([[`/api/tasks/${ID(1)}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }]])
    expect(statusOf(result, 1)).toBe('done')
  })

  it('removes tasks announced by tasks:bulk-deleted once the provider delivers it', async () => {
    const { result } = await renderBoard()
    act(() => {
      for (const handler of state.handlers) handler('tasks:bulk-deleted', { projectId: 'p1', taskIds: [ID(1), ID(2)] })
    })
    expect(result.current.tasks.map((task) => task.number)).toEqual([3, 4])
  })
})

describe('useKanbanBoard idempotent create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tasks = [makeTask(1)]
    state.deletionMode = 'archive'
    state.handlers = []
    state.routes = new Map()
  })

  it('sends one Idempotency-Key and reuses it when the create is retried automatically', async () => {
    const keys = []
    state.routes.set('/api/tasks', async (init) => {
      keys.push(init.headers['Idempotency-Key'])
      if (keys.length === 1) throw new ApiError(409, 'still processing', 'IDEMPOTENCY_IN_PROGRESS', { retryAfterSeconds: 0.01 })
      if (keys.length === 2) throw new ApiError(503, 'Service Unavailable')
      return makeTask(9, { title: 'Inline' })
    })
    const { result } = await renderBoard()
    await act(async () => { await result.current.handleInlineCreateTask('todo', 'Inline') })

    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.current.tasks.map((task) => task.id)).toEqual([ID(9), ID(1)])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('uses a new key for each create action', async () => {
    const keys = []
    state.routes.set('/api/tasks', async (init) => {
      keys.push(init.headers['Idempotency-Key'])
      return makeTask(10 + keys.length)
    })
    const { result } = await renderBoard()
    await act(async () => { await result.current.handleInlineCreateTask('todo', 'One') })
    await act(async () => { await result.current.handleInlineCreateTask('todo', 'Two') })
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  it('does not retry a conflict and removes the placeholder', async () => {
    let calls = 0
    state.routes.set('/api/tasks', async () => {
      calls += 1
      throw new ApiError(409, 'Idempotency-Key was already used with a different request', 'IDEMPOTENCY_CONFLICT')
    })
    const { result } = await renderBoard()
    await act(async () => { await result.current.handleInlineCreateTask('todo', 'Dup') })
    expect(calls).toBe(1)
    expect(result.current.tasks.map((task) => task.id)).toEqual([ID(1)])
    expect(toast.error).toHaveBeenCalledWith('This request was already submitted with different details.', {
      description: 'Nothing new was saved. Review your changes and submit again.',
    })
  })
})

describe('useKanbanBoard execution errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tasks = [makeTask(1, { status: 'in_progress' })]
    state.deletionMode = 'archive'
    state.handlers = []
    state.routes = new Map()
  })

  it('maps execute failures through the error-code table', async () => {
    state.routes.set(`/api/tasks/${ID(1)}/execute`, async () => {
      throw new ApiError(400, 'The current execution engine does not support codex', 'RUNNER_NOT_SUPPORTED', { runner: 'codex', supportedRunners: ['opencode'] })
    })
    const { result } = await renderBoard()
    await act(async () => { await result.current.handleExecute(ID(1)) })
    expect(toast.error).toHaveBeenCalledWith("Codex can't execute tasks yet.", {
      description: 'The execution engine currently supports OpenCode. Switch the task or project agent and try again.',
    })
    expect(result.current.startingExecuteIds.size).toBe(0)
  })

  it('W17a/FE-10: a blocked task offers "Run with blockers" (one batch, blockers first) and "Run anyway"', async () => {
    state.tasks = [makeTask(1, { status: 'in_progress' }), makeTask(2), makeTask(3)]
    const bodies = []
    state.routes.set(`/api/tasks/${ID(1)}/execute`, async (init) => {
      bodies.push(init.body ?? null)
      if (!init.body) throw new ApiError(409, 'This task is blocked by KT-2.', 'TASK_BLOCKED', { blockers: [{ id: ID(2), identifier: 'KT-2', title: 'Task 2', status: 'todo' }] })
      return { message: 'Task execution started' }
    })
    state.routes.set(`/api/tasks/${ID(1)}/dependencies/closure`, async () => ({
      tasks: [
        { id: ID(2), identifier: 'KT-2', title: 'Task 2', status: 'todo', archived: false, resolved: false },
        { id: ID(3), identifier: 'KT-3', title: 'Task 3', status: 'todo', archived: false, resolved: false },
      ],
      truncated: false,
    }))
    let batchBody = null
    state.routes.set('/api/batches', async (init) => {
      if (init.method !== 'POST') return []
      batchBody = JSON.parse(init.body)
      return { id: 'batch-1', status: 'running', mode: 'parallel', tasks: batchBody.taskIds.map((taskId) => ({ taskId, title: taskId, status: 'queued' })) }
    })
    const { result } = await renderBoard()
    await act(async () => { await result.current.handleExecute(ID(1)) })
    const [title, options] = toast.error.mock.calls[0]
    expect(title).toBe('Blocked by KT-2')
    expect(options.action.label).toBe('Run with blockers')
    expect(options.cancel.label).toBe('Run anyway')

    await act(async () => { options.action.onClick() })
    await waitFor(() => expect(batchBody).toEqual({ taskIds: [ID(2), ID(3), ID(1)], mode: 'parallel' }))
    await waitFor(() => expect(result.current.activeBatch?.id).toBe('batch-1'))

    await act(async () => { options.cancel.onClick() })
    await waitFor(() => expect(bodies).toEqual([null, JSON.stringify({ allowBlocked: true })]))
  })

  it('FE-10: refuses to run with blockers that are archived or already running, and explains why', async () => {
    state.tasks = [makeTask(1, { status: 'in_progress' }), makeTask(2, { status: 'in_progress', sessionId: 'ses_live' })]
    state.routes.set(`/api/tasks/${ID(1)}/dependencies/closure`, async () => ({
      tasks: [{ id: ID(2), identifier: 'KT-2', title: 'Task 2', status: 'in_progress', archived: false, resolved: false }],
      truncated: false,
    }))
    const { result } = await renderBoard()
    await act(async () => { await result.current.handleRunWithBlockers(ID(1)) })
    expect(toast.error).toHaveBeenCalledWith("Can't run it with its blockers", { description: 'KT-2 is running now. Run this task when it finishes.' })
    expect(apiFetch.mock.calls.some(([path, init]) => path === '/api/batches' && init?.method === 'POST')).toBe(false)
  })

  it('reports a failed stop and offers a retry', async () => {
    let attempts = 0
    state.routes.set(`/api/tasks/${ID(1)}/cancel`, async () => {
      attempts += 1
      if (attempts === 1) throw new ApiError(400, 'Cancellation could not be confirmed; execution remains reserved')
      return { message: 'Task cancelled' }
    })
    const { result } = await renderBoard()
    let accepted
    await act(async () => { accepted = await result.current.handleCancel(ID(1)) })
    expect(accepted).toBe(false)
    const [, options] = toast.error.mock.calls[0]
    expect(options.action.label).toBe('Retry stop')
    await act(async () => { options.action.onClick() })
    await waitFor(() => expect(attempts).toBe(2))
  })

  it('does not offer a retry when the task is not running', async () => {
    state.routes.set(`/api/tasks/${ID(1)}/cancel`, async () => { throw new ApiError(400, 'Task is not running') })
    const { result } = await renderBoard()
    await act(async () => { await result.current.handleCancel(ID(1)) })
    expect(toast.error).toHaveBeenCalledWith('Task is not running', {})
  })

  it('maps a network failure while creating', async () => {
    state.routes.set('/api/tasks', async () => { throw new NetworkError('offline', 1) })
    const { result } = await renderBoard()
    await act(async () => { await result.current.handleInlineCreateTask('todo', 'Offline') })
    expect(toast.error).toHaveBeenCalledWith("Couldn't reach OpenLinear.", { description: 'Check your connection and try again.' })
  }, 10_000)
})
