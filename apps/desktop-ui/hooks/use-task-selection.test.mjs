import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/components/board/use-kanban-board', () => ({
  COLUMNS: [
    { id: 'todo', status: 'todo' },
    { id: 'in_progress', status: 'in_progress' },
    { id: 'done', status: 'done' },
    { id: 'cancelled', status: 'cancelled' },
  ],
}))

const { useTaskSelection } = await import('./use-task-selection.ts')

function createTask(id, status) {
  return { id, title: `Task ${id}`, status, priority: 'medium', createdAt: '', updatedAt: '', labels: [], executionElapsedMs: 0, inboxRead: false, archived: false }
}

describe('useTaskSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts with empty selection', () => {
    const tasks = [createTask('t1', 'todo')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))
    expect(result.current.selectedTaskIds).toEqual(new Set())
    expect(result.current.selectionActive).toBe(false)
    expect(result.current.selectedTaskId).toBeNull()
  })

  it('toggleTaskSelect adds task to selection', () => {
    const tasks = [createTask('t1', 'todo')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))

    act(() => {
      result.current.toggleTaskSelect('t1')
    })

    expect(result.current.selectedTaskIds).toEqual(new Set(['t1']))
    expect(result.current.selectionActive).toBe(true)
  })

  it('toggleTaskSelect removes already selected task', () => {
    const tasks = [createTask('t1', 'todo')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))

    act(() => {
      result.current.toggleTaskSelect('t1')
    })
    act(() => {
      result.current.toggleTaskSelect('t1')
    })

    expect(result.current.selectedTaskIds).toEqual(new Set())
    expect(result.current.selectionActive).toBe(false)
  })

  it('toggleTaskSelect ignores batch-locked task ids', () => {
    const tasks = [createTask('t1', 'todo'), createTask('t2', 'in_progress')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: ['t1'] }))

    act(() => {
      result.current.toggleTaskSelect('t1')
    })

    expect(result.current.selectedTaskIds).toEqual(new Set())
  })

  it('shift-click selects range between last selected and target', () => {
    const tasks = [
      createTask('t1', 'todo'),
      createTask('t2', 'todo'),
      createTask('t3', 'todo'),
    ]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))

    act(() => {
      result.current.toggleTaskSelect('t1')
    })
    act(() => {
      result.current.toggleTaskSelect('t3', { shift: true })
    })

    expect(result.current.selectedTaskIds).toEqual(new Set(['t1', 't2', 't3']))
  })

  it('clearSelection resets everything', () => {
    const tasks = [createTask('t1', 'todo')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))

    act(() => {
      result.current.toggleTaskSelect('t1')
    })
    expect(result.current.selectionActive).toBe(true)

    act(() => {
      result.current.clearSelection()
    })

    expect(result.current.selectedTaskIds).toEqual(new Set())
    expect(result.current.selectionActive).toBe(false)
    expect(result.current.lastSelectedIdRef.current).toBeNull()
  })

  it('selectAllVisible selects all non-batch tasks', () => {
    const tasks = [createTask('t1', 'todo'), createTask('t2', 'todo'), createTask('t3', 'in_progress')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: ['t3'] }))

    act(() => {
      result.current.selectAllVisible()
    })

    expect(result.current.selectedTaskIds).toEqual(new Set(['t1', 't2']))
  })

  it('toggleColumnSelectAll selects all tasks in a column', () => {
    const tasks = [createTask('t1', 'todo'), createTask('t2', 'todo'), createTask('t3', 'in_progress')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))

    act(() => {
      result.current.toggleColumnSelectAll('todo')
    })

    expect(result.current.selectedTaskIds).toEqual(new Set(['t1', 't2']))
    expect(result.current.selectingColumns).toEqual(new Set())
  })

  it('toggleColumnSelectAll deselects all when all already selected', () => {
    const tasks = [createTask('t1', 'todo'), createTask('t2', 'todo')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))

    act(() => {
      result.current.toggleColumnSelectAll('todo')
    })
    expect(result.current.selectedTaskIds).toEqual(new Set(['t1', 't2']))

    act(() => {
      result.current.toggleColumnSelectAll('todo')
    })

    expect(result.current.selectedTaskIds).toEqual(new Set())
  })

  it('toggleColumnSelection toggles column tracking state', () => {
    const tasks = [createTask('t1', 'todo')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))

    act(() => {
      result.current.toggleColumnSelection('todo')
    })

    expect(result.current.selectingColumns).toEqual(new Set(['todo']))

    act(() => {
      result.current.toggleColumnSelection('todo')
    })

    expect(result.current.selectingColumns).toEqual(new Set())
  })

  it('meta-click toggles individual selection without range', () => {
    const tasks = [createTask('t1', 'todo'), createTask('t2', 'todo')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))

    act(() => {
      result.current.toggleTaskSelect('t1', { meta: true })
    })
    act(() => {
      result.current.toggleTaskSelect('t2', { meta: true })
    })

    expect(result.current.selectedTaskIds).toEqual(new Set(['t1', 't2']))
  })

  it('clearSelection resets selection state but not selectedTaskId', () => {
    const tasks = [createTask('t1', 'todo')]
    const { result } = renderHook(() => useTaskSelection({ tasks, filteredTasks: tasks, batchTaskIds: [] }))

    act(() => {
      result.current.setSelectedTaskId('t1')
    })
    expect(result.current.selectedTaskId).toBe('t1')

    act(() => {
      result.current.toggleTaskSelect('t1')
    })
    expect(result.current.selectionActive).toBe(true)
    expect(result.current.selectedTaskIds).toEqual(new Set(['t1']))

    act(() => {
      result.current.clearSelection()
    })

    expect(result.current.selectionActive).toBe(false)
    expect(result.current.selectedTaskIds).toEqual(new Set())
    expect(result.current.selectingColumns).toEqual(new Set())
    expect(result.current.lastSelectedIdRef.current).toBeNull()
  })
})
