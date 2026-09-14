import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@/lib/api', () => ({
  fetchCurrentUser: vi.fn(),
  getActiveRepository: vi.fn(),
  logout: vi.fn(),
  verifyCallbackToken: vi.fn(),
}))

const { fetchCurrentUser, getActiveRepository, logout, verifyCallbackToken } = await import('@/lib/api')
const { AuthProvider, useAuth } = await import('./use-auth.tsx')

function wrapper({ children }) {
  return createElement(AuthProvider, null, children)
}

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.getItem.mockReturnValue(null)
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '', pathname: '/', href: 'http://localhost/' },
      writable: true,
      configurable: true,
    })
  })

  it('throws outside provider', () => {
    expect(() => {
      renderHook(() => useAuth())
    }).toThrow('useAuth must be used within an AuthProvider')
  })

  it('starts with isLoading true and no user', () => {
    const { result } = renderHook(() => useAuth(), { wrapper })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.user).toBeNull()
    expect(result.current.isAuthenticated).toBe(false)
  })

  it('loads user on mount when token exists', async () => {
    const user = { id: 'u1', username: 'test' }
    localStorage.getItem.mockReturnValue('tok123')
    fetchCurrentUser.mockResolvedValue(user)
    getActiveRepository.mockResolvedValue(null)

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.user).toEqual(user)
    expect(result.current.isAuthenticated).toBe(true)
  })

  it('sets isLoading false when no token', async () => {
    localStorage.getItem.mockReturnValue(null)
    fetchCurrentUser.mockResolvedValue(null)

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.user).toBeNull()
  })

  it('handles fetchCurrentUser error gracefully', async () => {
    localStorage.getItem.mockReturnValue('tok123')
    fetchCurrentUser.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.user).toBeNull()
    expect(result.current.isAuthenticated).toBe(false)
  })

  it('refreshUser calls fetchCurrentUser', async () => {
    const user = { id: 'u1', username: 'test' }
    localStorage.getItem.mockReturnValue('tok123')
    fetchCurrentUser.mockResolvedValue(user)
    getActiveRepository.mockResolvedValue(null)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    fetchCurrentUser.mockResolvedValue({ id: 'u2', username: 'updated' })
    await act(async () => {
      await result.current.refreshUser()
    })

    expect(result.current.user).toEqual({ id: 'u2', username: 'updated' })
  })

  it('refreshActiveRepository calls getActiveRepository', async () => {
    const repo = { id: 'r1', name: 'Repo' }
    localStorage.getItem.mockReturnValue('tok123')
    fetchCurrentUser.mockResolvedValue({ id: 'u1' })
    getActiveRepository.mockResolvedValue(repo)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    getActiveRepository.mockResolvedValue({ id: 'r2', name: 'Repo2' })
    await act(async () => {
      await result.current.refreshActiveRepository()
    })

    expect(result.current.activeRepository).toEqual({ id: 'r2', name: 'Repo2' })
  })

  it('logout clears user and repository', async () => {
    localStorage.getItem.mockReturnValue('tok123')
    fetchCurrentUser.mockResolvedValue({ id: 'u1' })
    getActiveRepository.mockResolvedValue({ id: 'r1' })

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.user).not.toBeNull()

    act(() => {
      result.current.logout()
    })

    expect(result.current.user).toBeNull()
    expect(result.current.activeRepository).toBeNull()
    expect(logout).toHaveBeenCalled()
  })

  it('dispatches auth:expired event and clears user', async () => {
    localStorage.getItem.mockReturnValue('tok123')
    fetchCurrentUser.mockResolvedValue({ id: 'u1' })
    getActiveRepository.mockResolvedValue(null)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.user).not.toBeNull()

    act(() => {
      window.dispatchEvent(new CustomEvent('auth:expired'))
    })

    await waitFor(() => {
      expect(result.current.user).toBeNull()
    })
    expect(result.current.activeRepository).toBeNull()
  })

  it('extracts error from URL query params and logs it', async () => {
    const originalSearch = window.location.search
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?error=auth_denied', pathname: '/' },
      writable: true,
      configurable: true,
    })
    fetchCurrentUser.mockResolvedValue(null)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    consoleSpy.mockRestore()

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: originalSearch },
      writable: true,
      configurable: true,
    })
  })
})
