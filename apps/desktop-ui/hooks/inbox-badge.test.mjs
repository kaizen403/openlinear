/**
 * Sidebar unread badge + Inbox page on the shared notifications cache.
 * Renders the real Sidebar and InboxPage under the real QueryProvider and SSE
 * bridge, with a fake API, and counts requests.
 *
 * Before the migration: the badge fetched `?pageSize=1` on every route change
 * and the inbox fetched `?pageSize=100` on every visit, each with its own SSE
 * handler, and the badge lagged behind the inbox's reads until the next
 * navigation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { createElement } from 'react'

const state = vi.hoisted(() => ({
  listeners: new Set(),
  pathname: '/',
  notifications: [],
  failMarkAll: false,
  rejectMarkAll: () => {},
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isFullscreen: async () => false, onResized: async () => () => {} }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }) => createElement('a', { href, ...props }, children),
}))
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'alice', avatarUrl: null }, isAuthenticated: true, isLoading: false, logout: vi.fn() }),
}))
vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ activeProject: null, projects: [], setActiveProject: vi.fn(), isLoading: false, refreshProjects: vi.fn() }),
}))
vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({ activeWorkspace: { id: 'w1', name: 'One', role: 'owner' }, workspaces: [{ id: 'w1', name: 'One', role: 'owner' }], setActiveWorkspace: vi.fn(), isLoading: false, refreshWorkspaces: vi.fn() }),
}))
vi.mock('@/providers/sse-provider', async () => {
  const React = await import('react')
  return {
    useSSESubscription: (handler) => {
      const ref = React.useRef(handler)
      React.useEffect(() => { ref.current = handler })
      React.useEffect(() => {
        const listener = (type, data, meta) => ref.current(type, data, meta)
        state.listeners.add(listener)
        return () => { state.listeners.delete(listener) }
      }, [])
    },
  }
})

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/fetch', async (importOriginal) => ({ ...(await importOriginal()), apiFetch }))

const { QueryProvider, QuerySseBridge } = await import('@/providers/query-provider')
const { Sidebar } = await import('@/components/layout/sidebar')
const { default: InboxPage } = await import('@/app/(app)/inbox/page')
const { createAppQueryClient } = await import('@/lib/query/client')

const notification = (id, overrides = {}) => ({
  id,
  userId: 'u1',
  type: 'mention',
  taskId: null,
  commentId: null,
  actorUserId: 'u2',
  actor: { id: 'u2', username: 'bob', avatarUrl: null },
  body: `Note ${id}`,
  readAt: null,
  createdAt: new Date().toISOString(),
  ...overrides,
})

function unread() {
  return state.notifications.filter((n) => n.readAt === null).length
}

function respond(path, init) {
  const method = init?.method ?? 'GET'
  if (method === 'GET' && path.startsWith('/api/notifications?pageSize=')) {
    const size = Number(path.split('=')[1])
    return { items: state.notifications.slice(0, size), page: 1, pageSize: size, total: state.notifications.length, hasMore: false, unreadCount: unread() }
  }
  if (method === 'PATCH' && /^\/api\/notifications\/[^/]+\/read$/.test(path)) {
    const id = path.split('/')[3]
    state.notifications = state.notifications.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n))
    return {}
  }
  if (method === 'POST' && path === '/api/notifications/read-all') {
    if (state.failMarkAll) return new Promise((_resolve, reject) => { state.rejectMarkAll = () => reject(new Error('offline')) })
    state.notifications = state.notifications.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))
    return { updated: 1 }
  }
  throw new Error(`unexpected ${method} ${path}`)
}

/** Requests to `path` (exact, or a prefix ending in `?`). */
function calls(path, method = 'GET') {
  return apiFetch.mock.calls.filter(([url, init]) =>
    (path.endsWith('?') ? url.startsWith(path) : url === path) && (init?.method ?? 'GET') === method).length
}

function emit(type, data) {
  for (const listener of [...state.listeners]) listener(type, data, { stream: 'cloud', id: null })
}

function App({ client, children }) {
  return createElement(QueryProvider, { client }, createElement(QuerySseBridge, { windowMs: 5 }), children)
}

function badge() {
  const link = screen.getByRole('link', { name: /inbox/i })
  return link.querySelector('span.ml-auto')?.textContent ?? null
}

function header() {
  return screen.getByRole('heading', { name: 'Inbox' }).nextElementSibling?.textContent ?? null
}

beforeEach(() => {
  cleanup()
  apiFetch.mockReset()
  apiFetch.mockImplementation(async (path, init) => respond(path, init))
  state.listeners.clear()
  state.pathname = '/'
  state.failMarkAll = false
  state.notifications = [notification('n1'), notification('n2'), notification('n3', { readAt: '2026-10-01T00:00:00.000Z' })]
})

describe('sidebar badge + inbox page', () => {
  it('share one unread-count request, and route changes reuse it while fresh', async () => {
    const client = createAppQueryClient()
    const sidebar = () => createElement(Sidebar, { open: true, onClose: () => {}, width: 240 })
    const view = render(createElement(App, { client }, sidebar()))
    await waitFor(() => expect(badge()).toBe('2'))
    expect(calls('/api/notifications?pageSize=1')).toBe(1)

    // Navigate to the inbox: the list loads once, the count is not fetched again.
    state.pathname = '/inbox'
    view.rerender(createElement(App, { client }, sidebar(), createElement(InboxPage)))
    await waitFor(() => expect(screen.getByText('Note n1')).toBeTruthy())
    expect(header()).toBe('2')
    expect(calls('/api/notifications?pageSize=100')).toBe(1)
    expect(calls('/api/notifications?pageSize=1')).toBe(1)

    // More route changes within the freshness window: still one count request.
    for (const path of ['/my-issues', '/archived', '/inbox']) {
      state.pathname = path
      view.rerender(createElement(App, { client }, sidebar(), createElement(InboxPage)))
    }
    await act(async () => {})
    expect(calls('/api/notifications?pageSize=1')).toBe(1)
    expect(calls('/api/notifications?pageSize=100')).toBe(1)

    // Once stale, the next route change refreshes the badge (once).
    client.setQueryData(['ol', 'notifications', 'unread-count'], 2, { updatedAt: Date.now() - 10 * 60_000 })
    state.pathname = '/usage'
    view.rerender(createElement(App, { client }, sidebar()))
    await waitFor(() => expect(calls('/api/notifications?pageSize=1')).toBe(2))
  })

  it('a read in the inbox and a new notification update the badge and the header together, with no refetch', async () => {
    const client = createAppQueryClient()
    render(createElement(App, { client },
      createElement(Sidebar, { open: true, onClose: () => {}, width: 240 }),
      createElement(InboxPage)))
    await waitFor(() => expect(screen.getByText('Note n1')).toBeTruthy())
    await waitFor(() => expect(badge()).toBe('2'))
    const gets = calls('/api/notifications?')

    fireEvent.click(screen.getByText('Note n1'))
    await waitFor(() => expect(calls('/api/notifications/n1/read', 'PATCH')).toBe(1))
    expect(badge()).toBe('1')
    expect(header()).toBe('1')

    act(() => emit('notification:created', notification('n4', { body: 'Note n4' })))
    expect(screen.getByText('Note n4')).toBeTruthy()
    expect(badge()).toBe('2')
    expect(header()).toBe('2')
    // The same event delivered again (another stream) is not counted twice.
    act(() => emit('notification:created', notification('n4', { body: 'Note n4' })))
    expect(badge()).toBe('2')

    expect(calls('/api/notifications?')).toBe(gets)
  })

  it('mark all read is optimistic and rolls back on failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    state.failMarkAll = true
    const client = createAppQueryClient()
    render(createElement(App, { client },
      createElement(Sidebar, { open: true, onClose: () => {}, width: 240 }),
      createElement(InboxPage)))
    await waitFor(() => expect(badge()).toBe('2'))
    await waitFor(() => expect(screen.getByText('Note n1')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }))
    await waitFor(() => expect(calls('/api/notifications/read-all', 'POST')).toBe(1))
    // Optimistic: both counts clear while the request is in flight.
    expect(badge()).toBeNull()
    expect(screen.queryByRole('button', { name: /mark all read/i })).toBeNull()
    await act(async () => { state.rejectMarkAll() })
    await waitFor(() => expect(badge()).toBe('2'))
    expect(header()).toBe('2')
  })
})
