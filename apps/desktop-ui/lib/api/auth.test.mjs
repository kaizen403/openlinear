import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApiFetch = vi.fn()

vi.mock('./fetch', () => ({
  apiFetch: mockApiFetch,
  ApiError: class ApiError extends Error {
    constructor(status, message, code, details) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
      this.name = 'ApiError'
    }
  },
  AuthExpiredError: class AuthExpiredError extends Error {
    constructor(message) {
      super(message)
      this.status = 401
      this.code = 'auth_expired'
      this.name = 'AuthExpiredError'
    }
  },
  NetworkError: class NetworkError extends Error {
    constructor(message, retryAfterMs) {
      super(message)
      this.retryAfterMs = retryAfterMs
      this.name = 'NetworkError'
    }
  },
}))

vi.mock('./client', () => ({
  getApiUrl: vi.fn().mockReturnValue('http://127.0.0.1:3001'),
  getSidecarApiUrl: vi.fn().mockReturnValue('http://127.0.0.1:3001'),
  resolveKnownSidecarApiUrl: vi.fn().mockResolvedValue('http://127.0.0.1:3001'),
}))

const { apiFetch, ApiError, AuthExpiredError, NetworkError } = await import('./fetch')

const {
  extractCallbackToken,
  fetchCurrentUser,
  getLoginUrl,
  logout,
  updateEmail,
  verifyCallbackToken,
} = await import('./auth.ts')

describe('extractCallbackToken', () => {
  it('extracts token from query string', () => {
    expect(extractCallbackToken('?token=abc123')).toBe('abc123')
  })

  it('extracts token from openlinear callback URL', () => {
    expect(extractCallbackToken('openlinear://callback?token=xyz')).toBe('xyz')
  })

  it('returns empty string for error callback', () => {
    expect(extractCallbackToken('openlinear://callback?error=denied')).toBe('')
  })

  it('extracts JWT pattern', () => {
    expect(extractCallbackToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc')).toBe('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc')
  })

  it('decodes URL-encoded token', () => {
    expect(extractCallbackToken('?token=abc%20123')).toBe('abc 123')
  })

  it('returns empty string for empty input', () => {
    expect(extractCallbackToken('')).toBe('')
    expect(extractCallbackToken('   ')).toBe('')
  })

  it('returns normalized string for non-URL non-JWT input', () => {
    expect(extractCallbackToken('random-string')).toBe('random-string')
  })

  it('handles openlinear callback without token', () => {
    expect(extractCallbackToken('openlinear://callback')).toBe('')
  })

  it('extracts token from full URL', () => {
    expect(extractCallbackToken('https://example.com?token=abc123')).toBe('abc123')
  })
})

describe('fetchCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('returns null when no token in localStorage', async () => {
    const result = await fetchCurrentUser()
    expect(result).toBeNull()
  })

  it('returns user data when token exists and request succeeds', async () => {
    const user = { id: 'u1', username: 'test' }
    localStorage.setItem('token', 'tok123')
    apiFetch.mockResolvedValue(user)
    const result = await fetchCurrentUser()
    expect(result).toEqual(user)
  })

  it('returns null on AuthExpiredError', async () => {
    localStorage.setItem('token', 'tok123')
    apiFetch.mockRejectedValue(new AuthExpiredError('Session expired'))
    const result = await fetchCurrentUser()
    expect(result).toBeNull()
  })

  it('returns null on NetworkError', async () => {
    localStorage.setItem('token', 'tok123')
    apiFetch.mockRejectedValue(new NetworkError('Offline'))
    const result = await fetchCurrentUser()
    expect(result).toBeNull()
  })

  it('returns null on 401 ApiError', async () => {
    localStorage.setItem('token', 'tok123')
    apiFetch.mockRejectedValue(new ApiError(401, 'Unauthorized', 'auth_expired'))
    const result = await fetchCurrentUser()
    expect(result).toBeNull()
  })

  it('returns null on 500 ApiError', async () => {
    localStorage.setItem('token', 'tok123')
    apiFetch.mockRejectedValue(new ApiError(500, 'Server Error', 'internal'))
    const result = await fetchCurrentUser()
    expect(result).toBeNull()
  })
})

describe('getLoginUrl', () => {
  it('returns non-desktop login URL', () => {
    const url = getLoginUrl()
    expect(url).toContain('/api/auth/github')
  })
})

describe('logout', () => {
  it('removes token and redirects', () => {
    localStorage.setItem('token', 'tok123')
    logout()
    expect(localStorage.getItem('token')).toBeNull()
  })
})

describe('updateEmail', () => {
  it('calls apiFetch with PATCH', async () => {
    apiFetch.mockResolvedValue({ id: 'u1', email: 'test@example.com' })
    const result = await updateEmail('test@example.com')
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ email: 'test@example.com' }),
    })
    expect(result).toEqual({ id: 'u1', email: 'test@example.com' })
  })
})

describe('verifyCallbackToken', () => {
  it('returns user when token is valid', async () => {
    const user = { id: 'u1', username: 'test' }
    apiFetch.mockResolvedValue(user)
    const result = await verifyCallbackToken('valid-token')
    expect(result).toEqual(user)
  })
})
