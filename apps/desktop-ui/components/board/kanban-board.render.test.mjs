// Render-storm regression: an SSE `task:updated` for one task must re-render
// one card and one column, not the whole board, and must not re-register the
// global keydown listener. Timings live in board-render.bench.test.mjs.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createElement } from 'react'

const state = vi.hoisted(() => ({
  tasks: [],
  handlers: [],
  cardRenders: 0,
  columnRenders: {},
  auth: {
    isAuthenticated: true,
    activeRepository: { id: 'repo-1', fullName: 'acme/app', defaultBranch: 'main' },
    refreshActiveRepository: () => {},
    user: { id: 'u1', username: 'me' },
  },
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => state.auth }))
vi.mock('@/hooks/use-team-members', () => ({ useTeamMembers: () => ({ members: [], isLoading: false }) }))
vi.mock('@/providers/sse-provider', () => ({
  useSSESubscription: (handler) => { if (!state.handlers.includes(handler)) state.handlers.push(handler) },
}))
vi.mock('@/components/task-form', () => ({ TaskFormDialog: () => null }))
vi.mock('@/components/task-detail-view', () => ({ TaskDetailView: () => null }))
vi.mock('@/components/provider-setup-dialog', () => ({ ProviderSetupDialog: () => null }))
vi.mock('./model-selector', () => ({ ModelSelector: () => null }))
vi.mock('./column', async (importOriginal) => {
  const actual = await importOriginal()
  const { createElement: h } = await import('react')
  return {
    Column: (props) => {
      state.columnRenders[props.id] = (state.columnRenders[props.id] ?? 0) + 1
      return h(actual.Column, props)
    },
  }
})
vi.mock('@/lib/execution-state-store', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useExecutionProgress: (taskId) => {
      state.cardRenders += 1
      return actual.useExecutionProgress(taskId)
    },
  }
})
vi.mock('@/lib/api/fetch', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    apiFetch: vi.fn(async (path) => {
      if (typeof path === 'string' && path.startsWith('/api/tasks?')) return { items: state.tasks }
      if (path === '/api/settings') return { taskDeletionMode: 'archive' }
      return {}
    }),
  }
})

const { KanbanBoard } = await import('./kanban-board.tsx')

const STATUSES = ['todo', 'in_progress', 'done', 'cancelled']
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function makeTasks(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: ID(index + 1),
    title: `Task ${index + 1}`,
    description: null,
    priority: 'medium',
    status: STATUSES[index % STATUSES.length],
    sessionId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    labels: [],
    executionStartedAt: null,
    executionPausedAt: null,
    executionElapsedMs: 0,
    executionProgress: null,
    prUrl: null,
    outcome: null,
    batchId: null,
    inboxRead: false,
    identifier: `KT-${index + 1}`,
    number: index + 1,
    dueDate: null,
    projectId: 'p1',
    teamId: 'team-1',
    archived: false,
  }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('KanbanBoard render isolation', () => {
  it('re-renders one card and one column per single-task SSE update at 400 tasks', async () => {
    state.tasks = makeTasks(400)
    state.handlers = []
    const addListener = vi.spyOn(window, 'addEventListener')
    await act(async () => {
      render(createElement(KanbanBoard, { projectId: 'p1', projects: [] }))
    })
    expect(state.cardRenders).toBeGreaterThanOrEqual(400)

    const keydownBefore = addListener.mock.calls.filter(([type]) => type === 'keydown').length
    const target = state.tasks[1] // in_progress
    for (let iteration = 0; iteration < 5; iteration += 1) {
      state.cardRenders = 0
      state.columnRenders = {}
      await act(async () => {
        for (const handler of state.handlers) {
          handler('task:updated', { id: target.id, projectId: 'p1', teamId: 'team-1', executionProgress: iteration * 10, updatedAt: `2026-10-02T00:00:0${iteration}.000Z` })
        }
      })
      expect(state.cardRenders).toBe(1)
      expect(state.columnRenders).toEqual({ in_progress: 1 })
    }
    const keydownAfter = addListener.mock.calls.filter(([type]) => type === 'keydown').length
    expect(keydownAfter).toBe(keydownBefore)
  })
})
