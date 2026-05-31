import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fetch', () => ({
  apiFetch: vi.fn(),
}))

vi.mock('./client', () => ({
  getApiUrl: vi.fn().mockReturnValue('http://127.0.0.1:3001'),
  getAuthHeader: vi.fn().mockReturnValue({ Authorization: 'Bearer tok' }),
}))

const { getApiUrl, getAuthHeader } = await import('./client')

const {
  fetchChatSessions,
  createChatSession,
  fetchChatSession,
  updateChatSession,
  archiveChatSession,
  transcribeChatAudio,
  uploadChatAttachment,
  sendChatMessage,
} = await import('./chat')

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
    expect(apiFetch).toHaveBeenCalledWith('/api/transcribe', {
      method: 'POST',
      sidecar: true,
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
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Server Error',
    })

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError,
    })

    expect(onError).toHaveBeenCalled()
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
