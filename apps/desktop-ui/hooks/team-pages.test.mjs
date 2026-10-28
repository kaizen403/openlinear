/**
 * Teams page, team settings and Settings → Members on the query cache.
 * Real pages under the real QueryProvider + SSE bridge, fake API; asserts
 * request counts, optimistic writes, rollback and event echoes.
 *
 * Before the migration each page fetched on mount, refetched after its own
 * write, and refetched again on the write's own `team:*` event (the Teams page
 * on every team event in the system).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, cleanup, fireEvent, within } from '@testing-library/react'
import { createElement } from 'react'

const state = vi.hoisted(() => ({
  listeners: new Set(),
  params: new URLSearchParams(),
  teams: [],
  gates: [],
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/teams',
  useSearchParams: () => state.params,
}))
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'alice', avatarUrl: null }, isAuthenticated: true, isLoading: false, logout: vi.fn() }),
}))
vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({ activeWorkspace: { id: 'w1', name: 'One', role: 'owner' }, workspaces: [], setActiveWorkspace: vi.fn(), isLoading: false, refreshWorkspaces: vi.fn() }),
}))
vi.mock('@/providers/teams-provider', () => ({
  useTeams: () => ({ teams: state.teams.map(({ id, name, color, projectId }) => ({ id, name, color, projectId })), isLoading: false, reload: vi.fn() }),
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

const api = vi.hoisted(() => ({
  fetchTeams: vi.fn(),
  fetchTeam: vi.fn(),
  updateTeam: vi.fn(),
  deleteTeam: vi.fn(),
  createTeam: vi.fn(),
  joinTeam: vi.fn(),
  updateTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  fetchProjects: vi.fn(),
}))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal()), ...api }))
const workspacesApi = vi.hoisted(() => ({
  fetchWorkspaceMembers: vi.fn(),
  updateWorkspaceMember: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  inviteWorkspaceMember: vi.fn(),
}))
vi.mock('@/lib/api/workspaces', async (importOriginal) => ({ ...(await importOriginal()), ...workspacesApi }))

const { QueryProvider, QuerySseBridge } = await import('@/providers/query-provider')
const { createAppQueryClient } = await import('@/lib/query/client')
const { default: TeamsPage } = await import('@/app/(app)/teams/page')
const { default: TeamDetailPage } = await import('@/app/(app)/teams/manage/page')
const { default: MembersPage } = await import('@/app/(app)/settings/members/page')
const { useTeamMembers } = await import('@/hooks/use-team-members')

const member = (userId, role, teamId = 't1') => ({
  id: `m-${teamId}-${userId}`,
  teamId,
  userId,
  role,
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  user: { id: userId, username: userId === 'u1' ? 'alice' : `user-${userId}`, email: null, avatarUrl: null },
})

const team = (id, overrides = {}) => ({
  id,
  name: `Team ${id}`,
  key: id.toUpperCase(),
  description: null,
  color: '#22c55e',
  icon: null,
  private: false,
  inviteCode: `${id.toUpperCase()}-CODE`,
  nextIssueNumber: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  projectId: 'p1',
  project: { id: 'p1', name: 'P1', status: 'in_progress', color: '#000', icon: null },
  members: [member('u1', 'owner', id), member('u2', 'member', id)],
  _count: { members: 2 },
  ...overrides,
})

/** A promise the test settles by hand (to observe optimistic state). */
function gate() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  state.gates.push({ resolve, reject })
  return { promise, resolve, reject }
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

beforeEach(() => {
  cleanup()
  for (const fn of [...Object.values(api), ...Object.values(workspacesApi)]) fn.mockReset()
  state.listeners.clear()
  state.gates = []
  state.teams = [team('t1'), team('t2')]
  state.params = new URLSearchParams()
  api.fetchTeams.mockImplementation(async () => state.teams)
  api.fetchTeam.mockImplementation(async (id) => state.teams.find((t) => t.id === id))
  api.fetchProjects.mockImplementation(async () => [{ id: 'p1', name: 'P1' }])
  workspacesApi.fetchWorkspaceMembers.mockImplementation(async () => [
    { id: 'wm1', workspaceId: 'w1', userId: 'u1', role: 'owner', invitedAt: '', joinedAt: null, user: { id: 'u1', username: 'alice', email: null, avatarUrl: null } },
    { id: 'wm2', workspaceId: 'w1', userId: 'u2', role: 'member', invitedAt: '', joinedAt: null, user: { id: 'u2', username: 'bob', email: null, avatarUrl: null } },
  ])
})

function renderTeamsAndSettings(client) {
  state.params = new URLSearchParams('id=t1')
  return render(createElement(App, { client },
    createElement('section', { 'data-testid': 'teams' }, createElement(TeamsPage)),
    createElement('section', { 'data-testid': 'settings' }, createElement(TeamDetailPage))))
}

const teamsView = () => within(screen.getByTestId('teams'))
const settingsView = () => within(screen.getByTestId('settings'))

describe('team pages on the query cache', () => {
  it('a team edit is optimistic in every view, then costs no refetch (nor does its own event)', async () => {
    const client = createAppQueryClient()
    renderTeamsAndSettings(client)
    await waitFor(() => expect(teamsView().getAllByText('Team t1').length).toBeGreaterThan(0))
    await waitFor(() => expect(settingsView().getByDisplayValue('Team t1')).toBeTruthy())
    expect(api.fetchTeams).toHaveBeenCalledTimes(1)
    expect(api.fetchTeam).toHaveBeenCalledTimes(1)

    const saved = gate()
    api.updateTeam.mockImplementation(() => saved.promise)
    fireEvent.change(settingsView().getByLabelText('Name'), { target: { value: 'Platform' } })
    fireEvent.click(settingsView().getByRole('button', { name: /save changes/i }))
    // Optimistic: the Teams page row and the settings title change before the server answers.
    await waitFor(() => expect(teamsView().getAllByText('Platform').length).toBeGreaterThan(0))
    expect(api.updateTeam).toHaveBeenCalledWith('t1', { name: 'Platform', description: null, color: '#22c55e' })

    const server = team('t1', { name: 'Platform', updatedAt: '2026-10-02T00:00:00.000Z' })
    state.teams = [server, state.teams[1]]
    await act(async () => { saved.resolve(server) })
    act(() => emit('team:updated', server))
    await settle()
    expect(teamsView().getAllByText('Platform').length).toBeGreaterThan(0)
    expect(api.fetchTeams).toHaveBeenCalledTimes(1)
    expect(api.fetchTeam).toHaveBeenCalledTimes(1)
  })

  it('a failed edit rolls back every view and keeps what the user typed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = createAppQueryClient()
    renderTeamsAndSettings(client)
    await waitFor(() => expect(settingsView().getByDisplayValue('Team t1')).toBeTruthy())

    const saved = gate()
    api.updateTeam.mockImplementation(() => saved.promise)
    fireEvent.change(settingsView().getByLabelText('Name'), { target: { value: 'Platform' } })
    fireEvent.click(settingsView().getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(teamsView().getAllByText('Platform').length).toBeGreaterThan(0))

    await act(async () => { saved.reject(new Error('nope')) })
    await waitFor(() => expect(teamsView().queryAllByText('Platform')).toHaveLength(0))
    expect(teamsView().getAllByText('Team t1').length).toBeGreaterThan(0)
    expect(settingsView().getByDisplayValue('Platform')).toBeTruthy()
  })

  it('deleting a team removes its row at once and puts it back in place if the delete fails', async () => {
    const client = createAppQueryClient()
    render(createElement(App, { client }, createElement(TeamsPage)))
    await waitFor(() => expect(screen.getAllByText('Team t2').length).toBeGreaterThan(0))

    const removed = gate()
    api.deleteTeam.mockImplementation(() => removed.promise)
    fireEvent.click(screen.getAllByTitle('Delete team')[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryAllByText('Team t1')).toHaveLength(0))

    await act(async () => { removed.reject(new Error('nope')) })
    await waitFor(() => expect(screen.getAllByText('Team t1').length).toBeGreaterThan(0))
    const names = screen.getAllByText(/^Team t\d$/).map((node) => node.textContent)
    expect(names.indexOf('Team t1')).toBeLessThan(names.indexOf('Team t2'))
    expect(api.fetchTeams).toHaveBeenCalledTimes(1)
  })

  it('member events patch the full team; a removal refetches only teams still listing the user', async () => {
    const client = createAppQueryClient()
    state.params = new URLSearchParams('id=t1')
    render(createElement(App, { client }, createElement(TeamDetailPage)))
    await waitFor(() => expect(screen.getByText('user-u2')).toBeTruthy())

    act(() => emit('team:member-updated', member('u2', 'admin')))
    await settle()
    expect(client.getQueryData(['ol', 'team', 't1', 'detail']).members.find((m) => m.userId === 'u2').role).toBe('admin')
    expect(api.fetchTeam).toHaveBeenCalledTimes(1)

    // Own removal: the cache already dropped the user, so the echo costs nothing.
    api.removeTeamMember.mockResolvedValue(undefined)
    fireEvent.click(screen.getByTitle('Remove member'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByText('user-u2')).toBeNull())
    act(() => emit('team:member-removed', { userId: 'u2' }))
    await settle()
    expect(api.fetchTeam).toHaveBeenCalledTimes(1)

    // Someone else removes a user this team still lists: refetch it (once).
    act(() => emit('team:member-removed', { userId: 'u1' }))
    await waitFor(() => expect(api.fetchTeam).toHaveBeenCalledTimes(2))
  })

  it('Settings → Members shares the workspace member list with the assignee options (one request)', async () => {
    const client = createAppQueryClient()
    const seen = []
    function AssigneeOptions() {
      const { members } = useTeamMembers()
      seen.push(members.length)
      return null
    }
    render(createElement(App, { client }, createElement(MembersPage), createElement(AssigneeOptions)))
    await waitFor(() => expect(screen.getByText('bob')).toBeTruthy())
    await waitFor(() => expect(seen.at(-1)).toBe(2))
    expect(workspacesApi.fetchWorkspaceMembers).toHaveBeenCalledTimes(1)

    expect(workspacesApi.fetchWorkspaceMembers).toHaveBeenCalledTimes(1)
  })
})
