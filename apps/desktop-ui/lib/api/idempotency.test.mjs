import { describe, it, expect, vi } from 'vitest'

const { ApiError, NetworkError } = await import('./fetch.ts')
const {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyIntent,
  createIdempotencyKey,
  idempotencyHeaders,
  isRetryableWithSameKey,
  retryDelayMs,
  sendWithIdempotencyKey,
} = await import('./idempotency.ts')

// The server accepts 8-128 chars of [A-Za-z0-9._:~+/=-] (apps/api/src/schemas/idempotency.ts).
const SERVER_KEY_PATTERN = /^[A-Za-z0-9._:~+/=-]{8,128}$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('createIdempotencyKey', () => {
  it('returns unique UUID v4 keys the server accepts', () => {
    const keys = new Set(Array.from({ length: 200 }, () => createIdempotencyKey()))
    expect(keys.size).toBe(200)
    for (const key of keys) {
      expect(key).toMatch(UUID_V4)
      expect(key).toMatch(SERVER_KEY_PATTERN)
    }
  })

  it('falls back to getRandomValues when randomUUID is unavailable', () => {
    // Shadow the prototype method with an own property, then remove it again.
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true, writable: true })
    try {
      expect(createIdempotencyKey()).toMatch(UUID_V4)
    } finally {
      delete globalThis.crypto.randomUUID
    }
    expect(typeof globalThis.crypto.randomUUID).toBe('function')
  })

  it('builds the header object', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key')
    expect(idempotencyHeaders('abc-12345')).toEqual({ 'Idempotency-Key': 'abc-12345' })
  })
})

describe('retry policy', () => {
  it('retries only failures where resending the same key is safe', () => {
    expect(isRetryableWithSameKey(new NetworkError('offline'))).toBe(true)
    expect(isRetryableWithSameKey(new ApiError(409, 'busy', 'IDEMPOTENCY_IN_PROGRESS'))).toBe(true)
    expect(isRetryableWithSameKey(new ApiError(503, 'unavailable'))).toBe(true)
    expect(isRetryableWithSameKey(new ApiError(409, 'conflict', 'IDEMPOTENCY_CONFLICT'))).toBe(false)
    expect(isRetryableWithSameKey(new ApiError(400, 'bad', 'VALIDATION_ERROR'))).toBe(false)
    expect(isRetryableWithSameKey(new ApiError(500, 'boom', 'INTERNAL_ERROR'))).toBe(false)
    expect(isRetryableWithSameKey(new Error('other'))).toBe(false)
  })

  it('waits for Retry-After on IDEMPOTENCY_IN_PROGRESS and backs off otherwise', () => {
    expect(retryDelayMs(new ApiError(409, 'busy', 'IDEMPOTENCY_IN_PROGRESS', { retryAfterSeconds: 3 }), 1, 400)).toBe(3000)
    expect(retryDelayMs(new ApiError(409, 'busy', 'IDEMPOTENCY_IN_PROGRESS'), 1, 400)).toBe(1000)
    expect(retryDelayMs(new ApiError(503, 'x'), 2, 400)).toBe(800)
    expect(retryDelayMs(new NetworkError('offline', 1500), 1, 400)).toBe(1500)
  })
})

describe('sendWithIdempotencyKey', () => {
  const noSleep = () => Promise.resolve()

  it('reuses the same key on every automatic retry until the request succeeds', async () => {
    const keys = []
    const request = vi.fn(async (key) => {
      keys.push(key)
      if (keys.length === 1) throw new NetworkError('connection reset')
      if (keys.length === 2) throw new ApiError(409, 'still running', 'IDEMPOTENCY_IN_PROGRESS', { retryAfterSeconds: 1 })
      return { id: 'task-1' }
    })
    const sleep = vi.fn(noSleep)
    const result = await sendWithIdempotencyKey('key-00000001', request, { sleep })
    expect(result).toEqual({ id: 'task-1' })
    expect(keys).toEqual(['key-00000001', 'key-00000001', 'key-00000001'])
    expect(sleep).toHaveBeenNthCalledWith(1, 1500)
    expect(sleep).toHaveBeenNthCalledWith(2, 1000)
  })

  it('does not retry a conflict', async () => {
    const request = vi.fn(async () => { throw new ApiError(409, 'different body', 'IDEMPOTENCY_CONFLICT') })
    await expect(sendWithIdempotencyKey('key-00000002', request, { sleep: noSleep })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget with the last error', async () => {
    const request = vi.fn(async () => { throw new ApiError(409, 'busy', 'IDEMPOTENCY_IN_PROGRESS') })
    const onRetry = vi.fn()
    await expect(sendWithIdempotencyKey('key-00000003', request, { attempts: 3, sleep: noSleep, onRetry })).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' })
    expect(request).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(ApiError), 'key-00000003')
  })
})

describe('IdempotencyIntent', () => {
  it('keeps one key per payload until completed', () => {
    const intent = new IdempotencyIntent()
    const first = intent.keyFor('{"title":"A"}')
    expect(intent.keyFor('{"title":"A"}')).toBe(first)
    const edited = intent.keyFor('{"title":"B"}')
    expect(edited).not.toBe(first)
    expect(intent.pendingKey).toBe(edited)
    intent.complete()
    expect(intent.pendingKey).toBeNull()
    expect(intent.keyFor('{"title":"B"}')).not.toBe(edited)
  })
})
