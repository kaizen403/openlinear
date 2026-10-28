import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

const auth = await import('./auth.ts')
const client = await import('./client.ts')
const tokenStore = await import('./token-store.ts')
const desktopAuth = await import('./desktop-auth.ts')
const { open } = await import('@tauri-apps/plugin-shell')

const {
  completeDesktopLogin,
  completeTwoFactorLogin,
  DesktopLoginError,
  fetchAuthProviders,
  fetchCurrentUser,
  getLoginUrl,
  logout,
  startDesktopLogin,
  startLogin,
  updateEmail,
  verifyCallbackToken,
} = auth

const CLOUD = 'https://cloud.example.test'
const ENV_KEYS = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_CLOUD_API_URL', 'NEXT_PUBLIC_SIDECAR_URL']
const savedEnv = {}
const USER = { id: 'u1', username: 'octo' }
const CODE = 'c'.repeat(43)
const STATE = 's'.repeat(32)
const VERIFIER = 'v'.repeat(43)

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function bodyOf(call) {
  return JSON.parse(call[1].body)
}

function authorizationOf(call) {
  const headers = call[1]?.headers
  return headers instanceof Headers ? headers.get('Authorization') : headers?.Authorization ?? null
}

function urls() {
  return globalThis.fetch.mock.calls.map(([url]) => String(url))
}

function setDesktop(enabled) {
  window.__TAURI_INTERNALS__ = enabled ? {} : undefined
  if (enabled) {
    process.env.NEXT_PUBLIC_CLOUD_API_URL = CLOUD
  } else {
    delete process.env.NEXT_PUBLIC_CLOUD_API_URL
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.NEXT_PUBLIC_API_URL = CLOUD
  delete process.env.NEXT_PUBLIC_SIDECAR_URL
  setDesktop(false)
  invoke.mockReset()
  invoke.mockResolvedValue(null)
  open.mockClear()
  client.resetSidecarUrlCacheForTests()
  tokenStore.resetTokenStoreForTests()
  desktopAuth.resetPendingLoginsForTests()
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  setDesktop(false)
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('fetchCurrentUser', () => {
  it('returns null without a token and makes no request', async () => {
    await expect(fetchCurrentUser()).resolves.toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('asks the cloud API for the user', async () => {
    localStorage.setItem('token', 'tok')
    globalThis.fetch.mockResolvedValueOnce(json(200, USER))
    await expect(fetchCurrentUser()).resolves.toEqual(USER)
    expect(urls()).toEqual([`${CLOUD}/api/auth/me`])
  })

  it('refreshes an expired access token before giving up', async () => {
    localStorage.setItem('token', 'expired')
    globalThis.fetch
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { token: 'fresh' }))
      .mockResolvedValueOnce(json(200, USER))
    await expect(fetchCurrentUser()).resolves.toEqual(USER)
    expect(urls()).toEqual([`${CLOUD}/api/auth/me`, `${CLOUD}/api/auth/refresh`, `${CLOUD}/api/auth/me`])
    expect(localStorage.getItem('token')).toBe('fresh')
  })

  it('drops a token the API rejects', async () => {
    localStorage.setItem('token', 'bad')
    globalThis.fetch.mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(401, {}))
    await expect(fetchCurrentUser()).resolves.toBeNull()
    expect(localStorage.getItem('token')).toBeNull()
  })

  it('keeps the token on server errors', async () => {
    localStorage.setItem('token', 'tok')
    globalThis.fetch.mockResolvedValueOnce(json(500, {}))
    await expect(fetchCurrentUser()).resolves.toBeNull()
    expect(localStorage.getItem('token')).toBe('tok')
  })
})

describe('verifyCallbackToken (web /auth/session)', () => {
  it('verifies the token before storing it', async () => {
    let storedDuringRequest = 'unset'
    globalThis.fetch.mockImplementationOnce(async () => {
      storedDuringRequest = localStorage.getItem('token')
      return json(200, USER)
    })
    await expect(verifyCallbackToken('candidate')).resolves.toEqual(USER)
    expect(storedDuringRequest).toBeNull()
    expect(authorizationOf(globalThis.fetch.mock.calls[0])).toBe('Bearer candidate')
    expect(localStorage.getItem('token')).toBe('candidate')
  })

  it('stores nothing when the API rejects the token', async () => {
    localStorage.setItem('token', 'previous')
    globalThis.fetch.mockResolvedValueOnce(json(401, { error: 'Invalid token' }))
    await expect(verifyCallbackToken('forged')).rejects.toMatchObject({ status: 401 })
    expect(localStorage.getItem('token')).toBe('previous')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('provider discovery and web sign-in', () => {
  it('builds the web login URL on the cloud API', () => {
    expect(getLoginUrl()).toBe(`${CLOUD}/api/auth/github`)
  })

  it('reports GitHub availability from the API, anonymously', async () => {
    localStorage.setItem('token', 'tok')
    globalThis.fetch.mockResolvedValueOnce(json(200, { github: { enabled: true } }))
    await expect(fetchAuthProviders()).resolves.toEqual({ github: { enabled: true } })
    expect(authorizationOf(globalThis.fetch.mock.calls[0])).toBeNull()
  })

  it('treats an unreachable API as sign-in unavailable', async () => {
    globalThis.fetch.mockRejectedValueOnce(new Error('offline'))
    await expect(fetchAuthProviders()).resolves.toEqual({ github: { enabled: false } })
  })

  it('does not navigate when GitHub sign-in is disabled', async () => {
    globalThis.fetch.mockResolvedValueOnce(json(200, { github: { enabled: false } }))
    await expect(startLogin()).resolves.toBe(false)
  })
})

describe('desktop sign-in', () => {
  beforeEach(() => setDesktop(true))

  it('binds the sign-in to a PKCE challenge and opens GitHub in the system browser', async () => {
    localStorage.setItem('token', 'old-session')
    tokenStore.setToken('old-session')
    globalThis.fetch.mockResolvedValueOnce(json(200, { authorizeUrl: 'https://github.com/login/oauth/authorize?state=signed' }))

    await expect(startDesktopLogin()).resolves.toBe(true)

    const call = globalThis.fetch.mock.calls[0]
    expect(String(call[0])).toBe(`${CLOUD}/api/auth/desktop/authorize`)
    expect(authorizationOf(call)).toBeNull()
    const sent = bodyOf(call)
    expect(sent.codeChallengeMethod).toBe('S256')
    expect(sent.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const pending = desktopAuth.findPendingLogin(sent.state)
    expect(pending).not.toBeNull()
    await expect(desktopAuth.computeCodeChallenge(pending.verifier)).resolves.toBe(sent.codeChallenge)
    expect(JSON.stringify(sent)).not.toContain(pending.verifier)
    expect(open).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?state=signed')
  })

  it('startLogin uses the desktop flow in Tauri', async () => {
    globalThis.fetch.mockResolvedValueOnce(json(200, { authorizeUrl: 'https://github.com/login/oauth/authorize?state=signed' }))
    await expect(startLogin()).resolves.toBe(true)
    expect(urls()).toEqual([`${CLOUD}/api/auth/desktop/authorize`])
  })

  it('returns false when the server has GitHub sign-in disabled', async () => {
    globalThis.fetch.mockResolvedValueOnce(json(503, { code: 'GITHUB_OAUTH_DISABLED' }))
    await expect(startDesktopLogin()).resolves.toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses to open anything but GitHub', async () => {
    globalThis.fetch.mockResolvedValueOnce(json(200, { authorizeUrl: 'https://evil.example/login' }))
    await expect(startDesktopLogin()).rejects.toBeInstanceOf(DesktopLoginError)
    expect(open).not.toHaveBeenCalled()
  })

  function remember(state = STATE) {
    desktopAuth.rememberPendingLogin({ state, verifier: VERIFIER, createdAt: Date.now() })
  }

  it('redeems the code with the stored verifier and keeps the tokens', async () => {
    remember()
    globalThis.fetch
      .mockResolvedValueOnce(json(200, { token: 'access-1', refreshToken: 'refresh-1', tokenType: 'Bearer' }))
      .mockResolvedValueOnce(json(200, USER))

    await expect(completeDesktopLogin({ kind: 'code', code: CODE, state: STATE })).resolves.toEqual({ status: 'signed_in', user: USER })

    const redeem = globalThis.fetch.mock.calls[0]
    expect(String(redeem[0])).toBe(`${CLOUD}/api/auth/desktop/token`)
    expect(bodyOf(redeem)).toEqual({ code: CODE, codeVerifier: VERIFIER })
    expect(authorizationOf(redeem)).toBeNull()
    expect(authorizationOf(globalThis.fetch.mock.calls[1])).toBe('Bearer access-1')
    expect(tokenStore.getToken()).toBe('access-1')
    expect(tokenStore.getRefreshToken()).toBe('refresh-1')
    expect(localStorage.getItem('refreshToken')).toBeNull()
    // The attempt is spent: the same link is not redeemed again.
    await expect(completeDesktopLogin({ kind: 'code', code: CODE, state: STATE })).rejects.toMatchObject({ reason: 'unsolicited' })
  })

  it('ignores a callback it did not start, without any request', async () => {
    await expect(completeDesktopLogin({ kind: 'code', code: CODE, state: STATE })).rejects.toMatchObject({ reason: 'unsolicited' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(tokenStore.getToken()).toBeNull()
  })

  it('redeems a code delivered twice only once', async () => {
    remember()
    globalThis.fetch
      .mockResolvedValueOnce(json(200, { token: 'access-1', refreshToken: 'refresh-1' }))
      .mockResolvedValueOnce(json(200, USER))
    const [a, b] = await Promise.all([
      completeDesktopLogin({ kind: 'code', code: CODE, state: STATE }),
      completeDesktopLogin({ kind: 'code', code: CODE, state: STATE }),
    ])
    expect(a).toEqual(b)
    expect(urls().filter((url) => url.endsWith('/api/auth/desktop/token'))).toHaveLength(1)
  })

  it('surfaces a rejected code and stores nothing', async () => {
    remember()
    globalThis.fetch.mockResolvedValueOnce(json(400, { code: 'DESKTOP_AUTH_CODE_INVALID' }))
    await expect(completeDesktopLogin({ kind: 'code', code: CODE, state: STATE })).rejects.toMatchObject({ reason: 'rejected' })
    expect(tokenStore.getToken()).toBeNull()
    expect(desktopAuth.findPendingLogin(STATE)).toBeNull()
  })

  it('keeps the verifier after a network failure so the link can be retried', async () => {
    remember()
    globalThis.fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json(200, { token: 'access-1', refreshToken: 'refresh-1' }))
      .mockResolvedValueOnce(json(200, USER))
    await expect(completeDesktopLogin({ kind: 'code', code: CODE, state: STATE })).rejects.toMatchObject({ reason: 'network' })
    await expect(completeDesktopLogin({ kind: 'code', code: CODE, state: STATE })).resolves.toMatchObject({ status: 'signed_in' })
  })

  it('reports provider errors only for its own sign-in', async () => {
    remember()
    await expect(completeDesktopLogin({ kind: 'error', error: 'access_denied', state: STATE })).rejects.toMatchObject({ reason: 'provider_error' })
    await expect(completeDesktopLogin({ kind: 'error', error: 'access_denied', state: 'x'.repeat(32) })).rejects.toMatchObject({ reason: 'unsolicited' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('hands back the two-factor challenge without storing a session', async () => {
    remember()
    globalThis.fetch.mockResolvedValueOnce(json(200, { twoFactorRequired: true, tempToken: 'temp-1' }))
    await expect(completeDesktopLogin({ kind: 'code', code: CODE, state: STATE })).resolves.toEqual({
      status: 'two_factor_required',
      tempToken: 'temp-1',
    })
    expect(tokenStore.getToken()).toBeNull()
  })

  it('finishes a two-factor sign-in anonymously', async () => {
    tokenStore.setToken('stale')
    globalThis.fetch
      .mockResolvedValueOnce(json(200, { token: 'access-2', refreshToken: 'refresh-2' }))
      .mockResolvedValueOnce(json(200, USER))
    await expect(completeTwoFactorLogin('temp-1', '123456')).resolves.toEqual(USER)
    const validate = globalThis.fetch.mock.calls[0]
    expect(String(validate[0])).toBe(`${CLOUD}/api/auth/2fa/validate`)
    expect(authorizationOf(validate)).toBeNull()
    expect(bodyOf(validate)).toEqual({ tempToken: 'temp-1', code: '123456' })
    expect(tokenStore.getToken()).toBe('access-2')
    expect(tokenStore.getRefreshToken()).toBe('refresh-2')
  })
})

describe('updateEmail', () => {
  it('PATCHes the cloud API', async () => {
    localStorage.setItem('token', 'tok')
    globalThis.fetch.mockResolvedValueOnce(json(200, { id: 'u1', email: 'test@example.com' }))
    await expect(updateEmail('test@example.com')).resolves.toEqual({ id: 'u1', email: 'test@example.com' })
    expect(globalThis.fetch.mock.calls[0][1].method).toBe('PATCH')
    expect(urls()).toEqual([`${CLOUD}/api/auth/me`])
  })
})

describe('logout', () => {
  it('revokes the session at the cloud API and forgets the token', () => {
    localStorage.setItem('token', 'tok123')
    globalThis.fetch.mockResolvedValue(json(200, { success: true }))
    logout()
    const [url, init] = globalThis.fetch.mock.calls[0]
    expect(url).toBe(`${CLOUD}/api/auth/logout`)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok123')
    expect(init.credentials).toBe('include')
    expect(localStorage.getItem('token')).toBeNull()
  })
})
