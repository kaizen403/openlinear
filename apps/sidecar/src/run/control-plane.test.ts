import { afterEach, describe, expect, it } from 'vitest';
import { setCloudApiConfig } from '../config/cloud-api';
import { HttpError } from '../lib/errors';
import { createApiControlPlane, isAuthorityLost, isTransientControlError, snapshotFromTask } from './control-plane';
import { composeFaultHooks, crashHookFromEnv } from './faults';
import { fakeCredential } from './test-support';

afterEach(() => {
  setCloudApiConfig(null);
});

describe('control-plane error classification', () => {
  it('treats revoked/expired capabilities and closed attempts as lost authority (fenced)', () => {
    expect(isAuthorityLost(new HttpError(401, 'CAPABILITY_REVOKED', 'x'))).toBe(true);
    expect(isAuthorityLost(new HttpError(401, 'CAPABILITY_EXPIRED', 'x'))).toBe(true);
    expect(isAuthorityLost(new HttpError(404, 'ATTEMPT_NOT_FOUND', 'x'))).toBe(true);
    expect(isAuthorityLost(new HttpError(403, 'CAPABILITY_ATTEMPT_MISMATCH', 'x'))).toBe(true);
    expect(isAuthorityLost(new HttpError(409, 'ATTEMPT_STATE_CONFLICT', 'x', { status: 'closed' }))).toBe(true);
    expect(isAuthorityLost(new HttpError(409, 'ATTEMPT_STATE_CONFLICT', 'x', { status: 'released' }))).toBe(true);
    expect(isAuthorityLost(new HttpError(409, 'ATTEMPT_STATE_CONFLICT', 'x', { status: 'preparing' }))).toBe(false);
    expect(isAuthorityLost(new HttpError(409, 'TASK_FENCE_REJECTED', 'x'))).toBe(false);
    expect(isAuthorityLost(new Error('x'))).toBe(false);
  });

  it('retries only unreachable/rate-limited control planes and unknown failures', () => {
    expect(isTransientControlError(new HttpError(503, 'CLOUD_API_UNREACHABLE', 'x'))).toBe(true);
    expect(isTransientControlError(new HttpError(429, 'RATE_LIMITED', 'x'))).toBe(true);
    expect(isTransientControlError(new Error('socket hang up'))).toBe(true);
    expect(isTransientControlError(new HttpError(409, 'TASK_FENCE_REJECTED', 'x'))).toBe(false);
  });
});

describe('ApiControlPlane', () => {
  it('starts with the principal token and calls back only with the capability (W03a contract)', async () => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const responses = new Map<string, unknown>([
      ['/api/executions/attempts', {
        attempt: { id: 'a1', taskId: 't1', status: 'preparing', createdAt: new Date().toISOString() },
        capability: { token: 'olx_cap', expiresAt: new Date(Date.now() + 1_000).toISOString(), scopes: [] },
        snapshot: {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          task: {
            id: 't1', title: 'T', description: null, model: 'm/x', agent: null, teamId: null, creatorId: 'u1', workspaceId: null, projectId: 'p1',
            project: { id: 'p1', localPath: null, defaultAgent: 'opencode', repository: { id: 'r', name: 'repo', fullName: 'a/repo', cloneUrl: 'https://github.com/a/repo.git', defaultBranch: 'main' } },
            labels: [{ taskId: 't1', labelId: 'l', label: { id: 'l', name: 'bug', color: '#f00' } }],
          },
          authority: { id: 't1', projectId: 'p1', teamId: null, creatorId: 'u1', archived: false, status: 'todo' },
          settings: { parallelLimit: 2, maxBatchSize: 3, queueAutoApprove: false, stopOnFailure: false, conflictBehavior: 'skip' },
        },
      }],
      ['/api/executions/attempts/a1/heartbeat', { attemptId: 'a1', status: 'running', cancelRequested: true, heartbeatAt: new Date().toISOString(), capabilityExpiresAt: new Date(5_000).toISOString() }],
      ['/api/executions/attempts/a1/renew', { attemptId: 'a1', capability: { token: 'olx_new', expiresAt: new Date(9_000).toISOString(), scopes: [] }, previousExpiresAt: new Date().toISOString(), renewals: 1 }],
      ['/api/executions/attempts/a1/close', { attemptId: 'a1', status: 'closed', terminalStatus: null, closeReason: 'completed' }],
    ]);
    setCloudApiConfig({
      baseUrl: 'http://127.0.0.1:9',
      fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        const headers = new Headers(init?.headers);
        calls.push({ url: url.pathname, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
        const body = responses.get(url.pathname);
        if (!body) return new Response(JSON.stringify({ error: 'gone', code: 'CAPABILITY_REVOKED' }), { status: 401, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const cp = createApiControlPlane();
    const started = await cp.start(fakeCredential(), 't1');
    expect(started).toMatchObject({ attemptId: 'a1', parallelLimit: 2, capability: { token: 'olx_cap' } });
    expect(started.snapshot).toMatchObject({ agent: 'opencode', labels: ['bug'], repository: { fullName: 'a/repo' } });
    expect(calls[0]?.auth).toBe('Bearer jwt-token');

    const channel = cp.channel('a1', 'olx_cap');
    expect(await channel.heartbeat()).toEqual({ status: 'running', cancelRequested: true, capabilityExpiresAt: 5_000 });
    expect(await channel.renew()).toEqual({ token: 'olx_new', expiresAt: 9_000 });
    expect(await channel.close('completed')).toEqual({ status: 'closed', closeReason: 'completed' });
    expect(calls.slice(1).every((call) => call.auth === 'Bearer olx_cap')).toBe(true);
    await expect(channel.claim({ sessionId: 's', runner: 'opencode', model: 'm' })).rejects.toMatchObject({ statusCode: 401, code: 'CAPABILITY_REVOKED' });
  });

  it('maps snapshots without a project', () => {
    expect(snapshotFromTask({
      id: 't', title: 'T', description: 'd', model: null, agent: 'codex', teamId: 'tm', creatorId: null, workspaceId: null, projectId: null, project: null, labels: [],
    })).toEqual({ title: 'T', description: 'd', model: null, agent: 'codex', labels: [], projectId: null, teamId: 'tm', creatorId: null, localPath: null, repository: null });
  });
});

describe('fault hooks', () => {
  it('honours the crash point only under NODE_ENV=test and only at the exact point', async () => {
    let killed = 0;
    expect(crashHookFromEnv({ OPENLINEAR_RUN_ENGINE_CRASH_AT: 'after:x', NODE_ENV: 'production' }, () => { killed += 1; })).toBeNull();
    expect(crashHookFromEnv({ NODE_ENV: 'test' })).toBeNull();
    const hook = crashHookFromEnv({ OPENLINEAR_RUN_ENGINE_CRASH_AT: 'after:effect:git.commit:receipt', NODE_ENV: 'test' }, () => { killed += 1; });
    expect(hook).not.toBeNull();
    expect(hook?.('before', 'effect:git.commit:receipt', 'r')).toBeUndefined();
    void hook?.('after', 'effect:git.commit:receipt', 'r');
    expect(killed).toBe(1);
  });

  it('composes hooks in order', async () => {
    const seen: string[] = [];
    expect(composeFaultHooks(null, undefined)).toBeNull();
    const hook = composeFaultHooks((phase) => { seen.push(`a:${phase}`); }, (phase) => { seen.push(`b:${phase}`); });
    await hook?.('before', 'p', 'r');
    expect(seen).toEqual(['a:before', 'b:before']);
  });
});
