import { mkdtempSync, rmSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type NextFunction, type Response } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isTerminalRunState } from '@openlinear/execution-core';
import type { AuthedRequest, SidecarPrincipal } from '../auth/principal';
import { DurableRunJournal } from '../journal/durable';
import { createErrorHandler } from '../lib/errors';
import { registerRunService } from '../run/engine-mode';
import { RunService } from '../run/service';
import { FakeControlPlane, FakePublication, FakeRuntime, FakeRuntimeHost, FakeWorkspace, fakeCredential, fakeSnapshot, type HostStep } from '../run/test-support';

/**
 * FE-04 routes end to end: an "ask" run waits on a permission request; the
 * owner lists it (per task and across tasks) and answers it over HTTP
 * quoting the digest; nobody else sees or answers it; a changed operation,
 * a replay and a malformed body are refused; the runner gets the answer.
 */

// Bearer `<userId>` stands in for the control plane's principal lookup.
vi.mock('../auth/principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/principal')>();
  return {
    ...actual,
    requireSidecarAuth: (req: AuthedRequest, res: Response, next: NextFunction) => {
      const token = actual.bearerFrom(req);
      if (!token) {
        res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED', message: 'Authentication required' });
        return;
      }
      const principal: SidecarPrincipal = { userId: token, authSource: 'session', scopes: [], workspaceRestriction: null, tokenHash: 'h' };
      req.principal = principal;
      req.credential = { principal, token };
      req.userId = principal.userId;
      next();
    },
  };
});

const { default: approvalsRouter } = await import('./approvals');

const ASKING: HostStep[] = [
  { t: 'turn.started', turn: 1 },
  { t: 'permission.requested', id: 'perm-1', tool: 'bash', detail: 'pnpm publish' },
  { hold: 'reply:perm-1' },
  { writeFile: 'change.txt' },
  { t: 'file.changed', path: 'change.txt', kind: 'create' },
  { t: 'turn.finished', turn: 1, reason: 'idle' },
];

let server: Server | undefined;
let base = '';
const roots: string[] = [];
const services: RunService[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', approvalsRouter);
  app.use(createErrorHandler());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

afterEach(() => {
  registerRunService(null);
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function call(path: string, user: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(user ? { authorization: `Bearer ${user}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function askingService() {
  const root = mkdtempSync(join(tmpdir(), 'ol-approvals-route-'));
  roots.push(root);
  const cp = new FakeControlPlane();
  cp.snapshot = (taskId) => fakeSnapshot(taskId, { approvalMode: 'ask', title: 'Publish the package' });
  cp.addTask('task-1');
  const host = new FakeRuntimeHost();
  const original = host.create.bind(host);
  host.create = (runId, directory) => {
    host.scripts.set(runId, ASKING);
    return original(runId, directory);
  };
  const journal = new DurableRunJournal(join(root, 'journal', 'runs-v2.sqlite'));
  const service = new RunService({
    journal,
    controlPlane: cp,
    runtimes: new Map([['opencode', new FakeRuntime(host)]]),
    publication: new FakePublication(),
    workspace: new FakeWorkspace(join(root, 'worktrees')),
    events: { publish: () => undefined },
    options: { heartbeatMs: 3_600_000, retryBaseMs: 5, retryMaxMs: 20, relayDelayMs: 0, interruptGraceMs: 0, watchdogIntervalMs: 20, watchdog: { transportMs: 1e9, noProgressMs: 1e9, wallClockMs: 1e9 } },
  });
  services.push(service);
  registerRunService(service);
  return { host, journal, service };
}

describe('FE-04 approval routes', () => {
  it('authenticates every route', async () => {
    expect((await call('/api/approvals', null)).status).toBe(401);
    expect((await call('/api/tasks/task-1/approvals', null)).status).toBe(401);
    expect((await call('/api/tasks/task-1/approvals/a1', null, { decision: 'allow', digest: 'a'.repeat(64) })).status).toBe(401);
  });

  it('without a run engine: nothing is pending and nothing can be answered', async () => {
    expect(await call('/api/approvals', 'user-1')).toEqual({ status: 200, json: { approvals: [] } });
    expect(await call('/api/tasks/task-1/approvals', 'user-1')).toEqual({ status: 200, json: { approvals: [] } });
    const answer = await call('/api/tasks/task-1/approvals/a1', 'user-1', { decision: 'allow', digest: 'a'.repeat(64) });
    expect(answer).toMatchObject({ status: 404, json: { code: 'APPROVAL_NOT_FOUND' } });
  });

  it('the owner lists and answers a waiting request; others see nothing and cannot answer; changed, replayed and malformed answers fail', async () => {
    const h = askingService();
    const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
    await waitFor(() => h.service.pendingApprovals('task-1', 'user-1').length > 0, 'pending approval');

    const mine = await call('/api/approvals', 'user-1');
    expect(mine.status).toBe(200);
    const approvals = mine.json.approvals as Array<{ id: string; digest: string }>;
    expect(approvals).toEqual([expect.objectContaining({ taskId: 'task-1', runId: started.runId, tool: 'bash', detail: 'pnpm publish', taskTitle: 'Publish the package' })]);
    const [approval] = approvals;
    const id = approval?.id ?? '';
    const digest = approval?.digest ?? '';
    expect((await call('/api/tasks/task-1/approvals', 'user-1')).json.approvals).toEqual(approvals);
    expect(await call('/api/approvals', 'user-2')).toEqual({ status: 200, json: { approvals: [] } });
    expect(await call('/api/tasks/task-1/approvals', 'user-2')).toEqual({ status: 200, json: { approvals: [] } });

    expect(await call(`/api/tasks/task-1/approvals/${id}`, 'user-1', { decision: 'maybe', digest })).toMatchObject({ status: 400, json: { code: 'VALIDATION_ERROR' } });
    expect(await call(`/api/tasks/task-1/approvals/${id}`, 'user-1', { decision: 'allow', digest, extra: true })).toMatchObject({ status: 400, json: { code: 'VALIDATION_ERROR' } });
    expect(await call(`/api/tasks/task-1/approvals/${id}`, 'user-2', { decision: 'allow', digest })).toMatchObject({ status: 403, json: { code: 'APPROVAL_FORBIDDEN' } });
    expect(await call(`/api/tasks/task-1/approvals/${id}`, 'user-1', { decision: 'allow', digest: 'b'.repeat(64) })).toMatchObject({ status: 409, json: { code: 'APPROVAL_CHANGED' } });
    expect(await call(`/api/tasks/task-2/approvals/${id}`, 'user-1', { decision: 'allow', digest })).toMatchObject({ status: 404, json: { code: 'APPROVAL_NOT_FOUND' } });
    expect(h.host.permissionReplies).toEqual([]);

    expect(await call(`/api/tasks/task-1/approvals/${id}`, 'user-1', { decision: 'allow', digest })).toEqual({ status: 200, json: { decision: 'allow', scope: 'once', by: 'user' } });
    expect(await call(`/api/tasks/task-1/approvals/${id}`, 'user-1', { decision: 'allow', digest })).toMatchObject({ status: 404, json: { code: 'APPROVAL_NOT_FOUND' } });
    await waitFor(() => {
      const record = h.journal.get(started.runId);
      return record && isTerminalRunState(record.state);
    }, 'run finished');
    expect(h.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.host.permissionReplies.map((reply) => `${reply.id}:${reply.decision}`)).toEqual(['perm-1:allow']);
    expect((await call('/api/approvals', 'user-1')).json.approvals).toEqual([]);
  });
});
