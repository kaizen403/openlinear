import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}))

vi.mock('@/lib/api/workspaces', () => ({
  fetchWorkspaces: vi.fn(),
}))

const sseSubscriptionCallbacks = []

vi.mock('@/providers/sse-provider', () => ({
  useSSESubscription: (callback) => { sseSubscriptionCallbacks.push(callback) },
}))

const { fetchWorkspaces } = await import('@/lib/api/workspaces')
const { WorkspaceProvider, useWorkspace } = await import('./use-workspace.tsx')

function wrapper({ children }) {
  return createElement(WorkspaceProvider, null, children)
}

describe('useWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.getItem.mockReturnValue(null)
  })

  it('throws outside provider', () => {
    expect(() => {
      renderHook(() => useWorkspace())
    }).toThrow('useWorkspace must be used within a WorkspaceProvider')
  })

  it('loads workspaces on mount', async () => {
    const workspaces = [{ id: 'ws1', name: 'Test' }]
    fetchWorkspaces.mockResolvedValue(workspaces)

    const { result } = renderHook(() => useWorkspace(), { wrapper })

    await waitFor(() => {
      expect(result.current.workspaces).toEqual(workspaces)
    })
    expect(result.current.isLoading).toBe(false)
  })

  it('sets first workspace as active when no saved id', async () => {
    const workspaces = [{ id: 'ws1', name: 'First' }]
    fetchWorkspaces.mockResolvedValue(workspaces)

    const { result } = renderHook(() => useWorkspace(), { wrapper })

    await waitFor(() => {
      expect(result.current.activeWorkspace).toEqual(workspaces[0])
    })
    expect(localStorage.setItem).toHaveBeenCalledWith('openlinear:activeWorkspaceId', 'ws1')
  })

  it('restores saved workspace from localStorage', async () => {
    localStorage.getItem.mockReturnValue('ws2')
    const workspaces = [{ id: 'ws1', name: 'First' }, { id: 'ws2', name: 'Second' }]
    fetchWorkspaces.mockResolvedValue(workspaces)

    const { result } = renderHook(() => useWorkspace(), { wrapper })

    await waitFor(() => {
      expect(result.current.activeWorkspace).toEqual(workspaces[1])
    })
  })

  it('falls back to first workspace when saved id not found', async () => {
    localStorage.getItem.mockReturnValue('ws99')
    const workspaces = [{ id: 'ws1', name: 'First' }]
    fetchWorkspaces.mockResolvedValue(workspaces)

    const { result } = renderHook(() => useWorkspace(), { wrapper })

    await waitFor(() => {
      expect(result.current.activeWorkspace).toEqual(workspaces[0])
    })
    expect(localStorage.setItem).toHaveBeenCalledWith('openlinear:activeWorkspaceId', 'ws1')
  })

  it('setActiveWorkspace updates active workspace and saves to localStorage', async () => {
    const workspaces = [{ id: 'ws1', name: 'First' }, { id: 'ws2', name: 'Second' }]
    fetchWorkspaces.mockResolvedValue(workspaces)

    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2))

    act(() => {
      result.current.setActiveWorkspace(workspaces[1])
    })

    expect(result.current.activeWorkspace).toEqual(workspaces[1])
    expect(localStorage.setItem).toHaveBeenCalledWith('openlinear:activeWorkspaceId', 'ws2')
  })

  it('refreshWorkspaces reloads workspaces', async () => {
    const workspaces = [{ id: 'ws1', name: 'First' }]
    fetchWorkspaces.mockResolvedValue(workspaces)

    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    const updated = [{ id: 'ws1', name: 'Updated' }]
    fetchWorkspaces.mockResolvedValue(updated)

    await act(async () => {
      await result.current.refreshWorkspaces()
    })

    expect(result.current.workspaces).toEqual(updated)
  })

  it('handles fetchWorkspaces error gracefully', async () => {
    fetchWorkspaces.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useWorkspace(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.workspaces).toEqual([])
    expect(result.current.activeWorkspace).toBeNull()
  })

  it('sets empty workspaces when not authenticated', async () => {
    vi.doMock('@/hooks/use-auth', () => ({
      useAuth: () => ({ isAuthenticated: false, isLoading: false }),
    }))

    const { WorkspaceProvider: WP2, useWorkspace: UW2 } = await import('./use-workspace.tsx')
    const { result } = renderHook(() => UW2(), {
      wrapper: ({ children }) => createElement(WP2, null, children),
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.workspaces).toEqual([])

    vi.doUnmock('@/hooks/use-auth')
  })
})

describe('useWorkspace SSE subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sseSubscriptionCallbacks.length = 0
  })

  it('handles workspace:joined by adding new workspace', async () => {
    fetchWorkspaces.mockResolvedValue([{ id: 'ws1', name: 'First' }])
    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    const newWs = { id: 'ws2', name: 'Joined' }
    act(() => {
      sseSubscriptionCallbacks[0]('workspace:joined', newWs)
    })

    await waitFor(() => expect(result.current.workspaces).toHaveLength(2))
    expect(result.current.workspaces.find((w) => w.id === 'ws2')).toEqual(newWs)
  })

  it('handles workspace:joined by updating existing workspace', async () => {
    fetchWorkspaces.mockResolvedValue([{ id: 'ws1', name: 'First' }])
    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    const updated = { id: 'ws1', name: 'Updated' }
    act(() => {
      sseSubscriptionCallbacks[0]('workspace:joined', updated)
    })

    await waitFor(() => expect(result.current.workspaces[0].name).toBe('Updated'))
  })

  it('handles workspace:updated', async () => {
    fetchWorkspaces.mockResolvedValue([{ id: 'ws1', name: 'First' }])
    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    const updated = { id: 'ws1', name: 'Updated' }
    act(() => {
      sseSubscriptionCallbacks[0]('workspace:updated', updated)
    })

    await waitFor(() => expect(result.current.workspaces[0].name).toBe('Updated'))
    expect(result.current.activeWorkspace?.name).toBe('Updated')
  })

  it('handles workspace:left by removing workspace', async () => {
    fetchWorkspaces.mockResolvedValue([{ id: 'ws1', name: 'First' }])
    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    act(() => {
      sseSubscriptionCallbacks[0]('workspace:left', { workspaceId: 'ws1' })
    })

    await waitFor(() => expect(result.current.workspaces).toHaveLength(0))
    expect(result.current.activeWorkspace).toBeNull()
  })

  it('handles workspace:deleted by removing workspace', async () => {
    fetchWorkspaces.mockResolvedValue([{ id: 'ws1', name: 'First' }])
    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    act(() => {
      sseSubscriptionCallbacks[0]('workspace:deleted', { id: 'ws1' })
    })

    await waitFor(() => expect(result.current.workspaces).toHaveLength(0))
    expect(result.current.activeWorkspace).toBeNull()
  })

  it('ignores workspace:left when workspace is not active', async () => {
    fetchWorkspaces.mockResolvedValue([{ id: 'ws1', name: 'First' }])
    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    act(() => {
      sseSubscriptionCallbacks[0]('workspace:left', { workspaceId: 'ws99' })
    })

    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
    expect(result.current.activeWorkspace).not.toBeNull()
  })

  it('ignores workspace:joined with no id', async () => {
    fetchWorkspaces.mockResolvedValue([{ id: 'ws1', name: 'First' }])
    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    act(() => {
      sseSubscriptionCallbacks[0]('workspace:joined', {})
    })

    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
  })

  it('ignores workspace:updated with no id', async () => {
    fetchWorkspaces.mockResolvedValue([{ id: 'ws1', name: 'First' }])
    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    act(() => {
      sseSubscriptionCallbacks[0]('workspace:updated', {})
    })

    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
  })

  it('ignores workspace:left with no id', async () => {
    fetchWorkspaces.mockResolvedValue([{ id: 'ws1', name: 'First' }])
    const { result } = renderHook(() => useWorkspace(), { wrapper })
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))

    act(() => {
      sseSubscriptionCallbacks[0]('workspace:left', {})
    })

    await waitFor(() => expect(result.current.workspaces).toHaveLength(1))
  })
})
