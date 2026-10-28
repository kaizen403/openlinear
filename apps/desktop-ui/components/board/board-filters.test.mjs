import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, renderHook, act } from '@testing-library/react'
import { createElement } from 'react'

const nav = vi.hoisted(() => ({ params: new URLSearchParams(''), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ replace: nav.replace }),
}))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('@/hooks/use-team-members', () => ({ useTeamMembers: () => ({ members: [] }) }))

const { BoardFilters, matchesDependencyFilter, parseDependencyFilter, useBoardFilters } = await import('./board-filters.tsx')

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('board dependency filter (W17a)', () => {
  it('keeps blocked tasks, or open tasks nothing blocks', () => {
    const blocked = new Set(['b'])
    expect(parseDependencyFilter('blocked')).toBe('blocked')
    expect(parseDependencyFilter('nope')).toBeNull()
    expect(matchesDependencyFilter({ id: 'b', status: 'todo' }, 'blocked', blocked)).toBe(true)
    expect(matchesDependencyFilter({ id: 'a', status: 'todo' }, 'blocked', blocked)).toBe(false)
    expect(matchesDependencyFilter({ id: 'a', status: 'in_progress' }, 'ready', blocked)).toBe(true)
    expect(matchesDependencyFilter({ id: 'b', status: 'todo' }, 'ready', blocked)).toBe(false)
    expect(matchesDependencyFilter({ id: 'a', status: 'done' }, 'ready', blocked)).toBe(false)
    expect(matchesDependencyFilter({ id: 'a', status: 'done' }, null, blocked)).toBe(true)
  })

  it('toggles Blocked / Ready (one at a time) from the filter bar', () => {
    const onChange = vi.fn()
    const value = { assigneeIds: [], groupByAssignee: false, dependency: null }
    const { rerender } = render(createElement(BoardFilters, { value, onChange }))
    fireEvent.click(screen.getByRole('button', { name: 'Ready' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...value, dependency: 'ready' })
    rerender(createElement(BoardFilters, { value: { ...value, dependency: 'ready' }, onChange }))
    expect(screen.getByRole('button', { name: 'Ready' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Ready' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...value, dependency: null })
  })

  it('Run ready asks first, then runs (only with the Ready filter on)', () => {
    const onRunReady = vi.fn()
    const value = { assigneeIds: [], groupByAssignee: false, dependency: 'ready' }
    const { rerender } = render(createElement(BoardFilters, { value, onChange: vi.fn(), readyCount: 3, onRunReady }))
    fireEvent.click(screen.getByRole('button', { name: 'Run 3 ready' }))
    expect(screen.getByText('Run 3 ready tasks?')).toBeTruthy()
    expect(onRunReady).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(onRunReady).toHaveBeenCalledTimes(1)
    rerender(createElement(BoardFilters, { value: { ...value, dependency: 'blocked' }, onChange: vi.fn(), readyCount: 3, onRunReady }))
    expect(screen.queryByRole('button', { name: /ready$/ })).toBeNull()
  })

  it('writes every filter in one URL update, so changes never undo each other', () => {
    nav.params = new URLSearchParams('assignee=u1&deps=blocked&id=p1')
    const { result } = renderHook(() => useBoardFilters())
    expect(result.current).toMatchObject({ assigneeIds: ['u1'], dependency: 'blocked', groupByAssignee: false })
    act(() => result.current.setFilters({ assigneeIds: ['u2'], groupByAssignee: true, dependency: 'ready' }))
    expect(nav.replace).toHaveBeenCalledTimes(1)
    const url = new URLSearchParams(nav.replace.mock.calls[0][0].slice(1))
    expect(Object.fromEntries(url)).toEqual({ assignee: 'u2', deps: 'ready', id: 'p1', groupBy: 'assignee' })
  })
})
