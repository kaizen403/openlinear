import http, { type Server, type ServerResponse } from 'node:http';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { AgentEvent } from '@openlinear/execution-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const routing = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:1',
  authorization: 'Basic attempt',
  released: [] as string[],
  /** Whether this process's manager runs the attempt server being released. */
  owned: true,
  process: null as { pid: number | null; launchedAt: number; spawnedBy: number } | null,
  /** FE-04: `<directory>:<mode>` per start/resume, in order. */
  approvalModes: [] as string[],
}));

// W09a routing stand-in: the attempt's own server for the worktree.
vi.mock('../services/opencode', () => ({
  getClientForUser: async (_userId: string, directory: string) =>
    createOpencodeClient({ baseUrl: routing.baseUrl, directory, headers: { authorization: routing.authorization } }),
  getSandboxRunMetadata: () => ({ mode: 'enforce' }),
  releaseAttemptServer: async (directory: string) => {
    routing.released.push(directory);
    return routing.owned;
  },
  getAttemptServerProcess: () => routing.process,
  getAttemptApprovalMode: () => null,
  setAttemptApprovalMode: async (directory: string, mode: string) => {
    routing.approvalModes.push(`${directory}:${mode}`);
  },
  getOpenCodeStatus: () => ({ mode: 'host', serverUrl: null, running: false, restartAttempts: 0 }),
}));

const { createOpenCodeRuntime, describeOpenCodeClient } = await import('./opencode-runtime');
import type { RuntimeEndpoint } from './types';

/**
 * Recovery-side OpenCode operations against a loopback stand-in for
 * `opencode serve` (SDK v1 routes): endpoint capture, inspect, attach
 * (event stream only — no prompt), and abort with a positive receipt.
 */
interface StubState {
  status: Record<string, { type: string }>;
  sessions: Map<string, { error: boolean; messages: boolean }>;
  streams: Set<ServerResponse>;
  requests: string[];
  abortResult: boolean;
  authorization: string | null;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function stub(): Promise<{ url: string; state: StubState; emit: (event: unknown) => void }> {
  const state: StubState = { status: {}, sessions: new Map(), streams: new Set(), requests: [], abortResult: true, authorization: null };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    state.requests.push(`${req.method} ${url.pathname}`);
    state.authorization = req.headers.authorization ?? null;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      state.streams.add(res);
      req.on('close', () => state.streams.delete(res));
      return;
    }
    if (url.pathname === '/session/status') return json(200, state.status);
    if (req.method === 'POST' && url.pathname === '/session') {
      state.sessions.set('ses_new', { error: false, messages: false });
      return json(200, { id: 'ses_new', title: 't', directory: url.searchParams.get('directory') ?? '' });
    }
    if (parts[0] === 'session' && parts[1]) {
      const session = state.sessions.get(parts[1]);
      if (!session) return json(404, { name: 'NotFoundError', data: { message: 'not found' } });
      if (req.method === 'GET' && parts.length === 2) return json(200, { id: parts[1] });
      if (req.method === 'GET' && parts[2] === 'message') {
        if (!session.messages) return json(200, []);
        return json(200, [
          { info: { id: 'm1', role: 'user', sessionID: parts[1] }, parts: [] },
          { info: { id: 'm2', role: 'assistant', sessionID: parts[1], ...(session.error ? { error: { name: 'UnknownError', data: { message: 'boom' } } } : {}) }, parts: [] },
        ]);
      }
      if (req.method === 'POST' && parts[2] === 'abort') return json(200, state.abortResult);
    }
    return json(404, { error: 'not found' });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    emit: (event) => {
      for (const res of state.streams) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
  };
}

function endpointFor(url: string, authorization: string | null = null): RuntimeEndpoint {
  return { kind: 'opencode', baseUrl: url, directory: '/tmp/wt', authorization, sandboxMode: 'enforce' };
}

describe('describeOpenCodeClient', () => {
  it('reads the base URL and the per-attempt server authorization from an SDK client', () => {
    const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4555/', directory: '/tmp/wt', headers: { authorization: 'Basic abc' } });
    expect(describeOpenCodeClient(client)).toEqual({ baseUrl: 'http://127.0.0.1:4555', authorization: 'Basic abc' });
    const shared = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4556', directory: '/tmp/wt' });
    expect(describeOpenCodeClient(shared)).toEqual({ baseUrl: 'http://127.0.0.1:4556', authorization: null });
  });

  it('fails closed (null) when the SDK shape changes', () => {
    const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4555' });
    Reflect.set(client, '_client', { getConfig: () => ({}) });
    expect(describeOpenCodeClient(client)).toBeNull();
    Reflect.set(client, '_client', null);
    expect(describeOpenCodeClient(client)).toBeNull();
  });
});

describe('createOpenCodeRuntime', () => {
  it('inspects a journaled session without prompting it', async () => {
    const { url, state } = await stub();
    const runtime = createOpenCodeRuntime({ sandboxMode: () => 'enforce' });
    state.sessions.set('ses_busy', { error: false, messages: true });
    state.sessions.set('ses_idle', { error: false, messages: true });
    state.sessions.set('ses_err', { error: true, messages: true });
    state.sessions.set('ses_empty', { error: false, messages: false });
    state.status = { ses_busy: { type: 'busy' } };
    const endpoint = endpointFor(url, 'Basic pw');
    expect(await runtime.inspect(endpoint, 'ses_busy')).toBe('busy');
    expect(state.authorization).toBe('Basic pw');
    expect(await runtime.inspect(endpoint, 'ses_idle')).toBe('idle');
    expect(await runtime.inspect(endpoint, 'ses_err')).toBe('idle-error');
    expect(await runtime.inspect(endpoint, 'ses_empty')).toBe('idle-error');
    expect(await runtime.inspect(endpoint, 'ses_gone')).toBe('missing');
    expect(await runtime.inspect(endpointFor('http://127.0.0.1:1'), 'ses_busy')).toBe('unreachable');
    expect(state.requests.some((line) => line.includes('prompt'))).toBe(false);
  });

  it('attaches to the event stream of its own session only, never submitting a prompt', async () => {
    const { url, state, emit } = await stub();
    state.sessions.set('ses_a', { error: false, messages: true });
    state.status = { ses_a: { type: 'busy' } };
    const runtime = createOpenCodeRuntime({ sandboxMode: () => 'enforce' });
    const controller = new AbortController();
    const session = await runtime.attach(endpointFor(url), 'ses_a', controller.signal);
    const iterator = session.events[Symbol.asyncIterator]();
    const received: AgentEvent[] = [];
    const reading = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        received.push(next.value);
        if (next.value.t === 'turn.finished') return;
      }
    })();
    for (let attempt = 0; attempt < 100 && state.streams.size === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    emit({ type: 'server.heartbeat', properties: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    emit({ type: 'message.part.updated', properties: { part: { type: 'text', id: 'p1', sessionID: 'ses_other' }, delta: 'not mine' } });
    emit({ type: 'file.edited', properties: { sessionID: 'ses_a', file: 'x.ts' } });
    emit({ type: 'session.idle', properties: { sessionID: 'ses_a' } });
    await reading;
    expect(received.map((event) => event.t)).toEqual(expect.arrayContaining(['file.changed', 'turn.finished']));
    expect(received.some((event) => event.t === 'message.delta')).toBe(false);
    expect(state.requests.some((line) => line.includes('prompt'))).toBe(false);
  });

  it('reports a turn that ended between the probe and the subscription', async () => {
    const { url, state } = await stub();
    state.sessions.set('ses_done', { error: false, messages: true });
    const runtime = createOpenCodeRuntime({ sandboxMode: () => 'enforce' });
    const session = await runtime.attach(endpointFor(url), 'ses_done', new AbortController().signal);
    const first = await session.events[Symbol.asyncIterator]().next();
    expect(first.value).toEqual({ t: 'turn.finished', turn: 0, reason: 'idle' });
  });

  it('returns a stop receipt only when the provider confirms the abort', async () => {
    const { url, state } = await stub();
    state.sessions.set('ses_a', { error: false, messages: true });
    const runtime = createOpenCodeRuntime({ sandboxMode: () => 'enforce' });
    expect(await runtime.abort(endpointFor(url), 'ses_a')).toBe(true);
    state.abortResult = false;
    expect(await runtime.abort(endpointFor(url), 'ses_a')).toBe(false);
    expect(await runtime.abort(null, 'ses_a')).toBe(false);
    expect(await runtime.abort(endpointFor('http://127.0.0.1:1'), 'ses_a')).toBe(false);
    const attached = await runtime.attach(endpointFor(url), 'ses_a', new AbortController().signal);
    await expect(attached.abort()).rejects.toThrow('Provider did not confirm abort');
  });

  it('journals the endpoint of the session it started (AgentRunner contract + W09a routing)', async () => {
    const { url } = await stub();
    routing.baseUrl = url;
    const runtime = createOpenCodeRuntime();
    const started = await runtime.start({
      runId: 'run-1',
      worktreePath: '/tmp/wt',
      systemContract: 'contract',
      prompt: 'do it',
      budgets: { wallClockMs: 1_000 },
      permissions: { default: 'allow' },
      sandbox: { cwd: '/tmp/wt', env: {} },
      env: {},
      signal: new AbortController().signal,
    });
    expect(started.session.externalId).toBe('ses_new');
    await runtime.release?.(endpointFor(url));
    await runtime.release?.({ ...endpointFor(url), sandboxMode: 'trusted-host' });
    expect(routing.released).toEqual(['/tmp/wt']);
    expect(started.endpoint).toEqual({ kind: 'opencode', baseUrl: url, directory: '/tmp/wt', authorization: 'Basic attempt', sandboxMode: 'enforce' });
    expect(runtime.approvals).toBe('interactive');
  });

  it('FE-04 review fix: an ask session on a server that answers by policy fails closed before anything is prompted', async () => {
    const { url, state } = await stub();
    routing.baseUrl = url;
    const runtime = createOpenCodeRuntime({ approvalModeOf: () => 'policy' });
    await expect(runtime.start({ ...startInput(), permissions: { default: 'ask' } })).rejects.toMatchObject({ statusCode: 409, code: 'APPROVAL_MODE_UNAVAILABLE' });
    expect(state.requests.some((line) => line.includes('prompt'))).toBe(false);
    // Policy sessions don't care; no attempt server (trusted-host) is left to the service's warning.
    await expect(runtime.start(startInput())).resolves.toBeTruthy();
    await expect(createOpenCodeRuntime({ approvalModeOf: () => null }).start({ ...startInput(), permissions: { default: 'ask' } })).resolves.toBeTruthy();
  });

  it('FE-04: sets the attempt server\'s approval mode before each start and resume', async () => {
    const { url, state } = await stub();
    routing.baseUrl = url;
    routing.approvalModes.length = 0;
    state.sessions.set('ses_saved', { error: false, messages: true });
    const runtime = createOpenCodeRuntime();
    await runtime.start({ ...startInput(), permissions: { default: 'ask' } });
    await runtime.resume?.({ runId: 'run-2', worktreePath: '/tmp/wt', prompt: 'review', permissions: { default: 'allow' }, env: {}, signal: new AbortController().signal, sessionId: 'ses_saved' });
    expect(routing.approvalModes).toEqual(['/tmp/wt:ask', '/tmp/wt:policy']);
  });

  const startInput = () => ({
    runId: 'run-1',
    worktreePath: '/tmp/wt',
    systemContract: 'contract',
    prompt: 'do it',
    budgets: { wallClockMs: 1_000 },
    permissions: { default: 'allow' as const },
    sandbox: { cwd: '/tmp/wt', env: {} },
    env: {},
    signal: new AbortController().signal,
  });

  it('W07a: stops its own session through OpenCodeSession.abort(), confirmed only by a positive receipt', async () => {
    const { url, state } = await stub();
    routing.baseUrl = url;
    const runtime = createOpenCodeRuntime();
    const started = await runtime.start(startInput());
    const abortSpy = vi.spyOn(started.session, 'abort');
    state.abortResult = false;
    expect(await runtime.abort(started.endpoint, 'ses_new')).toBe(false);
    state.abortResult = true;
    // A fresh request after the unconfirmed one: OpenCode's `true` is the receipt.
    expect(await runtime.abort(started.endpoint, 'ses_new')).toBe(true);
    expect(abortSpy).toHaveBeenCalledTimes(2);
    expect(state.requests.filter((line) => line === 'POST /session/ses_new/abort')).toHaveLength(2);
    expect(state.requests.some((line) => line.includes('prompt'))).toBe(false);
  });

  it('W07a: resumes a saved session for a follow-up (prompted only when consumed), or answers null when it is gone', async () => {
    const { url, state } = await stub();
    routing.baseUrl = url;
    state.sessions.set('ses_saved', { error: false, messages: true });
    const runtime = createOpenCodeRuntime();
    const input = { runId: 'run-2', worktreePath: '/tmp/wt', prompt: 'review', permissions: { default: 'allow' as const }, env: {}, signal: new AbortController().signal };
    const resumed = await runtime.resume?.({ ...input, sessionId: 'ses_saved' });
    expect(resumed?.session.externalId).toBe('ses_saved');
    expect(resumed?.endpoint).toMatchObject({ kind: 'opencode', baseUrl: url, resumedSessionId: 'ses_saved' });
    expect(state.requests.some((line) => line.includes('prompt'))).toBe(false);
    expect(await runtime.resume?.({ ...input, sessionId: 'ses_gone' })).toBeNull();
  });
});

describe('W12a orphaned sandboxed OpenCode servers', () => {
  const endpoint = (overrides: Partial<RuntimeEndpoint> = {}): RuntimeEndpoint => ({
    kind: 'opencode', baseUrl: 'http://127.0.0.1:1', directory: '/tmp/wt-orphan', authorization: null, sandboxMode: 'enforce', ...overrides,
  });
  const identity = { pid: 4242, launchedAt: 1_000, spawnedBy: 1_100 };

  afterEach(() => {
    routing.owned = true;
    routing.process = null;
  });

  it('journals the enforce-mode attempt server identity with the endpoint', async () => {
    const { url } = await stub();
    routing.baseUrl = url;
    routing.process = identity;
    const runtime = createOpenCodeRuntime({ sandboxMode: () => 'enforce' });
    const input = (worktreePath: string) => ({
      runId: 'run-o', worktreePath, systemContract: 'c', prompt: 'p', budgets: { wallClockMs: 1_000 },
      permissions: { default: 'allow' as const }, sandbox: { cwd: worktreePath, env: {} }, env: {}, signal: new AbortController().signal,
    });
    const started = await runtime.start(input('/tmp/wt-o'));
    expect(started.endpoint).toMatchObject({ sandboxMode: 'enforce', process: identity });
    const trusted = createOpenCodeRuntime({ sandboxMode: () => 'trusted-host' });
    const plain = await trusted.start(input('/tmp/wt-p'));
    expect(plain.endpoint?.process).toBeUndefined();
  });

  it('closes its own server; stops a server a previous sidecar left behind by its identity; leaves the rest alone', async () => {
    const stopOrphan = vi.fn(async () => true);
    const runtime = createOpenCodeRuntime({ sandboxMode: () => 'enforce', stopOrphan });
    await runtime.release?.(endpoint({ process: identity }));
    expect(stopOrphan).not.toHaveBeenCalled();

    routing.owned = false;
    await runtime.release?.(endpoint({ process: identity }));
    expect(stopOrphan).toHaveBeenCalledWith(identity);

    stopOrphan.mockClear();
    await runtime.release?.(endpoint());
    await runtime.release?.(endpoint({ sandboxMode: 'trusted-host', process: identity }));
    expect(stopOrphan).not.toHaveBeenCalled();
  });
});
