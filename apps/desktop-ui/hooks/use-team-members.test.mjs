import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({ activeWorkspace: { id: 'ws1', name: 'Test' } }),
}))

vi.mock('@/lib/api/workspaces', () => ({
  fetchWorkspaceMembers: vi.fn(),
}))

const { fetchWorkspaceMembers } = await import('@/lib/api/workspaces')
const { useTeamMembers } = await import('./use-team-members.ts')

describe('useTeamMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads members on mount', async () => {
    const members = [
      {
        user: { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: 'https://a.com/1.png' },
        role: 'owner',
      },
      {
        user: { id: 'u2', username: 'bob', displayName: null, avatarUrl: null },
        role: 'member',
      },
    ]
    fetchWorkspaceMembers.mockResolvedValue(members)

    const { result } = renderHook(() => useTeamMembers())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.members).toHaveLength(2)
    expect(result.current.members[0].username).toBe('alice')
    expect(result.current.members[1].username).toBe('bob')
  })

  it('returns empty members when no workspace', async () => {
    vi.doMock('@/hooks/use-workspace', () => ({
      useWorkspace: () => ({ activeWorkspace: null }),
    }))

    const { useTeamMembers: useTeamMembers2 } = await import('./use-team-members.ts')
    const { result } = renderHook(() => useTeamMembers2())

    await waitFor(() => {
      expect(result.current.members).toEqual([])
    })

    vi.doUnmock('@/hooks/use-workspace')
  })

  it('handles fetchWorkspaceMembers error gracefully', async () => {
    fetchWorkspaceMembers.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useTeamMembers())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.members).toEqual([])
  })

  it('filters out members with null user', async () => {
    const members = [
      { user: null, role: 'member' },
      { user: { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null }, role: 'member' },
    ]
    fetchWorkspaceMembers.mockResolvedValue(members)

    const { result } = renderHook(() => useTeamMembers())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.members).toHaveLength(1)
    expect(result.current.members[0].username).toBe('alice')
  })
})
