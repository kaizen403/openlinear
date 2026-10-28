import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ createKnowledge: null, updateKnowledge: null, approveKnowledge: null, retractKnowledge: null, restoreKnowledge: null, fetchKnowledgeEntry: null }))
vi.mock('@/lib/api/knowledge', async (original) => ({
  ...(await original()),
  createKnowledge: (...args) => api.createKnowledge(...args),
  updateKnowledge: (...args) => api.updateKnowledge(...args),
  approveKnowledge: (...args) => api.approveKnowledge(...args),
  retractKnowledge: (...args) => api.retractKnowledge(...args),
  restoreKnowledge: (...args) => api.restoreKnowledge(...args),
  fetchKnowledgeEntry: (...args) => api.fetchKnowledgeEntry(...args),
}))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

const { KnowledgeForm, expiryFor } = await import('./knowledge-form.tsx')
const { KnowledgeList, provenance } = await import('./knowledge-list.tsx')
const { createAppQueryClient } = await import('@/lib/query/client.ts')
const { ApiError } = await import('@/lib/api/fetch.ts')

afterEach(() => { cleanup(); vi.clearAllMocks() })

const entry = (overrides) => ({
  id: 'k1', projectId: 'p1', kind: 'convention', title: 'Use pnpm', body: 'Never npm or yarn.', status: 'active', source: 'user', sourceRef: null,
  version: 2, expiresAt: null, expired: false, createdById: 'u1', updatedById: 'u1', approvedById: 'u1', approvedAt: '2026-10-27T10:00:00.000Z',
  retractedById: null, retractedAt: null, retractReason: null, createdAt: '2026-10-27T10:00:00.000Z', updatedAt: '2026-10-27T11:00:00.000Z', ...overrides,
})

function wrap(element) {
  const client = createAppQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  return render(createElement(QueryClientProvider, { client }, element))
}

describe('W19b knowledge form', () => {
  it('adds an entry with its kind, text, expiry and provenance, keyed once per form', async () => {
    api.createKnowledge = vi.fn(async (_projectId, draft) => entry({ ...draft, id: 'new', version: 1 }))
    const onSaved = vi.fn()
    wrap(createElement(KnowledgeForm, { projectId: 'p1', initial: { title: 'Guard division', body: 'Check b !== 0.', sourceRef: { taskId: 't1', reviewId: 'r1', findingId: 'f1', commit: 'abcdef1' } }, onCancel: vi.fn(), onSaved }))
    fireEvent.click(screen.getByRole('radio', { name: 'Procedure' }))
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add for every run' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [projectId, draft, key] = api.createKnowledge.mock.calls[0]
    expect(projectId).toBe('p1')
    expect(draft).toMatchObject({ kind: 'procedure', title: 'Guard division', body: 'Check b !== 0.', sourceRef: { taskId: 't1', reviewId: 'r1', findingId: 'f1', commit: 'abcdef1' } })
    expect(Date.parse(draft.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000)
    expect(typeof key).toBe('string')
  })

  it('an edit is a new revision based on the one opened; a conflict says so', async () => {
    api.updateKnowledge = vi.fn(async () => { throw new ApiError(409, 'changed', 'KNOWLEDGE_VERSION_CONFLICT', { latest: 3 }) })
    wrap(createElement(KnowledgeForm, { projectId: 'p1', entry: entry({}), onCancel: vi.fn(), onSaved: vi.fn() }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Use pnpm 9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }))
    await waitFor(() => expect(api.updateKnowledge).toHaveBeenCalledWith('k1', { baseVersion: 2, kind: 'convention', title: 'Use pnpm 9', body: 'Never npm or yarn.' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('This entry changed since you opened it.')
  })

  it('maps expiry choices', () => {
    expect(expiryFor('keep')).toBeUndefined()
    expect(expiryFor('never')).toBeNull()
    expect(expiryFor('90', 0)).toBe(new Date(90 * 86_400_000).toISOString())
  })
})

describe('W19b knowledge list', () => {
  it('a proposal from an agent waits for Approve (of the revision shown)', async () => {
    api.approveKnowledge = vi.fn(async () => entry({ status: 'active', version: 3 }))
    wrap(createElement(KnowledgeList, { entries: [entry({ status: 'proposed', source: 'agent', title: 'Tests beside code' }), entry({ id: 'k2' })], tab: 'proposed', onEdit: vi.fn() }))
    const row = screen.getByRole('listitem', { name: 'Convention: Tests beside code' })
    expect(within(row).getByText('Waiting for approval')).toBeTruthy()
    expect(within(row).getByText(/Proposed by an agent/)).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.approveKnowledge).toHaveBeenCalledWith('k1', 2))
    expect(toasts.success).toHaveBeenCalledWith('Active: agents get it from their next run')
  })

  it('retracting asks why; a retracted entry can be restored; history lists revisions', async () => {
    api.retractKnowledge = vi.fn(async () => entry({ status: 'retracted' }))
    api.restoreKnowledge = vi.fn(async () => entry({ status: 'active' }))
    api.fetchKnowledgeEntry = vi.fn(async () => ({ ...entry({}), versions: [
      { version: 2, kind: 'convention', title: 'Use pnpm', body: 'Never npm or yarn.', status: 'active', change: 'edited', note: null, editedById: 'u1', createdAt: '2026-10-27T11:00:00.000Z' },
      { version: 1, kind: 'convention', title: 'Use pnpm', body: 'Never npm.', status: 'active', change: 'created', note: null, editedById: 'u1', createdAt: '2026-10-27T10:00:00.000Z' },
    ] }))
    const { rerender } = wrap(createElement(KnowledgeList, { entries: [entry({})], tab: 'active', onEdit: vi.fn() }))
    fireEvent.click(screen.getByRole('button', { name: 'Retract' }))
    const form = screen.getByRole('form', { name: 'Retract' })
    expect(within(form).getByRole('button', { name: 'Retract' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'We use bun now' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Retract' }))
    await waitFor(() => expect(api.retractKnowledge).toHaveBeenCalledWith('k1', 'We use bun now'))

    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(await screen.findByText(/v1 · Created/)).toBeTruthy()
    expect(screen.getByText(/v2 · Edited/)).toBeTruthy()

    cleanup()
    wrap(createElement(KnowledgeList, { entries: [entry({ status: 'retracted', retractReason: 'We use bun now', retractedAt: '2026-10-27T12:00:00.000Z' })], tab: 'retracted', onEdit: vi.fn() }))
    expect(screen.getByText(/retracted: We use bun now/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(api.restoreKnowledge).toHaveBeenCalledWith('k1'))
    void rerender
  })

  it('says where an entry came from', () => {
    expect(provenance({ source: 'review_finding', sourceRef: { commit: 'abcdef1234' } })).toBe('From an agent review finding at abcdef1')
    expect(provenance({ source: 'agent', sourceRef: null })).toBe('Proposed by an agent')
    expect(provenance({ source: 'user', sourceRef: null })).toBeNull()
  })

  it('empty tabs explain themselves', () => {
    wrap(createElement(KnowledgeList, { entries: [entry({})], tab: 'proposed', onEdit: vi.fn() }))
    expect(screen.getByText(/Agents' proposals appear here/)).toBeTruthy()
  })
})
