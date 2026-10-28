import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Only the network call is stubbed; types, the tool-effect catalogue and
// ChatStreamError stay real.
vi.mock('@/lib/api/chat', async (importOriginal) => ({
  ...(await importOriginal()),
  sendChatMessage: vi.fn(),
}))

const { sendChatMessage } = await import('@/lib/api/chat')
const { useChatStream } = await import('./use-chat-stream.tsx')

describe('useChatStream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('send adds a user message and sets status to streaming', async () => {
    sendChatMessage.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    const { result } = renderHook(() => useChatStream())

    act(() => {
      result.current.send('s1', 'hello')
    })

    expect(result.current.status).toBe('streaming')
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].role).toBe('user')
    expect(result.current.messages[0].content).toBe('hello')
    expect(result.current.messages[0].createdAt).toBeDefined()
  })

  it('assistant_delta chunks accumulate streamingContent', async () => {
    sendChatMessage.mockImplementation(async ({ onChunk }) => {
      onChunk({ type: 'assistant_delta', content: 'Hello' })
      onChunk({ type: 'assistant_delta', content: ' world' })
    })

    const { result } = renderHook(() => useChatStream())

    await act(async () => {
      await result.current.send('s1', 'hello')
    })

    expect(result.current.streamingContent).toBe('Hello world')
    expect(result.current.status).toBe('streaming')
  })

  it('tool_call_start chunks add to activeToolCalls', async () => {
    sendChatMessage.mockImplementation(async ({ onChunk }) => {
      onChunk({ type: 'tool_call_start', toolCall: { id: 'tc1', name: 'test_tool', arguments: '{}' } })
    })

    const { result } = renderHook(() => useChatStream())

    await act(async () => {
      await result.current.send('s1', 'hello')
    })

    expect(result.current.activeToolCalls).toHaveLength(1)
    expect(result.current.activeToolCalls[0]).toMatchObject({
      id: 'tc1',
      name: 'test_tool',
      arguments: '{}',
      status: 'in_progress',
    })
  })

  it('tool_result chunks update existing tool call status', async () => {
    sendChatMessage.mockImplementation(async ({ onChunk }) => {
      onChunk({ type: 'tool_call_start', toolCall: { id: 'tc1', name: 'test_tool', arguments: '{}' } })
      onChunk({ type: 'tool_result', toolResult: { toolCallId: 'tc1', name: 'test_tool', content: 'done', isError: false } })
    })

    const { result } = renderHook(() => useChatStream())

    await act(async () => {
      await result.current.send('s1', 'hello')
    })

    expect(result.current.activeToolCalls).toHaveLength(1)
    expect(result.current.activeToolCalls[0].status).toBe('completed')
    expect(result.current.activeToolCalls[0].result).toBe('done')
    expect(result.current.activeToolCalls[0].isError).toBe(false)
  })

  it('assistant_final chunk updates final content', async () => {
    sendChatMessage.mockImplementation(async ({ onChunk, onDone }) => {
      onChunk({ type: 'assistant_delta', content: 'Hello' })
      onChunk({ type: 'assistant_final', content: 'Final answer' })
      onChunk({ type: 'done' })
      onDone()
    })

    const { result } = renderHook(() => useChatStream())

    await act(async () => {
      await result.current.send('s1', 'hello')
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].role).toBe('assistant')
    expect(result.current.messages[1].content).toBe('Final answer')
    expect(result.current.streamingContent).toBe('')
    expect(result.current.status).toBe('idle')
  })

  it('done chunk finalizes the assistant message', async () => {
    sendChatMessage.mockImplementation(async ({ onChunk, onDone }) => {
      onChunk({ type: 'assistant_delta', content: 'Hello' })
      onChunk({ type: 'done' })
      onDone()
    })

    const { result } = renderHook(() => useChatStream())

    await act(async () => {
      await result.current.send('s1', 'hello')
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].role).toBe('assistant')
    expect(result.current.messages[1].content).toBe('Hello')
    expect(result.current.streamingContent).toBe('')
    expect(result.current.status).toBe('idle')
  })

  // The failure is structured (incomplete.error), no longer written into the
  // assistant's text, so a partial answer and the error can both be shown.
  it('error chunk adds an incomplete assistant turn and sets status to error', async () => {
    sendChatMessage.mockImplementation(async ({ onChunk }) => {
      onChunk({ type: 'error', error: { code: 'E', message: 'fail' } })
    })

    const { result } = renderHook(() => useChatStream())

    await act(async () => {
      await result.current.send('s1', 'hello')
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].role).toBe('assistant')
    expect(result.current.messages[1].content).toBe('')
    expect(result.current.messages[1].incomplete).toMatchObject({ reason: 'error', error: { code: 'E', message: 'fail' } })
    expect(result.current.messages[1].retry).toBe('available')
    expect(result.current.status).toBe('error')
  })

  it('onError callback adds an incomplete assistant turn', async () => {
    sendChatMessage.mockImplementation(async ({ onError }) => {
      onError(new Error('network fail'))
    })

    const { result } = renderHook(() => useChatStream())

    await act(async () => {
      await result.current.send('s1', 'hello')
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].role).toBe('assistant')
    expect(result.current.messages[1].content).toBe('')
    expect(result.current.messages[1].incomplete).toMatchObject({ reason: 'error', error: { message: 'network fail' } })
    expect(result.current.status).toBe('error')
  })

  it('stop calls abort and sets status to idle', async () => {
    sendChatMessage.mockImplementation(async ({ signal }) => {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (signal.aborted) return
    })

    const { result } = renderHook(() => useChatStream())

    act(() => {
      result.current.send('s1', 'hello')
    })

    expect(result.current.status).toBe('streaming')

    act(() => {
      result.current.stop()
    })

    expect(result.current.status).toBe('idle')
  })

  it('reset clears all state and aborts', async () => {
    sendChatMessage.mockImplementation(async ({ signal, onChunk }) => {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (signal.aborted) return
      onChunk({ type: 'assistant_delta', content: 'Hello' })
    })

    const { result } = renderHook(() => useChatStream())

    act(() => {
      result.current.send('s1', 'hello')
    })

    expect(result.current.status).toBe('streaming')

    act(() => {
      result.current.reset()
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.messages).toHaveLength(0)
    expect(result.current.streamingContent).toBe('')
    expect(result.current.activeToolCalls).toHaveLength(0)
  })

  it('loadHistory loads historical messages', async () => {
    const { result } = renderHook(() => useChatStream())

    const history = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: 'hello',
        toolCalls: null,
        toolCallId: null,
        name: null,
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'm2',
        sessionId: 's1',
        role: 'assistant',
        content: 'hi',
        toolCalls: [{ id: 'tc1', name: 'tool', arguments: '{}' }],
        toolCallId: null,
        name: null,
        createdAt: '2024-01-01T00:00:01Z',
      },
      // The server stores each tool result as a `tool` row after the call.
      {
        id: 'm3',
        sessionId: 's1',
        role: 'tool',
        content: JSON.stringify({ ok: true, code: 'OK', message: 'done', data: { n: 1 } }),
        toolCalls: null,
        toolCallId: 'tc1',
        toolName: 'tool',
        createdAt: '2024-01-01T00:00:02Z',
      },
    ]

    await act(async () => {
      result.current.loadHistory(history)
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].role).toBe('user')
    expect(result.current.messages[0].content).toBe('hello')
    expect(result.current.messages[1].role).toBe('assistant')
    expect(result.current.messages[1].content).toBe('hi')
    expect(result.current.messages[1].toolCalls).toHaveLength(1)
    expect(result.current.messages[1].toolCalls[0].id).toBe('tc1')
    expect(result.current.messages[1].toolCalls[0].status).toBe('completed')
  })

  it('loadHistory marks a stored write call without a stored result as outcome unknown', async () => {
    const { result } = renderHook(() => useChatStream())

    await act(async () => {
      result.current.loadHistory([
        { id: 'm1', sessionId: 's1', role: 'user', content: 'make an issue', toolCalls: null, toolCallId: null, createdAt: '2024-01-01T00:00:00Z' },
        {
          id: 'm2',
          sessionId: 's1',
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'create_issue', arguments: '{"title":"x"}' } },
            { id: 'c2', type: 'function', function: { name: 'list_issues', arguments: '{}' } },
          ],
          // Effects come from the server's journal states (no client catalogue).
          toolCallStates: [
            { toolCallId: 'c1', toolName: 'create_issue', effect: 'write', status: 'running', code: null, reconciled: false, reconciledAfter: null, endedAt: null },
            { toolCallId: 'c2', toolName: 'list_issues', effect: 'read', status: 'running', code: null, reconciled: false, reconciledAfter: null, endedAt: null },
          ],
          toolCallId: null,
          createdAt: '2024-01-01T00:00:01Z',
        },
      ])
    })

    const [write, read] = result.current.messages[1].toolCalls
    expect(write).toMatchObject({ status: 'unknown', effect: 'write', code: 'TOOL_OUTCOME_UNKNOWN' })
    expect(read).toMatchObject({ status: 'error', effect: 'read' })
  })

  it('multiple tool calls in one stream', async () => {
    sendChatMessage.mockImplementation(async ({ onChunk, onDone }) => {
      onChunk({ type: 'tool_call_start', toolCall: { id: 'tc1', name: 'tool1', arguments: '{}' } })
      onChunk({ type: 'tool_call_start', toolCall: { id: 'tc2', name: 'tool2', arguments: '{}' } })
      onChunk({ type: 'tool_result', toolResult: { toolCallId: 'tc1', name: 'tool1', content: 'r1', isError: false } })
      onChunk({ type: 'tool_result', toolResult: { toolCallId: 'tc2', name: 'tool2', content: 'r2', isError: true } })
      onChunk({ type: 'done' })
      onDone()
    })

    const { result } = renderHook(() => useChatStream())

    await act(async () => {
      await result.current.send('s1', 'hello')
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].role).toBe('assistant')
    expect(result.current.messages[1].toolCalls).toHaveLength(2)
    expect(result.current.messages[1].toolCalls[0]).toMatchObject({
      id: 'tc1',
      name: 'tool1',
      status: 'completed',
      result: 'r1',
      isError: false,
    })
    expect(result.current.messages[1].toolCalls[1]).toMatchObject({
      id: 'tc2',
      name: 'tool2',
      status: 'error',
      result: 'r2',
      isError: true,
    })
  })
})
