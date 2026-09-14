import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getApiUrl, getSidecarApiUrl, getAuthToken, getAuthHeader } = await import('./client.ts')

describe('client.ts URL helpers', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('getAuthToken returns null when no token', () => {
    expect(getAuthToken()).toBeNull()
  })

  it('getAuthToken returns token from localStorage', () => {
    localStorage.setItem('token', 'abc123')
    expect(getAuthToken()).toBe('abc123')
  })

  it('getAuthHeader includes Bearer when token exists', () => {
    localStorage.setItem('token', 'tok123')
    const headers = getAuthHeader()
    expect(headers).toMatchObject({ Authorization: 'Bearer tok123' })
  })

  it('getApiUrl returns default API URL in non-desktop', () => {
    expect(getApiUrl()).toContain('http://127.0.0.1:3001')
  })

  it('getSidecarApiUrl returns default sidecar URL', () => {
    expect(getSidecarApiUrl()).toContain('http://127.0.0.1:3001')
  })
})
