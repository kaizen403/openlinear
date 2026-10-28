import { describe, it, expect, beforeEach } from 'vitest'

const {
  base64UrlEncode,
  computeCodeChallenge,
  DESKTOP_LOGIN_TTL_MS,
  findPendingLogin,
  forgetPendingLogin,
  generateCodeVerifier,
  generateLoginState,
  parseDesktopCallbackUrl,
  rememberPendingLogin,
  resetPendingLoginsForTests,
} = await import('./desktop-auth.ts')

beforeEach(() => {
  resetPendingLoginsForTests()
})

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B S256 test vector', async () => {
    await expect(computeCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('generates 43-character base64url verifiers and distinct states', () => {
    const a = generateCodeVerifier()
    const b = generateCodeVerifier()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
    expect(generateLoginState()).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('encodes base64url without padding', () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
  })
})

describe('pending sign-in attempts', () => {
  it('finds an attempt by state until it expires', () => {
    const now = Date.now()
    rememberPendingLogin({ state: 'state-aaaaaaaaaaaaaaaa', verifier: 'v'.repeat(43), createdAt: now })
    expect(findPendingLogin('state-aaaaaaaaaaaaaaaa', now + 1000)?.verifier).toBe('v'.repeat(43))
    expect(findPendingLogin('state-bbbbbbbbbbbbbbbb', now + 1000)).toBeNull()
    expect(findPendingLogin('state-aaaaaaaaaaaaaaaa', now + DESKTOP_LOGIN_TTL_MS)).toBeNull()
  })

  it('survives a webview reload through sessionStorage', () => {
    const now = Date.now()
    rememberPendingLogin({ state: 'state-reloadreload01', verifier: 'w'.repeat(43), createdAt: now })
    expect(sessionStorage.getItem('openlinear:desktop-login')).toContain('state-reloadreload01')
  })

  it('forgets an attempt once it is used', () => {
    const now = Date.now()
    rememberPendingLogin({ state: 'state-forgetforget01', verifier: 'x'.repeat(43), createdAt: now })
    forgetPendingLogin('state-forgetforget01')
    expect(findPendingLogin('state-forgetforget01', now)).toBeNull()
    expect(sessionStorage.getItem('openlinear:desktop-login')).toBeNull()
  })

  it('keeps at most five attempts', () => {
    const now = Date.now()
    for (let i = 0; i < 7; i += 1) {
      rememberPendingLogin({ state: `state-${String(i).padStart(16, '0')}`, verifier: 'y'.repeat(43), createdAt: now + i })
    }
    expect(findPendingLogin(`state-${'0'.repeat(16)}`, now + 10)).toBeNull()
    expect(findPendingLogin(`state-${String(6).padStart(16, '0')}`, now + 10)).not.toBeNull()
  })
})

describe('parseDesktopCallbackUrl', () => {
  const code = 'c'.repeat(43)
  const state = 's'.repeat(32)

  it('accepts a code callback', () => {
    expect(parseDesktopCallbackUrl(`openlinear://callback?code=${code}&state=${state}`)).toEqual({ kind: 'code', code, state })
    expect(parseDesktopCallbackUrl(`  openlinear://callback/?code=${code}&amp;state=${state}  `)).toEqual({ kind: 'code', code, state })
  })

  it('accepts an error callback with or without state', () => {
    expect(parseDesktopCallbackUrl(`openlinear://callback?error=access_denied&state=${state}`)).toEqual({
      kind: 'error',
      error: 'access_denied',
      state,
    })
    expect(parseDesktopCallbackUrl('openlinear://callback?error=access_denied')).toEqual({
      kind: 'error',
      error: 'access_denied',
      state: null,
    })
  })

  it.each([
    ['a bare JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc'],
    ['a token callback from older servers', 'openlinear://callback?token=eyJhbGciOiJIUzI1NiJ9.e.s'],
    ['a code without state', `openlinear://callback?code=${code}`],
    ['an https URL', `https://openlinear.tech/callback?code=${code}&state=${state}`],
    ['another host', `openlinear://other?code=${code}&state=${state}`],
    ['a path', `openlinear://callback/x?code=${code}&state=${state}`],
    ['a short code', `openlinear://callback?code=abc&state=${state}`],
    ['free text', 'random-string'],
    ['empty input', '   '],
  ])('rejects %s', (_label, value) => {
    expect(parseDesktopCallbackUrl(value)).toBeNull()
  })
})
