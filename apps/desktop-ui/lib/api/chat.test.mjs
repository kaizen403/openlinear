import { describe, it, expect, vi, beforeEach } from 'vitest'

// apiFetch is stubbed for the CRUD helpers; sendChatMessage goes through the
// real apiFetchRaw (routing, auth, refresh) against a stubbed global fetch.
vi.mock('./fetch', async (importOriginal) => ({
  ...(await importOriginal()),
  apiFetch: vi.fn(),
}))

const {
  fetchChatSessions,
  createChatSession,
  fetchChatSession,
  updateChatSession,
  archiveChatSession,
  transcribeChatAudio,
  uploadChatAttachment,
  sendChatMessage,
  fetchModelUsage,
  ChatStreamError,
} = await import('./chat')
const { ApiError } = await import('./fetch')
const { API_ERROR_COPY, describeApiError } = await import('./errors')

function createMockStreamResponse(chunks) {
  const encoder = new TextEncoder()
  let index = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    },
  })
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: stream,
  }
}

describe('chat API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetchChatSessions with workspaceId', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ data: [], nextCursor: null })
    const result = await fetchChatSessions('ws1')
    expect(apiFetch).toHaveBeenCalledWith('/api/chat/sessions?workspaceId=ws1')
    expect(result).toEqual({ data: [], nextCursor: null })
  })

  it('fetchChatSessions with cursor', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ data: [], nextCursor: null })
    await fetchChatSessions('ws1', 'cursor1')
    expect(apiFetch).toHaveBeenCalledWith('/api/chat/sessions?workspaceId=ws1&cursor=cursor1')
  })

  it('createChatSession', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ id: 's1', title: 'New Session' })
    const result = await createChatSession('ws1', 'p1')
    expect(apiFetch).toHaveBeenCalledWith('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1', projectId: 'p1' }),
    })
    expect(result).toEqual({ id: 's1', title: 'New Session' })
  })

  it('createChatSession without projectId', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ id: 's1' })
    await createChatSession('ws1')
    expect(apiFetch).toHaveBeenCalledWith('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1', projectId: undefined }),
    })
  })

  it('fetchChatSession', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ id: 's1', messages: [] })
    const result = await fetchChatSession('s1')
    expect(apiFetch).toHaveBeenCalledWith('/api/chat/sessions/s1')
    expect(result).toEqual({ id: 's1', messages: [] })
  })

  it('fetchChatSession with before', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ id: 's1', messages: [] })
    await fetchChatSession('s1', 'msg1')
    expect(apiFetch).toHaveBeenCalledWith('/api/chat/sessions/s1?before=msg1')
  })

  it('updateChatSession', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ id: 's1', title: 'Updated' })
    const result = await updateChatSession('s1', { title: 'Updated' })
    expect(apiFetch).toHaveBeenCalledWith('/api/chat/sessions/s1', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Updated' }),
    })
    expect(result).toEqual({ id: 's1', title: 'Updated' })
  })

  it('archiveChatSession', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue(undefined)
    await archiveChatSession('s1')
    expect(apiFetch).toHaveBeenCalledWith('/api/chat/sessions/s1', { method: 'DELETE' })
  })

  it('transcribeChatAudio sends audio blob to sidecar', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ text: 'hello' })
    const blob = new Blob(['audio'], { type: 'audio/webm' })
    const result = await transcribeChatAudio(blob)
    // routes.ts sends /api/transcribe to the sidecar; no per-call flag.
    expect(apiFetch).toHaveBeenCalledWith('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: blob,
    })
    expect(result).toEqual({ text: 'hello' })
  })

  it('uploadChatAttachment sends form data', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ id: 'a1', filename: 'file.txt' })
    const file = new File(['content'], 'file.txt', { type: 'text/plain' })
    const result = await uploadChatAttachment(file)
    expect(apiFetch).toHaveBeenCalledWith('/api/chat/attachments', {
      method: 'POST',
      body: expect.any(FormData),
    })
    expect(result).toEqual({ id: 'a1', filename: 'file.txt' })
  })
})

describe('sendChatMessage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('calls onChunk and onDone for successful stream', async () => {
    const onChunk = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    const chunks = [
      'data: {"type":"assistant_delta","content":"Hello"}\n\n',
      'data: {"type":"done"}\n\n',
    ]
    globalThis.fetch.mockResolvedValue(createMockStreamResponse(chunks))

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk,
      onDone,
      onError,
    })

    expect(onChunk).toHaveBeenCalledWith({ type: 'assistant_delta', content: 'Hello' })
    expect(onDone).toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('calls onError for non-ok response', async () => {
    const onError = vi.fn()
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CHAT_FAILED', message: 'Server Error' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError,
    })

    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(onError.mock.calls[0][0].message).toBe('Chat request failed: 500 Server Error')
  })

  it('posts to the cloud API and refreshes an expired token before streaming', async () => {
    localStorage.setItem('token', 'expired')
    const onChunk = vi.fn()
    globalThis.fetch
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'fresh' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(createMockStreamResponse(['data: {"type":"done"}\n\n']))

    await sendChatMessage({ sessionId: 's1', content: 'hi', onChunk, onError: vi.fn() })

    const urls = globalThis.fetch.mock.calls.map(([url]) => String(url))
    expect(urls[0]).toMatch(/\/api\/chat\/sessions\/s1\/messages$/)
    expect(urls[1]).toMatch(/\/api\/auth\/refresh$/)
    expect(globalThis.fetch.mock.calls[2][1].headers.get('Authorization')).toBe('Bearer fresh')
    expect(onChunk).toHaveBeenCalledWith({ type: 'done' })
    localStorage.clear()
  })

  it('reports a network failure through onError instead of throwing', async () => {
    const onError = vi.fn()
    globalThis.fetch.mockRejectedValue(new Error('offline'))
    await expect(sendChatMessage({ sessionId: 's1', content: 'hi', onChunk: vi.fn(), onError })).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('calls onError when no response body', async () => {
    const onError = vi.fn()
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    })

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError,
    })

    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('handles error chunk', async () => {
    const onError = vi.fn()
    const chunks = [
      'data: {"type":"error","error":{"message":"Something went wrong"}}\n\n',
    ]
    globalThis.fetch.mockResolvedValue(createMockStreamResponse(chunks))

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError,
    })

    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('handles [DONE] marker', async () => {
    const onDone = vi.fn()
    const chunks = [
      'data: [DONE]\n\n',
    ]
    globalThis.fetch.mockResolvedValue(createMockStreamResponse(chunks))

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onDone,
    })

    expect(onDone).toHaveBeenCalled()
  })

  it('includes attachmentIds in body', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
    })

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      attachmentIds: ['a1', 'a2'],
      onChunk: vi.fn(),
      onDone: vi.fn(),
    })

    const [, init] = globalThis.fetch.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ content: 'hi', attachmentIds: ['a1', 'a2'] })
  })
})

describe('fetchModelUsage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads the last 30 days by default', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ totals: { calls: 0 }, groups: [] })
    await fetchModelUsage()
    expect(apiFetch).toHaveBeenCalledWith('/api/usage/models?days=30')
  })

  it('passes workspace and surface filters', async () => {
    const { apiFetch } = await import('./fetch')
    apiFetch.mockResolvedValue({ totals: { calls: 0 }, groups: [] })
    await fetchModelUsage({ days: 7, workspaceId: 'w1', surface: 'chat.turn' })
    expect(apiFetch).toHaveBeenCalledWith('/api/usage/models?days=7&workspaceId=w1&surface=chat.turn')
  })
})

describe('sendChatMessage: safety and metering contract', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('sends confirmationTokens only when there are some', async () => {
    globalThis.fetch.mockResolvedValue(createMockStreamResponse(['data: {"type":"done"}\n\n']))
    await sendChatMessage({ sessionId: 's1', content: 'Confirm CONFIRM-7KQ2MX9P', confirmationTokens: ['CONFIRM-7KQ2MX9P'], onChunk: vi.fn() })
    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body)).toEqual({ content: 'Confirm CONFIRM-7KQ2MX9P', confirmationTokens: ['CONFIRM-7KQ2MX9P'] })

    globalThis.fetch.mockResolvedValue(createMockStreamResponse(['data: {"type":"done"}\n\n']))
    await sendChatMessage({ sessionId: 's1', content: 'hi', confirmationTokens: [], onChunk: vi.fn() })
    expect(JSON.parse(globalThis.fetch.mock.calls[1][1].body)).toEqual({ content: 'hi' })
  })

  it('reports an error chunk with its code and details', async () => {
    const onError = vi.fn()
    const onDone = vi.fn()
    globalThis.fetch.mockResolvedValue(createMockStreamResponse([
      'event: assistant_delta\ndata: {"type":"assistant_delta","content":"Par"}\n\n',
      'event: error\ndata: {"type":"error","code":"LLM_RATE_LIMITED","message":"The chat model provider is rate limiting requests","details":{"retryAfterSeconds":3}}\n\n',
      'event: done\ndata: {"type":"done"}\n\n',
    ]))

    await sendChatMessage({ sessionId: 's1', content: 'hi', onChunk: vi.fn(), onError, onDone })

    expect(onDone).not.toHaveBeenCalled()
    const error = onError.mock.calls[0][0]
    expect(error).toBeInstanceOf(ChatStreamError)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('LLM_RATE_LIMITED')
    expect(error.details).toEqual({ retryAfterSeconds: 3 })
  })

  it('treats a stream that ends without done or error as interrupted', async () => {
    const onError = vi.fn()
    const onDone = vi.fn()
    const onChunk = vi.fn()
    globalThis.fetch.mockResolvedValue(createMockStreamResponse([
      'data: {"type":"assistant_delta","content":"Hello"}\n\n',
    ]))

    await sendChatMessage({ sessionId: 's1', content: 'hi', onChunk, onError, onDone })

    expect(onChunk).toHaveBeenCalledWith({ type: 'assistant_delta', content: 'Hello' })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'CHAT_STREAM_INTERRUPTED' })
  })

  it('reports nothing after the caller aborts', async () => {
    const controller = new AbortController()
    const onError = vi.fn()
    const onDone = vi.fn()
    globalThis.fetch.mockImplementation(async () => {
      controller.abort()
      return createMockStreamResponse([])
    })

    await sendChatMessage({ sessionId: 's1', content: 'hi', signal: controller.signal, onChunk: vi.fn(), onError, onDone })

    expect(onError).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('parses CRLF framing and data: without a space', async () => {
    const onChunk = vi.fn()
    const onDone = vi.fn()
    globalThis.fetch.mockResolvedValue(createMockStreamResponse([
      'event: assistant_delta\r\ndata:{"type":"assistant_delta","content":"A"}\r\n\r\n',
      'data: {"type":"done","sessionId":"s1","usage":{"inputTokens":10,"outputTokens":2,"totalTokens":12,"costUsd":null}}\r\n\r\n',
    ]))

    await sendChatMessage({ sessionId: 's1', content: 'hi', onChunk, onDone, onError: vi.fn() })

    expect(onChunk).toHaveBeenNthCalledWith(1, { type: 'assistant_delta', content: 'A' })
    expect(onChunk).toHaveBeenNthCalledWith(2, {
      type: 'done',
      sessionId: 's1',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: null },
    })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('keeps the request error, its status and envelope on a non-ok response', async () => {
    const onError = vi.fn()
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Too many chat messages', code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await sendChatMessage({ sessionId: 's1', content: 'hi', onChunk: vi.fn(), onError })

    const error = onError.mock.calls[0][0]
    expect(error).toBeInstanceOf(ChatStreamError)
    expect(error.status).toBe(429)
    expect(error.origin).toBeInstanceOf(ApiError)
    expect(describeApiError(error.origin).hint).toBe('Wait 60 seconds and try again.')
  })
})

describe('chat contract data', () => {
  it('keeps no client copy of the tool effect catalogue (the server sends effects)', async () => {
    const chatModule = await import('./chat.ts')
    expect(chatModule).not.toHaveProperty('CHAT_TOOL_EFFECTS')
  })

  it('maps every chat error code to actionable copy', () => {
    const codes = [
      'LLM_RATE_LIMITED', 'LLM_QUOTA_EXCEEDED', 'LLM_PROVIDER_UNAVAILABLE', 'LLM_TIMEOUT', 'LLM_NETWORK_ERROR',
      'LLM_AUTH_FAILED', 'LLM_NOT_CONFIGURED', 'LLM_MISCONFIGURED', 'LLM_MODEL_NOT_FOUND', 'LLM_BAD_REQUEST',
      'LLM_REQUEST_REJECTED', 'LLM_CONTEXT_OVERFLOW', 'LLM_STREAM_TRUNCATED', 'LLM_STREAM_ERROR', 'LLM_STREAM_MALFORMED',
      'LLM_EMPTY_STREAM', 'LLM_RESPONSE_MALFORMED', 'LLM_OUTPUT_TRUNCATED', 'CHAT_STREAM_INTERRUPTED', 'TURN_TIMEOUT',
      'ROUND_LIMIT', 'CLIENT_ABORTED', 'CHAT_TURN_FAILED', 'CHAT_STREAM_FAILED', 'SESSION_NOT_FOUND', 'PROJECT_SCOPE_MISMATCH',
      'CONFIRMATION_REQUIRED', 'CONFIRMATION_EXPIRED', 'CONFIRMATION_USED', 'CONFIRMATION_STALE', 'CONFIRMATION_INVALID',
      'CONFIRMATION_NOT_FROM_USER', 'CONFIRMATION_REQUIRES_USER_TURN', 'TOOL_OUTCOME_UNKNOWN', 'TOOL_TIMEOUT',
      'TOOL_CALL_IN_PROGRESS', 'SELECTION_TOO_LARGE', 'EXPLICIT_IDS_REQUIRED', 'INVALID_TOOL_ARGUMENTS',
      'TOOL_REQUIRES_APPROVAL', 'UNKNOWN_TOOL',
    ]
    for (const code of codes) {
      expect(API_ERROR_COPY[code], code).toBeTypeOf('function')
      const described = describeApiError(new ChatStreamError(`raw provider text for ${code}`, { code }))
      expect(described.code).toBe(code)
      expect(described.message, code).not.toContain('raw provider text')
      expect(described.hint, code).toBeTruthy()
    }
  })

  it('marks transient provider failures retryable and configuration failures not', () => {
    const retryable = (code) => describeApiError(new ChatStreamError('x', { code })).retryable
    expect(retryable('LLM_PROVIDER_UNAVAILABLE')).toBe(true)
    expect(retryable('LLM_STREAM_TRUNCATED')).toBe(true)
    expect(retryable('CHAT_STREAM_INTERRUPTED')).toBe(true)
    expect(retryable('LLM_AUTH_FAILED')).toBe(false)
    expect(retryable('LLM_QUOTA_EXCEEDED')).toBe(false)
    expect(retryable('CONFIRMATION_STALE')).toBe(false)
  })
})
