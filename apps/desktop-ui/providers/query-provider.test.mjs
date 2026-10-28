import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, act, waitFor, cleanup } from '@testing-library/react'
import { createElement } from 'react'

const state = vi.hoisted(() => ({
  listeners: new Set(),
  auth: { isAuthenticated: true, isLoading: false, user: { id: 'u1' } },
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => state.auth }))
vi.mock('@/providers/sse-provider', async () => {
  const React = await import('react')
  return {
    useSSESubscription: (handler) => {
      const ref = React.useRef(handler)
      React.useEffect(() => { ref.current = handler })
      React.useEffect(() => {
        const listener = (type, data, meta) => ref.current(type, data, meta)
        state.listeners.add(listener)
        return () => { state.listeners.delete(listener) }
      }, [])
    },
  }
})
vi.mock('@/lib/api/workspaces', () => ({
  fetchWorkspaces: vi.fn(async () => [{ id: 'w1', name: 'One' }]),
  fetchWorkspaceMembers: vi.fn(async () => [{ user: { id: 'u1', username: 'alice', avatarUrl: null } }]),
}))

const { fetchWorkspaces, fetchWorkspaceMembers } = await import('@/lib/api/workspaces')
const { QueryProvider, QuerySseBridge } = await import('./query-provider.tsx')
const { WorkspaceProvider, useWorkspace } = await import('@/hooks/use-workspace')
const { useTeamMembers } = await import('@/hooks/use-team-members')
const { createAppQueryClient } = await import('@/lib/query/client')
const { queryKeys } = await import('@/lib/query/keys')

function emit(type, data) {
  for (const listener of [...state.listeners]) listener(type, data, { stream: 'cloud', id: null })
}

function App({ client, children }) {
  return createElement(QueryProvider, { client },
    createElement(QuerySseBridge),
    createElement(WorkspaceProvider, null, children))
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  state.listeners.clear()
  state.auth = { isAuthenticated: true, isLoading: false, user: { id: 'u1' } }
  localStorage.clear()
})

describe('QueryProvider + QuerySseBridge', () => {
  it('shares one request between every consumer of a resource', async () => {
    const seen = []
    function Consumer({ name }) {
      const { members } = useTeamMembers()
      seen.push([name, members.length])
      return null
    }
    render(createElement(App, { client: createAppQueryClient() },
      createElement(Consumer, { name: 'board' }),
      createElement(Consumer, { name: 'filters' }),
      createElement(Consumer, { name: 'task-form' })))

    await waitFor(() => expect(seen.filter(([, n]) => n === 1).map(([name]) => name).sort()).toEqual(['board', 'filters', 'task-form']))
    expect(fetchWorkspaces).toHaveBeenCalledTimes(1)
    expect(fetchWorkspaceMembers).toHaveBeenCalledTimes(1)
  })

  it('applies each SSE event once: the bridge feeds the cache, providers only keep their selection', async () => {
    const client = createAppQueryClient()
    const setData = vi.spyOn(client, 'setQueryData')
    const { result } = renderHook(() => useWorkspace(), {
      wrapper: ({ children }) => createElement(App, { client }, children),
    })
    await waitFor(() => expect(result.current.activeWorkspace?.id).toBe('w1'))
    setData.mockClear()

    act(() => { emit('workspace:updated', { id: 'w1', name: 'Renamed' }) })

    expect(result.current.activeWorkspace?.name).toBe('Renamed')
    expect(setData.mock.calls.filter(([key]) => JSON.stringify(key) === JSON.stringify(queryKeys.workspaces.list()))).toHaveLength(1)

    act(() => { emit('workspace:left', { workspaceId: 'w1' }) })
    expect(result.current.workspaces).toEqual([])
    expect(result.current.activeWorkspace).toBeNull()
  })

  it('drops the cache when the user signs out or changes', async () => {
    const client = createAppQueryClient()
    const view = render(createElement(App, { client }))
    await waitFor(() => expect(client.getQueryData(queryKeys.workspaces.list())).toHaveLength(1))

    state.auth = { isAuthenticated: false, isLoading: false, user: null }
    view.rerender(createElement(App, { client }))
    await waitFor(() => expect(client.getQueryData(queryKeys.workspaces.list())).toBeUndefined())
  })
})
