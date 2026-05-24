import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement } from 'react'

const mockWorkspace = { id: 'ws1', name: 'Test' }
const mockProject = { id: 'p1', name: 'Proj' }

vi.mock('@/lib/api/chat', () => ({
  fetchChatSessions: vi.fn(),
  createChatSession: vi.fn(),
  archiveChatSession: vi.fn(),
  updateChatSession: vi.fn(),
}))

vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({ activeWorkspace: mockWorkspace }),
}))

vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ activeProject: mockProject }),
}))

const { fetchChatSessions, createChatSession, archiveChatSession, updateChatSession } = await import('@/lib/api/chat')
const { ChatSessionsProvider, useChatSessions } = await import('./use-chat-sessions.tsx')

function wrapper({ children }) {
  return createElement(ChatSessionsProvider, null, children)
}

describe('useChatSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchChatSessions.mockResolvedValue({ data: [] })
  })

  it('throws outside provider', () => {
    expect(() => {
      renderHook(() => useChatSessions())
    }).toThrow('useChatSessions must be used within ChatSessionsProvider')
  })

  it('loads sessions on mount when workspace is active', async () => {
    const sessions = [{ id: 's1', title: 'Session 1' }]
    fetchChatSessions.mockResolvedValue({ data: sessions })

    const { result } = renderHook(() => useChatSessions(), { wrapper })

    await waitFor(() => {
      expect(result.current.sessions).toEqual(sessions)
    })
    expect(fetchChatSessions).toHaveBeenCalledWith('ws1')
  })

  it('createSession calls API and adds to sessions list', async () => {
    const newSession = { id: 's2', title: 'New' }
    createChatSession.mockResolvedValue(newSession)

    const { result } = renderHook(() => useChatSessions(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let session
    await act(async () => {
      session = await result.current.createSession('p1')
    })

    expect(createChatSession).toHaveBeenCalledWith('ws1', 'p1')
    expect(session).toEqual(newSession)
    expect(result.current.sessions).toContainEqual(newSession)
    expect(result.current.activeSessionId).toBe('s2')
  })

  it('archiveSession removes from list', async () => {
    fetchChatSessions.mockResolvedValue({ data: [{ id: 's1', title: 'A' }] })
    archiveChatSession.mockResolvedValue(undefined)

    const { result } = renderHook(() => useChatSessions(), { wrapper })

    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    await act(async () => {
      await result.current.archiveSession('s1')
    })

    expect(archiveChatSession).toHaveBeenCalledWith('s1')
    expect(result.current.sessions).toHaveLength(0)
  })

  it('renameSession updates session title in list', async () => {
    fetchChatSessions.mockResolvedValue({ data: [{ id: 's1', title: 'Old' }] })
    updateChatSession.mockResolvedValue({ id: 's1', title: 'New Title' })

    const { result } = renderHook(() => useChatSessions(), { wrapper })

    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    await act(async () => {
      await result.current.renameSession('s1', 'New Title')
    })

    expect(updateChatSession).toHaveBeenCalledWith('s1', { title: 'New Title' })
    expect(result.current.sessions[0].title).toBe('New Title')
  })

  it('setActiveSessionId works', async () => {
    const { result } = renderHook(() => useChatSessions(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setActiveSessionId('s99')
    })

    expect(result.current.activeSessionId).toBe('s99')
  })
})
