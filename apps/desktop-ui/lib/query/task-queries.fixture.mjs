// Test fixture (not a test file): a fake `GET /api/tasks` with the API's
// keyset semantics — order `createdAt DESC, id DESC`, `pagination=cursor`,
// `status`/`projectId`/`teamId` filters, an opaque cursor that is a position
// in the shared order (not bound to filters), `view=compact` omitting
// `executionLogs`. Used by task-queries.test.mjs and
// components/board/board-pagination.test.mjs.

export const STATUSES = ['todo', 'in_progress', 'done', 'cancelled']
export const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const BASE = Date.parse('2026-10-01T00:00:00.000Z')

/** Task n is created n seconds before the newest; statuses rotate, so every column holds count/4. */
export function makeBoardTask(n, overrides = {}) {
  return {
    id: ID(n),
    title: `Task ${n}`,
    description: null,
    priority: 'medium',
    status: STATUSES[(n - 1) % STATUSES.length],
    sessionId: null,
    createdAt: new Date(BASE - n * 1000).toISOString(),
    updatedAt: new Date(BASE - n * 1000).toISOString(),
    labels: [],
    executionStartedAt: null,
    executionPausedAt: null,
    executionElapsedMs: 0,
    executionProgress: null,
    prUrl: null,
    outcome: null,
    batchId: null,
    inboxRead: false,
    identifier: `KT-${n}`,
    number: n,
    dueDate: null,
    projectId: 'p1',
    teamId: 'team-1',
    archived: false,
    executionLogs: [{ timestamp: new Date(BASE).toISOString(), type: 'info', message: `log ${n}` }],
    ...overrides,
  }
}

export function makeBoardTasks(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => makeBoardTask(index + 1, overrides))
}

/** Negative when a comes first (newer). */
export function compareRows(a, b) {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt)
  if (byTime !== 0) return byTime
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1
}

function encode(row) {
  return btoa(JSON.stringify({ v: 1, c: row.createdAt, i: row.id })).replace(/=+$/, '')
}

function decode(token) {
  const parsed = JSON.parse(atob(token))
  return { createdAt: parsed.c, id: parsed.i }
}

export function createKeysetServer(tasks) {
  const server = {
    tasks,
    /** Every list request's query parameters, in order. */
    requests: [],
    /** Cursors the server refuses (400 INVALID_CURSOR). */
    rejectCursors: new Set(),
    list(path) {
      const params = new URL(path, 'http://test.local').searchParams
      server.requests.push(Object.fromEntries(params))
      const pageSize = Number(params.get('pageSize') ?? 50)
      const status = params.get('status')
      const projectId = params.get('projectId')
      const teamId = params.get('teamId')
      const cursor = params.get('cursor')
      if (cursor && server.rejectCursors.has(cursor)) return { error: 'INVALID_CURSOR' }
      let rows = server.tasks
        .filter((task) => !task.archived)
        .filter((task) => !projectId || task.projectId === projectId)
        .filter((task) => !teamId || task.teamId === teamId)
        .filter((task) => !status || task.status === status)
        .sort(compareRows)
      if (cursor) {
        const position = decode(cursor)
        rows = rows.filter((row) => compareRows(row, position) > 0)
      }
      const page = rows.slice(0, pageSize)
      const hasMore = rows.length > pageSize
      const compact = params.get('view') === 'compact'
      const items = page.map((row) => {
        const copy = structuredClone(row)
        if (compact) delete copy.executionLogs
        return copy
      })
      return { items, pageSize, hasMore, nextCursor: hasMore ? encode(page.at(-1)) : null }
    },
  }
  return server
}
