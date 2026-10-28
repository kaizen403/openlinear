import express, { type NextFunction, type Request, type Response } from 'express';
import http, { type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, createErrorHandler } from '../lib/errors';
import type { RunServiceHandle } from '../run/engine-mode';

/**
 * Route wiring for OPENLINEAR_RUN_ENGINE=v2 (execute, running, logs, cancel,
 * run state) and the legacy SANDBOX_UNAVAILABLE → 503 mapping.
 */
const mocks = vi.hoisted(() => ({
  executeTask: vi.fn(),
  cancelTask: vi.fn(),
  isTaskRunning: vi.fn(() => false),
  getExecutionLogs: vi.fn(() => []),
  authorize: vi.fn(async () => undefined),
  runEngineActive: vi.fn(() => true),
  submit: vi.fn(),
  followUp: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('../auth/principal', () => ({
  requireSidecarAuth: (req: Request & { credential?: unknown }, _res: Response, next: NextFunction) => {
    req.credential = { principal: { userId: 'user-1', authSource: 'session', scopes: [], workspaceRestriction: null, tokenHash: 'h' }, token: 'token-1' };
    next();
  },
  credentialOf: (req: Request & { credential?: unknown }) => req.credential,
}));
vi.mock('../auth/task-access', () => ({ authorizeTaskAccess: mocks.authorize }));
vi.mock('../services/execution', () => ({
  executeTask: mocks.executeTask,
  cancelTask: mocks.cancelTask,
  isTaskRunning: mocks.isTaskRunning,
  getExecutionLogs: mocks.getExecutionLogs,
}));
vi.mock('../services/batch/registry', () => ({ getBatchExecutionLogs: () => [], batchOwnerOf: () => null }));
vi.mock('../run/index', () => ({
  runEngineActive: mocks.runEngineActive,
  getRunService: () => ({ submit: mocks.submit, followUp: mocks.followUp, redirect: mocks.redirect }),
}));

const { default: router } = await import('./execution');
const { registerRunService } = await import('../run/engine-mode');

let server: Server | undefined;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', router);
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTaskRunning.mockReturnValue(false);
  mocks.runEngineActive.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  registerRunService(null);
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: 'Bearer token-1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function handle(overrides: Partial<RunServiceHandle> = {}): RunServiceHandle {
  return {
    isRunning: () => true,
    ownerOf: () => 'user-1',
    cancel: async () => ({ success: true, state: 'cancelled' }),
    logsFor: () => [{ timestamp: new Date(0).toISOString(), type: 'info', message: 'v2 log' }],
    describe: () => ({ runId: 'run-1', state: 'running', attemptId: 'a1', lastSeq: 4, relayAckSeq: 3, terminal: null, effects: [], runner: 'opencode', followUp: null, verification: null, workspaceExpired: null, budgets: null,
      phases: { queuedMs: 0, preparingMs: 1_000, setupMs: 0, agentMs: 2_000, approvalWaitMs: 0, verifyingMs: 0, finishingMs: 0, totalMs: 3_000, live: true }, knowledge: [] }),
    submit: mocks.submit,
    followUp: mocks.followUp,
    ...overrides,
  };
}

describe('execution routes with OPENLINEAR_RUN_ENGINE=v2', () => {
  it('starts through the run service and answers 202 for a queued run', async () => {
    vi.stubEnv('OPENLINEAR_RUN_ENGINE', 'v2');
    mocks.submit.mockResolvedValueOnce({ runId: 'run-1', attemptId: 'a1', state: 'running' });
    expect(await call('POST', '/api/tasks/task-1/execute')).toEqual({
      status: 200,
      body: { message: 'Task execution started', runId: 'run-1', attemptId: 'a1', state: 'running' },
    });
    expect(mocks.submit).toHaveBeenCalledWith({ credential: expect.objectContaining({ token: 'token-1' }), taskId: 'task-1', allowBlocked: false });
    expect(mocks.executeTask).not.toHaveBeenCalled();

    mocks.submit.mockResolvedValueOnce({ runId: 'run-2', attemptId: 'a2', state: 'queued' });
    expect((await call('POST', '/api/tasks/task-2/execute')).status).toBe(202);
  });

  it('W17a: a blocked task answers 409 with its blockers; "run anyway" passes allowBlocked', async () => {
    vi.stubEnv('OPENLINEAR_RUN_ENGINE', 'v2');
    mocks.submit.mockRejectedValueOnce(new HttpError(409, 'TASK_BLOCKED', 'This task is blocked by ENG-1.', { blockers: [{ id: 'b1', identifier: 'ENG-1' }] }));
    const refused = await call('POST', '/api/tasks/task-1/execute');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'TASK_BLOCKED', details: { blockers: [{ id: 'b1', identifier: 'ENG-1' }] } });

    mocks.submit.mockResolvedValueOnce({ runId: 'run-3', attemptId: 'a3', state: 'running' });
    expect((await call('POST', '/api/tasks/task-1/execute', { allowBlocked: true })).status).toBe(200);
    expect(mocks.submit).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: 'task-1', allowBlocked: true }));
    // Only a literal true counts.
    mocks.submit.mockResolvedValueOnce({ runId: 'run-4', attemptId: 'a4', state: 'running' });
    await call('POST', '/api/tasks/task-1/execute', { allowBlocked: 'yes' });
    expect(mocks.submit).toHaveBeenLastCalledWith(expect.objectContaining({ allowBlocked: false }));
  });

  it('keeps setup failures on their status (sandbox unavailable → 503)', async () => {
    vi.stubEnv('OPENLINEAR_RUN_ENGINE', 'v2');
    mocks.submit.mockRejectedValueOnce(new HttpError(503, 'SANDBOX_UNAVAILABLE', 'No verified sandbox'));
    const res = await call('POST', '/api/tasks/task-1/execute');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SANDBOX_UNAVAILABLE');
  });

  it('falls back to the legacy engine outside API persistence mode', async () => {
    vi.stubEnv('OPENLINEAR_RUN_ENGINE', 'v2');
    mocks.runEngineActive.mockReturnValue(false);
    mocks.executeTask.mockResolvedValueOnce({ success: true });
    expect((await call('POST', '/api/tasks/task-1/execute')).status).toBe(200);
    expect(mocks.executeTask).toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('serves running, logs, run state and cancel from the run service', async () => {
    registerRunService(handle());
    expect(await call('GET', '/api/tasks/task-1/running')).toEqual({ status: 200, body: { running: true } });
    expect((await call('GET', '/api/tasks/task-1/logs')).body.logs).toEqual([expect.objectContaining({ message: 'v2 log' })]);
    expect((await call('GET', '/api/tasks/task-1/run')).body.run).toMatchObject({ runId: 'run-1', state: 'running', lastSeq: 4 });
    expect(await call('POST', '/api/tasks/task-1/cancel')).toEqual({ status: 200, body: { message: 'Task cancelled' } });
    // The owner shortcut: no control-plane authorization round trip.
    expect(mocks.authorize).not.toHaveBeenCalled();

    registerRunService(handle({ cancel: async () => ({ success: false, error: 'Cancellation could not be confirmed; execution remains reserved' }) }));
    expect((await call('POST', '/api/tasks/task-1/cancel')).status).toBe(400);
    registerRunService(handle({ cancel: async () => ({ success: false, error: 'Cancellation is still in progress' }) }));
    expect((await call('POST', '/api/tasks/task-1/cancel')).status).toBe(202);
  });

  it('authorizes non-owners through the control plane and 404s an unknown run', async () => {
    registerRunService(handle({ ownerOf: () => 'someone-else', describe: () => null }));
    const res = await call('GET', '/api/tasks/task-1/run');
    expect(mocks.authorize).toHaveBeenCalled();
    expect(res).toMatchObject({ status: 404, body: { code: 'RUN_NOT_FOUND' } });
  });
});

describe('legacy execute', () => {
  it('maps SANDBOX_UNAVAILABLE / SANDBOX_START_FAILED to 503 instead of 400', async () => {
    // W07a: v2 is the default; legacy stays selectable explicitly.
    vi.stubEnv('OPENLINEAR_RUN_ENGINE', 'legacy');
    mocks.executeTask.mockResolvedValueOnce({ success: false, error: 'No verified sandbox', code: 'SANDBOX_UNAVAILABLE' });
    expect(await call('POST', '/api/tasks/task-1/execute')).toEqual({ status: 503, body: { error: 'No verified sandbox', code: 'SANDBOX_UNAVAILABLE' } });
    mocks.executeTask.mockResolvedValueOnce({ success: false, error: 'start failed', code: 'SANDBOX_START_FAILED' });
    expect((await call('POST', '/api/tasks/task-1/execute')).status).toBe(503);
    mocks.executeTask.mockResolvedValueOnce({ success: false, error: 'No active project selected' });
    expect((await call('POST', '/api/tasks/task-1/execute')).status).toBe(400);
  });
});

describe('W07a default engine', () => {
  it('executes through the run service when OPENLINEAR_RUN_ENGINE is unset', async () => {
    vi.stubEnv('OPENLINEAR_RUN_ENGINE', '');
    mocks.submit.mockResolvedValueOnce({ runId: 'run-9', attemptId: 'a9', state: 'running' });
    expect((await call('POST', '/api/tasks/task-9/execute')).status).toBe(200);
    expect(mocks.submit).toHaveBeenCalled();
    expect(mocks.executeTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/redirect (W12 stop and redirect)', () => {
  it('stops and continues with the instruction (202), validates the body, and refuses legacy runs', async () => {
    mocks.redirect.mockResolvedValueOnce({ runId: 'run-9', attemptId: 'a9', state: 'running' });
    expect(await call('POST', '/api/tasks/task-1/redirect', { message: 'Use the helper instead' })).toEqual({ status: 202, body: { runId: 'run-9', attemptId: 'a9', state: 'running' } });
    expect(mocks.redirect).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', request: { message: 'Use the helper instead', comments: [] } }));
    expect((await call('POST', '/api/tasks/task-1/redirect', { message: '   ' })).status).toBe(400);

    mocks.redirect.mockRejectedValueOnce(new HttpError(409, 'REDIRECT_PENDING', "The agent hasn't stopped yet"));
    expect((await call('POST', '/api/tasks/task-1/redirect', { message: 'now' })).body).toMatchObject({ code: 'REDIRECT_PENDING' });

    mocks.isTaskRunning.mockReturnValueOnce(true);
    expect((await call('POST', '/api/tasks/task-1/redirect', { message: 'now' })).body).toMatchObject({ code: 'FOLLOW_UP_UNSUPPORTED' });
  });
});

describe('POST /api/tasks/:id/follow-up (W07a contract)', () => {
  const valid = {
    message: 'Please handle the null case.',
    comments: [{ path: 'src/a.ts', line: 3, side: 'new', body: 'null here' }, { path: 'README.md', body: 'mention it' }],
  };

  it('starts a follow-up turn and answers 202 { runId, attemptId, state }', async () => {
    mocks.followUp.mockResolvedValueOnce({ runId: 'run-2', attemptId: 'a2', state: 'running' });
    expect(await call('POST', '/api/tasks/task-1/follow-up', valid)).toEqual({ status: 202, body: { runId: 'run-2', attemptId: 'a2', state: 'running' } });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-1' }), 'task-1', 'write');
    expect(mocks.followUp).toHaveBeenCalledWith({
      credential: expect.objectContaining({ token: 'token-1' }),
      taskId: 'task-1',
      request: { message: valid.message, comments: valid.comments },
    });
    mocks.followUp.mockResolvedValueOnce({ runId: 'run-3', attemptId: 'a3', state: 'queued' });
    expect(await call('POST', '/api/tasks/task-1/follow-up', { message: 'again' })).toEqual({ status: 202, body: { runId: 'run-3', attemptId: 'a3', state: 'queued' } });
    expect(mocks.followUp).toHaveBeenLastCalledWith(expect.objectContaining({ request: { message: 'again', comments: [] } }));
    // Review follow-ups send no run id: none is passed on.
    expect(mocks.followUp.mock.calls.every(([input]) => !('parentRunId' in input))).toBe(true);
  });

  it('W12: passes the run being continued (parentRunId) and answers 409 FOLLOW_UP_RUN_MISMATCH with its details', async () => {
    const parentRunId = '6f1c2a8e-0b7d-4c55-9a3e-2d1f0e9b8c7a';
    mocks.followUp.mockResolvedValueOnce({ runId: 'run-5', attemptId: 'a5', state: 'running' });
    expect((await call('POST', '/api/tasks/task-1/follow-up', { message: 'Continue', comments: [], parentRunId })).status).toBe(202);
    expect(mocks.followUp).toHaveBeenLastCalledWith({
      credential: expect.objectContaining({ token: 'token-1' }),
      taskId: 'task-1',
      request: { message: 'Continue', comments: [] },
      parentRunId,
    });

    mocks.followUp.mockRejectedValueOnce(new HttpError(409, 'FOLLOW_UP_RUN_MISMATCH', 'The run to continue is not the latest run of this task on this device', { expected: parentRunId, latest: null }));
    expect(await call('POST', '/api/tasks/task-1/follow-up', { message: 'Continue', parentRunId })).toMatchObject({
      status: 409,
      body: { code: 'FOLLOW_UP_RUN_MISMATCH', details: { expected: parentRunId, latest: null } },
    });
  });

  it('W12: redirect takes no run id (strict body)', async () => {
    expect(await call('POST', '/api/tasks/task-1/redirect', { message: 'now', parentRunId: 'run-1' })).toMatchObject({ status: 400, body: { code: 'VALIDATION_ERROR' } });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('rejects invalid bodies with 400 before touching the control plane', async () => {
    const invalid: unknown[] = [
      {},
      { message: '' },
      { message: '   ' },
      { message: 'x'.repeat(20_001) },
      { message: 'ok', comments: [{ path: '', body: 'b' }] },
      { message: 'ok', comments: [{ path: 'a', body: '' }] },
      { message: 'ok', comments: [{ path: 'a', body: 'b', line: 0 }] },
      { message: 'ok', comments: [{ path: 'a', body: 'b', line: 1.5 }] },
      { message: 'ok', comments: [{ path: 'a', body: 'b', side: 'left' }] },
      { message: 'ok', comments: [{ path: 'a', body: 'b', extra: true }] },
      { message: 'ok', comments: Array.from({ length: 201 }, () => ({ path: 'a', body: 'b' })) },
      { message: 'ok', extra: 1 },
      { message: 'nul\u0000byte' },
      { message: 'ok', parentRunId: '' },
      { message: 'ok', parentRunId: '   ' },
      { message: 'ok', parentRunId: 42 },
      { message: 'ok', parentRunId: null },
      { message: 'ok', parentRunId: 'r'.repeat(201) },
      { message: 'ok', parentRunId: 'run\u0000x' },
    ];
    for (const body of invalid) {
      const res = await call('POST', '/api/tasks/task-1/follow-up', body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.followUp).not.toHaveBeenCalled();
    // 200 comments is the bound, not an error.
    mocks.followUp.mockResolvedValueOnce({ runId: 'run-4', attemptId: 'a4', state: 'running' });
    expect((await call('POST', '/api/tasks/task-1/follow-up', { message: 'ok', comments: Array.from({ length: 200 }, () => ({ path: 'a', body: 'b' })) })).status).toBe(202);
  });

  it('maps the control plane 404 to TASK_NOT_FOUND and passes 409/503 through', async () => {
    mocks.authorize.mockRejectedValueOnce(new HttpError(404, 'OWNERSHIP_REQUIRED', 'Resource not found'));
    expect(await call('POST', '/api/tasks/task-x/follow-up', valid)).toMatchObject({ status: 404, body: { code: 'TASK_NOT_FOUND' } });
    expect(mocks.followUp).not.toHaveBeenCalled();

    mocks.followUp.mockRejectedValueOnce(new HttpError(409, 'RUN_ACTIVE', 'A turn is already in progress for this task'));
    expect(await call('POST', '/api/tasks/task-1/follow-up', valid)).toMatchObject({ status: 409, body: { code: 'RUN_ACTIVE' } });
    mocks.followUp.mockRejectedValueOnce(new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'No retained worktree', { reason: 'worktree_missing' }));
    expect(await call('POST', '/api/tasks/task-1/follow-up', valid)).toMatchObject({ status: 409, body: { code: 'FOLLOW_UP_UNSUPPORTED', details: { reason: 'worktree_missing' } } });
    mocks.followUp.mockRejectedValueOnce(new HttpError(503, 'SANDBOX_UNAVAILABLE', 'No verified sandbox'));
    expect(await call('POST', '/api/tasks/task-1/follow-up', valid)).toMatchObject({ status: 503, body: { code: 'SANDBOX_UNAVAILABLE' } });
    mocks.authorize.mockRejectedValueOnce(new HttpError(503, 'CLOUD_API_UNREACHABLE', 'OpenLinear API is unreachable'));
    expect(await call('POST', '/api/tasks/task-1/follow-up', valid)).toMatchObject({ status: 503, body: { code: 'CLOUD_API_UNREACHABLE' } });
  });

  it('answers RUN_ACTIVE while a legacy execution runs and FOLLOW_UP_UNSUPPORTED without the v2 engine', async () => {
    mocks.isTaskRunning.mockReturnValue(true);
    expect(await call('POST', '/api/tasks/task-1/follow-up', valid)).toMatchObject({ status: 409, body: { code: 'RUN_ACTIVE' } });
    mocks.isTaskRunning.mockReturnValue(false);
    mocks.runEngineActive.mockReturnValue(false);
    expect(await call('POST', '/api/tasks/task-1/follow-up', valid)).toMatchObject({ status: 409, body: { code: 'FOLLOW_UP_UNSUPPORTED', details: { reason: 'run_engine_legacy' } } });
    expect(mocks.followUp).not.toHaveBeenCalled();
  });
});
