import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCloudApiConfig } from '../config/cloud-api';
import { boundLogEntries, createApiStore } from './api-store';
import type { AttemptContext } from './store';

interface Call { method: string; path: string; auth: string; body: unknown }
const calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(String(input));
  const call: Call = {
    method: init?.method ?? 'GET',
    path: url.pathname,
    auth: new Headers(init?.headers).get('Authorization') ?? '',
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  calls.push(call);
  return respond(call);
});

const credential = {
  principal: { userId: 'user-1', authSource: 'session' as const, scopes: [], workspaceRestriction: null, tokenHash: 'h' },
  token: 'user-token',
};
const CAPABILITY = `olx_${'a'.repeat(43)}`;
const snapshot = {
  schemaVersion: 1,
  capturedAt: '2026-10-25T00:00:00.000Z',
  task: { id: 'task-1', title: 'T', description: null, model: 'm/x', agent: null, teamId: 't', creatorId: 'user-1', workspaceId: 'w', projectId: 'p', project: null, labels: [] },
  authority: { id: 'task-1', projectId: 'p', teamId: 't', creatorId: 'user-1', archived: false, status: 'todo' },
  settings: { parallelLimit: 2, maxBatchSize: 3, queueAutoApprove: false, stopOnFailure: false, conflictBehavior: 'skip' },
};

describe('API store (W03a)', () => {
  beforeEach(() => {
    calls.length = 0;
    respond = (call) => {
      if (call.path === '/api/executions/attempts') {
        return json(201, { attempt: { id: 'attempt-1', taskId: 'task-1', status: 'preparing', createdAt: 'now' }, capability: { token: CAPABILITY, expiresAt: 'later', scopes: [] }, snapshot });
      }
      if (call.path.endsWith('/close')) return json(200, { attemptId: 'attempt-1', status: 'released', terminalStatus: null, closeReason: 'x' });
      if (call.path.endsWith('/terminal')) return json(200, { attemptId: 'attempt-1', status: 'finishing', terminalStatus: 'done', repeated: false, task: { id: 'task-1', status: 'done' } });
      if (call.path.endsWith('/git-credential')) return json(200, { provider: 'github', token: 'gho_x', purpose: 'clone', notAfter: 'later' });
      return json(200, {});
    };
    setCloudApiConfig({ baseUrl: 'http://127.0.0.1:4597', fetch: fetchMock as unknown as typeof fetch });
  });

  afterEach(() => setCloudApiConfig(null));

  async function started(): Promise<AttemptContext> {
    const result = await createApiStore().startAttempt({ taskId: 'task-1', userId: 'user-1', credential, admit: () => null });
    if (!result.ok) throw new Error(result.error);
    return result.attempt;
  }

  it('starts with the user credential and uses only the capability afterwards', async () => {
    const store = createApiStore();
    const attempt = await started();
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/executions/attempts', auth: 'Bearer user-token', body: { taskId: 'task-1' } });
    expect(attempt).toMatchObject({ attemptId: 'attempt-1', credential: null });
    await store.getGitCredential(attempt, 'clone');
    await store.writeTaskStatus(attempt, { taskId: 'task-1', status: 'done', sessionId: null, executionData: { prUrl: 'https://github.com/a/b/pull/1', executionPausedAt: new Date('2026-10-25T00:00:00Z') }, fence: null });
    for (const call of calls.slice(1)) {
      expect(call.auth).toBe(`Bearer ${CAPABILITY}`);
      expect(call.path.startsWith('/api/executions/attempts/attempt-1/')).toBe(true);
    }
    expect(calls.find((call) => call.path.endsWith('/terminal'))?.body).toEqual({
      status: 'done', prUrl: 'https://github.com/a/b/pull/1', executionPausedAt: '2026-10-25T00:00:00.000Z',
    });
  });

  it('releases the attempt when local admission rejects it', async () => {
    const result = await createApiStore().startAttempt({ taskId: 'task-1', userId: 'user-1', credential, admit: () => 'Parallel limit reached (2 tasks max)' });
    expect(result).toEqual({ ok: false, error: 'Parallel limit reached (2 tasks max)' });
    expect(calls.map((call) => call.path)).toEqual(['/api/executions/attempts', '/api/executions/attempts/attempt-1/close']);
  });

  it('keeps the control plane status and code for denials and maps outages to 503', async () => {
    respond = () => json(403, { error: 'Required role is missing', code: 'OWNERSHIP_REQUIRED', message: 'Required role is missing' });
    await expect(createApiStore().startAttempt({ taskId: 'task-1', userId: 'user-1', credential, admit: () => null }))
      .rejects.toMatchObject({ statusCode: 403, code: 'OWNERSHIP_REQUIRED' });
    respond = () => { throw new TypeError('ECONNREFUSED'); };
    await expect(createApiStore().startAttempt({ taskId: 'task-1', userId: 'user-1', credential, admit: () => null }))
      .rejects.toMatchObject({ statusCode: 503, code: 'CLOUD_API_UNREACHABLE' });
    respond = () => json(500, { code: 'INTERNAL_ERROR' });
    await expect(createApiStore().startAttempt({ taskId: 'task-1', userId: 'user-1', credential, admit: () => null }))
      .rejects.toMatchObject({ statusCode: 503, code: 'CLOUD_API_UNREACHABLE' });
  });

  it('never writes in_progress outside the claim and never writes without an attempt', async () => {
    const store = createApiStore();
    await expect(store.writeTaskStatus(null, { taskId: 'task-1', status: 'cancelled', sessionId: null, fence: null }))
      .rejects.toMatchObject({ code: 'ATTEMPT_REQUIRED' });
    const attempt = await started();
    await expect(store.writeTaskStatus(attempt, { taskId: 'task-1', status: 'in_progress', sessionId: 'ses', fence: null }))
      .rejects.toMatchObject({ code: 'CLAIM_REQUIRED' });
    await expect(store.authorizePublication(null, { taskId: 'task-1', fence: { sessionId: 's', teamId: null, creatorId: null }, currentToken: null }))
      .rejects.toMatchObject({ code: 'ATTEMPT_REQUIRED' });
  });

  it('closes once, tolerating an already-revoked capability', async () => {
    const store = createApiStore();
    const attempt = await started();
    respond = () => json(401, { code: 'CAPABILITY_REVOKED' });
    await expect(store.closeAttempt(attempt, 'done')).resolves.toBeUndefined();
    await store.closeAttempt(attempt);
    expect(calls.filter((call) => call.path.endsWith('/close'))).toHaveLength(1);
    expect(attempt.closed).toBe(true);
  });

  it('bounds the persisted log snapshot to the control-plane contract', () => {
    const logs = Array.from({ length: 2_100 }, (_, index) => ({
      timestamp: '2026-10-25T00:00:00.000Z', type: 'info' as const, message: `${index}${'x'.repeat(9_000)}`, details: 'd'.repeat(20_000),
    }));
    const bounded = boundLogEntries(logs);
    expect(bounded).toHaveLength(2_000);
    expect(bounded[0]?.message.startsWith('100')).toBe(true);
    expect(bounded.every((entry) => entry.message.length <= 8_000 && (entry.details?.length ?? 0) <= 16_000)).toBe(true);
  });

  it('refuses journal recovery projections without a capability', async () => {
    await expect(createApiStore().recordRecoveryOutcome({
      id: 'run', taskId: 'task', batchId: null, runner: 'opencode', externalSessionId: null, worktreePath: null,
      status: 'running', startedAt: 0, heartbeatAt: 0, finishedAt: null, budgetsJson: '{}', usageJson: null,
    }, 'failed')).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
