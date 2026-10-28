import { describe, it, expect, vi } from 'vitest'

const api = vi.hoisted(() => ({ apiFetch: null }))
vi.mock('./fetch', async (original) => ({ ...(await original()), apiFetch: (...args) => api.apiFetch(...args) }))

const { ApiError } = await import('./fetch.ts')
const { addTaskBlocker, blockedByFromError, removeTaskBlocker, runWithBlockersProblem, searchBlockerCandidates } = await import('./task-dependencies.ts')

describe('W17a dependency API helpers', () => {
  it('adds and removes blockers on the task route', async () => {
    api.apiFetch = vi.fn(async () => ({ created: true, blockedBy: [], blocking: [] }))
    await addTaskBlocker('t 1', 'b-1')
    expect(api.apiFetch).toHaveBeenCalledWith('/api/tasks/t%201/dependencies', { method: 'POST', body: JSON.stringify({ dependsOnTaskId: 'b-1' }) })
    api.apiFetch = vi.fn(async () => undefined)
    await removeTaskBlocker('t1', 'b-1')
    expect(api.apiFetch).toHaveBeenCalledWith('/api/tasks/t1/dependencies/b-1', { method: 'DELETE' })
  })

  it('searches the project and leaves out the task itself and its current blockers', async () => {
    api.apiFetch = vi.fn(async () => ({ items: [
      { id: 't1', identifier: 'ENG-1', title: 'Self', status: 'todo', labels: [] },
      { id: 'b1', identifier: 'ENG-2', title: 'Already', status: 'todo' },
      { id: 'c1', identifier: 'ENG-3', title: 'Candidate', status: 'in_progress', extra: true },
    ] }))
    const found = await searchBlockerCandidates({ projectId: 'p1', taskId: 't1', query: ' login ', exclude: ['b1'] })
    expect(api.apiFetch).toHaveBeenCalledWith('/api/tasks?projectId=p1&view=compact&pageSize=20&q=login')
    expect(found).toEqual([{ id: 'c1', identifier: 'ENG-3', title: 'Candidate', status: 'in_progress' }])
  })

  it('reads the open blockers out of a TASK_BLOCKED refusal only', () => {
    const blocked = new ApiError(409, 'This task is blocked by ENG-1.', 'TASK_BLOCKED', { blockers: [{ id: 'b1', identifier: 'ENG-1', title: 'Schema', status: 'todo' }, { nope: true }] })
    expect(blockedByFromError(blocked)).toEqual([{ id: 'b1', identifier: 'ENG-1', title: 'Schema' }])
    expect(blockedByFromError(new ApiError(409, 'x', 'TASK_BLOCKED'))).toEqual([])
    expect(blockedByFromError(new ApiError(409, 'x', 'TASK_ALREADY_RUNNING'))).toBeNull()
    expect(blockedByFromError(new Error('x'))).toBeNull()
  })

  it('FE-10: says why a task cannot run with its blockers', () => {
    const ref = (id, extra = {}) => ({ id, identifier: id.toUpperCase(), title: id, status: 'todo', archived: false, resolved: false, ...extra })
    const never = () => false
    expect(runWithBlockersProblem({ tasks: [ref('a')], truncated: false }, never, 3)).toBeNull()
    expect(runWithBlockersProblem({ tasks: [ref('a'), ref('b')], truncated: false }, never, 3)).toBeNull()
    expect(runWithBlockersProblem({ tasks: [ref('a'), ref('b'), ref('c')], truncated: false }, never, 3))
      .toBe('It needs 4 tasks in one batch and your maximum batch size is 3. Raise it in Settings → AI Execution, or run some blockers first.')
    expect(runWithBlockersProblem({ tasks: [ref('a')], truncated: true }, never, 20)).toContain('more than 2 tasks')
    expect(runWithBlockersProblem({ tasks: [ref('a', { archived: true }), ref('b', { archived: true })], truncated: false }, never, 10)).toBe('A, B are archived. Restore them or remove the dependency.')
    expect(runWithBlockersProblem({ tasks: [ref('a')], truncated: false }, (id) => id === 'a', 10)).toBe('A is running now. Run this task when it finishes.')
  })
})
