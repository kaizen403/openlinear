import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClientProvider, QueryObserver, matchQuery } from '@tanstack/react-query'
import { ApiError, AuthExpiredError, NetworkError } from '@/lib/api/fetch'
import { createAppQueryClient, isRetryableQueryError, queryRetryDelay, shouldRetryQuery } from './client.ts'
import { boardTaskScope, queryKeys, taskListScopeFromKey } from './keys.ts'
import { hasSseBridge, registerSseBridge, useAppQueryClient } from './use-app-query-client.ts'

describe('query retry policy (follows lib/api/errors.ts)', () => {
  it('never retries 4xx except 408 and 429', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableQueryError(new ApiError(status, 'no'))).toBe(false)
    }
    expect(isRetryableQueryError(new ApiError(408, 'timeout'))).toBe(true)
    expect(isRetryableQueryError(new ApiError(429, 'slow down', 'RATE_LIMITED'))).toBe(true)
  })

  it('retries network and 5xx failures, never auth expiry or unknown errors', () => {
    expect(isRetryableQueryError(new NetworkError())).toBe(true)
    expect(isRetryableQueryError(new ApiError(503, 'down'))).toBe(true)
    expect(isRetryableQueryError(new AuthExpiredError())).toBe(false)
    expect(isRetryableQueryError(new Error('bug'))).toBe(false)
    expect(isRetryableQueryError(new TypeError('bad json'))).toBe(false)
  })

  it('caps retries at two', () => {
    const err = new NetworkError()
    expect(shouldRetryQuery(0, err)).toBe(true)
    expect(shouldRetryQuery(1, err)).toBe(true)
    expect(shouldRetryQuery(2, err)).toBe(false)
  })

  it('waits as long as the server asks, else backs off exponentially', () => {
    expect(queryRetryDelay(0, new ApiError(429, 'slow down', 'RATE_LIMITED', { retryAfterSeconds: 7 }))).toBe(7000)
    expect(queryRetryDelay(0, new ApiError(429, 'slow down', 'RATE_LIMITED', { retryAfterSeconds: 600 }))).toBe(30_000)
    expect(queryRetryDelay(0, new NetworkError())).toBe(1000)
    expect(queryRetryDelay(2, new ApiError(503, 'down'))).toBe(4000)
    expect(queryRetryDelay(9, new ApiError(503, 'down'))).toBe(8000)
  })

  it('a failing read is retried per the policy, a 404 is not', async () => {
    const client = createAppQueryClient()
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } })
    const notFound = vi.fn(async () => { throw new ApiError(404, 'gone', 'NOT_FOUND') })
    await expect(client.query({ queryKey: ['t', 404], queryFn: notFound })).rejects.toThrow('gone')
    expect(notFound).toHaveBeenCalledTimes(1)
    const flaky = vi.fn(async () => { throw new ApiError(502, 'bad gateway') })
    await expect(client.query({ queryKey: ['t', 502], queryFn: flaky })).rejects.toThrow('bad gateway')
    expect(flaky).toHaveBeenCalledTimes(3)
  })

  it('does not refetch on window focus or reconnect, and never retries mutations', () => {
    const defaults = createAppQueryClient().getDefaultOptions()
    expect(defaults.queries.refetchOnWindowFocus).toBe(false)
    expect(defaults.queries.refetchOnReconnect).toBe(false)
    expect(defaults.mutations.retry).toBe(false)
  })
})

describe('cache notifications', () => {
  it('are delivered synchronously, like the useState they replace', () => {
    const client = createAppQueryClient()
    client.setQueryData(['n'], 1)
    const observer = new QueryObserver(client, { queryKey: ['n'], queryFn: async () => 1, staleTime: Infinity })
    let notified = 0
    const stop = observer.subscribe(() => { notified += 1 })
    client.setQueryData(['n'], 2)
    expect(notified).toBe(1)
    expect(observer.getCurrentResult().data).toBe(2)
    stop()
  })
})

describe('query keys', () => {
  it('nest workspace-owned resources under the workspace', () => {
    const scope = queryKeys.workspaces.scope('w1')
    for (const key of [
      queryKeys.workspaces.members('w1'),
      queryKeys.workspaces.chatSessions('w1'),
      queryKeys.projects.list('w1', { fields: ['id'] }),
      queryKeys.teams.list('w1', { fields: ['id'] }),
    ]) {
      expect(matchQuery({ queryKey: scope }, { queryKey: key, queryHash: JSON.stringify(key) })).toBe(true)
    }
    expect(matchQuery({ queryKey: scope }, { queryKey: queryKeys.workspaces.members('w2'), queryHash: '' })).toBe(false)
  })

  it('field selections are order-insensitive parts of the key', () => {
    expect(queryKeys.projects.list('w1', { fields: ['name', 'id'] })).toEqual(queryKeys.projects.list('w1', { fields: ['id', 'name'] }))
    expect(queryKeys.projects.list('w1', { fields: ['id'] })).not.toEqual(queryKeys.projects.list('w1', { fields: ['id', 'name'] }))
  })

  it('task list keys round-trip their scope', () => {
    const scope = boardTaskScope('p1')
    expect(taskListScopeFromKey(queryKeys.tasks.list(scope))).toEqual({ kind: 'board', projectId: 'p1', teamId: null, pageSize: 200 })
    expect(taskListScopeFromKey(queryKeys.tasks.detail('t1'))).toBeNull()
  })
})

describe('useAppQueryClient', () => {
  it('uses the provider client when there is one', () => {
    const client = createAppQueryClient()
    const { result } = renderHook(() => useAppQueryClient(), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    })
    expect(result.current).toBe(client)
  })

  it('falls back to a private client per component outside the provider', () => {
    const a = renderHook(() => useAppQueryClient())
    const b = renderHook(() => useAppQueryClient())
    expect(a.result.current).not.toBe(b.result.current)
    const first = a.result.current
    a.rerender()
    expect(a.result.current).toBe(first)
  })

  it('tracks whether an SSE bridge feeds a client', () => {
    const client = createAppQueryClient()
    expect(hasSseBridge(client)).toBe(false)
    const off = registerSseBridge(client)
    expect(hasSseBridge(client)).toBe(true)
    off()
    expect(hasSseBridge(client)).toBe(false)
  })
})
