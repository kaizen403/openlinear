import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchSimilarTasks: null }))
vi.mock('@/lib/api/task-dependencies', async (original) => ({
  ...(await original()),
  fetchSimilarTasks: (...args) => api.fetchSimilarTasks(...args),
}))

const { SimilarIssuesHint } = await import('./similar-issues-hint.tsx')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => cleanup())

function show(props) {
  const client = createAppQueryClient()
  const element = (next) => createElement(QueryClientProvider, { client }, createElement(SimilarIssuesHint, next))
  const view = render(element(props))
  return { rerender: (next) => view.rerender(element(next)) }
}

describe('SimilarIssuesHint (FE-11)', () => {
  it('lists similar open issues once the title is long enough (debounced), and nothing otherwise', async () => {
    api.fetchSimilarTasks = vi.fn(async () => [{ id: 't1', identifier: 'ENG-3', title: 'Fix the login form validation', status: 'in_progress', score: 0.62 }])
    const { rerender } = show({ projectId: 'p1', title: 'login' })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(api.fetchSimilarTasks).not.toHaveBeenCalled()
    rerender({ projectId: 'p1', title: 'login form validation' })
    expect(await screen.findByRole('note', { name: 'Similar issues' })).toBeTruthy()
    expect(screen.getByText('ENG-3')).toBeTruthy()
    expect(api.fetchSimilarTasks).toHaveBeenCalledTimes(1)
    expect(api.fetchSimilarTasks).toHaveBeenCalledWith('p1', 'login form validation')
  })

  it('stays silent without a project or matches', async () => {
    api.fetchSimilarTasks = vi.fn(async () => [])
    show({ projectId: 'p1', title: 'brand new idea here' })
    await waitFor(() => expect(api.fetchSimilarTasks).toHaveBeenCalled())
    expect(screen.queryByRole('note')).toBeNull()
    cleanup()
    api.fetchSimilarTasks = vi.fn(async () => [])
    show({ projectId: null, title: 'brand new idea here' })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(api.fetchSimilarTasks).not.toHaveBeenCalled()
  })
})
