// 2,000-task board: bounded requests and DOM with keyset paging.
//
// Renders the real KanbanBoard against a fake keyset `GET /api/tasks`
// (lib/query/task-queries.fixture.mjs) holding 2,000 tasks, 500 per column.
// Asserts request counts and card counts at every step (the default run).
// BOARD2_BENCH=1 also prints wall times:
//   BOARD2_BENCH=1 pnpm --filter @openlinear/desktop-ui exec vitest run components/board/board-pagination.test.mjs
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createKeysetServer, makeBoardTask, makeBoardTasks, compareRows, ID } from '../../lib/query/task-queries.fixture.mjs'

const state = vi.hoisted(() => ({
  server: null,
  handlers: [],
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
vi.mock('@/lib/api/fetch', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    apiFetch: vi.fn(async (path) => {
      if (typeof path === 'string' && path.startsWith('/api/tasks?')) return state.server.list(path)
      if (path === '/api/settings') return { taskDeletionMode: 'archive' }
      return {}
    }),
  }
})

const { KanbanBoard } = await import('./kanban-board.tsx')

const TOTAL = 2000
const FIRST_PAGE = 200
const COLUMN_PAGE = 50
const PER_COLUMN = TOTAL / 4
const BENCH = process.env.BOARD2_BENCH === '1'

const listRequests = () => state.server.requests
const cards = (container) => container.querySelectorAll('[data-board-task]')
const cardIds = (container) => [...cards(container)].map((node) => node.getAttribute('data-board-task'))

function emit(type, data) {
  for (const handler of state.handlers) handler(type, data)
}

async function timed(label, timings, fn) {
  const start = performance.now()
  await fn()
  timings[label] = Math.round((performance.now() - start) * 10) / 10
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('board pagination at 2,000 tasks', () => {
  it('keeps requests and DOM bounded while every task stays reachable', async () => {
    state.server = createKeysetServer(makeBoardTasks(TOTAL))
    state.handlers = []
    const timings = {}
    let view

    // Open: one request (first page, compact), one page of cards.
    await timed('open', timings, async () => {
      await act(async () => { view = render(createElement(KanbanBoard, { projectId: 'p1', projects: [] })) })
      await waitFor(() => expect(cards(view.container)).toHaveLength(FIRST_PAGE))
    })
    const { container } = view
    expect(listRequests()).toEqual([{ pageSize: '200', pagination: 'cursor', view: 'compact', projectId: 'p1' }])
    expect(screen.getAllByText(`${FIRST_PAGE / 4}+`)).toHaveLength(4)
    expect(screen.getByText(`${FIRST_PAGE}+ issues`)).toBeTruthy()

    // One "Load more" on Todo: one request, one column page more.
    // (querySelector, not *ByRole: role queries over ~700 cards dominate the timings.)
    const todoButton = () => container.querySelector('button[aria-label="Load more in All Issues"]')
    await timed('loadMore', timings, async () => {
      await act(async () => { fireEvent.click(todoButton()) })
      await waitFor(() => expect(cards(container)).toHaveLength(FIRST_PAGE + COLUMN_PAGE))
    })
    expect(listRequests()).toHaveLength(2)
    expect(listRequests()[1]).toMatchObject({ status: 'todo', pageSize: '50', view: 'compact', cursor: expect.any(String) })

    // Drain Todo: one request per click, 500 todo cards, no duplicates.
    await timed('drainTodo', timings, async () => {
      while (todoButton()) {
        await act(async () => { fireEvent.click(todoButton()) })
        await waitFor(() => expect(todoButton()?.hasAttribute('disabled') ?? false).toBe(false))
      }
    })
    const todoClicks = (PER_COLUMN - FIRST_PAGE / 4) / COLUMN_PAGE
    expect(listRequests()).toHaveLength(1 + todoClicks)
    const loaded = FIRST_PAGE + PER_COLUMN - FIRST_PAGE / 4
    expect(cards(container)).toHaveLength(loaded)
    expect(new Set(cardIds(container)).size).toBe(loaded)
    expect(screen.getByText(String(PER_COLUMN))).toBeTruthy()

    // SSE, task not loaded and beyond the Done window: left for Done's next page.
    const deepDone = state.server.tasks.filter((task) => task.status === 'done').sort(compareRows)[300]
    await act(async () => { emit('task:updated', { ...deepDone, executionLogs: undefined, title: 'still deep' }) })
    expect(cards(container)).toHaveLength(loaded)

    // SSE, task not loaded but Todo is complete: inserted at its sorted place.
    const deepCancelled = state.server.tasks.filter((task) => task.status === 'cancelled').sort(compareRows)[200]
    await act(async () => { emit('task:updated', { ...deepCancelled, status: 'todo' }) })
    expect(cards(container)).toHaveLength(loaded + 1)
    const todoOrder = cardIds(container).filter((id) => id === deepCancelled.id || state.server.tasks.find((task) => task.id === id)?.status === 'todo')
    const expectedTodo = [...state.server.tasks.filter((task) => task.status === 'todo'), { ...deepCancelled, status: 'todo' }].sort(compareRows).map((task) => task.id)
    expect(todoOrder).toEqual(expectedTodo)

    // SSE, a task moving into this project inside the Done window (between
    // the first two done tasks, KT-3 and KT-7): inserted in order.
    const movedIn = makeBoardTask(TOTAL + 1, { status: 'done', createdAt: new Date(Date.parse(state.server.tasks[6].createdAt) + 500).toISOString() })
    await act(async () => { emit('task:updated', movedIn) })
    expect(cards(container)).toHaveLength(loaded + 2)
    const doneIds = cardIds(container).filter((id) => id === movedIn.id || state.server.tasks.find((task) => task.id === id)?.status === 'done')
    expect(doneIds.indexOf(movedIn.id)).toBe(1)

    // Resync (stream reconnect): first page + Todo back to its depth in pages of 200.
    state.server.tasks.find((task) => task.id === deepCancelled.id).status = 'todo'
    state.server.requests = []
    await timed('resync', timings, async () => {
      await act(async () => { emit('connected', { clientId: 'c2' }) })
      await waitFor(() => expect(listRequests().length).toBe(1 + Math.ceil((PER_COLUMN - FIRST_PAGE / 4) / 200)))
      await waitFor(() => expect(cards(container).length).toBeGreaterThanOrEqual(loaded))
    })
    expect(listRequests().map((request) => [request.status ?? 'all', request.pageSize])).toEqual([
      ['all', '200'], ['todo', '200'], ['todo', '200'], ['todo', '50'],
    ])
    // Moved-in task is not on the server: the resync drops it; the re-statused one stays.
    const afterResync = cardIds(container)
    expect(afterResync).not.toContain(movedIn.id)
    expect(afterResync).toContain(deepCancelled.id)
    expect(new Set(afterResync).size).toBe(afterResync.length)

    if (BENCH) {
      console.log(`BOARD2_BENCH_RESULT ${JSON.stringify({ tasks: TOTAL, timingsMs: timings, cardsAfterOpen: FIRST_PAGE, cardsAfterDrainTodo: loaded, requestsToDrainTodo: 1 + todoClicks, resyncRequests: 4 })}`)
    }
  }, 60_000)

  it('shows no empty state and a Load more for a column with nothing on the first page', async () => {
    // 300 todo tasks newer than everything else: the first page holds only todos.
    const tasks = [
      ...Array.from({ length: 300 }, (_, i) => makeBoardTask(i + 1, { status: 'todo' })),
      ...Array.from({ length: 20 }, (_, i) => makeBoardTask(1000 + i, { status: 'cancelled' })),
    ]
    state.server = createKeysetServer(tasks)
    state.handlers = []
    let view
    await act(async () => { view = render(createElement(KanbanBoard, { projectId: 'p1', projects: [] })) })
    await waitFor(() => expect(cards(view.container)).toHaveLength(FIRST_PAGE))
    expect(screen.queryByText('No cancelled tasks')).toBeNull()
    const cancelledButton = screen.getByRole('button', { name: 'Load more in Cancelled' })
    await act(async () => { fireEvent.click(cancelledButton) })
    await waitFor(() => expect(cards(view.container)).toHaveLength(FIRST_PAGE + 20))
    expect(screen.queryByRole('button', { name: 'Load more in Cancelled' })).toBeNull()
    expect(screen.getByText('20')).toBeTruthy()
    expect(state.server.requests.map((request) => request.status ?? 'all')).toEqual(['all', 'cancelled'])
    expect(cardIds(view.container)).toContain(ID(1000))
  })
})
