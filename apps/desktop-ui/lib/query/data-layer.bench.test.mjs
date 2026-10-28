// Data-layer request/render budget (default run) and before/after benchmark (opt-in).
//
//   pnpm --filter @openlinear/desktop-ui exec vitest run lib/query/data-layer.bench.test.mjs
//   DATAUI_BENCH=1 pnpm --filter @openlinear/desktop-ui exec vitest run lib/query/data-layer.bench.test.mjs
//
// Renders the real app providers (Workspace → Teams → Project → ChatSessions,
// plus QueryProvider/QuerySseBridge when they exist), the real board page body
// (KanbanBoard + TaskFormDialog) and the real My Issues page, with the network
// (`apiFetch`), auth and the SSE transport faked. Scenarios: app start, board
// open, project switch and back, an SSE burst of 100 `task:updated` events
// (delivered in one batch and one per macrotask), and a stream reconnect. It counts every request by
// endpoint and React commits per subtree (Profiler) and TaskCard renders.
//
// Without DATAUI_BENCH the file asserts the post-migration budgets. With it,
// it prints one `DATAUI_BENCH_RESULT {json}` line per scenario and asserts
// nothing, so the same file runs unchanged against the pre-migration tree
// (QueryProvider is picked up only if the module exists).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createElement, Fragment, Profiler, useState } from 'react'

const BENCH = process.env.DATAUI_BENCH === '1'
const BURST = Number(process.env.DATAUI_BENCH_BURST ?? 100)

const state = vi.hoisted(() => ({
  listeners: new Set(),
  calls: [],
  tasksByProject: {},
  myIssues: [],
  commits: {},
  cardRenders: 0,
  auth: {
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u1', username: 'bench' },
    activeRepository: null,
    refreshActiveRepository: () => {},
  },
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => state.auth }))
vi.mock('@/providers/sse-provider', async () => {
  const React = await import('react')
  return {
    SSEProvider: ({ children }) => children,
    useSSESubscription: (handler) => {
      const ref = React.useRef(handler)
      React.useEffect(() => { ref.current = handler })
      React.useEffect(() => {
        const listener = (type, data, meta) => ref.current(type, data, meta)
        state.listeners.add(listener)
        return () => { state.listeners.delete(listener) }
      }, [])
    },
    useSSEStatus: () => ({ isConnected: true, isReconnecting: false }),
  }
})
vi.mock('@/components/task-detail-view', () => ({ TaskDetailView: () => null }))
vi.mock('@/components/provider-setup-dialog', () => ({ ProviderSetupDialog: () => null }))
vi.mock('@/components/task-form-model-selector', () => ({ TaskFormModelSelector: () => null }))
vi.mock('@/components/board/model-selector', () => ({ ModelSelector: () => null }))
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
  const route = (path) => {
    if (path === '/api/workspaces') return [{ id: 'w1', name: 'Bench', slug: 'bench', role: 'owner' }]
    if (path.startsWith('/api/projects?')) {
      return ['p1', 'p2'].map((id) => ({ id, workspaceId: 'w1', name: id.toUpperCase(), status: 'in_progress', teams: [{ id: `team-${id}`, name: 'T' }], repositoryId: 'repo-1' }))
    }
    if (path.startsWith('/api/teams?')) return [{ id: 'team-p1', name: 'T1', color: '#000', projectId: 'p1' }]
    if (path.startsWith('/api/workspaces/w1/members')) {
      return { data: [{ id: 'm1', workspaceId: 'w1', userId: 'u1', role: 'owner', user: { id: 'u1', username: 'bench', email: null, avatarUrl: null } }], nextCursor: null }
    }
    if (path.startsWith('/api/chat/sessions?')) return { data: [], nextCursor: null }
    if (path.startsWith('/api/tasks?pageSize=')) {
      const projectId = new URLSearchParams(path.split('?')[1]).get('projectId')
      return { items: state.tasksByProject[projectId] ?? [], hasMore: false }
    }
    if (path === '/api/tasks?assignee=me') return { items: state.myIssues, hasMore: false }
    if (path === '/api/settings') return { taskDeletionMode: 'archive' }
    return {}
  }
  return {
    ...actual,
    apiFetch: vi.fn(async (path) => {
      state.calls.push(path)
      await new Promise((resolve) => setTimeout(resolve, 2))
      return structuredClone(route(path))
    }),
  }
})

const optionalQueryProvider = import.meta.glob('../../providers/query-provider.tsx')
const queryProviderModule = Object.values(optionalQueryProvider)[0] ? await Object.values(optionalQueryProvider)[0]() : null
const { WorkspaceProvider } = await import('@/hooks/use-workspace')
const { TeamsProvider } = await import('@/providers/teams-provider')
const { ProjectProvider, useProject } = await import('@/hooks/use-project')
const { ChatSessionsProvider } = await import('@/hooks/use-chat-sessions')
const { KanbanBoard } = await import('@/components/board/kanban-board')
const { TaskFormDialog } = await import('@/components/task-form')
const MyIssuesPage = (await import('../../app/(app)/my-issues/page.tsx')).default

const STATUSES = ['todo', 'todo', 'in_progress', 'done']

function makeTasks(projectId, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${projectId}-${String(index).padStart(4, '0')}`,
    title: `${projectId} task ${index}`,
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
    identifier: `${projectId.toUpperCase()}-${index}`,
    number: index,
    dueDate: null,
    projectId,
    teamId: `team-${projectId}`,
    assigneeId: index < BURST ? 'u1' : null,
    creatorId: 'u1',
    archived: false,
  }))
}

function count(prefixes) {
  const out = {}
  for (const path of state.calls) {
    const key = prefixes.find(([, test]) => test(path))?.[0] ?? path
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

const CATEGORIES = [
  ['workspaces', (p) => p === '/api/workspaces'],
  ['projects', (p) => p.startsWith('/api/projects?')],
  ['teams', (p) => p.startsWith('/api/teams?')],
  ['members', (p) => p.startsWith('/api/workspaces/w1/members')],
  ['chatSessions', (p) => p.startsWith('/api/chat/sessions?')],
  ['boardTasks', (p) => p.startsWith('/api/tasks?pageSize=')],
  ['myIssues', (p) => p === '/api/tasks?assignee=me'],
  ['settings', (p) => p === '/api/settings'],
]

function snapshot() {
  return { calls: state.calls.length, byEndpoint: count(CATEGORIES), commits: { ...state.commits }, cardRenders: state.cardRenders }
}

function delta(before, after) {
  const byEndpoint = {}
  for (const [key, value] of Object.entries(after.byEndpoint)) {
    const diff = value - (before.byEndpoint[key] ?? 0)
    if (diff) byEndpoint[key] = diff
  }
  const commits = {}
  for (const [key, value] of Object.entries(after.commits)) {
    const diff = value - (before.commits[key] ?? 0)
    if (diff) commits[key] = diff
  }
  return { requests: after.calls - before.calls, byEndpoint, commits, cardRenders: after.cardRenders - before.cardRenders }
}

/** Let fetches, retries and coalesced invalidations finish. */
async function settle() {
  let stable = 0
  let last = -1
  while (stable < 4) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
    if (state.calls.length === last) stable += 1
    else { stable = 0; last = state.calls.length }
  }
}

function emit(type, data, meta = { stream: 'cloud', id: null }) {
  for (const listener of [...state.listeners]) listener(type, data, meta)
}

const onRender = (id) => { state.commits[id] = (state.commits[id] ?? 0) + 1 }

let controls = null

function HomeProbe() {
  const { projects, activeProject } = useProject()
  return createElement('span', { 'data-projects': projects.length, 'data-active': activeProject?.id ?? '' })
}

function Screens() {
  const [boardProjectId, setBoardProjectId] = useState(null)
  const [showIssues, setShowIssues] = useState(false)
  const { projects } = useProject()
  controls = { setBoardProjectId, setShowIssues }
  return createElement(Fragment, null,
    createElement(HomeProbe),
    boardProjectId && createElement(Profiler, { id: 'board', onRender },
      createElement(KanbanBoard, { projectId: boardProjectId, teamId: null, projects, searchQuery: '' }),
      createElement(TaskFormDialog, { open: false, onOpenChange: () => {}, defaultProjectId: boardProjectId, projects }),
    ),
    showIssues && createElement(Profiler, { id: 'issues', onRender }, createElement(MyIssuesPage)),
  )
}

function App() {
  let tree = createElement(Profiler, { id: 'app', onRender },
    createElement(WorkspaceProvider, null,
      createElement(TeamsProvider, null,
        createElement(ProjectProvider, null,
          createElement(ChatSessionsProvider, null, createElement(Screens))))))
  if (queryProviderModule) {
    tree = createElement(queryProviderModule.QueryProvider, null, createElement(queryProviderModule.QuerySseBridge), tree)
  }
  return tree
}

function report(name, result) {
  if (BENCH) console.log(`DATAUI_BENCH_RESULT ${JSON.stringify({ scenario: name, variant: queryProviderModule ? 'after' : 'before', ...result })}`)
}

afterEach(() => {
  cleanup()
  state.listeners.clear()
  state.calls = []
  state.commits = {}
  state.cardRenders = 0
  controls = null
})

describe(BENCH ? 'data layer benchmark' : 'data layer request/render budget', () => {
  it('app start, board open, project switch, SSE burst', async () => {
    state.tasksByProject = { p1: makeTasks('p1', 200), p2: makeTasks('p2', 200) }
    state.myIssues = state.tasksByProject.p1.slice(0, BURST).map((task) => ({ ...task, project: { id: 'p1', name: 'P1', status: 'in_progress', color: '#000' }, team: null }))

    // 1. App start: providers load, then the cloud stream connects.
    let before = snapshot()
    render(createElement(App))
    await settle()
    const appStart = delta(before, snapshot())
    before = snapshot()
    await act(async () => { emit('connected', { clientId: 'c1' }) })
    await settle()
    const firstConnect = delta(before, snapshot())
    report('app-start', { load: appStart, firstConnected: firstConnect })

    // 2. Board open (board page body: KanbanBoard + TaskFormDialog).
    before = snapshot()
    await act(async () => { controls.setBoardProjectId('p1') })
    await settle()
    const boardOpen = delta(before, snapshot())
    report('board-open', boardOpen)

    // 3. Project switch p1 → p2 → p1.
    before = snapshot()
    await act(async () => { controls.setBoardProjectId('p2') })
    await settle()
    const toP2 = delta(before, snapshot())
    before = snapshot()
    await act(async () => { controls.setBoardProjectId('p1') })
    await settle()
    const backToP1 = delta(before, snapshot())
    report('project-switch', { toP2, backToP1 })

    // 4. SSE burst with the board (p1) and My Issues open.
    await act(async () => { controls.setShowIssues(true) })
    await settle()
    const updates = (round) => state.tasksByProject.p1.slice(0, BURST).map((task, index) => ({
      id: task.id,
      title: `${task.title} (round ${round})`,
      updatedAt: `2026-10-02T00:00:${String(round).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
    }))

    before = snapshot()
    let started = performance.now()
    await act(async () => { for (const data of updates(1)) emit('task:updated', data) })
    const batchedWallMs = Number((performance.now() - started).toFixed(1))
    await settle()
    const batched = { ...delta(before, snapshot()), wallMs: batchedWallMs }

    before = snapshot()
    started = performance.now()
    for (const data of updates(2)) {
      await act(async () => { emit('task:updated', data); await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
    const spreadWallMs = Number((performance.now() - started).toFixed(1))
    await settle()
    const spread = { ...delta(before, snapshot()), wallMs: spreadWallMs }
    report('sse-burst', { events: BURST, oneBatch: batched, onePerTask: spread })

    // 5. The cloud stream reconnects (board + My Issues open).
    before = snapshot()
    await act(async () => { emit('connected', { clientId: 'c2' }) })
    await settle()
    const reconnect = delta(before, snapshot())
    report('reconnect', reconnect)

    if (BENCH) return

    // Budgets for the migrated data layer.
    expect(appStart.byEndpoint).toEqual({ workspaces: 1, projects: 1, teams: 1, chatSessions: 1 })
    expect(firstConnect.requests).toBe(0)
    expect(boardOpen.byEndpoint).toEqual({ boardTasks: 1, settings: 1, members: 1 })
    expect(toP2.byEndpoint).toEqual({ boardTasks: 1 })
    expect(backToP1.requests).toBe(0)
    expect(batched.requests).toBe(0)
    expect(spread.requests).toBe(0)
    // Renders: no more board commits than the useState board had (2 for a
    // batched burst, 2 per event when spread), each card renders once per
    // change (spread), and a batched burst never re-renders unchanged cards.
    expect(batched.commits.board ?? 0).toBeLessThanOrEqual(2)
    // Exactly one render per changed card: TaskCard no longer leaves a no-op
    // state update queued at mount, which used to cost every non-running card
    // a second (bail-out) render the first time a batch touched it (175 → 100).
    expect(batched.cardRenders).toBeLessThanOrEqual(BURST)
    expect(spread.commits.board ?? 0).toBeLessThanOrEqual(2 * BURST)
    expect(spread.cardRenders).toBeLessThanOrEqual(BURST)
    // A reconnect resyncs every active query once (no duplicates).
    expect(Object.values(reconnect.byEndpoint).every((n) => n === 1)).toBe(true)
    expect(reconnect.byEndpoint.boardTasks).toBe(1)
  }, 120_000)
})
