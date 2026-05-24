import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({ activeWorkspace: { id: 'ws1' } }),
}))

vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ activeProject: { id: 'p1' } }),
}))

const { ChatScopeProvider, useChatScope } = await import('./use-chat-scope.tsx')

function wrapper({ children }) {
  return createElement(ChatScopeProvider, null, children)
}

describe('useChatScope', () => {
  it('throws outside provider', () => {
    expect(() => {
      renderHook(() => useChatScope())
    }).toThrow('useChatScope must be used within ChatScopeProvider')
  })

  it('scope defaults to workspace', () => {
    const { result } = renderHook(() => useChatScope(), { wrapper })
    expect(result.current.scope).toBe('workspace')
  })

  it('scopeProjectId is null when scope is workspace', () => {
    const { result } = renderHook(() => useChatScope(), { wrapper })
    expect(result.current.scopeProjectId).toBeNull()
  })

  it('switching scope to project returns project id as scopeProjectId', () => {
    const { result } = renderHook(() => useChatScope(), { wrapper })

    act(() => {
      result.current.setScope('project')
    })

    expect(result.current.scope).toBe('project')
    expect(result.current.scopeProjectId).toBe('p1')
  })

  it('scopeWorkspaceId always returns the active workspace id', () => {
    const { result } = renderHook(() => useChatScope(), { wrapper })
    expect(result.current.scopeWorkspaceId).toBe('ws1')

    act(() => {
      result.current.setScope('project')
    })

    expect(result.current.scopeWorkspaceId).toBe('ws1')
  })
})
