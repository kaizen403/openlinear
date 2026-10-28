import { describe, it, expect, vi } from 'vitest'

const { SseParser, EventStreamConnection, RecentEventIds, defaultBackoffMs, SSE_MAX_BACKOFF_MS } = await import('./event-stream.ts')

const encoder = new TextEncoder()

/** A text/event-stream Response whose body the test writes to. */
function controllableStream() {
  let controller
  const body = new ReadableStream({
    start(c) {
      controller = c
    },
  })
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  }
}

function streamOf(text) {
  const stream = controllableStream()
  stream.write(text)
  stream.close()
  return stream.response
}

describe('SseParser', () => {
  it('parses named events with ids and multi-line data', () => {
    const parser = new SseParser()
    const events = parser.push('id: 7\nevent: task:updated\ndata: {"a":1,\ndata: "b":2}\n\n')
    expect(events).toEqual([{ type: 'task:updated', data: '{"a":1,\n"b":2}', id: '7', lastEventId: '7' }])
  })

  it('defaults the type to message and ignores comments and empty events', () => {
    const parser = new SseParser()
    expect(parser.push(': heartbeat\n\nevent: x\n\ndata: hi\n\n')).toEqual([
      { type: 'message', data: 'hi', id: null, lastEventId: null },
    ])
  })

  it('keeps the last-event-id buffer but reports per-event ids', () => {
    const parser = new SseParser()
    const events = parser.push('id: 1\nevent: a\ndata: {}\n\nevent: b\ndata: {}\n\n')
    expect(events.map((e) => [e.type, e.id, e.lastEventId])).toEqual([
      ['a', '1', '1'],
      ['b', null, '1'],
    ])
  })

  it('handles CRLF, CR and chunks split anywhere, including between CR and LF', () => {
    const parser = new SseParser()
    const text = 'id: 9\r\nevent: a\rdata: x\r\n\r\n'
    const events = []
    for (const ch of text) events.push(...parser.push(ch))
    expect(events).toEqual([{ type: 'a', data: 'x', id: '9', lastEventId: '9' }])
  })

  it('reads retry and ignores ids containing NUL', () => {
    const parser = new SseParser()
    const events = parser.push('retry: 2500\nid: a\u0000b\ndata: x\n\n')
    expect(parser.retryMs).toBe(2500)
    expect(events[0].id).toBeNull()
  })
})

describe('EventStreamConnection', () => {
  it('opens the prepared request and delivers events tagged with the stream', async () => {
    const stream = controllableStream()
    const fetchImpl = vi.fn(async () => stream.response)
    const onMessage = vi.fn()
    const connection = new EventStreamConnection({
      name: 'local',
      prepare: async () => ({ url: 'http://127.0.0.1:4199/api/events', headers: { Authorization: 'Bearer t' } }),
      onMessage,
      fetchImpl,
      backoffMs: () => 0,
    })
    connection.start()
    await vi.waitFor(() => expect(connection.state).toBe('open'))
    stream.write('id: run:1\nevent: execution:progress\ndata: {"seq":1}\n\n')
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1))
    expect(onMessage.mock.calls[0][0]).toMatchObject({ stream: 'local', type: 'execution:progress', id: 'run:1' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:4199/api/events')
    expect(init.headers).toMatchObject({ Accept: 'text/event-stream', Authorization: 'Bearer t' })
    expect(connection.cursor).toBe('run:1')
    connection.stop()
    expect(connection.state).toBe('closed')
  })

  it('reconnects from its own cursor, counting only resumable ids', async () => {
    const prepare = vi.fn(async (cursor) => ({ url: `https://cloud.test/api/events?c=${cursor ?? ''}` }))
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(streamOf('id: 41\nevent: task:created\ndata: {}\n\nid: run:3\nevent: execution:progress\ndata: {}\n\n'))
      .mockImplementation(async () => controllableStream().response)
    const connection = new EventStreamConnection({
      name: 'cloud',
      prepare,
      isCursor: (id) => /^\d+$/.test(id),
      onMessage: () => {},
      fetchImpl,
      backoffMs: () => 0,
    })
    connection.start()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    expect(prepare.mock.calls.map(([cursor]) => cursor)).toEqual([null, '41'])
    connection.stop()
  })

  it('asks for a token refresh on 401 and tries again', async () => {
    const onUnauthorized = vi.fn(async () => true)
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockImplementation(async () => controllableStream().response)
    const connection = new EventStreamConnection({
      name: 'local',
      prepare: async () => ({ url: 'http://127.0.0.1:4199/api/events' }),
      onUnauthorized,
      onMessage: () => {},
      fetchImpl,
      backoffMs: () => 0,
    })
    connection.start()
    await vi.waitFor(() => expect(connection.state).toBe('open'))
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    connection.stop()
  })

  it('retries when the request cannot be prepared, and stops cleanly', async () => {
    const prepare = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ url: 'https://cloud.test/api/events' })
    const fetchImpl = vi.fn(async () => controllableStream().response)
    const connection = new EventStreamConnection({ name: 'cloud', prepare, onMessage: () => {}, fetchImpl, backoffMs: () => 0 })
    connection.start()
    await vi.waitFor(() => expect(connection.state).toBe('open'))
    expect(prepare).toHaveBeenCalledTimes(2)
    connection.stop()
    const calls = fetchImpl.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchImpl.mock.calls.length).toBe(calls)
  })

  it('backs off exponentially with jitter up to 30 s', () => {
    expect(defaultBackoffMs(1, () => 0)).toBe(1000)
    expect(defaultBackoffMs(3, () => 0)).toBe(4000)
    expect(defaultBackoffMs(20, () => 0.999)).toBe(SSE_MAX_BACKOFF_MS)
  })
})

describe('RecentEventIds', () => {
  it('deduplicates by (stream, id)', () => {
    const ids = new RecentEventIds()
    expect(ids.firstSighting('cloud', '7')).toBe(true)
    expect(ids.firstSighting('cloud', '7')).toBe(false)
    expect(ids.firstSighting('local', '7')).toBe(true)
  })

  it('is bounded', () => {
    const ids = new RecentEventIds(2)
    ids.firstSighting('cloud', 'a')
    ids.firstSighting('cloud', 'b')
    ids.firstSighting('cloud', 'c')
    expect(ids.firstSighting('cloud', 'a')).toBe(true)
    expect(ids.firstSighting('cloud', 'c')).toBe(false)
  })
})
