import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the dependencies
vi.mock('./client', () => ({
  getApiUrl: () => 'http://test',
  getAuthHeader: () => ({ Authorization: 'Bearer test' }),
}))

vi.mock('./fetch', () => ({
  apiFetch: vi.fn(),
}))

// Helper to create a ReadableStream from SSE lines
function createSSEStream(lines) {
  const encoder = new TextEncoder()
  const text = lines.map(l => l + '\n').join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

describe('sendChatMessage', () => {
  let sendChatMessage

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn())
    const mod = await import('./chat.ts')
    sendChatMessage = mod.sendChatMessage
  })

  it('parses assistant_delta chunks and calls onChunk', async () => {
    const chunks = []
    const body = createSSEStream([
      'data: {"type":"assistant_delta","content":"hello"}',
      'data: {"type":"assistant_delta","content":" world"}',
      'data: {"type":"done"}',
    ])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    const onDone = vi.fn()
    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: (c) => chunks.push(c),
      onDone,
    })

    // onChunk is called for all chunks including done
    const deltas = chunks.filter(c => c.type === 'assistant_delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0]).toEqual({ type: 'assistant_delta', content: 'hello' })
    expect(deltas[1]).toEqual({ type: 'assistant_delta', content: ' world' })
    expect(onDone).toHaveBeenCalled()
  })

  it('parses tool_call_start chunks', async () => {
    const chunks = []
    const body = createSSEStream([
      'data: {"type":"tool_call_start","toolCallId":"tc1","toolName":"list_workspaces","args":{}}',
      'data: {"type":"done"}',
    ])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: (c) => chunks.push(c),
    })

    expect(chunks[0]).toEqual({
      type: 'tool_call_start',
      toolCallId: 'tc1',
      toolName: 'list_workspaces',
      args: {},
    })
  })

  it('parses tool_result chunks', async () => {
    const chunks = []
    const body = createSSEStream([
      'data: {"type":"tool_result","toolCallId":"tc1","result":{"ok":true,"data":[]}}',
      'data: {"type":"done"}',
    ])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: (c) => chunks.push(c),
    })

    expect(chunks[0]).toEqual({
      type: 'tool_result',
      toolCallId: 'tc1',
      result: { ok: true, data: [] },
    })
  })

  it('calls onDone on type:done chunk', async () => {
    const body = createSSEStream(['data: {"type":"done"}'])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    const onDone = vi.fn()
    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onDone,
    })

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('calls onDone on data: [DONE] sentinel', async () => {
    const body = createSSEStream(['data: [DONE]'])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    const onDone = vi.fn()
    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onDone,
    })

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('calls onError on non-ok response', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })

    const onError = vi.fn()
    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onError,
    })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toContain('500')
  })

  it('skips malformed JSON lines without crashing', async () => {
    const chunks = []
    const body = createSSEStream([
      'data: {not valid json',
      'data: {"type":"assistant_delta","content":"ok"}',
      'data: {"type":"done"}',
    ])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: (c) => chunks.push(c),
    })

    const deltas = chunks.filter(c => c.type === 'assistant_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].content).toBe('ok')
  })

  it('ignores lines that do not start with data:', async () => {
    const chunks = []
    const body = createSSEStream([
      ': comment line',
      'event: message',
      'data: {"type":"assistant_delta","content":"yes"}',
      'data: {"type":"done"}',
    ])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: (c) => chunks.push(c),
    })

    const deltas = chunks.filter(c => c.type === 'assistant_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].content).toBe('yes')
  })

  it('calls onError on error chunk with nested error', async () => {
    const body = createSSEStream([
      'data: {"type":"error","error":{"code":"RATE_LIMIT","message":"Too many requests"}}',
    ])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    const onError = vi.fn()
    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onError,
    })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('Too many requests')
  })

  it('calls onError on error chunk with flat message', async () => {
    const body = createSSEStream([
      'data: {"type":"error","message":"Something broke"}',
    ])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    const onError = vi.fn()
    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onError,
    })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('Something broke')
  })

  it('sends correct request headers and body', async () => {
    const body = createSSEStream(['data: {"type":"done"}'])
    globalThis.fetch.mockResolvedValue({ ok: true, body })

    await sendChatMessage({
      sessionId: 'sess-123',
      content: 'hello there',
      onChunk: vi.fn(),
    })

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://test/api/chat/sessions/sess-123/messages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test',
        },
        body: JSON.stringify({ content: 'hello there' }),
      }),
    )
  })

  it('calls onError when response body is null', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, body: null })

    const onError = vi.fn()
    await sendChatMessage({
      sessionId: 's1',
      content: 'hi',
      onChunk: vi.fn(),
      onError,
    })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('No response body')
  })
})
