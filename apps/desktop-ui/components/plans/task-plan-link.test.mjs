import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ fetchTaskTeamId: null }))
vi.mock('@/lib/api/comments', async (original) => ({ ...(await original()), fetchTaskTeamId: (...args) => api.fetchTaskTeamId(...args) }))

const { TaskPlanLink } = await import('./task-plan-link.tsx')
const { createAppQueryClient } = await import('@/lib/query/client.ts')

afterEach(() => cleanup())

function show(props) {
  const client = createAppQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  return render(createElement(QueryClientProvider, { client }, createElement(TaskPlanLink, props)))
}

describe('TaskPlanLink (W17b)', () => {
  it('links a planned task to its plan review', async () => {
    api.fetchTaskTeamId = vi.fn(async () => ({ id: 't1', teamId: 'team', title: 'API', plan: { id: 'plan-1', key: 'api', title: 'Login', status: 'approved', approvedRevision: 2 } }))
    show({ taskId: 't1', projectId: 'p1' })
    const link = await screen.findByRole('link', { name: /Login/ })
    expect(link.getAttribute('href')).toBe('/projects/plans?id=p1&plan=plan-1')
    expect(screen.getByText('api')).toBeTruthy()
  })

  it('shows nothing for a task that is not from a plan', async () => {
    api.fetchTaskTeamId = vi.fn(async () => ({ id: 't2', teamId: 'team', title: 'Loose', plan: null }))
    const { container } = show({ taskId: 't2', projectId: 'p1' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(container.textContent).toBe('')
  })
})
