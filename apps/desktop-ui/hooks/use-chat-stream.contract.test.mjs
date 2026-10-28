/**
 * Home Chat client for the round-7 server contract: server-sent tool effects,
 * `tool_reconciled` outcomes, budget notices and codes, single-writer refusal,
 * server-side Dismiss (revoke), history with incomplete markers, per-turn
 * usage, journal states and revoked confirmations, and the outcome refresh
 * after a turn ended with writes in an unknown state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/lib/api/chat', async (importOriginal) => ({
  ...(await importOriginal()),
  sendChatMessage: vi.fn(),
  fetchChatSession: vi.fn(),
  revokeChatConfirmation: vi.fn(),
}))

const { sendChatMessage, fetchChatSession, revokeChatConfirmation, ChatStreamError } = await import('@/lib/api/chat')
const { ApiError } = await import('@/lib/api/fetch')
const { useChatStream, OUTCOME_REFRESH_DELAYS_MS } = await import('./use-chat-stream.tsx')
const state = await import('./chat-stream-state.ts')

const CODE = 'CONFIRM-7KQ2MX9P'
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString()

function lastAssistant(result) {
  return result.current.messages.filter((message) => message.role === 'assistant').at(-1)
}

function previewTurn(code = CODE) {
  return async ({ onChunk, onDone }) => {
    onChunk({ type: 'user_message', messageId: 'u1', sessionId: 's1', turnId: 't1' })
    onChunk({ type: 'tool_call_start', toolCallId: 'call_p', toolName: 'bulk_update_issues', effect: 'destructive', messageId: 'a1', args: { status: 'done' } })
    onChunk({
      type: 'tool_result',
      toolCallId: 'call_p',
      toolName: 'bulk_update_issues',
      effect: 'destructive',
      messageId: 'a1',
      result: {
        ok: false,
        code: 'CONFIRMATION_REQUIRED',
        message: 'Set status to done on 2 issues. Nothing has changed yet.',
        details: { confirmation: { id: 'conf-1', code, expiresAt: inMinutes(10) }, summary: 'Set status to done on 2 issues', preview: { status: 'done', selection: 'explicit', willChange: [], alreadyInStatus: 0, notFound: [] } },
      },
    })
    onChunk({ type: 'confirmation_required', toolCallId: 'call_p', toolName: 'bulk_update_issues', code, expiresAt: inMinutes(10), summary: 'Set status to done on 2 issues' })
    onChunk({ type: 'assistant_final', messageId: 'a1b', content: `Reply with ${code}.` })
    onChunk({ type: 'done', sessionId: 's1' })
    onDone()
  }
}

beforeEach(() => {
  sendChatMessage.mockReset()
  fetchChatSession.mockReset()
  revokeChatConfirmation.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('tool_reconciled', () => {
  it('resolves an outcome-unknown write in the running turn, keeping the reconciliation visible', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onChunk, onDone }) => {
      onChunk({ type: 'tool_call_start', toolCallId: 'w', toolName: 'create_issue', effect: 'write', messageId: 'a1', args: { title: 'x' } })
      onChunk({ type: 'tool_result', toolCallId: 'w', toolName: 'create_issue', effect: 'write', messageId: 'a1', result: { ok: false, code: 'TOOL_OUTCOME_UNKNOWN', message: 'interrupted', details: { cause: 'TOOL_TIMEOUT' } } })
      onChunk({ type: 'assistant_delta', content: 'I tried.' })
      onChunk({
        type: 'tool_reconciled',
        toolCallId: 'w',
        toolName: 'create_issue',
        effect: 'write',
        messageId: 'a1',
        status: 'succeeded',
        result: { ok: true, code: 'OK', message: 'Issue created', data: { id: 'i1' }, details: { reconciledAfter: 'TOOL_TIMEOUT' } },
        reconciledAfter: 'TOOL_TIMEOUT',
        reconciledAt: '2026-10-26T10:00:00.000Z',
      })
      onChunk({ type: 'done', sessionId: 's1' })
      onDone()
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'create it')
    })
    const [call] = lastAssistant(result).toolCalls
    expect(call).toMatchObject({ status: 'completed', effect: 'write', code: 'OK', message: 'Issue created', messageId: 'a1' })
    expect(call.reconciled).toEqual({ status: 'succeeded', after: 'TOOL_TIMEOUT', at: '2026-10-26T10:00:00.000Z' })
    expect(call.error).toBeUndefined()
  })

  it('updates a call of an earlier, finished turn and moves its confirmation card to confirmed', async () => {
    sendChatMessage.mockImplementationOnce(previewTurn())
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'close them')
    })
    // The confirming turn's write is interrupted: outcome unknown.
    sendChatMessage.mockImplementationOnce(async ({ onChunk, onDone }) => {
      onChunk({ type: 'user_message', messageId: 'u2', sessionId: 's1' })
      onChunk({ type: 'tool_call_start', toolCallId: 'call_r', toolName: 'bulk_update_issues', effect: 'destructive', messageId: 'a2', args: { status: 'done', confirmationToken: CODE } })
      onChunk({ type: 'tool_result', toolCallId: 'call_r', toolName: 'bulk_update_issues', effect: 'destructive', messageId: 'a2', result: { ok: false, code: 'TOOL_OUTCOME_UNKNOWN', message: 'interrupted', details: { cause: 'TOOL_TIMEOUT' } } })
      onChunk({ type: 'assistant_final', messageId: 'a2b', content: 'Not sure it ran.' })
      onChunk({ type: 'done', sessionId: 's1' })
      onDone()
    })
    await act(async () => {
      result.current.confirm(CODE)
    })
    expect(result.current.confirmations[CODE].phase).toBe('outcome_unknown')

    // A later turn's stream carries the reconciliation of that earlier call.
    sendChatMessage.mockImplementationOnce(async ({ onChunk, onDone }) => {
      onChunk({ type: 'user_message', messageId: 'u3', sessionId: 's1' })
      onChunk({ type: 'tool_reconciled', toolCallId: 'call_r', toolName: 'bulk_update_issues', effect: 'destructive', messageId: 'a2', status: 'succeeded', result: { ok: true, code: 'OK', message: 'Issues updated', details: { confirmationId: 'conf-1', reconciledAfter: 'TOOL_TIMEOUT' } }, reconciledAfter: 'TOOL_TIMEOUT' })
      onChunk({ type: 'assistant_final', messageId: 'a3', content: 'It did run.' })
      onChunk({ type: 'done', sessionId: 's1' })
      onDone()
    })
    await act(async () => {
      await result.current.send('s1', 'did it run?')
    })
    const earlier = result.current.messages.filter((message) => message.role === 'assistant').at(-2)
    expect(earlier.toolCalls[0]).toMatchObject({ status: 'completed', redeems: CODE, reconciled: { status: 'succeeded' } })
    expect(result.current.confirmations[CODE].phase).toBe('confirmed')
  })
})

describe('budgets and single writer', () => {
  it('attaches budget_warning notices to the reply', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onChunk, onDone }) => {
      onChunk({ type: 'user_message', messageId: 'u1', sessionId: 's1' })
      onChunk({ type: 'budget_warning', code: 'CHAT_BUDGET_COST_UNKNOWN', message: 'This model has no configured price, so the USD chat budget cannot limit this reply. Token caps still apply.', details: { policy: 'allow' } })
      onChunk({ type: 'budget_warning', code: 'CHAT_BUDGET_NEARLY_EXHAUSTED', message: 'Your monthly chat budget is 85% used.', details: { scope: 'user', dimension: 'usd', resetsAt: '2026-11-01T00:00:00.000Z' } })
      onChunk({ type: 'assistant_final', messageId: 'a1', content: 'Answer.' })
      onChunk({ type: 'done', sessionId: 's1' })
      onDone()
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'hi')
    })
    const notices = lastAssistant(result).notices
    expect(notices.map((notice) => notice.code)).toEqual(['CHAT_BUDGET_COST_UNKNOWN', 'CHAT_BUDGET_NEARLY_EXHAUSTED'])
    expect(notices[0].message).toMatch(/no configured price/)
    expect(notices[1].message).toBe('Your monthly chat budget is almost used up.')
    expect(notices[1].hint).toBe('It resets on Nov 1.')
  })

  it('explains a 409 TURN_IN_PROGRESS refusal and offers Retry', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onError }) => {
      const origin = new ApiError(409, 'Another reply is still being written in this chat.', 'TURN_IN_PROGRESS', { retryAfterSeconds: 7, leaseExpiresAt: inMinutes(1) })
      onError(new ChatStreamError('Chat request failed: 409', { status: 409, code: 'TURN_IN_PROGRESS', details: origin.details, origin }))
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'second window')
    })
    const reply = lastAssistant(result)
    expect(reply.incomplete.reason).toBe('error')
    expect(reply.incomplete.error).toMatchObject({ code: 'TURN_IN_PROGRESS', status: 409, retryable: true, retryAfterMs: 7000 })
    expect(reply.incomplete.error.message).toMatch(/still being written/)
    expect(reply.retry).toBe('available')
  })

  it('explains budget refusals (request) and a budget stop (stream)', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onError }) => {
      const origin = new ApiError(402, 'used up', 'CHAT_BUDGET_EXCEEDED', { scope: 'workspace', dimension: 'usd', source: 'config', resetsAt: '2026-11-01T00:00:00.000Z' })
      onError(new ChatStreamError('Chat request failed: 402', { status: 402, code: 'CHAT_BUDGET_EXCEEDED', details: origin.details, origin }))
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'expensive')
    })
    expect(lastAssistant(result).incomplete.error).toMatchObject({
      code: 'CHAT_BUDGET_EXCEEDED',
      message: "This workspace's monthly chat spending budget is used up.",
      hint: 'It resets on Nov 1. A workspace owner or admin can raise the limit.',
      retryable: false,
    })

    sendChatMessage.mockImplementationOnce(async ({ onChunk }) => {
      onChunk({ type: 'assistant_delta', content: 'Partial' })
      onChunk({ type: 'error', code: 'CHAT_BUDGET_EXCEEDED', message: 'Your monthly chat token budget is used up.', details: { scope: 'user', dimension: 'tokens', limit: 100, spent: 140 } })
    })
    await act(async () => {
      await result.current.send('s1', 'more')
    })
    const stopped = lastAssistant(result)
    expect(stopped.content).toBe('Partial')
    expect(stopped.incomplete.error.message).toBe('Your monthly chat token budget is used up.')
  })
})

describe('Dismiss revokes the code on the server', () => {
  it('sends the revoke and marks the card revoked', async () => {
    sendChatMessage.mockImplementationOnce(previewTurn())
    revokeChatConfirmation.mockResolvedValueOnce({ confirmation: { id: 'conf-1', toolName: 'bulk_update_issues', state: 'revoked', expiresAt: inMinutes(10), consumedAt: null, revokedAt: new Date().toISOString() } })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'close them')
    })
    await act(async () => {
      result.current.dismissConfirmation(CODE)
    })
    expect(revokeChatConfirmation).toHaveBeenCalledWith('s1', CODE)
    expect(result.current.confirmations[CODE]).toMatchObject({ phase: 'dismissed', revoke: 'done' })
    // A dismissed card cannot be confirmed any more.
    expect(result.current.confirm(CODE)).toBe(false)
  })

  it('shows a change that already ran as confirmed, and a failed revoke as still usable', async () => {
    sendChatMessage.mockImplementationOnce(previewTurn())
    revokeChatConfirmation.mockRejectedValueOnce(new ApiError(409, 'already ran', 'CONFIRMATION_USED'))
    const first = renderHook(() => useChatStream())
    await act(async () => {
      await first.result.current.send('s1', 'close them')
    })
    await act(async () => {
      first.result.current.dismissConfirmation(CODE)
    })
    expect(first.result.current.confirmations[CODE]).toMatchObject({ phase: 'confirmed', outcome: 'This change had already been confirmed and ran.' })

    sendChatMessage.mockImplementationOnce(previewTurn())
    revokeChatConfirmation.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const second = renderHook(() => useChatStream())
    await act(async () => {
      await second.result.current.send('s1', 'close them')
    })
    await act(async () => {
      second.result.current.dismissConfirmation(CODE)
    })
    expect(second.result.current.confirmations[CODE]).toMatchObject({ phase: 'dismissed', revoke: 'failed' })
    expect(second.result.current.confirmations[CODE].error.message).toBeTruthy()
  })
})

describe('history replay', () => {
  const base = { sessionId: 's1', toolCallId: null, toolCalls: null }

  it('restores incomplete turns, usage totals, journal outcomes and revoked confirmations', async () => {
    const usage = { modelCalls: 1, coverage: 'complete', inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50, costUsd: 0.12, costBasis: 'estimated' }
    const history = [
      { ...base, id: 'u1', role: 'user', content: 'first', createdAt: '2026-10-26T10:00:00Z' },
      { ...base, id: 'a1', role: 'assistant', content: 'Full answer', finishReason: 'stop', incomplete: false, usage, createdAt: '2026-10-26T10:00:01Z' },
      { ...base, id: 'u2', role: 'user', content: 'second', createdAt: '2026-10-26T10:01:00Z' },
      { ...base, id: 'a2', role: 'assistant', content: 'Half', incomplete: true, errorCode: 'LLM_STREAM_ERROR', usage: { ...usage, costUsd: null, costBasis: 'unknown' }, createdAt: '2026-10-26T10:01:01Z' },
      { ...base, id: 'u3', role: 'user', content: 'third', createdAt: '2026-10-26T10:02:00Z' },
      { ...base, id: 'a3', role: 'assistant', content: 'Starting', incomplete: true, errorCode: 'CLIENT_ABORTED', createdAt: '2026-10-26T10:02:01Z' },
      { ...base, id: 'u4', role: 'user', content: 'fourth', createdAt: '2026-10-26T10:03:00Z' },
      { ...base, id: 'a4', role: 'assistant', content: null, incomplete: true, errorCode: 'LLM_PROVIDER_UNAVAILABLE', createdAt: '2026-10-26T10:03:01Z' },
      { ...base, id: 'u5', role: 'user', content: 'make one', createdAt: '2026-10-26T10:04:00Z' },
      {
        ...base,
        id: 'a5',
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'create_issue', arguments: '{"title":"x"}' } }],
        toolCallStates: [{ toolCallId: 'c1', toolName: 'create_issue', effect: 'write', status: 'succeeded', code: 'OK', reconciled: true, reconciledAfter: 'CLIENT_ABORTED', endedAt: '2026-10-26T10:04:09Z', result: { ok: true, code: 'OK', message: 'Issue created', details: { reconciledAfter: 'CLIENT_ABORTED' } } }],
        createdAt: '2026-10-26T10:04:01Z',
      },
      { ...base, id: 't5', role: 'tool', toolCallId: 'c1', toolName: 'create_issue', content: JSON.stringify({ ok: false, code: 'TOOL_OUTCOME_UNKNOWN', message: 'interrupted', details: { cause: 'CLIENT_ABORTED' } }), createdAt: '2026-10-26T10:04:02Z' },
      { ...base, id: 'u6', role: 'user', content: 'close them', createdAt: '2026-10-26T10:05:00Z' },
      {
        ...base,
        id: 'a6',
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c2', type: 'function', function: { name: 'bulk_update_issues', arguments: '{"status":"done"}' } }],
        toolCallStates: [{ toolCallId: 'c2', toolName: 'bulk_update_issues', effect: 'destructive', status: 'failed', code: 'CONFIRMATION_REQUIRED', reconciled: false, reconciledAfter: null, endedAt: '2026-10-26T10:05:01Z' }],
        createdAt: '2026-10-26T10:05:01Z',
      },
      { ...base, id: 't6', role: 'tool', toolCallId: 'c2', toolName: 'bulk_update_issues', content: JSON.stringify({ ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Preview', details: { confirmation: { id: 'conf-9', code: CODE, expiresAt: inMinutes(5) }, summary: 'Set status to done on 1 issue', preview: { status: 'done', selection: 'explicit', willChange: [], alreadyInStatus: 0, notFound: [] } } }), createdAt: '2026-10-26T10:05:02Z' },
    ]
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      result.current.loadHistory(history, 's1', {
        confirmations: [{ id: 'conf-9', toolName: 'bulk_update_issues', state: 'revoked', expiresAt: inMinutes(5), consumedAt: null, revokedAt: '2026-10-26T10:05:30Z' }],
      })
    })
    const assistants = result.current.messages.filter((message) => message.role === 'assistant')
    expect(assistants[0].incomplete).toBeUndefined()
    expect(assistants[0].usage).toEqual(usage)
    expect(assistants[1].incomplete).toMatchObject({ reason: 'error', error: { code: 'LLM_STREAM_ERROR' } })
    expect(assistants[2].incomplete).toEqual({ reason: 'stopped' })
    expect(assistants[3]).toMatchObject({ content: '', incomplete: { reason: 'error', error: { code: 'LLM_PROVIDER_UNAVAILABLE' } } })
    // The stored tool row said "unknown"; the journal says it ran.
    expect(assistants[4].toolCalls[0]).toMatchObject({ status: 'completed', effect: 'write', messageId: 'a5', reconciled: { status: 'succeeded', after: 'CLIENT_ABORTED' } })
    // Effect from the journal, card dismissed because the server revoked it.
    expect(assistants[5].toolCalls[0]).toMatchObject({ effect: 'destructive', status: 'needs_confirmation' })
    expect(result.current.confirmations[CODE].phase).toBe('dismissed')
    expect(result.current.confirm(CODE)).toBe(false)

    // Session totals survive a reload: stored usage is counted.
    expect(result.current.sessionUsage).toMatchObject({ turns: 2, inputTokens: 200, outputTokens: 40, cacheReadTokens: 100, knownCostUsd: 0.12, costIncomplete: true })
    // Failed turns stored without usage count as replies without usage.
    expect(result.current.sessionUsage.turnsWithoutUsage).toBe(2)
  })

  it('a stored call cancelled before it started reads as interrupted, not unknown', () => {
    const derived = state.deriveHistory([
      { ...base, id: 'u1', role: 'user', content: 'go', createdAt: '2026-10-26T10:00:00Z' },
      {
        ...base,
        id: 'a1',
        role: 'assistant',
        content: null,
        incomplete: true,
        errorCode: 'CLIENT_ABORTED',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'update_issue', arguments: '{}' } }],
        toolCallStates: [{ toolCallId: 'c1', toolName: 'update_issue', effect: 'write', status: 'cancelled', code: 'CLIENT_ABORTED', reconciled: false, reconciledAfter: null, endedAt: null }],
        createdAt: '2026-10-26T10:00:01Z',
      },
    ])
    expect(derived.messages[1].toolCalls[0]).toMatchObject({ status: 'error', effect: 'write' })
    expect(derived.messages[1].toolCalls[0].error.message).toMatch(/before it started/)
  })
})

describe('outcome refresh after an interrupted write', () => {
  it('re-reads the journal and resolves the unknown outcome once the server recorded it', async () => {
    vi.useFakeTimers()
    sendChatMessage.mockImplementationOnce(async ({ onChunk }) => {
      onChunk({ type: 'user_message', messageId: 'u1', sessionId: 's1' })
      onChunk({ type: 'tool_call_start', toolCallId: 'w', toolName: 'update_issue', effect: 'write', messageId: 'a1', args: { status: 'done' } })
      onChunk({ type: 'error', code: 'TURN_TIMEOUT', message: 'The chat turn exceeded its time limit' })
    })
    fetchChatSession
      .mockResolvedValueOnce({ session: {}, messages: [{ id: 'a1', sessionId: 's1', role: 'assistant', content: null, toolCalls: [], toolCallId: null, createdAt: '', toolCallStates: [{ toolCallId: 'w', toolName: 'update_issue', effect: 'write', status: 'cancelled', code: 'TOOL_OUTCOME_UNKNOWN', reconciled: false, reconciledAfter: null, endedAt: null }] }], nextCursor: null })
      .mockResolvedValueOnce({ session: {}, messages: [{ id: 'a1', sessionId: 's1', role: 'assistant', content: null, toolCalls: [], toolCallId: null, createdAt: '', toolCallStates: [{ toolCallId: 'w', toolName: 'update_issue', effect: 'write', status: 'succeeded', code: 'OK', reconciled: true, reconciledAfter: 'TURN_TIMEOUT', endedAt: '2026-10-26T10:00:05Z', result: { ok: true, code: 'OK', message: 'Issue updated' } }] }], nextCursor: null })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'close it')
    })
    expect(lastAssistant(result).toolCalls[0].status).toBe('unknown')

    // First refresh: still settling on the server.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_DELAYS_MS[0])
    })
    expect(fetchChatSession).toHaveBeenCalledTimes(1)
    expect(lastAssistant(result).toolCalls[0].status).toBe('unknown')

    // Second refresh: reconciled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_DELAYS_MS[1])
    })
    expect(fetchChatSession).toHaveBeenCalledTimes(2)
    expect(lastAssistant(result).toolCalls[0]).toMatchObject({ status: 'completed', message: 'Issue updated', reconciled: { status: 'succeeded', after: 'TURN_TIMEOUT' } })

    // Nothing left to resolve: no more requests.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fetchChatSession).toHaveBeenCalledTimes(2)
  })
})
