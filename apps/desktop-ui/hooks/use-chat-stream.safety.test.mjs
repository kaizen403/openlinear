/**
 * Home Chat client for the tool-safety / metering backend: confirmation
 * cards, effect-aware tool rows, interrupted turns with Retry, usage.
 * The server stream is replayed through a stubbed `sendChatMessage`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/lib/api/chat', async (importOriginal) => ({
  ...(await importOriginal()),
  sendChatMessage: vi.fn(),
}))

const { sendChatMessage, ChatStreamError } = await import('@/lib/api/chat')
const { useChatStream } = await import('./use-chat-stream.tsx')

const CODE_A = 'CONFIRM-7KQ2MX9P'
const CODE_B = 'CONFIRM-AB12CD34'
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString()

function previewResult(code, { expiresAt = inMinutes(10), id = `conf-${code}`, status = 'done' } = {}) {
  return {
    ok: false,
    code: 'CONFIRMATION_REQUIRED',
    message: `Set status to ${status} on 2 issues. Nothing has changed yet.`,
    details: {
      confirmation: { id, code, expiresAt },
      summary: `Set status to ${status} on 2 issues`,
      preview: {
        projectId: 'p1',
        status,
        selection: 'explicit_issue_ids',
        willChange: [
          { id: 'i1', identifier: 'KT-1', title: 'First', status: 'todo' },
          { id: 'i2', identifier: 'KT-2', title: 'Second', status: 'in_progress' },
        ],
        alreadyInStatus: 1,
        notFound: [],
      },
    },
  }
}

/** A preview turn: the model calls bulk_update_issues and gets a code back. */
function previewTurn(code, options = {}) {
  const callId = options.callId ?? `call_${code}`
  const result = previewResult(code, options)
  return async ({ onChunk, onDone }) => {
    onChunk({ type: 'user_message', messageId: 'u1', sessionId: 's1' })
    onChunk({ type: 'tool_call_start', toolCallId: callId, toolName: 'bulk_update_issues', effect: 'destructive', messageId: 'a1-tools', args: { status: options.status ?? 'done', issueIds: ['i1', 'i2', 'i3'] } })
    onChunk({ type: 'tool_result', toolCallId: callId, toolName: 'bulk_update_issues', effect: 'destructive', messageId: 'a1-tools', result })
    onChunk({
      type: 'confirmation_required',
      toolCallId: callId,
      toolName: 'bulk_update_issues',
      code,
      expiresAt: result.details.confirmation.expiresAt,
      summary: result.details.summary,
    })
    onChunk({ type: 'assistant_final', messageId: 'a1', content: `Reply with ${code} to proceed.` })
    onChunk({ type: 'done', sessionId: 's1' })
    onDone()
  }
}

/** The confirming turn: the model redeems the code and the server answers `result`. */
function redeemTurn(code, result) {
  return async ({ onChunk, onDone }) => {
    onChunk({ type: 'user_message', messageId: 'u2', sessionId: 's1' })
    onChunk({ type: 'tool_call_start', toolCallId: 'call_redeem', toolName: 'bulk_update_issues', effect: 'destructive', messageId: 'a2-tools', args: { status: 'done', issueIds: ['i1', 'i2', 'i3'], confirmationToken: code } })
    onChunk({ type: 'tool_result', toolCallId: 'call_redeem', toolName: 'bulk_update_issues', effect: 'destructive', messageId: 'a2-tools', result })
    onChunk({ type: 'assistant_final', messageId: 'a2', content: 'Done.' })
    onChunk({ type: 'done', sessionId: 's1' })
    onDone()
  }
}

async function renderWithPreview(code = CODE_A, options) {
  sendChatMessage.mockImplementationOnce(previewTurn(code, options))
  const hook = renderHook(() => useChatStream())
  await act(async () => {
    await hook.result.current.send('s1', 'close KT-1 and KT-2')
  })
  return hook
}

function lastAssistant(result) {
  return result.current.messages.filter((message) => message.role === 'assistant').at(-1)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('confirmation_required', () => {
  it('renders the preview as a pending confirmation on a destructive tool row', async () => {
    const { result } = await renderWithPreview()

    const call = lastAssistant(result).toolCalls[0]
    expect(call).toMatchObject({ name: 'bulk_update_issues', effect: 'destructive', status: 'needs_confirmation', code: 'CONFIRMATION_REQUIRED' })
    expect(call.confirmation).toMatchObject({
      code: CODE_A,
      confirmationId: `conf-${CODE_A}`,
      summary: 'Set status to done on 2 issues',
      preview: { kind: 'status_change', status: 'done', unchangedCount: 1, wholeProject: false },
    })
    expect(call.confirmation.preview.issues.map((issue) => issue.identifier)).toEqual(['KT-1', 'KT-2'])
    expect(result.current.confirmations[CODE_A]).toEqual({ phase: 'pending' })
  })

  it('Confirm sends exactly the token for that card through confirmationTokens', async () => {
    const { result } = await renderWithPreview(CODE_A)
    // A second, unrelated card in the same chat.
    sendChatMessage.mockImplementationOnce(previewTurn(CODE_B, { callId: 'call_b', status: 'cancelled' }))
    await act(async () => {
      await result.current.send('s1', 'and cancel the others')
    })
    expect(result.current.confirmations[CODE_B]).toEqual({ phase: 'pending' })

    sendChatMessage.mockImplementationOnce(redeemTurn(CODE_B, { ok: true, code: 'OK', message: 'Issues updated', details: { confirmationId: `conf-${CODE_B}` } }))
    let accepted
    await act(async () => {
      accepted = result.current.confirm(CODE_B)
    })

    expect(accepted).toBe(true)
    const request = sendChatMessage.mock.calls.at(-1)[0]
    expect(request.sessionId).toBe('s1')
    expect(request.confirmationTokens).toEqual([CODE_B])
    expect(request.content).toContain(CODE_B)
    expect(request.content).not.toContain(CODE_A)
    expect(result.current.confirmations[CODE_B]).toMatchObject({ phase: 'confirmed', via: 'button', outcome: 'Issues updated' })
    expect(result.current.confirmations[CODE_A]).toEqual({ phase: 'pending' })
  })

  it('never auto-confirms: a preview alone sends nothing more', async () => {
    await renderWithPreview()
    expect(sendChatMessage).toHaveBeenCalledTimes(1)
  })

  it('blocks a double submit of the same card', async () => {
    const { result } = await renderWithPreview()
    let release
    sendChatMessage.mockImplementationOnce(({ onChunk }) => new Promise((resolve) => {
      onChunk({ type: 'user_message', messageId: 'u2', sessionId: 's1' })
      release = resolve
    }))

    let first
    let second
    act(() => {
      first = result.current.confirm(CODE_A)
      second = result.current.confirm(CODE_A)
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(sendChatMessage).toHaveBeenCalledTimes(2)
    expect(result.current.confirmations[CODE_A].phase).toBe('submitting')
    await act(async () => {
      release()
    })
  })

  it('a card for a stale selection is refused with the mapped message and cannot be confirmed twice', async () => {
    const { result } = await renderWithPreview()
    sendChatMessage.mockImplementationOnce(redeemTurn(CODE_A, {
      ok: false,
      code: 'CONFIRMATION_STALE',
      message: 'The selection or the change no longer matches the confirmed preview.',
    }))

    await act(async () => {
      result.current.confirm(CODE_A)
    })

    expect(result.current.confirmations[CODE_A]).toMatchObject({
      phase: 'rejected',
      error: { code: 'CONFIRMATION_STALE', message: 'The issues changed after this preview was made.' },
    })
    expect(result.current.confirmations[CODE_A].error.hint).toMatch(/fresh preview/)

    let again
    await act(async () => {
      again = result.current.confirm(CODE_A)
    })
    expect(again).toBe(false)
    expect(sendChatMessage).toHaveBeenCalledTimes(2)
  })

  it('an expired card is not sent', async () => {
    const { result } = await renderWithPreview(CODE_A, { expiresAt: new Date(Date.now() - 1000).toISOString() })

    let accepted
    await act(async () => {
      accepted = result.current.confirm(CODE_A)
    })

    expect(accepted).toBe(false)
    expect(sendChatMessage).toHaveBeenCalledTimes(1)
    expect(result.current.confirmations[CODE_A].phase).toBe('pending')
  })

  it('maps a server-side CONFIRMATION_EXPIRED to a clear message', async () => {
    const { result } = await renderWithPreview()
    sendChatMessage.mockImplementationOnce(redeemTurn(CODE_A, {
      ok: false,
      code: 'CONFIRMATION_EXPIRED',
      message: 'This confirmation code has expired. Call the tool without confirmationToken to get a new preview.',
    }))

    await act(async () => {
      result.current.confirm(CODE_A)
    })

    expect(result.current.confirmations[CODE_A]).toMatchObject({
      phase: 'rejected',
      error: { code: 'CONFIRMATION_EXPIRED', message: 'This confirmation expired; codes are valid for 10 minutes.' },
    })
  })

  it('maps CONFIRMATION_USED and keeps the card closed', async () => {
    const { result } = await renderWithPreview()
    sendChatMessage.mockImplementationOnce(redeemTurn(CODE_A, { ok: false, code: 'CONFIRMATION_USED', message: 'already used' }))

    await act(async () => {
      result.current.confirm(CODE_A)
    })

    expect(result.current.confirmations[CODE_A]).toMatchObject({ phase: 'rejected', error: { message: 'This confirmation was already used.' } })
  })

  it('reports an interrupted confirmed change as outcome unknown', async () => {
    const { result } = await renderWithPreview()
    sendChatMessage.mockImplementationOnce(redeemTurn(CODE_A, {
      ok: false,
      code: 'TOOL_OUTCOME_UNKNOWN',
      message: 'The tool was interrupted after it started.',
      details: { cause: 'TOOL_TIMEOUT' },
    }))

    await act(async () => {
      result.current.confirm(CODE_A)
    })

    expect(result.current.confirmations[CODE_A].phase).toBe('outcome_unknown')
    expect(lastAssistant(result).toolCalls[0]).toMatchObject({ status: 'unknown', effect: 'destructive', redeems: CODE_A })
  })

  it('reopens the card when the confirmation never reached the server', async () => {
    const { result } = await renderWithPreview()
    sendChatMessage.mockImplementationOnce(async ({ onError }) => {
      onError(new ChatStreamError('Chat request failed: 429 Too many chat messages', {
        status: 429,
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: 60 },
      }))
    })

    await act(async () => {
      result.current.confirm(CODE_A)
    })

    expect(result.current.confirmations[CODE_A].phase).toBe('pending')
    expect(result.current.confirmations[CODE_A].error.message).toMatch(/wasn't acknowledged/)

    sendChatMessage.mockImplementationOnce(redeemTurn(CODE_A, { ok: true, code: 'OK', message: 'Issues updated' }))
    let again
    await act(async () => {
      again = result.current.confirm(CODE_A)
    })
    expect(again).toBe(true)
    expect(result.current.confirmations[CODE_A].phase).toBe('confirmed')
  })

  it('keeps the typed-code fallback working and reflects it on the card', async () => {
    const { result } = await renderWithPreview()
    sendChatMessage.mockImplementationOnce(redeemTurn(CODE_A, { ok: true, code: 'OK', message: 'Issues updated' }))

    await act(async () => {
      await result.current.send('s1', `yes, ${CODE_A.toLowerCase()}`)
    })

    const request = sendChatMessage.mock.calls.at(-1)[0]
    expect(request.content).toBe(`yes, ${CODE_A.toLowerCase()}`)
    expect(request.confirmationTokens).toBeUndefined()
    expect(result.current.confirmations[CODE_A]).toMatchObject({ phase: 'confirmed', via: 'typed' })
  })

  it('a newer preview in the confirming turn supersedes the old card', async () => {
    const { result } = await renderWithPreview()
    sendChatMessage.mockImplementationOnce(previewTurn(CODE_B, { callId: 'call_again' }))

    await act(async () => {
      result.current.confirm(CODE_A)
    })

    expect(result.current.confirmations[CODE_A].phase).toBe('superseded')
    expect(result.current.confirmations[CODE_B].phase).toBe('pending')
  })

  it('a model replaying a code on its own does not close a pending card', async () => {
    const { result } = await renderWithPreview()
    sendChatMessage.mockImplementationOnce(redeemTurn(CODE_A, {
      ok: false,
      code: 'CONFIRMATION_NOT_FROM_USER',
      message: "The user's latest message does not contain the code.",
    }))

    await act(async () => {
      await result.current.send('s1', 'what will that change?')
    })

    expect(result.current.confirmations[CODE_A]).toEqual({ phase: 'pending' })
  })

  it('dismiss closes the card without sending anything', async () => {
    const { result } = await renderWithPreview()

    act(() => {
      result.current.dismissConfirmation(CODE_A)
    })

    expect(result.current.confirmations[CODE_A].phase).toBe('dismissed')
    let accepted
    act(() => {
      accepted = result.current.confirm(CODE_A)
    })
    expect(accepted).toBe(false)
    expect(sendChatMessage).toHaveBeenCalledTimes(1)
  })

  it('creates the card from the confirmation_required event alone', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onChunk, onDone }) => {
      onChunk({ type: 'tool_call_start', toolCallId: 'c1', toolName: 'archive_issues', args: { issueIdentifiers: ['KT-1'] } })
      onChunk({ type: 'confirmation_required', toolCallId: 'c1', toolName: 'archive_issues', code: CODE_A, expiresAt: inMinutes(10), summary: 'Archive 1 issue' })
      onChunk({ type: 'done', sessionId: 's1' })
      onDone()
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'archive KT-1')
    })

    expect(lastAssistant(result).toolCalls[0]).toMatchObject({
      status: 'needs_confirmation',
      effect: 'destructive',
      confirmation: { code: CODE_A, summary: 'Archive 1 issue', preview: null },
    })
    expect(result.current.confirmations[CODE_A].phase).toBe('pending')
  })
})

describe('effect-aware tool rows', () => {
  it('classifies tool calls by effect and keeps unknown tools unclassified', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onChunk, onDone }) => {
      // The server sends each tool's effect (null for a tool it does not know).
      onChunk({ type: 'tool_call_start', toolCallId: 'r', toolName: 'list_issues', effect: 'read', messageId: 'm-tools', args: {} })
      onChunk({ type: 'tool_call_start', toolCallId: 'w', toolName: 'create_issue', effect: 'write', messageId: 'm-tools', args: { title: 'x' } })
      onChunk({ type: 'tool_call_start', toolCallId: 'x', toolName: 'mystery_tool', effect: null, messageId: 'm-tools', args: {} })
      onChunk({ type: 'tool_result', toolCallId: 'r', toolName: 'list_issues', result: { ok: true, code: 'OK', message: 'Issues', data: [] } })
      onChunk({ type: 'tool_result', toolCallId: 'w', toolName: 'create_issue', result: { ok: false, code: 'TOOL_OUTCOME_UNKNOWN', message: 'interrupted', details: { cause: 'TOOL_TIMEOUT' } } })
      onChunk({ type: 'tool_result', toolCallId: 'x', toolName: 'mystery_tool', result: { ok: false, code: 'UNKNOWN_TOOL', message: 'Unknown tool: mystery_tool' } })
      onChunk({ type: 'done', sessionId: 's1' })
      onDone()
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'go')
    })

    const [read, write, unknown] = lastAssistant(result).toolCalls
    expect(read).toMatchObject({ effect: 'read', status: 'completed', isError: false })
    expect(write).toMatchObject({ effect: 'write', status: 'unknown', code: 'TOOL_OUTCOME_UNKNOWN' })
    expect(write.error.message).toMatch(/may or may not have been applied/)
    expect(unknown).toMatchObject({ effect: null, status: 'error' })
    expect(unknown.error.message).toBe("The assistant tried an action that doesn't exist.")
  })

  it('marks a write still running when the stream fails as outcome unknown, and a read as interrupted', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onChunk }) => {
      onChunk({ type: 'tool_call_start', toolCallId: 'r', toolName: 'get_issue', effect: 'read', args: {} })
      onChunk({ type: 'tool_call_start', toolCallId: 'w', toolName: 'update_issue', effect: 'write', args: {} })
      onChunk({ type: 'error', code: 'TURN_TIMEOUT', message: 'The chat turn exceeded its time limit' })
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'go')
    })

    const [read, write] = lastAssistant(result).toolCalls
    expect(read.status).toBe('error')
    expect(write.status).toBe('unknown')
  })
})

describe('errors and truncation', () => {
  it('keeps partial text marked incomplete with the mapped error and a Retry that resends the request', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onChunk, onError }) => {
      onChunk({ type: 'user_message', messageId: 'u1', sessionId: 's1' })
      onChunk({ type: 'assistant_delta', content: 'Here is the pla' })
      const chunk = { type: 'error', code: 'LLM_STREAM_TRUNCATED', message: 'The model stream ended before the response was complete' }
      onChunk(chunk)
      onError(new ChatStreamError(chunk.message, { code: chunk.code }))
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'plan the sprint', ['att-1'])
    })

    const failed = lastAssistant(result)
    expect(failed.content).toBe('Here is the pla')
    expect(failed.incomplete).toMatchObject({
      reason: 'error',
      error: { code: 'LLM_STREAM_TRUNCATED', message: 'The reply was cut off before it finished.', retryable: true },
    })
    expect(failed.retry).toBe('available')
    expect(result.current.status).toBe('error')

    sendChatMessage.mockImplementationOnce(async ({ onChunk, onDone }) => {
      onChunk({ type: 'assistant_final', messageId: 'a2', content: 'Full plan.' })
      onChunk({ type: 'done', sessionId: 's1' })
      onDone()
    })
    await act(async () => {
      result.current.retry(failed.id)
    })

    const retried = sendChatMessage.mock.calls.at(-1)[0]
    expect(retried).toMatchObject({ sessionId: 's1', content: 'plan the sprint', attachmentIds: ['att-1'] })
    expect(result.current.messages.find((message) => message.id === failed.id).retry).toBe('used')
    expect(lastAssistant(result).content).toBe('Full plan.')
    expect(lastAssistant(result).incomplete).toBeUndefined()

    // A used Retry does nothing.
    await act(async () => {
      result.current.retry(failed.id)
    })
    expect(sendChatMessage).toHaveBeenCalledTimes(2)
  })

  it('maps provider codes to actionable copy', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onChunk }) => {
      onChunk({ type: 'error', code: 'LLM_RATE_LIMITED', message: 'rate limited', details: { retryAfterSeconds: 7 } })
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'hi')
    })

    expect(lastAssistant(result).incomplete.error).toMatchObject({
      code: 'LLM_RATE_LIMITED',
      message: 'The AI provider is rate-limiting requests.',
      hint: 'Wait 7 seconds, then retry.',
      retryAfterMs: 7000,
    })
  })

  it('describes a request rejected before streaming from the original API error', async () => {
    const { ApiError } = await import('@/lib/api/fetch')
    sendChatMessage.mockImplementationOnce(async ({ onError }) => {
      const origin = new ApiError(404, 'Resource not found', 'OWNERSHIP_REQUIRED', { resourceType: 'workspace' })
      onError(new ChatStreamError('Chat request failed: 404 Resource not found', { status: 404, code: origin.code, origin }))
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'hi')
    })

    expect(lastAssistant(result).incomplete.error.message).toBe('This workspace no longer exists or you no longer have access to it.')
  })

  it('stop keeps the partial reply as incomplete with Retry', async () => {
    sendChatMessage.mockImplementationOnce(({ onChunk, signal }) => new Promise((resolve) => {
      onChunk({ type: 'assistant_delta', content: 'Partial' })
      signal.addEventListener('abort', () => resolve())
    }))
    const { result } = renderHook(() => useChatStream())
    act(() => {
      result.current.send('s1', 'long question')
    })
    await act(async () => {
      result.current.stop()
    })

    expect(lastAssistant(result)).toMatchObject({ content: 'Partial', incomplete: { reason: 'stopped' }, retry: 'available' })
    expect(result.current.status).toBe('idle')
  })

  it('a reply cut at the length limit is marked, without Retry', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onChunk, onDone }) => {
      onChunk({ type: 'assistant_final', messageId: 'a1', content: 'Long answer…', finishReason: 'length' })
      onChunk({ type: 'done', sessionId: 's1' })
      onDone()
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'tell me everything')
    })

    expect(lastAssistant(result).incomplete).toEqual({ reason: 'length' })
    expect(lastAssistant(result).retry).toBeUndefined()
    expect(result.current.status).toBe('idle')
  })
})

describe('usage', () => {
  it('stores done.usage on the turn and totals the session without inventing a cost', async () => {
    const turns = [
      { modelCalls: 2, coverage: 'complete', inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 800, cacheWriteTokens: null, reasoningTokens: null, costUsd: null, costBasis: 'unknown' },
      { modelCalls: 1, coverage: 'complete', inputTokens: 500, outputTokens: 50, totalTokens: 550, cacheReadTokens: 400, cacheWriteTokens: null, reasoningTokens: null, costUsd: 0.0021, costBasis: 'estimated' },
    ]
    for (const usage of turns) {
      sendChatMessage.mockImplementationOnce(async ({ onChunk, onDone }) => {
        onChunk({ type: 'assistant_final', messageId: 'a', content: 'ok' })
        onChunk({ type: 'done', sessionId: 's1', usage })
        onDone()
      })
    }
    const { result } = renderHook(() => useChatStream())
    expect(result.current.sessionUsage).toBeNull()

    await act(async () => {
      await result.current.send('s1', 'one')
    })
    expect(lastAssistant(result).usage).toEqual(turns[0])
    expect(result.current.sessionUsage).toMatchObject({ turns: 1, totalTokens: 1200, cacheReadTokens: 800, knownCostUsd: null, costIncomplete: true })

    await act(async () => {
      await result.current.send('s1', 'two')
    })
    expect(result.current.sessionUsage).toMatchObject({
      turns: 2,
      inputTokens: 1500,
      outputTokens: 250,
      totalTokens: 1750,
      cacheReadTokens: 1200,
      knownCostUsd: 0.0021,
      costIncomplete: true,
      costEstimated: true,
    })
  })

  it('counts a failed turn as a turn without usage', async () => {
    sendChatMessage.mockImplementationOnce(async ({ onChunk }) => {
      onChunk({ type: 'error', code: 'LLM_TIMEOUT', message: 'timeout' })
    })
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('s1', 'hi')
    })
    expect(result.current.sessionUsage).toMatchObject({ turns: 0, turnsWithoutUsage: 1, knownCostUsd: null })
  })
})

describe('history', () => {
  const at = (seconds) => new Date(Date.now() - 600_000 + seconds * 1000).toISOString()
  const previewRow = (code, callId, createdAt) => ({
    id: `tool-${callId}`,
    sessionId: 's1',
    role: 'tool',
    content: JSON.stringify(previewResult(code)),
    toolCalls: null,
    toolCallId: callId,
    toolName: 'bulk_update_issues',
    createdAt,
  })
  const callRow = (id, callId, args, createdAt) => ({
    id,
    sessionId: 's1',
    role: 'assistant',
    content: null,
    toolCalls: [{ id: callId, type: 'function', function: { name: 'bulk_update_issues', arguments: JSON.stringify(args) } }],
    toolCallId: null,
    createdAt,
  })
  const userRow = (id, content, createdAt) => ({ id, sessionId: 's1', role: 'user', content, toolCalls: null, toolCallId: null, createdAt })

  it('rebuilds cards and what became of them; the provider may reuse call ids across turns', async () => {
    const history = [
      userRow('u1', 'close them', at(0)),
      callRow('a1', 'functions.bulk_update_issues:0', { status: 'done' }, at(1)),
      previewRow(CODE_A, 'functions.bulk_update_issues:0', at(2)),
      userRow('u2', `Confirm ${CODE_A}: Set status to done on 2 issues`, at(3)),
      callRow('a2', 'functions.bulk_update_issues:0', { status: 'done', confirmationToken: CODE_A }, at(4)),
      {
        id: 'tool-redeem',
        sessionId: 's1',
        role: 'tool',
        content: JSON.stringify({ ok: true, code: 'OK', message: 'Issues updated', details: { confirmationId: `conf-${CODE_A}` } }),
        toolCalls: null,
        toolCallId: 'functions.bulk_update_issues:0',
        toolName: 'bulk_update_issues',
        createdAt: at(5),
      },
      userRow('u3', 'now cancel the rest', at(6)),
      callRow('a3', 'functions.bulk_update_issues:0', { status: 'cancelled' }, at(7)),
      previewRow(CODE_B, 'functions.bulk_update_issues:0', at(8)),
    ]
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      result.current.loadHistory(history)
    })

    const assistants = result.current.messages.filter((message) => message.role === 'assistant')
    expect(assistants.map((message) => message.toolCalls[0].status)).toEqual(['needs_confirmation', 'completed', 'needs_confirmation'])
    expect(result.current.confirmations[CODE_A].phase).toBe('confirmed')
    expect(result.current.confirmations[CODE_B]).toEqual({ phase: 'pending' })

    // The reloaded pending card can be confirmed; the settled one cannot.
    sendChatMessage.mockImplementationOnce(redeemTurn(CODE_B, { ok: true, code: 'OK', message: 'Issues updated' }))
    let settled
    let pending
    await act(async () => {
      settled = result.current.confirm(CODE_A)
      pending = result.current.confirm(CODE_B)
    })
    expect(settled).toBe(false)
    expect(pending).toBe(true)
    expect(sendChatMessage.mock.calls[0][0]).toMatchObject({ sessionId: 's1', confirmationTokens: [CODE_B] })
  })
})
