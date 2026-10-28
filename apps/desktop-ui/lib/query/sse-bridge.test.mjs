import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { QueryObserver } from '@tanstack/react-query'
import { createAppQueryClient } from './client.ts'
import { boardTaskScope, queryKeys } from './keys.ts'
import {
  applySseEventToCache,
  BOARD_OWNED_META,
  createBridgeState,
  writeCreatedTaskToCache,
} from './sse-bridge.ts'

const task = (id, overrides = {}) => ({
  id,
  title: `Task ${id}`,
  description: null,
  priority: 'medium',
  status: 'todo',
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
  identifier: `KT-${id}`,
  number: 1,
  dueDate: null,
  projectId: 'p1',
  teamId: 'team-1',
  assigneeId: null,
  creatorId: 'u1',
  archived: false,
  ...overrides,
})

const issue = (id, overrides = {}) => ({
  id,
  title: `Issue ${id}`,
  description: null,
  priority: 'medium',
  status: 'todo',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  prUrl: null,
  executionElapsedMs: 0,
  executionProgress: null,
  labels: [],
  project: { id: 'p1', name: 'P1', status: 'in_progress', color: '#000' },
  team: { id: 'team-1', name: 'Team', key: 'KT', color: '#000' },
  assigneeId: 'u1',
  ...overrides,
})

const P1 = queryKeys.tasks.list(boardTaskScope('p1', null))
const P2 = queryKeys.tasks.list(boardTaskScope('p2', null))
const MINE = queryKeys.tasks.list({ kind: 'mine', filter: 'assigned' })

let client
let state

function emit(type, data, stream = 'cloud') {
  applySseEventToCache(client, type, data, { stream, id: null }, state)
}

/** Subscribe an observer so the query counts as active (and, with BOARD_OWNED_META, as a mounted board). */
function observe(queryKey, options = {}) {
  const observer = new QueryObserver(client, { queryKey, queryFn: async () => [], staleTime: Infinity, ...options })
  return observer.subscribe(() => {})
}

beforeEach(() => {
  client = createAppQueryClient()
  state = createBridgeState(client, { windowMs: 10 })
  state.currentUserId = 'u1'
})

afterEach(() => {
  state.invalidator.dispose()
  client.clear()
  vi.useRealTimers()
})

describe('task events', () => {
  it('patches every cached list and the detail in place, without refetching', () => {
    client.setQueryData(P1, [task('a'), task('b')])
    client.setQueryData(P2, [task('z', { projectId: 'p2' })])
    client.setQueryData(MINE, [issue('a')])
    client.setQueryData(queryKeys.tasks.detail('a'), task('a'))
    const p2Before = client.getQueryData(P2)

    emit('task:updated', { id: 'a', status: 'done', title: 'Renamed' })

    expect(client.getQueryData(P1).find((t) => t.id === 'a')).toMatchObject({ status: 'done', title: 'Renamed' })
    expect(client.getQueryData(P1).find((t) => t.id === 'b')).toBe(client.getQueryData(P1)[1])
    expect(client.getQueryData(MINE)[0]).toMatchObject({ status: 'done', title: 'Renamed', project: { id: 'p1' } })
    expect(client.getQueryData(queryKeys.tasks.detail('a'))).toMatchObject({ status: 'done' })
    expect(client.getQueryData(P2)).toBe(p2Before)
  })

  it('leaves a mounted board list to the board, but still applies label changes to it', () => {
    client.setQueryData(P1, [task('a')])
    const unsubscribe = observe(P1, { meta: BOARD_OWNED_META })
    const before = client.getQueryData(P1)

    emit('task:updated', { id: 'a', status: 'done' })
    emit('task:deleted', { id: 'a' })
    expect(client.getQueryData(P1)).toBe(before)

    emit('task:label:assigned', { taskId: 'a', label: { id: 'l1', name: 'bug', color: '#f00', priority: 1 } })
    expect(client.getQueryData(P1)[0].labels).toEqual([{ id: 'l1', name: 'bug', color: '#f00', priority: 1 }])
    unsubscribe()
  })

  it('removes a task that leaves a scope and marks a list stale when a task may have entered it', async () => {
    client.setQueryData(P1, [task('a')])
    client.setQueryData(P2, [])

    emit('task:updated', { id: 'a', projectId: 'p2' })

    expect(client.getQueryData(P1)).toEqual([])
    expect(client.getQueryData(P2)).toEqual([])
    await vi.waitFor(() => expect(client.getQueryState(P2).isInvalidated).toBe(true))
    expect(client.getQueryState(P1).isInvalidated).toBe(false)
  })

  it('adds created tasks to matching boards and refetches issue lists that may contain them', async () => {
    client.setQueryData(P1, [task('a')])
    client.setQueryData(P2, [])
    client.setQueryData(MINE, [])

    emit('task:created', task('n', { assigneeId: 'u1' }))

    expect(client.getQueryData(P1).map((t) => t.id)).toEqual(['n', 'a'])
    expect(client.getQueryData(P2)).toEqual([])
    await vi.waitFor(() => expect(client.getQueryState(MINE).isInvalidated).toBe(true))
  })

  it('drops an issue that is no longer assigned to the current user', () => {
    client.setQueryData(MINE, [issue('a'), issue('b')])
    emit('task:updated', { id: 'a', assigneeId: 'someone-else' })
    expect(client.getQueryData(MINE).map((t) => t.id)).toEqual(['b'])
  })

  it('removes bulk-deleted tasks and forgets their unobserved detail queries', () => {
    client.setQueryData(P1, [task('a'), task('b'), task('c')])
    client.setQueryData(queryKeys.tasks.detail('a'), task('a'))
    client.setQueryData(queryKeys.tasks.comments('a'), [])

    emit('tasks:bulk-deleted', { projectId: 'p1', taskIds: ['a', 'b'] })

    expect(client.getQueryData(P1).map((t) => t.id)).toEqual(['c'])
    expect(client.getQueryData(queryKeys.tasks.detail('a'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.tasks.comments('a'))).toBeUndefined()
  })

  it('coalesces a burst of invalidations into one refetch per list', async () => {
    const queryFn = vi.fn(async () => [issue('x')])
    const unsubscribe = observe(MINE, { queryFn, staleTime: 30_000 })
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))

    for (let i = 0; i < 100; i += 1) emit('tasks:bulk-created', { projectId: 'p1', taskIds: [`t${i}`] })

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(queryFn).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('applies a batch PR to cached boards', () => {
    client.setQueryData(P1, [task('a', { batchId: 'b1' }), task('b')])
    emit('batch:completed', { batchId: 'b1', prUrl: 'https://github.com/o/r/pull/1' })
    expect(client.getQueryData(P1).map((t) => t.prUrl)).toEqual(['https://github.com/o/r/pull/1', null])
  })
})

describe('stream (re)connects', () => {
  it('first cloud connect resyncs task lists only and reuses a fetch already in flight', async () => {
    let resolveTasks
    const tasksFn = vi.fn(() => new Promise((resolve) => { resolveTasks = resolve }))
    const workspacesFn = vi.fn(async () => [{ id: 'w1' }])
    const offTasks = observe(MINE, { queryFn: tasksFn, staleTime: 30_000 })
    const offWorkspaces = observe(queryKeys.workspaces.list(), { queryFn: workspacesFn, staleTime: 30_000 })
    await vi.waitFor(() => expect(workspacesFn).toHaveBeenCalledTimes(1))
    expect(tasksFn).toHaveBeenCalledTimes(1)

    emit('connected', { clientId: 'c1' })

    expect(tasksFn).toHaveBeenCalledTimes(1) // in flight: deduplicated, not re-sent
    expect(workspacesFn).toHaveBeenCalledTimes(1)
    resolveTasks([])
    offTasks()
    offWorkspaces()
  })

  it('a reconnect or a replay gap resyncs everything; local first connects change nothing', async () => {
    const workspacesFn = vi.fn(async () => [{ id: 'w1' }])
    const off = observe(queryKeys.workspaces.list(), { queryFn: workspacesFn, staleTime: 30_000 })
    await vi.waitFor(() => expect(workspacesFn).toHaveBeenCalledTimes(1))

    emit('connected', {}, 'local')
    emit('connected', {}, 'cloud')
    await Promise.resolve()
    expect(workspacesFn).toHaveBeenCalledTimes(1)

    emit('connected', {}, 'cloud')
    await vi.waitFor(() => expect(workspacesFn).toHaveBeenCalledTimes(2))
    // A resync while that refetch is still in flight would reuse it.
    await vi.waitFor(() => expect(client.getQueryState(queryKeys.workspaces.list()).fetchStatus).toBe('idle'))

    emit('replay-gap', {}, 'cloud')
    await vi.waitFor(() => expect(workspacesFn).toHaveBeenCalledTimes(3))
    off()
  })

  it('never resyncs a mounted board list (the board refetches it itself)', async () => {
    const boardFn = vi.fn(async () => [task('a')])
    const off = observe(P1, { queryFn: boardFn, staleTime: 30_000, meta: BOARD_OWNED_META })
    await vi.waitFor(() => expect(boardFn).toHaveBeenCalledTimes(1))
    emit('connected', {})
    emit('replay-gap', {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(boardFn).toHaveBeenCalledTimes(1)
    off()
  })
})

describe('other resources', () => {
  it('comments: created, updated, deleted', () => {
    const key = queryKeys.tasks.comments('a')
    client.setQueryData(key, [{ id: 'c1', body: 'one' }])
    emit('comment:created', { taskId: 'a', comment: { id: 'c2', body: 'two' } })
    emit('comment:created', { taskId: 'a', comment: { id: 'c2', body: 'two' } })
    emit('comment:updated', { taskId: 'a', comment: { id: 'c1', body: 'edited' } })
    expect(client.getQueryData(key)).toEqual([{ id: 'c1', body: 'edited' }, { id: 'c2', body: 'two' }])
    emit('comment:deleted', { taskId: 'a', id: 'c1' })
    expect(client.getQueryData(key)).toEqual([{ id: 'c2', body: 'two' }])
  })

  it('labels: list and the copies embedded in tasks', () => {
    const labels = queryKeys.projects.labels('p1')
    client.setQueryData(labels, [{ id: 'l2', name: 'b', color: '#0f0', priority: 2 }])
    client.setQueryData(P1, [task('a', { labels: [{ id: 'l2', name: 'b', color: '#0f0', priority: 2 }] })])

    emit('label:created', { id: 'l1', name: 'a', color: '#f00', priority: 1, projectId: 'p1' })
    expect(client.getQueryData(labels).map((l) => l.id)).toEqual(['l1', 'l2'])

    emit('label:updated', { id: 'l2', name: 'renamed', color: '#00f', priority: 2, projectId: 'p1' })
    expect(client.getQueryData(P1)[0].labels[0].name).toBe('renamed')

    emit('label:deleted', { id: 'l2' })
    expect(client.getQueryData(labels).map((l) => l.id)).toEqual(['l1'])
    expect(client.getQueryData(P1)[0].labels).toEqual([])
  })

  it('projects: created (same workspace only), updated, deleted', () => {
    const list = queryKeys.projects.list('w1', { fields: ['id'] })
    client.setQueryData(list, [{ id: 'p1', workspaceId: 'w1', name: 'One' }])
    emit('project:created', { id: 'p9', workspaceId: 'other', name: 'Elsewhere' })
    emit('project:created', { id: 'p2', workspaceId: 'w1', name: 'Two' })
    emit('project:updated', { id: 'p1', name: 'Renamed' })
    expect(client.getQueryData(list).map((p) => p.name)).toEqual(['Renamed', 'Two'])
    emit('project:deleted', { id: 'p1' })
    expect(client.getQueryData(list).map((p) => p.id)).toEqual(['p2'])
  })

  it('workspaces, chat sessions and settings are patched; team events invalidate', async () => {
    client.setQueryData(queryKeys.workspaces.list(), [{ id: 'w1', name: 'One' }])
    emit('workspace:joined', { id: 'w2', name: 'Two' })
    emit('workspace:updated', { id: 'w1', name: 'Renamed' })
    expect(client.getQueryData(queryKeys.workspaces.list()).map((w) => w.name)).toEqual(['Renamed', 'Two'])
    emit('workspace:left', { workspaceId: 'w2' })
    expect(client.getQueryData(queryKeys.workspaces.list()).map((w) => w.id)).toEqual(['w1'])

    client.setQueryData(queryKeys.workspaces.chatSessions('w1'), [{ id: 's1', workspaceId: 'w1', title: null }])
    emit('chat:session:updated', { id: 's1', workspaceId: 'w1', title: 'Auto title' })
    expect(client.getQueryData(queryKeys.workspaces.chatSessions('w1'))[0].title).toBe('Auto title')

    client.setQueryData(queryKeys.settings(), { taskDeletionMode: 'archive' })
    emit('settings:updated', { taskDeletionMode: 'delete' })
    expect(client.getQueryData(queryKeys.settings())).toEqual({ taskDeletionMode: 'delete' })

    const teams = queryKeys.teams.list('w1', { fields: ['id'] })
    client.setQueryData(teams, [{ id: 'team-1' }])
    emit('team:updated', { id: 'team-1', name: 'x' })
    await vi.waitFor(() => expect(client.getQueryState(teams).isInvalidated).toBe(true))
  })
})

describe('writeCreatedTaskToCache', () => {
  it('inserts into every matching board, mounted or not, once', () => {
    client.setQueryData(P1, [task('a')])
    client.setQueryData(P2, [])
    const off = observe(P1, { meta: BOARD_OWNED_META })
    writeCreatedTaskToCache(client, task('n'))
    writeCreatedTaskToCache(client, task('n'))
    expect(client.getQueryData(P1).map((t) => t.id)).toEqual(['n', 'a'])
    expect(client.getQueryData(P2)).toEqual([])
    off()
  })
})
