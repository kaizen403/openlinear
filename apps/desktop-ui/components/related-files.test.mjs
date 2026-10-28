import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchRelatedFiles: null }))
vi.mock('@/lib/api/repo-context', async (original) => ({
  ...(await original()),
  fetchRelatedFiles: (...args) => api.fetchRelatedFiles(...args),
}))

const { RelatedFilesSection, relatedFilesRevision } = await import('./related-files.tsx')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => cleanup())

const TASK = { title: 'Users get logged out after an hour', description: 'Renew the access token', labels: [{ name: 'auth' }] }

function show(task = TASK) {
  const client = createAppQueryClient()
  const element = (next) => createElement(QueryClientProvider, { client }, createElement(RelatedFilesSection, { taskId: 't1', task: next }))
  const view = render(element(task))
  return { rerender: (next) => view.rerender(element(next)) }
}

const READY = {
  status: 'ready',
  reason: null,
  repository: { source: 'local-folder', commit: 'a'.repeat(40) },
  files: [
    { path: 'src/auth/session.ts', startLine: 4, endLine: 17, score: 9.1, reasons: ['declares refreshAccessToken', 'mentions token'], matched: ['access', 'token', 'renew'] },
    { path: 'docs/auth.md', startLine: null, endLine: null, score: 3.2, reasons: ['file name: auth'], matched: [] },
  ],
  receipt: { sha: 'a'.repeat(40), indexedFiles: 12, contentFiles: 12, cacheHit: true, reusedBlobs: 0, ms: 4 },
}

describe('RelatedFilesSection (FE-11)', () => {
  it('lists related files with line ranges and matched words', async () => {
    api.fetchRelatedFiles = vi.fn(async () => READY)
    show()
    expect(await screen.findByRole('heading', { name: 'Related files' })).toBeTruthy()
    expect(screen.getByText('src/auth/session.ts')).toBeTruthy()
    expect(screen.getByText('L4–17')).toBeTruthy()
    expect(screen.getByText('matched: access, token, renew')).toBeTruthy()
    expect(screen.getByText('docs/auth.md')).toBeTruthy()
    expect(api.fetchRelatedFiles).toHaveBeenCalledWith('t1', expect.objectContaining({ signal: expect.anything() }))
  })

  it.each([
    ['unavailable', { ...READY, status: 'unavailable', files: [], reason: 'The project has no repository' }],
    ['disabled', { ...READY, status: 'disabled', files: [], reason: 'off' }],
    ['no match', { ...READY, files: [], reason: 'no file in the repository shares words with the task' }],
  ])('stays silent when %s', async (_name, body) => {
    api.fetchRelatedFiles = vi.fn(async () => body)
    const { container } = render(createElement(QueryClientProvider, { client: createAppQueryClient() }, createElement(RelatedFilesSection, { taskId: 't1', task: TASK })))
    await waitFor(() => expect(api.fetchRelatedFiles).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(container.innerHTML).toBe('')
  })

  it('stays silent when the sidecar cannot be reached', async () => {
    api.fetchRelatedFiles = vi.fn(async () => { throw new Error('Could not reach the local server') })
    show()
    await waitFor(() => expect(api.fetchRelatedFiles).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: 'Related files' })).toBeNull()
  })

  it('asks again while the repository is being indexed', async () => {
    api.fetchRelatedFiles = vi.fn()
      .mockResolvedValueOnce({ ...READY, status: 'indexing', files: [], reason: 'the repository is still being indexed', retryAfterMs: 30 })
      .mockResolvedValue(READY)
    show()
    expect(await screen.findByText('src/auth/session.ts')).toBeTruthy()
    expect(api.fetchRelatedFiles).toHaveBeenCalledTimes(2)
  })

  it('refetches when the task text changes', async () => {
    api.fetchRelatedFiles = vi.fn(async () => READY)
    const { rerender } = show()
    await screen.findByText('src/auth/session.ts')
    rerender({ ...TASK, description: 'Renew the refresh token too' })
    await waitFor(() => expect(api.fetchRelatedFiles).toHaveBeenCalledTimes(2))
    expect(relatedFilesRevision(TASK)).not.toBe(relatedFilesRevision({ ...TASK, labels: [] }))
    expect(relatedFilesRevision(TASK)).toBe(relatedFilesRevision({ ...TASK }))
  })
})
