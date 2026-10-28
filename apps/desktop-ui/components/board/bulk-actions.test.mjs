import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/api/fetch', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, apiFetch: vi.fn() }
})

const { apiFetch, ApiError, NetworkError } = await import('@/lib/api/fetch')
const {
  describeBulkAction,
  planBulkRequests,
  runBulkAction,
  summarizeBulkFailures,
} = await import('./bulk-actions.ts')

function task(id, projectId = 'p1', status = 'todo') {
  return { id, projectId, status, title: `Task ${id}`, identifier: `KT-${id}` }
}

function index(tasks) {
  return new Map(tasks.map((item) => [item.id, item]))
}

describe('planBulkRequests', () => {
  it('groups by project, chunks at the limit, and separates unscoped and placeholder ids', () => {
    const tasks = [
      ...Array.from({ length: 150 }, (_, i) => task(`a${i}`, 'p1')),
      task('b1', 'p2'),
      task('team-only', null),
      task('temp-123', 'p1'),
    ]
    const plan = planBulkRequests([...tasks.map((item) => item.id), 'a0', 'missing'], index(tasks))
    expect(plan.batches.map((batch) => [batch.projectId, batch.taskIds.length])).toEqual([
      ['p1', 100],
      ['p1', 50],
      ['p2', 1],
    ])
    expect(plan.unscoped).toEqual(['team-only'])
    expect(plan.skipped).toEqual(['temp-123', 'missing'])
  })
})

describe('runBulkAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends exactly one bulk-status request for a single-project selection and maps per-item outcomes', async () => {
    const tasks = [task('t1'), task('t2'), task('t3')]
    apiFetch.mockResolvedValueOnce({
      updated: [{ ...task('t1'), status: 'done' }],
      already: [{ id: 't2', identifier: 'KT-t2', title: 'Task t2', status: 'done' }],
      failed: [{ id: 't3', error: 'Issue was not found in the selected project' }],
      status: 'done',
    })
    const outcome = await runBulkAction({ kind: 'status', status: 'done' }, ['t1', 't2', 't3'], index(tasks))
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks/bulk-status', {
      method: 'PATCH',
      body: JSON.stringify({ projectId: 'p1', status: 'done', taskIds: ['t1', 't2', 't3'] }),
    })
    expect(outcome.requestCount).toBe(1)
    expect(outcome.succeeded.sort()).toEqual(['t1', 't2'])
    expect(outcome.failed).toEqual([{ id: 't3', reason: 'Issue was not found in the selected project', code: null, source: 'item' }])
    expect(outcome.updatedTasks.map((item) => item.id)).toEqual(['t1'])
  })

  it('archives through one bulk-archive request', async () => {
    apiFetch.mockResolvedValueOnce({ archived: [{ id: 't1' }, { id: 't2' }], failed: [], count: 2 })
    const outcome = await runBulkAction({ kind: 'archive' }, ['t1', 't2'], index([task('t1'), task('t2')]))
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks/bulk-archive', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p1', taskIds: ['t1', 't2'] }),
    })
    expect(outcome.failed).toEqual([])
  })

  it('deletes permanently through one bulk-delete request', async () => {
    apiFetch.mockResolvedValueOnce({ deleted: ['t1'], failed: [{ id: 't2', error: 'Issue was not found in the selected project' }], permanent: true })
    const outcome = await runBulkAction({ kind: 'delete' }, ['t1', 't2'], index([task('t1'), task('t2')]))
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p1', taskIds: ['t1', 't2'], permanent: true }),
    })
    expect(outcome.succeeded).toEqual(['t1'])
    expect(outcome.failed.map((item) => item.id)).toEqual(['t2'])
  })

  it('fails every item of a rejected request and keeps the error for code mapping', async () => {
    const error = new ApiError(403, 'Required role is missing', 'OWNERSHIP_REQUIRED', { resourceType: 'project' })
    apiFetch.mockRejectedValueOnce(error)
    const outcome = await runBulkAction({ kind: 'archive' }, ['t1', 't2'], index([task('t1'), task('t2')]))
    expect(outcome.requestError).toBe(error)
    expect(outcome.failed).toEqual([
      { id: 't1', reason: 'Required role is missing', code: 'OWNERSHIP_REQUIRED', source: 'request' },
      { id: 't2', reason: 'Required role is missing', code: 'OWNERSHIP_REQUIRED', source: 'request' },
    ])
  })

  it('treats ids the server did not report as failed', async () => {
    apiFetch.mockResolvedValueOnce({ archived: [{ id: 't1' }], failed: [], count: 1 })
    const outcome = await runBulkAction({ kind: 'archive' }, ['t1', 't2'], index([task('t1'), task('t2')]))
    expect(outcome.failed).toEqual([{ id: 't2', reason: 'The server did not report a result for this task', code: null, source: 'item' }])
  })

  it('issues one request per project and falls back to single endpoints for tasks without a project', async () => {
    const tasks = [task('t1', 'p1'), task('t2', 'p2'), task('t3', null)]
    apiFetch.mockImplementation(async (path) => {
      if (path === '/api/tasks/bulk-status') return { updated: [], already: [], failed: [], status: 'done' }
      if (path === '/api/tasks/t3') throw new NetworkError('offline')
      return {}
    })
    const outcome = await runBulkAction({ kind: 'status', status: 'done' }, ['t1', 't2', 't3'], index(tasks))
    expect(outcome.requestCount).toBe(3)
    expect(apiFetch).toHaveBeenCalledTimes(3)
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks/t3', { method: 'PATCH', body: JSON.stringify({ status: 'done' }) })
    expect(outcome.failed.find((item) => item.id === 't3')).toMatchObject({ source: 'request' })
    expect(outcome.requestError).toBeInstanceOf(NetworkError)
  })

  it('sends project-less tasks with their teamId: one request per scope, no per-task fallback', async () => {
    const tasks = [
      task('p-1', 'p1'),
      task('p-2', 'p1'),
      { ...task('t-1', null), teamId: 'team-a' },
      { ...task('t-2', null), teamId: 'team-a' },
      { ...task('t-3', null), teamId: 'team-b' },
    ]
    apiFetch.mockImplementation(async (_path, init) => {
      const body = JSON.parse(init.body)
      return { updated: body.taskIds.map((id) => ({ ...task(id, body.projectId ?? null), status: 'done' })), already: [], failed: [], status: 'done' }
    })
    const outcome = await runBulkAction({ kind: 'status', status: 'done' }, tasks.map((item) => item.id), index(tasks))
    expect(outcome.requestCount).toBe(3)
    expect(apiFetch.mock.calls.map(([path, init]) => [path, JSON.parse(init.body)])).toEqual([
      ['/api/tasks/bulk-status', { projectId: 'p1', status: 'done', taskIds: ['p-1', 'p-2'] }],
      ['/api/tasks/bulk-status', { teamId: 'team-a', status: 'done', taskIds: ['t-1', 't-2'] }],
      ['/api/tasks/bulk-status', { teamId: 'team-b', status: 'done', taskIds: ['t-3'] }],
    ])
    // Exactly one scope per request.
    for (const [, init] of apiFetch.mock.calls) {
      const body = JSON.parse(init.body)
      expect(('projectId' in body) !== ('teamId' in body)).toBe(true)
    }
    expect(outcome.failed).toEqual([])
    expect(outcome.succeeded.sort()).toEqual(['p-1', 'p-2', 't-1', 't-2', 't-3'])
  })

  it('archives and deletes a team-only selection with one request each', async () => {
    const tasks = [{ ...task('t-1', null), teamId: 'team-a' }, { ...task('t-2', null), teamId: 'team-a' }]
    apiFetch.mockResolvedValueOnce({ archived: [{ id: 't-1' }, { id: 't-2' }], failed: [], count: 2 })
    await runBulkAction({ kind: 'archive' }, ['t-1', 't-2'], index(tasks))
    apiFetch.mockResolvedValueOnce({ deleted: ['t-1', 't-2'], failed: [], permanent: true })
    await runBulkAction({ kind: 'delete' }, ['t-1', 't-2'], index(tasks))
    expect(apiFetch.mock.calls).toEqual([
      ['/api/tasks/bulk-archive', { method: 'POST', body: JSON.stringify({ teamId: 'team-a', taskIds: ['t-1', 't-2'] }) }],
      ['/api/tasks/bulk-delete', { method: 'POST', body: JSON.stringify({ teamId: 'team-a', taskIds: ['t-1', 't-2'], permanent: true }) }],
    ])
  })

  it('chunks a team scope at the limit and keeps tasks with neither project nor team on the single endpoint', () => {
    const tasks = [
      ...Array.from({ length: 120 }, (_, i) => ({ ...task(`t${i}`, null), teamId: 'team-a' })),
      task('orphan', null),
    ]
    const plan = planBulkRequests(tasks.map((item) => item.id), index(tasks))
    expect(plan.batches.map((batch) => [batch.scope, batch.teamId, batch.taskIds.length])).toEqual([
      ['team', 'team-a', 100],
      ['team', 'team-a', 20],
    ])
    expect(plan.unscoped).toEqual(['orphan'])
  })

  it('maps TASK_IDS_REQUIRED and BULK_SCOPE_INVALID through the error map', async () => {
    const { describeApiError, formatApiError } = await import('@/lib/api/errors')
    for (const [code, status] of [['TASK_IDS_REQUIRED', 400], ['BULK_SCOPE_INVALID', 400]]) {
      const error = new ApiError(status, 'server text', code)
      apiFetch.mockRejectedValueOnce(error)
      const outcome = await runBulkAction({ kind: 'archive' }, ['t1'], index([task('t1')]))
      expect(outcome.failed).toEqual([{ id: 't1', reason: 'server text', code, source: 'request' }])
      const described = describeApiError(outcome.requestError)
      expect(described.code).toBe(code)
      expect(described.message).not.toBe('server text')
      expect(described.hint).toBeTruthy()
      expect(formatApiError(outcome.requestError)).toContain(described.message)
    }
    expect(describeApiError(new ApiError(400, 'x', 'TASK_IDS_REQUIRED')).message).toBe('No tasks were selected, so nothing changed.')
    expect(describeApiError(new ApiError(400, 'x', 'BULK_SCOPE_INVALID')).hint).toMatch(/one project or one team/)
  })

  it('sends nothing for optimistic placeholders', async () => {
    const outcome = await runBulkAction({ kind: 'archive' }, ['temp-1'], index([task('temp-1')]))
    expect(apiFetch).not.toHaveBeenCalled()
    expect(outcome.requestCount).toBe(0)
  })
})

describe('bulk toast copy', () => {
  it('describes actions', () => {
    expect(describeBulkAction({ kind: 'status', status: 'in_progress' })).toEqual({ verb: 'move to In Progress', past: 'Moved to In Progress' })
    expect(describeBulkAction({ kind: 'archive' }).past).toBe('Archived')
    expect(describeBulkAction({ kind: 'delete' }).verb).toBe('delete')
  })

  it('groups failures by reason and truncates', () => {
    const label = (id) => `KT-${id}`
    const failures = [
      { id: '1', reason: 'Not found', code: null, source: 'item' },
      { id: '2', reason: 'Not found', code: null, source: 'item' },
      { id: '3', reason: 'Not found', code: null, source: 'item' },
      { id: '4', reason: 'Not found', code: null, source: 'item' },
      { id: '5', reason: 'Locked', code: null, source: 'item' },
    ]
    expect(summarizeBulkFailures(failures, label)).toBe('KT-1, KT-2, KT-3 +1 more: Not found · …and 1 other reason')
    expect(summarizeBulkFailures(failures.slice(3), label)).toBe('KT-4: Not found · KT-5: Locked')
  })
})
