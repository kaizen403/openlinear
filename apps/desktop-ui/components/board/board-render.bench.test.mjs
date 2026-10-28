// Board render benchmark (opt-in): renders the real KanbanBoard with the real
// @hello-pangea/dnd at 500/1000/2000 tasks and measures mount time, the cost
// of a single SSE `task:updated` event, and select-all.
//
//   BOARD_BENCH=1 pnpm --filter @openlinear/desktop-ui exec vitest run components/board/board-render.bench.test.mjs
//
// Optional: BOARD_BENCH_SIZES=500,1000,2000  BOARD_BENCH_UPDATES=10  BOARD_BENCH_WARMUP=2
//           BOARD_BENCH_DND=mock (use the test-setup dnd stub instead of the real library)
// Without BOARD_BENCH the suite is skipped, so the default test run is unaffected.
// Each size prints one `BOARD_BENCH_RESULT {json}` line as soon as it finishes.
// Numbers are jsdom React render/commit times (no layout or paint); compare runs
// on the same machine only. Card renders are counted exactly, through the one
// `useExecutionProgress` call each TaskCard render makes.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createElement, Profiler } from 'react'

const BENCH = process.env.BOARD_BENCH === '1'
const SIZES = (process.env.BOARD_BENCH_SIZES ?? '500,1000,2000').split(',').map((value) => Number(value.trim())).filter((value) => value > 0)
const UPDATES = Number(process.env.BOARD_BENCH_UPDATES ?? 10)
const WARMUP_UPDATES = Number(process.env.BOARD_BENCH_WARMUP ?? 2)
const REAL_DND = process.env.BOARD_BENCH_DND !== 'mock'
const TIMEOUT_MS = Number(process.env.BOARD_BENCH_TIMEOUT_MS ?? 3_600_000)

if (REAL_DND) vi.doUnmock('@hello-pangea/dnd')

const state = vi.hoisted(() => ({
  tasks: [],
  handlers: [],
  cardRenders: 0,
  auth: {
    isAuthenticated: true,
    activeRepository: { id: 'repo-1', fullName: 'acme/app', defaultBranch: 'main', name: 'app', cloneUrl: '', githubRepoId: 1, isActive: true, userId: 'u1' },
    refreshActiveRepository: () => {},
    user: { id: 'u1', username: 'bench' },
  },
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => state.auth }))
vi.mock('@/hooks/use-team-members', () => ({ useTeamMembers: () => ({ members: [], isLoading: false }) }))
vi.mock('@/providers/sse-provider', () => ({
  useSSESubscription: (handler) => {
    if (!state.handlers.includes(handler)) state.handlers.push(handler)
  },
}))
vi.mock('@/components/task-form', () => ({ TaskFormDialog: () => null }))
vi.mock('@/components/task-detail-view', () => ({ TaskDetailView: () => null }))
vi.mock('@/components/provider-setup-dialog', () => ({ ProviderSetupDialog: () => null }))
vi.mock('./model-selector', () => ({ ModelSelector: () => null }))
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
      if (typeof path === 'string' && path.startsWith('/api/tasks?')) {
        return { items: state.tasks, total: state.tasks.length, page: 1, pageSize: state.tasks.length, hasMore: false }
      }
      if (path === '/api/settings') return { taskDeletionMode: 'archive' }
      return {}
    }),
  }
})

const { KanbanBoard } = await import('./kanban-board.tsx')

const STATUSES = ['todo', 'todo', 'todo', 'todo', 'in_progress', 'in_progress', 'in_progress', 'done', 'done', 'cancelled']
const LABELS = [
  { id: 'l1', name: 'bug', color: '#e5484d', priority: 1 },
  { id: 'l2', name: 'feature', color: '#3e63dd', priority: 2 },
  { id: 'l3', name: 'infra', color: '#30a46c', priority: 3 },
]

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function makeTasks(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: uuid(index + 1),
    title: `Benchmark task ${index + 1} with a reasonably long title to wrap`,
    description: null,
    priority: ['low', 'medium', 'high'][index % 3],
    status: STATUSES[index % STATUSES.length],
    sessionId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    labels: LABELS.slice(0, index % 3),
    executionStartedAt: null,
    executionPausedAt: null,
    executionElapsedMs: index % 5 === 0 ? 65_000 : 0,
    executionProgress: null,
    prUrl: null,
    outcome: null,
    batchId: null,
    inboxRead: false,
    identifier: `BEN-${index + 1}`,
    number: index + 1,
    dueDate: null,
    projectId: 'p1',
    teamId: 'team-1',
    assigneeId: null,
    assignee: null,
    creator: { id: 'u1', username: 'bench', avatarUrl: null },
    archived: false,
  }))
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  return Number(sorted[rank].toFixed(2))
}

function dispatchSse(eventType, data) {
  for (const handler of state.handlers) handler(eventType, data)
}

const project = {
  id: 'p1', workspaceId: 'w1', key: 'BEN', name: 'Bench', description: null, status: 'in_progress', color: '#000', icon: null,
  startDate: null, targetDate: null, leadId: null, repoUrl: null, localPath: null, repositoryId: 'repo-1', repository: null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
}

async function measureSize(size) {
  state.tasks = makeTasks(size)
  state.handlers = []
  state.cardRenders = 0
  let commitMs = 0
  const onRender = (_id, _phase, actualDuration) => { commitMs += actualDuration }

  const mountStart = performance.now()
  await act(async () => {
    render(createElement(Profiler, { id: 'board', onRender }, createElement(KanbanBoard, { projectId: 'p1', projects: [project] })))
  })
  const mountMs = performance.now() - mountStart
  const mountCommitMs = commitMs
  const mountCardRenders = state.cardRenders
  if (REAL_DND) expect(document.querySelectorAll('[data-rfd-draggable-id]').length).toBeGreaterThanOrEqual(size)

  const inProgress = state.tasks.filter((task) => task.status === 'in_progress')
  const updateWall = []
  const updateCommit = []
  const updateCards = []
  for (let iteration = 0; iteration < WARMUP_UPDATES + UPDATES; iteration += 1) {
    const target = inProgress[iteration % inProgress.length]
    commitMs = 0
    const cardsBefore = state.cardRenders
    const start = performance.now()
    await act(async () => {
      dispatchSse('task:updated', {
        id: target.id,
        projectId: 'p1',
        teamId: 'team-1',
        executionProgress: (iteration * 7) % 100,
        updatedAt: new Date(Date.UTC(2026, 9, 2, 0, 0, iteration)).toISOString(),
      })
    })
    if (iteration >= WARMUP_UPDATES) {
      updateWall.push(performance.now() - start)
      updateCommit.push(commitMs)
      updateCards.push(state.cardRenders - cardsBefore)
    }
  }

  commitMs = 0
  const selectStart = performance.now()
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
  })
  const selectAllMs = performance.now() - selectStart
  const selectAllCommitMs = commitMs

  cleanup()
  return {
    size,
    dnd: REAL_DND ? 'real' : 'mock',
    mountMs: Number(mountMs.toFixed(1)),
    mountCommitMs: Number(mountCommitMs.toFixed(1)),
    mountCardRenders,
    sseUpdateWallMs: { p50: percentile(updateWall, 50), p95: percentile(updateWall, 95) },
    sseUpdateCommitMs: { p50: percentile(updateCommit, 50), p95: percentile(updateCommit, 95) },
    sseUpdateCardRenders: { min: Math.min(...updateCards), max: Math.max(...updateCards) },
    selectAllMs: Number(selectAllMs.toFixed(1)),
    selectAllCommitMs: Number(selectAllCommitMs.toFixed(1)),
  }
}

describe.skipIf(!BENCH)('board render benchmark', () => {
  afterEach(() => cleanup())

  it('measures mount, single-task SSE update and select-all', async () => {
    for (const size of SIZES) {
      const result = await measureSize(size)
      console.log(`BOARD_BENCH_RESULT ${JSON.stringify({ updates: UPDATES, warmup: WARMUP_UPDATES, ...result })}`)
    }
  }, TIMEOUT_MS)
})
