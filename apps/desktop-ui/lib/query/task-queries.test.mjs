import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { createKeysetServer, makeBoardTask, makeBoardTasks, compareRows, ID } from './task-queries.fixture.mjs'

const state = vi.hoisted(() => ({ server: null, gate: null }))

vi.mock('@/lib/api/fetch', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    apiFetch: vi.fn(async (path) => {
      if (state.gate) await state.gate(path)
      if (typeof path === 'string' && path.startsWith('/api/tasks?')) {
        const result = state.server.list(path)
        if (result.error) throw new actual.ApiError(400, 'cursor is not a valid pagination token', result.error)
        return result
      }
      return {}
    }),
  }
})

const { apiFetch } = await import('@/lib/api/fetch')
const {
  BOARD_COLUMN_PAGE_SIZE,
  boardTasksPath,
  boardTasksQuery,
  compareTaskSortKeys,
  fetchBoardTaskPage,
  getBoardPaging,
  isWithinColumnWindow,
  loadMoreBoardColumn,
  mergeColumnPage,
  placeUnloadedBoardTask,
  subscribeBoardPaging,
  taskSortKey,
} = await import('./task-queries.ts')
const { boardTaskScope, queryKeys } = await import('./keys.ts')

const scope = boardTaskScope('p1', null)
const key = queryKeys.tasks.list(scope)

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

async function load(client, { fresh = false } = {}) {
  return client.fetchQuery({ ...boardTasksQuery(client, scope), ...(fresh ? { staleTime: 0 } : {}) })
}

const params = () => state.server.requests
const listOf = (client) => client.getQueryData(key)
const ofStatus = (list, status) => list.filter((task) => task.status === status)

function deferred() {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.server = createKeysetServer(makeBoardTasks(2000))
  state.gate = null
})

describe('board list requests', () => {
  it('asks for keyset pages in compact view, pageSize first, scope and column filters after', () => {
    expect(boardTasksPath({ projectId: 'p1', teamId: null }, { pageSize: 200 }))
      .toBe('/api/tasks?pageSize=200&pagination=cursor&view=compact&projectId=p1')
    expect(boardTasksPath({ projectId: null, teamId: 'team-1' }, { pageSize: 50, status: 'done', cursor: 'abc' }))
      .toBe('/api/tasks?pageSize=50&pagination=cursor&view=compact&teamId=team-1&status=done&cursor=abc')
  })

  it('treats bare arrays and responses without a cursor as complete', async () => {
    apiFetch.mockResolvedValueOnce([makeBoardTask(1)])
    expect(await fetchBoardTaskPage(scope, { pageSize: 200 })).toMatchObject({ hasMore: false, nextCursor: null })
    // An offset-mode server (no keyset support) says hasMore but gives no cursor.
    apiFetch.mockResolvedValueOnce({ items: [makeBoardTask(1)], total: 900, page: 1, pageSize: 200, hasMore: true })
    expect(await fetchBoardTaskPage(scope, { pageSize: 200 })).toMatchObject({ hasMore: false, nextCursor: null })
  })
})

describe('first page and per-column paging', () => {
  it('loads the first page with one request and starts every column at its cursor', async () => {
    const client = newClient()
    const list = await load(client)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(params()[0]).toEqual({ pageSize: '200', pagination: 'cursor', view: 'compact', projectId: 'p1' })
    expect(list).toHaveLength(200)
    expect(list.some((task) => 'executionLogs' in task)).toBe(false)
    const paging = getBoardPaging(client, key)
    for (const status of ['todo', 'in_progress', 'done', 'cancelled']) {
      expect(paging.columns[status]).toMatchObject({ hasMore: true, extraLoaded: 0, loading: false })
      expect(paging.columns[status].cursor).toBe(paging.columns.todo.cursor)
      expect(paging.columns[status].boundary).toEqual(taskSortKey(list.at(-1)))
    }
  })

  it('loads one column page with one request and appends it after that column', async () => {
    const client = newClient()
    await load(client)
    const firstCursor = getBoardPaging(client, key).columns.todo.cursor
    const added = await loadMoreBoardColumn(client, scope, 'todo')
    expect(added).toBe(BOARD_COLUMN_PAGE_SIZE)
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(params()[1]).toEqual({ pageSize: '50', pagination: 'cursor', view: 'compact', projectId: 'p1', status: 'todo', cursor: firstCursor })
    const list = listOf(client)
    expect(list).toHaveLength(250)
    const todos = ofStatus(list, 'todo')
    expect(todos).toHaveLength(100)
    // The column stays one prefix of the server order.
    expect(todos.map((task) => task.id)).toEqual(
      state.server.tasks.filter((task) => task.status === 'todo').sort(compareRows).slice(0, 100).map((task) => task.id),
    )
    const paging = getBoardPaging(client, key)
    expect(paging.columns.todo).toMatchObject({ hasMore: true, extraLoaded: 50 })
    expect(paging.columns.todo.cursor).not.toBe(firstCursor)
    expect(paging.columns.done.cursor).toBe(firstCursor)
  })

  it('reaches every task of a column with bounded requests and no duplicates', async () => {
    const client = newClient()
    await load(client)
    let clicks = 0
    while (getBoardPaging(client, key).columns.done.hasMore) {
      await loadMoreBoardColumn(client, scope, 'done')
      clicks += 1
    }
    // 500 done tasks: 50 on the first page, 450 in pages of 50.
    expect(clicks).toBe(9)
    expect(apiFetch).toHaveBeenCalledTimes(10)
    const list = listOf(client)
    expect(new Set(list.map((task) => task.id)).size).toBe(list.length)
    expect(ofStatus(list, 'done')).toHaveLength(500)
    expect(await loadMoreBoardColumn(client, scope, 'done')).toBe(0)
    expect(apiFetch).toHaveBeenCalledTimes(10)
  })

  it('ignores a second click while a column page is loading', async () => {
    const client = newClient()
    await load(client)
    const gate = deferred()
    state.gate = () => gate.promise
    const first = loadMoreBoardColumn(client, scope, 'todo')
    expect(getBoardPaging(client, key).columns.todo.loading).toBe(true)
    expect(await loadMoreBoardColumn(client, scope, 'todo')).toBe(0)
    gate.resolve()
    expect(await first).toBe(50)
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(getBoardPaging(client, key).columns.todo.loading).toBe(false)
  })

  it('notifies subscribers when paging changes and forgets paging with the cache entry', async () => {
    const client = newClient()
    const listener = vi.fn()
    const unsubscribe = subscribeBoardPaging(client, key, listener)
    await load(client)
    expect(listener).toHaveBeenCalled()
    client.clear()
    expect(getBoardPaging(client, key)).toBeUndefined()
    unsubscribe()
  })
})

describe('full reload (resync, Retry, stale remount)', () => {
  it('reloads extended columns to the same depth and keeps unchanged task objects', async () => {
    const client = newClient()
    await load(client)
    await loadMoreBoardColumn(client, scope, 'todo')
    await loadMoreBoardColumn(client, scope, 'todo')
    const before = listOf(client)
    apiFetch.mockClear()
    state.server.requests = []

    const after = await load(client, { fresh: true })
    // First page + one todo page for the 100 extra rows (pages of up to 200).
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(params()[1]).toMatchObject({ status: 'todo', pageSize: '100' })
    expect(ofStatus(after, 'todo')).toHaveLength(150)
    expect(after).toHaveLength(300)
    expect(after).toBe(before)
    expect(getBoardPaging(client, key).columns.todo.extraLoaded).toBe(100)
  })

  it('reuses unchanged objects by id when a new task shifts the list', async () => {
    const client = newClient()
    const before = await load(client)
    state.server.tasks = [makeBoardTask(0, { status: 'todo', createdAt: '2026-10-02T00:00:00.000Z' }), ...state.server.tasks]
    const after = await load(client, { fresh: true })
    expect(after[0].id).toBe(ID(0))
    expect(after[1]).toBe(before[0])
    expect(after[199]).toBe(before[198])
  })

  it('drops a column page that was started before a full reload', async () => {
    const client = newClient()
    await load(client)
    const gate = deferred()
    state.gate = (path) => (path.includes('status=todo') ? gate.promise : undefined)
    const pending = loadMoreBoardColumn(client, scope, 'todo')
    await load(client, { fresh: true })
    gate.resolve()
    expect(await pending).toBe(0)
    expect(listOf(client)).toHaveLength(200)
    expect(getBoardPaging(client, key).columns.todo).toMatchObject({ extraLoaded: 0, loading: false })
  })

  it('restarts a column from its first page when the API refuses the cursor', async () => {
    const client = newClient()
    await load(client)
    state.server.rejectCursors.add(getBoardPaging(client, key).columns.todo.cursor)
    const added = await loadMoreBoardColumn(client, scope, 'todo')
    expect(params().slice(1)).toEqual([
      expect.objectContaining({ status: 'todo', cursor: expect.any(String) }),
      { pageSize: '100', pagination: 'cursor', view: 'compact', projectId: 'p1', status: 'todo' },
    ])
    expect(added).toBe(50)
    expect(ofStatus(listOf(client), 'todo')).toHaveLength(100)
  })
})

describe('list updaters', () => {
  const task = (n, overrides) => makeBoardTask(n, overrides)

  it('orders keys createdAt DESC, id DESC', () => {
    const newer = taskSortKey(task(1))
    const older = taskSortKey(task(2))
    expect(compareTaskSortKeys(newer, older)).toBeLessThan(0)
    expect(compareTaskSortKeys(older, newer)).toBeGreaterThan(0)
    const tieA = { createdAt: 1, id: 'b' }
    const tieB = { createdAt: 1, id: 'a' }
    expect(compareTaskSortKeys(tieA, tieB)).toBeLessThan(0)
    expect(isWithinColumnWindow({ hasMore: false, boundary: null }, older)).toBe(true)
    expect(isWithinColumnWindow({ hasMore: true, boundary: newer }, older)).toBe(false)
    expect(isWithinColumnWindow({ hasMore: true, boundary: older }, newer)).toBe(true)
    expect(isWithinColumnWindow({ hasMore: true, boundary: null }, newer)).toBe(false)
  })

  it('merges a column page after the column, keeping copies already on the board', () => {
    const local = { ...task(5), title: 'edited locally' }
    const list = [task(1), task(2), local, task(3)]
    const page = [{ ...task(5) }, task(9), task(13)]
    const next = mergeColumnPage(list, 'todo', page)
    expect(next.map((t) => t.id)).toEqual([ID(1), ID(2), ID(5), ID(9), ID(13), ID(3)])
    expect(next[2]).toBe(local)
    expect(mergeColumnPage(list, 'todo', [{ ...task(5) }])).toBe(list)
  })

  describe('placeUnloadedBoardTask (SSE rule for tasks the board has not loaded)', () => {
    const boardScope = { projectId: 'p1', teamId: null }
    // Loaded: todo tasks 1, 5, 9 (boundary at 9, more on the server); done is complete.
    const list = [task(1), task(5), task(9), task(3, { status: 'done' })]
    const paging = {
      columns: {
        todo: { cursor: 'c', hasMore: true, boundary: taskSortKey(task(9)), extraLoaded: 0, loading: false },
        in_progress: { cursor: 'c', hasMore: true, boundary: taskSortKey(task(9)), extraLoaded: 0, loading: false },
        done: { cursor: null, hasMore: false, boundary: null, extraLoaded: 0, loading: false },
        cancelled: { cursor: 'c', hasMore: true, boundary: taskSortKey(task(9)), extraLoaded: 0, loading: false },
      },
    }

    it('inserts a task inside the loaded window at its sorted position', () => {
      const event = task(6, { status: 'todo' })
      const next = placeUnloadedBoardTask(list, paging, boardScope, event)
      expect(next.map((t) => t.id)).toEqual([ID(1), ID(5), ID(6), ID(9), ID(3)])
    })

    it('leaves a task beyond the loaded window for that column\'s next page', () => {
      expect(placeUnloadedBoardTask(list, paging, boardScope, task(40, { status: 'todo' }))).toBe(list)
    })

    it('inserts into a fully loaded column wherever it sorts, even at the end', () => {
      const next = placeUnloadedBoardTask(list, paging, boardScope, task(400, { status: 'done' }))
      expect(next.map((t) => t.id)).toEqual([ID(1), ID(5), ID(9), ID(3), ID(400)])
      const newer = placeUnloadedBoardTask(list, paging, boardScope, task(2, { status: 'done' }))
      expect(newer.map((t) => t.id)).toEqual([ID(1), ID(5), ID(9), ID(2), ID(3)])
    })

    it('never guesses: no createdAt, other scope, archived, already loaded or no paging → unchanged', () => {
      const { createdAt: _omit, ...withoutCreatedAt } = task(6)
      expect(placeUnloadedBoardTask(list, paging, boardScope, withoutCreatedAt)).toBe(list)
      expect(placeUnloadedBoardTask(list, paging, boardScope, task(6, { projectId: 'p2' }))).toBe(list)
      expect(placeUnloadedBoardTask(list, paging, boardScope, task(6, { archived: true }))).toBe(list)
      expect(placeUnloadedBoardTask(list, paging, boardScope, { ...task(5), title: 'x' })).toBe(list)
      expect(placeUnloadedBoardTask(list, undefined, boardScope, task(6))).toBe(list)
      expect(placeUnloadedBoardTask(list, paging, { projectId: null, teamId: 'team-2' }, task(6))).toBe(list)
    })
  })
})
