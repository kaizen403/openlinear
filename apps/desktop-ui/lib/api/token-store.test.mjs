import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const persisted = new Map()
const store = {
  get: vi.fn(async (key) => persisted.get(key)),
  set: vi.fn(async (key, value) => {
    persisted.set(key, value)
  }),
  delete: vi.fn(async (key) => {
    persisted.delete(key)
  }),
  save: vi.fn(async () => {}),
}
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn(async () => store) } }))

const tokenStore = await import('./token-store.ts')
const {
  clearStoredSession,
  getRefreshToken,
  getToken,
  initTokenStore,
  resetTokenStoreForTests,
  setRefreshToken,
  setToken,
} = tokenStore

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  persisted.clear()
  vi.clearAllMocks()
  localStorage.clear()
  resetTokenStoreForTests()
  window.__TAURI_INTERNALS__ = undefined
})

afterEach(() => {
  window.__TAURI_INTERNALS__ = undefined
})

describe('web build', () => {
  it('keeps the access token in localStorage (unchanged behaviour)', async () => {
    await initTokenStore()
    setToken('access-1')
    expect(localStorage.getItem('token')).toBe('access-1')
    expect(getToken()).toBe('access-1')
  })

  it('reads the access token from localStorage on every call (another tab may refresh it)', async () => {
    await initTokenStore()
    setToken('access-1')
    localStorage.setItem('token', 'access-from-other-tab')
    expect(getToken()).toBe('access-from-other-tab')
  })

  it('never keeps a refresh token where page script can read it', async () => {
    await initTokenStore()
    setRefreshToken('refresh-1')
    expect(localStorage.getItem('refreshToken')).toBeNull()
    expect(getRefreshToken()).toBeNull()
  })

  it('deletes a refresh token left in localStorage by older builds', async () => {
    localStorage.setItem('refreshToken', 'legacy-refresh')
    await initTokenStore()
    expect(localStorage.getItem('refreshToken')).toBeNull()
    expect(getRefreshToken()).toBeNull()
  })
})

describe('desktop build', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {}
  })

  it('restores both tokens from the Tauri store after a restart', async () => {
    persisted.set('token', 'access-1')
    persisted.set('refreshToken', 'refresh-1')
    await initTokenStore()
    expect(getToken()).toBe('access-1')
    // Regression: the refresh token used to be lost on every restart.
    expect(getRefreshToken()).toBe('refresh-1')
  })

  it('persists writes to the store and keeps them out of localStorage', async () => {
    await initTokenStore()
    setToken('access-2')
    setRefreshToken('refresh-2')
    await flush()
    expect(persisted.get('token')).toBe('access-2')
    expect(persisted.get('refreshToken')).toBe('refresh-2')
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('refreshToken')).toBeNull()
  })

  it('lets a write made before the store loads win over the persisted value', async () => {
    persisted.set('token', 'stale-access')
    persisted.set('refreshToken', 'stale-refresh')
    setToken('new-access')
    setRefreshToken('new-refresh')
    await initTokenStore()
    expect(getToken()).toBe('new-access')
    expect(getRefreshToken()).toBe('new-refresh')
  })

  it('migrates tokens left in localStorage by pre-store builds', async () => {
    localStorage.setItem('token', 'legacy-access')
    localStorage.setItem('refreshToken', 'legacy-refresh')
    await initTokenStore()
    expect(getToken()).toBe('legacy-access')
    expect(getRefreshToken()).toBe('legacy-refresh')
    expect(persisted.get('token')).toBe('legacy-access')
    expect(persisted.get('refreshToken')).toBe('legacy-refresh')
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('refreshToken')).toBeNull()
  })

  it('clearStoredSession forgets both tokens', async () => {
    await initTokenStore()
    setToken('access-3')
    setRefreshToken('refresh-3')
    clearStoredSession()
    await flush()
    expect(getToken()).toBeNull()
    expect(getRefreshToken()).toBeNull()
    expect(persisted.has('token')).toBe(false)
    expect(persisted.has('refreshToken')).toBe(false)
  })
})
