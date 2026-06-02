import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('@/providers/sse-provider', () => ({
  useSSESubscription: vi.fn(),
}))

vi.mock('@/lib/execution-state-store', () => ({
  appendExecutionLog: vi.fn(),
  clearExecutionProgress: vi.fn(),
  setExecutionProgress: vi.fn(),
}))

vi.mock('@/components/board/board-state', () => ({
  upsertBoardTask: vi.fn((tasks, task) => {
    const existing = tasks.find((t) => t.id === task.id)
    if (existing) {
      return tasks.map((t) => (t.id === task.id ? task : t))
    }
    return [task, ...tasks]
  }),
}))

const { useSSESubscription } = await import('@/providers/sse-provider')
const { clearExecutionProgress } = await import('@/lib/execution-state-store')
const { useTaskSSE } = await import('./use-task-sse.ts')

function createMockProps() {
  return {
    projectId: 'p1',
    teamId: 't1',
    isAuthenticated: true,
    refreshActiveRepository: vi.fn(),
    fetchTasks: vi.fn(),
    reconcileActiveBatches: vi.fn(),
    setTasks: vi.fn(),
    setSelectedTaskId: vi.fn(),
    setSelectedTaskIds: vi.fn(),
    setActiveBatch: vi.fn(),
    setCompletedBatch: vi.fn(),
    setTaskDeletionMode: vi.fn(),
    lastSelectedIdRef: { current: null },
  }
}

describe('useTaskSSE', () => {
  let capturedHandler

  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler = null
    useSSESubscription.mockImplementation((handler) => {
      capturedHandler = handler
    })
  })

  it('subscribes to SSE events', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))
    expect(useSSESubscription).toHaveBeenCalled()
    expect(typeof capturedHandler).toBe('function')
  })

  it('task:created upserts new task when project matches', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))

    const existingTasks = [{ id: 't1', title: 'Existing', status: 'todo', priority: 'medium', createdAt: '', updatedAt: '', labels: [], executionElapsedMs: 0, inboxRead: false, archived: false }]
    props.setTasks.mockImplementation((fn) => fn(existingTasks))

    capturedHandler('task:created', {
      id: 't2',
      title: 'New Task',
      status: 'todo',
      projectId: 'p1',
      teamId: 't1',
    })

    expect(props.setTasks).toHaveBeenCalled()
  })

  it('task:created ignores task from different project', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))

    capturedHandler('task:created', {
      id: 't2',
      title: 'New Task',
      status: 'todo',
      projectId: 'other-project',
      teamId: 't1',
    })

    expect(props.setTasks).not.toHaveBeenCalled()
  })

  it('task:updated clears execution progress when status is not in_progress', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))

    const existingTasks = [{ id: 't1', title: 'Task', status: 'todo', priority: 'medium', createdAt: '', updatedAt: '', labels: [], executionElapsedMs: 0, inboxRead: false, archived: false }]
    props.setTasks.mockImplementation((fn) => fn(existingTasks))

    capturedHandler('task:updated', { id: 't1', status: 'done' })

    expect(clearExecutionProgress).toHaveBeenCalledWith('t1')
    expect(props.setTasks).toHaveBeenCalled()
  })

  it('task:updated removes archived tasks from scope', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))

    const existingTasks = [{ id: 't1', title: 'Task', status: 'todo', priority: 'medium', createdAt: '', updatedAt: '', labels: [], executionElapsedMs: 0, inboxRead: false, archived: false }]
    props.setTasks.mockImplementation((fn) => fn(existingTasks))
    props.setSelectedTaskIds.mockImplementation((fn) => fn(new Set(['t1'])))

    capturedHandler('task:updated', { id: 't1', archived: true })

    expect(props.setTasks).toHaveBeenCalled()
    const filterFn = props.setTasks.mock.calls[0][0]
    expect(filterFn(existingTasks)).toEqual([])
  })

  it('task:deleted removes task and clears selection', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))

    const existingTasks = [{ id: 't1', title: 'Task', status: 'todo', priority: 'medium', createdAt: '', updatedAt: '', labels: [], executionElapsedMs: 0, inboxRead: false, archived: false }]
    props.setTasks.mockImplementation((fn) => fn(existingTasks))
    props.setSelectedTaskIds.mockImplementation((fn) => fn(new Set(['t1'])))
    props.setSelectedTaskId.mockImplementation((fn) => fn('t1'))

    capturedHandler('task:deleted', { id: 't1' })

    expect(clearExecutionProgress).toHaveBeenCalledWith('t1')
    const filterFn = props.setTasks.mock.calls[0][0]
    expect(filterFn(existingTasks)).toEqual([])
  })

  it('connected triggers fetchTasks and reconcileActiveBatches', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))

    capturedHandler('connected', { clientId: 'c1' })

    expect(props.fetchTasks).toHaveBeenCalledWith({ silent: true })
    expect(props.refreshActiveRepository).toHaveBeenCalled()
    expect(props.reconcileActiveBatches).toHaveBeenCalled()
  })

  it('batch:created sets active batch', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))

    capturedHandler('batch:created', {
      batchId: 'b1',
      status: 'running',
      mode: 'parallel',
      tasks: [{ taskId: 't1', title: 'Task', status: 'queued' }],
    })

    expect(props.setActiveBatch).toHaveBeenCalledWith(expect.objectContaining({
      id: 'b1',
      status: 'running',
      mode: 'parallel',
    }))
  })

  it('batch:task:started updates task status in batch', () => {
    const props = createMockProps()
    const activeBatch = {
      id: 'b1',
      status: 'running',
      mode: 'parallel',
      tasks: [{ taskId: 't1', title: 'Task', status: 'queued' }],
      prUrl: null,
    }
    props.setActiveBatch.mockImplementation((fn) => {
      if (typeof fn === 'function') {
        fn(activeBatch)
      }
    })

    renderHook(() => useTaskSSE(props))
    capturedHandler('batch:task:started', { batchId: 'b1', taskId: 't1' })

    expect(props.setActiveBatch).toHaveBeenCalled()
  })

  it('batch:task:completed updates task status to completed', () => {
    const props = createMockProps()
    const activeBatch = {
      id: 'b1',
      status: 'running',
      mode: 'parallel',
      tasks: [{ taskId: 't1', title: 'Task', status: 'running' }],
      prUrl: null,
    }
    props.setActiveBatch.mockImplementation((fn) => {
      if (typeof fn === 'function') {
        const result = fn(activeBatch)
        expect(result.tasks[0].status).toBe('completed')
      }
    })

    renderHook(() => useTaskSSE(props))
    capturedHandler('batch:task:completed', { batchId: 'b1', taskId: 't1' })
  })

  it('batch:task:failed updates task status to failed', () => {
    const props = createMockProps()
    const activeBatch = {
      id: 'b1',
      status: 'running',
      mode: 'parallel',
      tasks: [{ taskId: 't1', title: 'Task', status: 'running' }],
      prUrl: null,
    }
    props.setActiveBatch.mockImplementation((fn) => {
      if (typeof fn === 'function') {
        const result = fn(activeBatch)
        expect(result.tasks[0].status).toBe('failed')
      }
    })

    renderHook(() => useTaskSSE(props))
    capturedHandler('batch:task:failed', { batchId: 'b1', taskId: 't1' })
  })

  it('batch:completed updates tasks with prUrl and sets completed batch', () => {
    const props = createMockProps()
    const activeBatch = {
      id: 'b1',
      status: 'running',
      mode: 'parallel',
      tasks: [{ taskId: 't1', title: 'Task', status: 'completed' }],
      prUrl: null,
    }
    props.setActiveBatch.mockImplementation((fn) => {
      if (typeof fn === 'function') {
        fn(activeBatch)
      }
    })

    const existingTasks = [{ id: 't1', title: 'Task', status: 'done', batchId: 'b1', priority: 'medium', createdAt: '', updatedAt: '', labels: [], executionElapsedMs: 0, inboxRead: false, archived: false }]
    props.setTasks.mockImplementation((fn) => fn(existingTasks))

    renderHook(() => useTaskSSE(props))
    capturedHandler('batch:completed', { batchId: 'b1', prUrl: 'https://github.com/pr/1' })

    expect(props.setTasks).toHaveBeenCalled()
    expect(props.setCompletedBatch).toHaveBeenCalledWith(expect.objectContaining({
      taskIds: ['t1'],
      prUrl: 'https://github.com/pr/1',
      mode: 'parallel',
    }))
  })

  it('batch:failed sets timeout to clear batch', () => {
    const props = createMockProps()
    const activeBatch = {
      id: 'b1',
      status: 'running',
      mode: 'parallel',
      tasks: [{ taskId: 't1', title: 'Task', status: 'running' }],
      prUrl: null,
    }
    props.setActiveBatch.mockImplementation((fn) => {
      if (typeof fn === 'function') {
        fn(activeBatch)
      }
    })

    vi.useFakeTimers()
    renderHook(() => useTaskSSE(props))
    capturedHandler('batch:failed', { batchId: 'b1' })

    expect(props.setActiveBatch).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('settings:updated changes task deletion mode', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))

    capturedHandler('settings:updated', { taskDeletionMode: 'delete' })

    expect(props.setTaskDeletionMode).toHaveBeenCalledWith('delete')
  })

  it('tasks:bulk-created fetches tasks silently', () => {
    const props = createMockProps()
    renderHook(() => useTaskSSE(props))

    capturedHandler('tasks:bulk-created', { projectId: 'p1' })

    expect(props.fetchTasks).toHaveBeenCalledWith({ silent: true })
  })
})
