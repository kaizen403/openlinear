import { describe, it, expect } from 'vitest'

const state = await import('./chat-stream-state.ts')

describe('confirmation codes', () => {
  it('normalizes codes the way the server does (Crockford base32, case-insensitive)', () => {
    expect(state.normalizeConfirmationCode(' confirm-7kq2mx9p ')).toBe('CONFIRM-7KQ2MX9P')
    expect(state.normalizeConfirmationCode('CONFIRM-7KQ2MX9I')).toBeNull() // I is not in the alphabet
    expect(state.normalizeConfirmationCode('CONFIRM-7KQ2MX9')).toBeNull()
    expect(state.normalizeConfirmationCode(42)).toBeNull()
  })

  it('extracts typed codes from free text, once each', () => {
    expect(state.extractConfirmationCodes('yes CONFIRM-7KQ2MX9P and confirm-7kq2mx9p, also CONFIRM-AB12CD34.')).toEqual([
      'CONFIRM-7KQ2MX9P',
      'CONFIRM-AB12CD34',
    ])
    expect(state.extractConfirmationCodes('XCONFIRM-7KQ2MX9PX')).toEqual([])
  })

  it('the Confirm message names the code so the model can redeem it', () => {
    expect(state.confirmationMessage({ code: 'CONFIRM-7KQ2MX9P', summary: 'Archive 2 issues' })).toBe('Confirm CONFIRM-7KQ2MX9P: Archive 2 issues')
  })
})

describe('previews', () => {
  it('parses an archive preview, including identifiers that were not found', () => {
    const preview = state.parseConfirmationPreview({
      projectId: 'p1',
      willArchive: [{ id: 'i1', identifier: 'KT-1', title: 'One', status: 'todo' }],
      notFound: [{ identifier: 'KT-404', error: 'Issue was not found in the selected project' }, { id: 'uuid-1', error: 'x' }],
    })
    expect(preview).toMatchObject({ kind: 'archive', notFound: ['KT-404', 'uuid-1'] })
    expect(preview.issues).toEqual([{ id: 'i1', identifier: 'KT-1', title: 'One', status: 'todo' }])
  })

  it('flags a whole-project status change', () => {
    const preview = state.parseConfirmationPreview({ status: 'done', selection: 'all_active_issues_in_project', willChange: [], alreadyInStatus: 0, notFound: [] })
    expect(preview).toMatchObject({ kind: 'status_change', wholeProject: true })
  })

  it('shows the exact arguments of a generic confirmation', () => {
    const preview = state.parseConfirmationPreview({ tool: 'change_workspace_member_role', arguments: { userId: 'u1', role: 'viewer' } })
    expect(preview.kind).toBe('generic')
    expect(JSON.parse(preview.argumentsText)).toEqual({ userId: 'u1', role: 'viewer' })
  })
})

describe('interrupted tool calls', () => {
  const call = (overrides) => ({ id: 'c', name: 't', arguments: '{}', status: 'in_progress', ...overrides })

  it('a destructive preview changes nothing; a redeeming call may have', () => {
    expect(state.interruptToolCall(call({ effect: 'destructive' })).status).toBe('error')
    expect(state.interruptToolCall(call({ effect: 'destructive', redeems: 'CONFIRM-7KQ2MX9P' })).status).toBe('unknown')
  })

  it('an unclassified tool is treated conservatively', () => {
    expect(state.interruptToolCall(call({ effect: null })).status).toBe('unknown')
  })

  it('leaves settled calls alone', () => {
    const done = call({ status: 'completed', effect: 'write' })
    expect(state.interruptToolCall(done)).toBe(done)
  })

  it('reads the redeemed code from the confirmationToken argument', () => {
    const created = state.createToolCall({ id: 'c', name: 'archive_issues', arguments: '{"confirmationToken":"confirm-7kq2mx9p"}', effect: 'destructive' })
    expect(created).toMatchObject({ effect: 'destructive', redeems: 'CONFIRM-7KQ2MX9P' })
  })

  it('takes the effect only from the server (no client catalogue)', () => {
    expect(state.createToolCall({ id: 'c', name: 'archive_issues', arguments: '{}' }).effect).toBeNull()
    expect(state.toolEffectFor('list_issues')).toBeNull()
    expect(state.toolEffectFor('anything', 'write')).toBe('write')
    expect(state.toolEffectFor('anything', 'teleport')).toBeNull()
  })
})

describe('confirmation lifecycle', () => {
  it('codes delivered but never applied become unresolved; undelivered codes reopen', () => {
    const states = { A: { phase: 'submitting', via: 'button' }, B: { phase: 'pending' } }
    expect(state.finishSubmitted(states, new Set(['A']), true).states.A.phase).toBe('unresolved')
    const reopened = state.finishSubmitted(states, new Set(['A']), false)
    expect(reopened.states.A.phase).toBe('pending')
    expect(reopened.reopened).toEqual(['A'])
    expect(reopened.states.B).toBe(states.B)
  })

  it('only pending, live codes can be submitted', () => {
    const states = { A: { phase: 'pending' }, B: { phase: 'rejected' }, C: { phase: 'pending' } }
    const marked = state.markSubmitted(states, ['A', 'B', 'C', 'D'], 'typed', (code) => code !== 'C')
    expect(marked.submitted).toEqual(['A'])
    expect(marked.states.A).toEqual({ phase: 'submitting', via: 'typed' })
    expect(marked.states.C.phase).toBe('pending')
  })
})

describe('describeChatError', () => {
  it('never shows a bare "Stream error"', () => {
    expect(state.describeChatError(new Error('Stream error')).message).toBe("I couldn't get a response from the model.")
  })
})
