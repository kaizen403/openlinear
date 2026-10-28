import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { createElement } from 'react'

const CLOUD = 'https://cloud.example.test'
const SIDECAR = 'http://127.0.0.1:4150'
let desktop = true

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ isAuthenticated: true }) }))
vi.mock('@/lib/api/runtime', () => ({ isDesktopRuntime: () => desktop }))
vi.mock('@/lib/api/client', () => ({
  getAuthToken: () => 'access-1',
  getCloudApiUrl: () => CLOUD,
  resolveApiBaseUrl: async (target) => (target === 'sidecar' ? SIDECAR : CLOUD),
}))
let ticketCounter = 0
const apiFetch = vi.fn(async () => ({ ticket: `ticket-${++ticketCounter}` }))
const refreshAccessToken = vi.fn(async () => true)
vi.mock('@/lib/api/fetch', () => ({
  apiFetch: (...args) => apiFetch(...args),
  refreshAccessToken: (...args) => refreshAccessToken(...args),
}))

const { SSEProvider, useSSESubscription, decodeStreamMessage, isCloudCursor } = await import('./sse-provider.tsx')

const encoder = new TextEncoder()

function finished(text) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** An open stream that never sends anything (ends the scripted sequence). */
function idle() {
  return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function event(type, data, id) {
  return `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Scripted responses per stream; each connection attempt consumes one. */
function scriptStreams({ cloud = [], local = [] }) {
  const queues = { cloud: [...cloud], local: [...local] }
  const requests = { cloud: [], local: [] }
  const fetchMock = vi.fn(async (url, init) => {
    const stream = String(url).startsWith(SIDECAR) ? 'local' : 'cloud'
    requests[stream].push({ url: String(url), headers: init?.headers ?? {} })
    const next = queues[stream].shift()
    return next ? next() : idle()
  })
  vi.stubGlobal('fetch', fetchMock)
  return requests
}

function renderProvider() {
  const received = []
  function Probe() {
    useSSESubscription((type, data, meta) => {
      received.push({ type, data, meta })
    })
    return null
  }
  render(createElement(SSEProvider, { backoffMs: () => 0 }, createElement(Probe)))
  return received
}

beforeEach(() => {
  desktop = true
  ticketCounter = 0
  apiFetch.mockClear()
  refreshAccessToken.mockClear()
  delete process.env.NEXT_PUBLIC_SIDECAR_URL
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete process.env.NEXT_PUBLIC_SIDECAR_URL
})

describe('SSEProvider streams', () => {
  it('desktop subscribes to cloud domain events and local execution events', async () => {
    const requests = scriptStreams({})
    renderProvider()
    await vi.waitFor(() => {
      expect(requests.cloud).toHaveLength(1)
      expect(requests.local).toHaveLength(1)
    })
    const cloudUrl = new URL(requests.cloud[0].url)
    expect(`${cloudUrl.origin}${cloudUrl.pathname}`).toBe(`${CLOUD}/api/events`)
    expect(cloudUrl.searchParams.get('ticket')).toBe('ticket-1')
    expect(requests.cloud[0].headers.Authorization).toBeUndefined()
    expect(apiFetch).toHaveBeenCalledWith('/api/events/ticket', { method: 'POST' })
    expect(requests.local[0].url).toBe(`${SIDECAR}/api/events`)
    expect(requests.local[0].headers.Authorization).toBe('Bearer access-1')
  })

  it('web opens only the cloud stream unless a dev sidecar is configured', async () => {
    desktop = false
    const requests = scriptStreams({})
    renderProvider()
    await vi.waitFor(() => expect(requests.cloud).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests.local).toHaveLength(0)
    cleanup()

    process.env.NEXT_PUBLIC_SIDECAR_URL = SIDECAR
    const withSidecar = scriptStreams({})
    renderProvider()
    await vi.waitFor(() => expect(withSidecar.local).toHaveLength(1))
  })

  it('resumes each stream from its own cursor and delivers replayed events once', async () => {
    const requests = scriptStreams({
      cloud: [
        () => finished(event('connected', { type: 'connected', clientId: 'c1' }) + event('task:created', { id: 't5' }, '5')),
        () => finished(event('task:created', { id: 't5' }, '5') + event('task:updated', { id: 't6' }, '6')),
      ],
      local: [
        () => finished(event('execution:progress', { runId: 'run1', seq: 1 }, 'run1:1')),
        () => finished(event('execution:progress', { runId: 'run1', seq: 1 }, 'run1:1') + event('execution:progress', { runId: 'run1', seq: 2 }, 'run1:2')),
      ],
    })
    const received = renderProvider()

    await vi.waitFor(() => {
      expect(requests.cloud.length).toBeGreaterThanOrEqual(3)
      expect(requests.local.length).toBeGreaterThanOrEqual(3)
    })

    // Cloud: resume from the numeric outbox id with a fresh ticket each time.
    const secondCloud = new URL(requests.cloud[1].url)
    expect(secondCloud.searchParams.get('lastEventId')).toBe('5')
    expect(secondCloud.searchParams.get('ticket')).toBe('ticket-2')
    expect(new URL(requests.cloud[2].url).searchParams.get('lastEventId')).toBe('6')
    // Local: resume from the execution event id, independently of the cloud cursor.
    expect(requests.local[0].headers['Last-Event-ID']).toBeUndefined()
    expect(requests.local[1].headers['Last-Event-ID']).toBe('run1:1')
    expect(requests.local[2].headers['Last-Event-ID']).toBe('run1:2')

    const ids = received.filter((e) => e.type !== 'connected').map((e) => `${e.meta.stream}:${e.meta.id}`)
    expect(ids).toEqual(expect.arrayContaining(['cloud:5', 'cloud:6', 'local:run1:1', 'local:run1:2']))
    expect(ids).toHaveLength(4)
    const connected = received.filter((e) => e.type === 'connected')
    expect(connected[0]).toMatchObject({ data: { clientId: 'c1' }, meta: { stream: 'cloud', id: null } })
  })

  it('keys deduplication by stream, so equal ids on different streams both arrive', async () => {
    scriptStreams({
      cloud: [() => finished(event('task:updated', { id: 'a' }, '7'))],
      local: [() => finished(event('execution:progress', { runId: 'r' }, '7'))],
    })
    const received = renderProvider()
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received.map((e) => e.meta.stream).sort()).toEqual(['cloud', 'local'])
  })

  it('refreshes the access token when the sidecar rejects it', async () => {
    scriptStreams({ local: [() => new Response('{}', { status: 401 })] })
    renderProvider()
    await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledTimes(1))
  })

  it('stops both streams on unmount', async () => {
    const requests = scriptStreams({})
    renderProvider()
    await vi.waitFor(() => expect(requests.local).toHaveLength(1))
    await act(async () => {
      cleanup()
    })
    const before = requests.cloud.length + requests.local.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests.cloud.length + requests.local.length).toBe(before)
  })
})

describe('decodeStreamMessage', () => {
  const base = { id: null, lastEventId: null, stream: 'cloud' }

  it('forwards known event types, including comment events', () => {
    expect(decodeStreamMessage({ ...base, type: 'comment:created', data: '{"taskId":"t1"}' })).toEqual({
      type: 'comment:created',
      data: { taskId: 't1' },
    })
  })

  it('maps named and unnamed connected events', () => {
    expect(decodeStreamMessage({ ...base, type: 'connected', data: '{"clientId":"x"}' })?.type).toBe('connected')
    expect(decodeStreamMessage({ ...base, type: 'message', data: '{"type":"connected"}' })?.type).toBe('connected')
  })

  it('ignores unknown types and malformed data', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(decodeStreamMessage({ ...base, type: 'something:else', data: '{}' })).toBeNull()
    expect(decodeStreamMessage({ ...base, type: 'task:updated', data: 'not json' })).toBeNull()
    error.mockRestore()
  })

  it('only numeric ids are cloud cursors', () => {
    expect(isCloudCursor('42')).toBe(true)
    expect(isCloudCursor('run1:3')).toBe(false)
  })
})
