import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

const client = await import('./client.ts')
const tokenStore = await import('./token-store.ts')
const {
  CLOUD_DEFAULT,
  DEFAULT_SIDECAR_URL,
  DEFAULT_WEB_API_URL,
  getApiBaseUrl,
  getApiUrl,
  getApiUrlForPath,
  getAuthHeader,
  getAuthToken,
  getCloudApiUrl,
  getSidecarApiUrl,
  isDesktopRuntime,
  isHealthyPayload,
  resolveApiBaseUrl,
  resetSidecarUrlCacheForTests,
} = client

const ENV_KEYS = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_CLOUD_API_URL', 'NEXT_PUBLIC_SIDECAR_URL']
const savedEnv = {}

function setDesktop(enabled) {
  window.__TAURI_INTERNALS__ = enabled ? {} : undefined
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  setDesktop(false)
  invoke.mockReset()
  invoke.mockResolvedValue(null)
  resetSidecarUrlCacheForTests()
  tokenStore.resetTokenStoreForTests()
  localStorage.clear()
})

afterEach(() => {
  setDesktop(false)
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('runtime detection', () => {
  it('treats an empty __TAURI_INTERNALS__ (the unit-test default) as the web', () => {
    expect('__TAURI_INTERNALS__' in window).toBe(true)
    expect(isDesktopRuntime()).toBe(false)
  })

  it('detects the Tauri shell', () => {
    setDesktop(true)
    expect(isDesktopRuntime()).toBe(true)
  })
})

describe('web runtime URLs', () => {
  it('defaults to the local cloud API and the local sidecar on different ports', () => {
    expect(getCloudApiUrl()).toBe(DEFAULT_WEB_API_URL)
    expect(DEFAULT_WEB_API_URL).toBe('http://127.0.0.1:3001')
    // Regression: the sidecar default used to be the API port (3001).
    expect(getSidecarApiUrl()).toBe(DEFAULT_SIDECAR_URL)
    expect(DEFAULT_SIDECAR_URL).toBe('http://127.0.0.1:3003')
  })

  it('reads NEXT_PUBLIC_API_URL for the cloud API, never for the sidecar', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://openlinear.example/'
    expect(getCloudApiUrl()).toBe('https://openlinear.example')
    expect(getSidecarApiUrl()).toBe('http://127.0.0.1:3003')
  })

  it('falls back to NEXT_PUBLIC_CLOUD_API_URL for the cloud API', () => {
    process.env.NEXT_PUBLIC_CLOUD_API_URL = 'https://cloud.example'
    expect(getCloudApiUrl()).toBe('https://cloud.example')
  })

  it('reads NEXT_PUBLIC_SIDECAR_URL and normalizes loopback hosts', () => {
    process.env.NEXT_PUBLIC_SIDECAR_URL = 'http://localhost:4199'
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4101'
    expect(getSidecarApiUrl()).toBe('http://127.0.0.1:4199')
    expect(getCloudApiUrl()).toBe('http://127.0.0.1:4101')
  })

  it('resolves base URLs per target without waiting on Tauri', async () => {
    expect(await resolveApiBaseUrl('cloud')).toBe('http://127.0.0.1:3001')
    expect(await resolveApiBaseUrl('sidecar')).toBe('http://127.0.0.1:3003')
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('desktop runtime URLs', () => {
  beforeEach(() => setDesktop(true))

  it('sends cloud traffic to the production API by default', () => {
    expect(getCloudApiUrl()).toBe(CLOUD_DEFAULT)
    expect(CLOUD_DEFAULT).toBe('https://openlinear.tech')
  })

  it('lets NEXT_PUBLIC_CLOUD_API_URL override the cloud API, ignoring the web variable', () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3001'
    process.env.NEXT_PUBLIC_CLOUD_API_URL = 'https://staging.openlinear.example'
    expect(getCloudApiUrl()).toBe('https://staging.openlinear.example')
  })

  it('never resolves the cloud API to the sidecar (regression)', async () => {
    invoke.mockImplementation(async (command) => (command === 'get_api_server_port' ? 45678 : null))
    expect(await resolveApiBaseUrl('sidecar')).toBe('http://127.0.0.1:45678')
    expect(getApiUrl()).toBe(CLOUD_DEFAULT)
    expect(getCloudApiUrl()).toBe(CLOUD_DEFAULT)
    expect(getApiBaseUrl('cloud')).toBe(CLOUD_DEFAULT)
  })

  it('uses the port the shell reports for the sidecar and caches it', async () => {
    invoke.mockImplementation(async (command) => (command === 'get_api_server_port' ? 45678 : null))
    expect(await resolveApiBaseUrl('sidecar')).toBe('http://127.0.0.1:45678')
    expect(getSidecarApiUrl()).toBe('http://127.0.0.1:45678')
    invoke.mockClear()
    expect(await resolveApiBaseUrl('sidecar')).toBe('http://127.0.0.1:45678')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('asks the shell to start the sidecar when no port is known yet', async () => {
    invoke.mockImplementation(async (command) => (command === 'start_api_server' ? 45999 : null))
    expect(await resolveApiBaseUrl('sidecar')).toBe('http://127.0.0.1:45999')
    expect(invoke).toHaveBeenCalledWith('start_api_server')
  })

  it('falls back to the configured or default sidecar URL before the shell answers', () => {
    expect(getSidecarApiUrl()).toBe('http://127.0.0.1:3003')
    process.env.NEXT_PUBLIC_SIDECAR_URL = 'http://127.0.0.1:4188'
    expect(getSidecarApiUrl()).toBe('http://127.0.0.1:4188')
  })

  it('marks requests as coming from the desktop client', () => {
    expect(getAuthHeader()).toMatchObject({ 'x-openlinear-client': 'desktop' })
  })
})

describe('getApiUrlForPath', () => {
  it('routes execution paths to the sidecar and everything else to the cloud', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://cloud.example'
    process.env.NEXT_PUBLIC_SIDECAR_URL = 'http://127.0.0.1:4199'
    expect(getApiUrlForPath('/api/tasks/t1/execute')).toBe('http://127.0.0.1:4199/api/tasks/t1/execute')
    expect(getApiUrlForPath('/api/tasks/t1')).toBe('https://cloud.example/api/tasks/t1')
  })
})

describe('sidecar health payloads', () => {
  it('accepts the current and the legacy shape only', () => {
    expect(isHealthyPayload({ ok: true, service: 'sidecar' })).toBe(true)
    expect(isHealthyPayload({ status: 'ok' })).toBe(true)
    expect(isHealthyPayload({ ok: false })).toBe(false)
    expect(isHealthyPayload(null)).toBe(false)
    expect(isHealthyPayload('ok')).toBe(false)
  })
})

describe('auth helpers', () => {
  it('getAuthToken returns null when no token', () => {
    expect(getAuthToken()).toBeNull()
  })

  it('getAuthToken returns the web token from localStorage', () => {
    localStorage.setItem('token', 'abc123')
    expect(getAuthToken()).toBe('abc123')
  })

  it('getAuthHeader includes Bearer when token exists', () => {
    localStorage.setItem('token', 'tok123')
    expect(getAuthHeader()).toMatchObject({ Authorization: 'Bearer tok123' })
    expect(getAuthHeader()).not.toHaveProperty('x-openlinear-client')
  })
})
