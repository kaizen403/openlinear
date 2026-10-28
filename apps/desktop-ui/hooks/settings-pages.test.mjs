/**
 * Project settings, Archived and Settings → Workspaces on the query cache:
 * real pages, real QueryProvider + SSE bridge, fake API, request counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { createElement } from 'react'

const state = vi.hoisted(() => ({
  listeners: new Set(),
  params: new URLSearchParams(),
  labels: [],
  access: [],
  archived: [],
  failDeletes: new Set(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => state.params,
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }) => createElement('a', { href, ...props }, children),
}))
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'alice', avatarUrl: null }, isAuthenticated: true, isLoading: false, logout: vi.fn() }),
}))
vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({ activeWorkspace: { id: 'w1', name: 'One', role: 'owner' }, workspaces: [], setActiveWorkspace: vi.fn(), isLoading: false, refreshWorkspaces: vi.fn() }),
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
const { createAppQueryClient } = await import('@/lib/query/client')
const { queryKeys } = await import('@/lib/query/keys')
const { default: ProjectManagePage } = await import('@/app/(app)/projects/manage/page')
const { default: ArchivedPage } = await import('@/app/(app)/archived/page')
const { WorkspacesSection } = await import('@/components/settings/workspaces-section')
const { useProjectLabels } = await import('@/hooks/use-project-labels')

const user = (id) => ({ id, username: `user-${id}`, email: null, avatarUrl: null })

function respond(path, init) {
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(init.body) : null
  if (method === 'GET' && path === '/api/projects/p1') return { id: 'p1', workspaceId: 'w1', name: 'Apollo', description: 'Moon', status: 'in_progress', color: '#000' }
  if (method === 'GET' && path === '/api/projects/p1/access') return state.access
  if (method === 'POST' && path === '/api/projects/p1/access') {
    const entry = { id: `a-${body.userId}`, projectId: 'p1', userId: body.userId, permission: body.permission, grantedAt: '', user: user(body.userId) }
    state.access = [...state.access.filter((a) => a.userId !== body.userId), entry]
    return entry
  }
  if (method === 'GET' && path === '/api/workspaces/w1/members?limit=200') {
    return { data: ['u1', 'u2', 'u3'].map((id) => ({ id: `wm-${id}`, workspaceId: 'w1', userId: id, role: 'member', invitedAt: '', joinedAt: null, user: user(id) })), nextCursor: null }
  }
  if (method === 'GET' && path === '/api/labels?projectId=p1') return state.labels
  if (method === 'POST' && path === '/api/labels') {
    const label = { id: `l-${body.name}`, name: body.name, color: body.color, priority: 0, projectId: 'p1' }
    state.labels = [...state.labels, label]
    return label
  }
  if (method === 'GET' && path === '/api/tasks/archived') return { items: state.archived }
  if (method === 'DELETE' && path.startsWith('/api/tasks/archived/')) {
    const id = path.split('/').at(-1)
    if (state.failDeletes.has(id)) throw new Error(`cannot delete ${id}`)
    state.archived = state.archived.filter((t) => t.id !== id)
    return undefined
  }
  if (method === 'GET' && /^\/api\/workspaces\/w\d\/structure\?view=summary$/.test(path)) {
    const id = path.split('/')[3]
    return {
      id, name: `Workspace ${id}`, slug: id, view: 'summary', _count: { members: id === 'w1' ? 7 : 3, projects: 1 },
      projects: [{ id: `${id}-p`, workspaceId: id, key: 'P', name: `Project of ${id}`, status: 'planned', color: '#000', icon: null, _count: { tasks: 4 },
        teams: [{ id: `${id}-t`, name: 'Core', key: 'CORE', color: '#000', projectId: `${id}-p`, _count: { members: 5, tasks: 4 } }] }],
    }
  }
  throw new Error(`unexpected ${method} ${path}`)
}

function calls(path, method = 'GET') {
  return apiFetch.mock.calls.filter(([url, init]) => url === path && (init?.method ?? 'GET') === method).length
}

function emit(type, data) {
  for (const listener of [...state.listeners]) listener(type, data, { stream: 'cloud', id: null })
}

function App({ client, children }) {
  return createElement(QueryProvider, { client }, createElement(QuerySseBridge, { windowMs: 5 }), children)
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

const task = (id, priority = 'medium') => ({ id, title: `Archived ${id}`, description: null, priority, status: 'done' })

beforeEach(() => {
  cleanup()
  apiFetch.mockReset()
  apiFetch.mockImplementation(async (path, init) => respond(path, init))
  state.listeners.clear()
  state.params = new URLSearchParams()
  state.labels = [{ id: 'l-bug', name: 'bug', color: '#f00', priority: 1, projectId: 'p1' }]
  state.access = [{ id: 'a-u2', projectId: 'p1', userId: 'u2', permission: 'full', grantedAt: '', user: user('u2') }]
  state.archived = [task('a'), task('b'), task('c'), task('d')]
  state.failDeletes = new Set()
})

describe('project settings', () => {
  it('loads with one request per resource, shares labels with the picker, and own writes cost no refetch', async () => {
    state.params = new URLSearchParams('id=p1')
    const client = createAppQueryClient()
    const picker = []
    function LabelPickerConsumer() {
      const { labels } = useProjectLabels('p1')
      picker.push(labels.map((l) => l.name).join(','))
      return null
    }
    render(createElement(App, { client }, createElement(ProjectManagePage), createElement(LabelPickerConsumer)))
    await waitFor(() => expect(screen.getByDisplayValue('Apollo')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('bug')).toBeTruthy())
    expect(calls('/api/projects/p1')).toBe(1)
    expect(calls('/api/projects/p1/access')).toBe(1)
    expect(calls('/api/workspaces/w1/members?limit=200')).toBe(1)
    expect(calls('/api/labels?projectId=p1')).toBe(1)

    // Create a label here: the picker sees it at once, and its own event is a no-op.
    fireEvent.change(screen.getByPlaceholderText('Label name'), { target: { value: 'infra' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Label name'), { key: 'Enter' })
    await waitFor(() => expect(picker.at(-1)).toBe('infra,bug'))
    act(() => emit('label:created', { id: 'l-infra', name: 'infra', color: '#6366f1', priority: 0, projectId: 'p1' }))
    expect(client.getQueryData(queryKeys.projects.labels('p1'))).toHaveLength(2)

    // Grant access, then its own event: patched once, no refetch.
    act(() => emit('project:access-changed', { projectId: 'p1', access: { id: 'a-u3', projectId: 'p1', userId: 'u3', permission: 'view', grantedAt: '', user: user('u3') } }))
    await settle()
    expect(client.getQueryData(queryKeys.projects.access('p1')).map((a) => a.userId)).toEqual(['u2', 'u3'])
    expect(calls('/api/projects/p1/access')).toBe(1)
    expect(calls('/api/labels?projectId=p1')).toBe(1)
  })
})

describe('archived tasks', () => {
  it('a partial bulk delete restores only the failed rows, in place, without a refetch', async () => {
    const client = createAppQueryClient()
    render(createElement(App, { client }, createElement(ArchivedPage)))
    await waitFor(() => expect(screen.getByText('Archived a')).toBeTruthy())

    state.failDeletes = new Set(['c'])
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }))
    await waitFor(() => expect(calls('/api/tasks/archived/a', 'DELETE')).toBe(1))
    await waitFor(() => expect(screen.getByText('Archived c')).toBeTruthy())
    expect(screen.queryByText('Archived a')).toBeNull()
    expect(screen.queryByText('Archived b')).toBeNull()
    expect(screen.queryByText('Archived d')).toBeNull()
    expect(calls('/api/tasks/archived')).toBe(1)
  })

  it('reopening shows the cached archive; an archive event in between makes it refetch once', async () => {
    const client = createAppQueryClient()
    const view = render(createElement(App, { client }, createElement(ArchivedPage)))
    await waitFor(() => expect(screen.getByText('Archived a')).toBeTruthy())
    view.rerender(createElement(App, { client }))
    view.rerender(createElement(App, { client }, createElement(ArchivedPage)))
    expect(screen.getByText('Archived a')).toBeTruthy()
    await settle()
    expect(calls('/api/tasks/archived')).toBe(1)

    view.rerender(createElement(App, { client }))
    state.archived = [...state.archived, task('e')]
    act(() => emit('task:deleted', { id: 'e' }))
    await settle()
    view.rerender(createElement(App, { client }, createElement(ArchivedPage)))
    await waitFor(() => expect(screen.getByText('Archived e')).toBeTruthy())
    expect(calls('/api/tasks/archived')).toBe(2)
  })
})

describe('Settings → Workspaces', () => {
  it('reuses the cached workspace list and asks for summaries (counts, not member lists)', async () => {
    const client = createAppQueryClient()
    client.setQueryData(queryKeys.workspaces.list(), [{ id: 'w1', name: 'One' }, { id: 'w2', name: 'Two' }])
    render(createElement(App, { client }, createElement(WorkspacesSection)))
    await waitFor(() => expect(screen.getByText('Workspace w1')).toBeTruthy())
    expect(apiFetch.mock.calls.map(([url]) => url).sort()).toEqual([
      '/api/workspaces/w1/structure?view=summary',
      '/api/workspaces/w2/structure?view=summary',
    ])
    // Member totals come from `_count` (7 + 3) and per-team counts from the team's `_count`.
    expect(screen.getByText('10')).toBeTruthy()
    expect(screen.getByText('7 members')).toBeTruthy()
  })
})
