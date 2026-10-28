import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueryObserver } from '@tanstack/react-query'
import { createAppQueryClient } from './client.ts'
import { queryKeys } from './keys.ts'
import { applySseEventToCache, createBridgeState } from './sse-bridge.ts'
import { restoreArchivedTasks, removeArchivedTasks } from './archived.ts'

let client
let state

function emit(type, data) {
  applySseEventToCache(client, type, data, { stream: 'cloud', id: null }, state)
}

function observe(queryKey, queryFn = async () => []) {
  const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: Infinity })
  return observer.subscribe(() => {})
}

const invalidated = (key) => client.getQueryState(key)?.isInvalidated === true

beforeEach(() => {
  client = createAppQueryClient()
  state = createBridgeState(client, { windowMs: 5 })
})

describe('page caches (SSE rules)', () => {
  it('project:access-changed patches the cached rules for all three payload shapes, no refetch', async () => {
    const key = queryKeys.projects.access('p1')
    client.setQueryData(key, [{ id: 'a1', projectId: 'p1', userId: 'u1', permission: 'full', grantedAt: '', user: { id: 'u1', username: 'a', email: null, avatarUrl: null } }])
    emit('project:access-changed', { projectId: 'p1', access: { id: 'a2', projectId: 'p1', userId: 'u2', permission: 'view', grantedAt: '', user: { id: 'u2', username: 'b', email: null, avatarUrl: null } } })
    emit('project:access-changed', { projectId: 'p1', access: [{ id: 'a1', projectId: 'p1', userId: 'u1', permission: 'view', grantedAt: '' }], skipped: [] })
    emit('project:access-changed', { projectId: 'p1', userId: 'u2', permission: 'deny' })
    expect(client.getQueryData(key).map((a) => [a.userId, a.permission])).toEqual([['u1', 'view'], ['u2', 'deny']])
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(invalidated(key)).toBe(false)
    // A revoke for a user without a rule can't be patched: refetch.
    emit('project:access-changed', { projectId: 'p1', userId: 'u9', permission: 'deny' })
    await vi.waitFor(() => expect(invalidated(key)).toBe(true))
  })

  it('project:updated patches the settings row and the picker; project:deleted drops unobserved entries', () => {
    client.setQueryData(queryKeys.projects.detail('p1'), { id: 'p1', name: 'Old', description: 'd' })
    client.setQueryData(queryKeys.projects.directory(), [{ id: 'p1', name: 'Old' }, { id: 'p2', name: 'Two' }])
    emit('project:updated', { id: 'p1', name: 'New' })
    expect(client.getQueryData(queryKeys.projects.detail('p1'))).toEqual({ id: 'p1', name: 'New', description: 'd' })
    expect(client.getQueryData(queryKeys.projects.directory())[0].name).toBe('New')

    client.setQueryData(queryKeys.projects.access('p1'), [])
    emit('project:deleted', { id: 'p1' })
    expect(client.getQueryData(queryKeys.projects.directory()).map((p) => p.id)).toEqual(['p2'])
    expect(client.getQueryData(queryKeys.projects.detail('p1'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.projects.access('p1'))).toBeUndefined()
  })

  it('archiving (task:deleted / tasks:bulk-deleted) marks the archive stale; nothing else does', async () => {
    const key = queryKeys.archivedTasks()
    client.setQueryData(key, [{ id: 'old' }])
    emit('task:updated', { id: 'x', title: 'y' })
    emit('team:updated', { id: 't1', name: 'T', key: 'T' })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(invalidated(key)).toBe(false)
    emit('tasks:bulk-deleted', { taskIds: ['a', 'b'] })
    await vi.waitFor(() => expect(invalidated(key)).toBe(true))
  })

  it('a mounted archive refetches once for a burst of 100 archive events', async () => {
    const key = queryKeys.archivedTasks()
    const queryFn = vi.fn(async () => [])
    client.setQueryData(key, [])
    const off = observe(key, queryFn)
    for (let i = 0; i < 100; i += 1) emit('task:deleted', { id: `t${i}` })
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(queryFn).toHaveBeenCalledTimes(1)
    off()
  })

  it('workspace summaries go stale on project, team and member events of their workspace', async () => {
    const w1 = queryKeys.workspaces.structureSummary('w1')
    const w2 = queryKeys.workspaces.structureSummary('w2')
    client.setQueryData(w1, { id: 'w1', projects: [] })
    client.setQueryData(w2, { id: 'w2', projects: [] })
    emit('workspace:member-added', { workspaceId: 'w1', userId: 'u3' })
    await vi.waitFor(() => expect(invalidated(w1)).toBe(true))
    expect(invalidated(w2)).toBe(false)
    emit('team:created', { id: 't9', name: 'T9', key: 'T9', projectId: 'p1' })
    await vi.waitFor(() => expect(invalidated(w2)).toBe(true))
  })

  it('team rows: created/updated upsert into matching directories, deleted removes, the detail is patched not refetched', async () => {
    const all = queryKeys.teams.directory(null)
    const p2 = queryKeys.teams.directory('p2')
    const detail = queryKeys.teams.detail('t1')
    client.setQueryData(all, [{ id: 't1', name: 'One', key: 'ONE', projectId: 'p1' }])
    client.setQueryData(p2, [])
    client.setQueryData(detail, { id: 't1', name: 'One', key: 'ONE', projectId: 'p1', members: [] })
    emit('team:created', { id: 't2', name: 'Two', key: 'TWO', projectId: 'p1' })
    emit('team:updated', { id: 't1', name: 'Uno', key: 'ONE', projectId: 'p1' })
    expect(client.getQueryData(all).map((t) => t.name)).toEqual(['Uno', 'Two'])
    expect(client.getQueryData(p2)).toEqual([])
    expect(client.getQueryData(detail).name).toBe('Uno')
    emit('team:deleted', { id: 't2' })
    expect(client.getQueryData(all).map((t) => t.id)).toEqual(['t1'])
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(invalidated(detail)).toBe(false)
    expect(invalidated(all)).toBe(false)
  })

  it('workspace member events patch member lists; a removal refetches only lists still showing the user', async () => {
    const key = queryKeys.workspaces.members('w1')
    const row = (userId, role) => ({ id: `wm-${userId}`, workspaceId: 'w1', userId, role, invitedAt: '', joinedAt: null, user: { id: userId, username: userId, email: null, avatarUrl: null } })
    client.setQueryData(key, [row('u1', 'owner'), row('u2', 'member')])
    emit('workspace:member-updated', row('u2', 'admin'))
    emit('workspace:member-added', row('u3', 'viewer'))
    expect(client.getQueryData(key).map((m) => `${m.userId}:${m.role}`)).toEqual(['u1:owner', 'u2:admin', 'u3:viewer'])
    emit('workspace:member-removed', { userId: 'u9' })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(invalidated(key)).toBe(false)
    emit('workspace:member-removed', { userId: 'u3' })
    await vi.waitFor(() => expect(invalidated(key)).toBe(true))
  })

  it('archive rollback restores only the failed tasks, in place, keeping newer changes', () => {
    const key = queryKeys.archivedTasks()
    client.setQueryData(key, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])
    const before = removeArchivedTasks(client, new Set(['b', 'c']))
    client.setQueryData(key, [...client.getQueryData(key), { id: 'e' }])
    restoreArchivedTasks(client, before, new Set(['c']))
    expect(client.getQueryData(key).map((t) => t.id)).toEqual(['a', 'c', 'd', 'e'])
  })
})
