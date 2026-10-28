import express from 'express';
import type http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCloudApiConfig } from '../config/cloud-api';
import { clearPrincipalCache } from '../auth/principal';
import { createLocalEventsRouter, deliverLocalEvent, parseLocalEventId, resetLocalEvents } from './local';

const users: Record<string, string> = { 'token-alice': 'alice', 'token-bob': 'bob' };
const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const token = (new Headers(init?.headers).get('Authorization') ?? '').replace(/^Bearer /, '');
  const userId = users[token];
  if (!userId) return new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Invalid token' }), { status: 401 });
  return new Response(JSON.stringify({ userId, username: userId, authSource: 'session', scopes: [], workspaceId: null }), { status: 200 });
});

let server: http.Server;
let base = '';

interface Frame { id?: string; event?: string; data?: unknown }

function parseFrames(text: string): Frame[] {
  return text.split('\n\n').filter((block) => block.includes('event:')).map((block) => {
    const frame: Frame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) frame.id = line.slice(4);
      else if (line.startsWith('event: ')) frame.event = line.slice(7);
      else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
    }
    return frame;
  });
}

/** Open a stream, run `during` once connected, collect frames until `until` holds. */
async function stream(
  path: string,
  headers: Record<string, string>,
  until: (frames: Frame[]) => boolean,
  during: () => void = () => undefined,
): Promise<{ status: number; frames: Frame[]; body?: unknown }> {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, { headers, signal: controller.signal });
  if (res.status !== 200) return { status: res.status, frames: [], body: await res.json() };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let ran = false;
  const deadline = Date.now() + 3_000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const frames = parseFrames(text);
      if (!ran && frames.some((frame) => frame.event === 'connected')) {
        ran = true;
        during();
      }
      if (until(frames)) return { status: 200, frames };
    }
    return { status: 200, frames: parseFrames(text) };
  } finally {
    controller.abort();
  }
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/events', createLocalEventsRouter());
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  resetLocalEvents();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  setCloudApiConfig(null);
});

beforeEach(() => {
  resetLocalEvents();
  clearPrincipalCache();
  setCloudApiConfig({ baseUrl: 'http://127.0.0.1:4598', fetch: fetchMock as unknown as typeof fetch });
});

describe('sidecar local event stream (W03a)', () => {
  it('refuses unauthenticated and invalid streams', async () => {
    const none = await fetch(`${base}/api/events`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: 'SSE_TOKEN_REQUIRED' });
    const invalid = await fetch(`${base}/api/events`, { headers: { Authorization: 'Bearer nope' } });
    expect(invalid.status).toBe(401);
  });

  it('authenticates from the Authorization header and delivers only the owner\'s task events, each with an id', async () => {
    const result = await stream('/api/events', { Authorization: 'Bearer token-alice' },
      (frames) => frames.some((frame) => frame.event === 'opencode:status'),
      () => {
        deliverLocalEvent('execution:progress', { taskId: 'bob-task', status: 'executing' }, { userId: 'bob' });
        deliverLocalEvent('execution:progress', { taskId: 'alice-task', status: 'executing' }, { userId: 'alice' });
        deliverLocalEvent('opencode:status', { status: 'ready' }, 'all');
      });
    expect(result.status).toBe(200);
    const events = result.frames.map((frame) => frame.event);
    expect(events).toEqual(['connected', 'execution:progress', 'opencode:status']);
    expect(result.frames[1]?.data).toMatchObject({ taskId: 'alice-task' });
    for (const frame of result.frames) expect(parseLocalEventId(frame.id ?? '')).not.toBeNull();
  });

  it('mints single-use tickets for EventSource clients', async () => {
    const minted = await fetch(`${base}/api/events/ticket`, { method: 'POST', headers: { Authorization: 'Bearer token-bob' } });
    expect(minted.status).toBe(200);
    const { ticket, expiresIn } = await minted.json() as { ticket: string; expiresIn: number };
    expect(expiresIn).toBe(60);
    const first = await stream(`/api/events?ticket=${encodeURIComponent(ticket)}`, {}, (frames) => frames.length > 0);
    expect(first.frames[0]?.event).toBe('connected');
    const reused = await fetch(`${base}/api/events?ticket=${encodeURIComponent(ticket)}`);
    expect(reused.status).toBe(401);
    expect(await reused.json()).toMatchObject({ code: 'INVALID_TICKET' });
    expect((await fetch(`${base}/api/events/ticket`, { method: 'POST' })).status).toBe(401);
  });

  it('replays missed events after Last-Event-ID, filtered by the reconnecting principal', async () => {
    const first = await stream('/api/events', { Authorization: 'Bearer token-alice' }, (frames) => frames.length > 0);
    const cursor = first.frames[0]?.id ?? '';
    deliverLocalEvent('execution:log', { taskId: 'alice-task', entry: { message: 'missed 1' } }, { userId: 'alice' });
    deliverLocalEvent('execution:log', { taskId: 'bob-task', entry: { message: 'not yours' } }, { userId: 'bob' });
    deliverLocalEvent('execution:log', { taskId: 'alice-task', entry: { message: 'missed 2' } }, { userId: 'alice' });
    const resumed = await stream('/api/events', { Authorization: 'Bearer token-alice', 'Last-Event-ID': cursor },
      (frames) => frames.filter((frame) => frame.event === 'execution:log').length >= 2);
    const replayed = resumed.frames.filter((frame) => frame.event === 'execution:log');
    expect(replayed.map((frame) => (frame.data as { entry: { message: string } }).entry.message)).toEqual(['missed 1', 'missed 2']);
    expect(resumed.frames.some((frame) => JSON.stringify(frame.data).includes('not yours'))).toBe(false);
  });

  it('signals a replay gap for a cursor from another sidecar boot', async () => {
    const resumed = await stream('/api/events', { Authorization: 'Bearer token-alice', 'Last-Event-ID': '00000000:5' },
      (frames) => frames.some((frame) => frame.event === 'replay-gap'));
    const gap = resumed.frames.find((frame) => frame.event === 'replay-gap');
    expect(gap?.data).toMatchObject({ reason: expect.stringMatching(/sidecar_restarted|invalid_cursor/) });
  });

  it('fails closed when the control plane cannot validate the stream principal', async () => {
    setCloudApiConfig({ baseUrl: 'http://127.0.0.1:4598', fetch: (async () => { throw new TypeError('ECONNREFUSED'); }) as unknown as typeof fetch });
    const res = await fetch(`${base}/api/events`, { headers: { Authorization: 'Bearer token-alice' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'CLOUD_API_UNREACHABLE' });
  });
});
