import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/errors';
import type { AttemptContext, SidecarStore, StartAttemptInput, TaskSnapshot } from '../../persistence/store';

/**
 * W03a attempt lifecycle in the sidecar: the claim is the only in_progress
 * transition, a rejected claim releases everything without a terminal write,
 * admission denials keep their HTTP status, and a control-plane cancellation
 * request runs the local cancel path.
 */
const mocks = vi.hoisted(() => ({
  cloneRepository: vi.fn(),
  createBranch: vi.fn(),
  releaseLocalWorktree: vi.fn(),
  subscribe: vi.fn(),
  failExecution: vi.fn(),
  getClientForUser: vi.fn(),
  sessionCreate: vi.fn(),
  promptAsync: vi.fn(),
  abort: vi.fn(),
}));

vi.mock('../opencode', () => ({ getClientForUser: mocks.getClientForUser }));
vi.mock('../opencode-model', () => ({ ensureModelConfigured: vi.fn() }));
vi.mock('./git', () => ({ cloneRepository: mocks.cloneRepository, createBranch: mocks.createBranch }));
vi.mock('../../workspace/local-worktree', () => ({ releaseLocalWorktree: mocks.releaseLocalWorktree }));
vi.mock('./events', () => ({
  subscribeToSessionEvents: mocks.subscribe,
  failExecutionFromEventStream: mocks.failExecution,
  claimFinalize: vi.fn(() => true),
}));

const { setSidecarStore } = await import('../../persistence/store');
const lifecycle = await import('./lifecycle');
const state = await import('./state');

const snapshot: TaskSnapshot = {
  id: 'task-a', title: 'Attempt fixture', description: null, model: 'test/model', agent: null,
  teamId: 'team-a', creatorId: 'user-a', workspaceId: 'ws-a', projectId: 'project-a', labels: [],
  project: {
    id: 'project-a', localPath: null, defaultAgent: null,
    repository: { id: 'repo-a', name: 'repo', fullName: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', defaultBranch: 'main' },
  },
};

function fakeStore(overrides: Partial<SidecarStore> = {}) {
  const closeAttempt = vi.fn(async (attempt: AttemptContext) => { attempt.closed = true; });
  const store: SidecarStore = {
    mode: 'api',
    startAttempt: vi.fn(async (input: StartAttemptInput) => {
      const settings = { parallelLimit: 3, maxBatchSize: 3, queueAutoApprove: false, stopOnFailure: false, conflictBehavior: 'skip' as const };
      const rejected = input.admit(settings);
      if (rejected) return { ok: false as const, error: rejected };
      return {
        ok: true as const,
        attempt: { taskId: input.taskId, userId: input.userId, attemptId: 'attempt-a', client: null, credential: null },
        task: snapshot,
        authority: { id: 'task-a', projectId: 'project-a', teamId: 'team-a', creatorId: 'user-a', archived: false, status: 'todo' },
        settings,
      };
    }),
    getGitCredential: vi.fn(async () => 'gho_token'),
    claimAttempt: vi.fn(async () => ({ agentRunId: 'run-a', task: { id: 'task-a', status: 'in_progress' } })),
    writeTaskStatus: vi.fn(async () => ({ id: 'task-a' })),
    persistLogs: vi.fn(async () => undefined),
    finalizeRun: vi.fn(async () => undefined),
    authorizePublication: vi.fn(async () => 'gho_token'),
    acknowledgeCancellation: vi.fn(async () => undefined),
    relayEvents: vi.fn(async () => ({ cancelRequested: false })),
    heartbeat: vi.fn(async () => ({ cancelRequested: false })),
    closeAttempt,
    readPersistedLogs: vi.fn(async () => []),
    refreshPullRequest: vi.fn(async () => ({ prUrl: null, refreshed: false })),
    recordRecoveryOutcome: vi.fn(async () => undefined),
    ...overrides,
  };
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.activeExecutions.clear();
  mocks.cloneRepository.mockResolvedValue({ kind: 'local-worktree', runId: 'r', worktreePath: '/owned/r', mirrorPath: '/m', branch: 'openlinear/r' });
  mocks.createBranch.mockResolvedValue(undefined);
  mocks.releaseLocalWorktree.mockResolvedValue(undefined);
  mocks.subscribe.mockResolvedValue(undefined);
  mocks.sessionCreate.mockResolvedValue({ data: { id: 'ses_a' } });
  mocks.promptAsync.mockResolvedValue({});
  mocks.abort.mockResolvedValue({ data: true });
  mocks.getClientForUser.mockResolvedValue({ session: { create: mocks.sessionCreate, promptAsync: mocks.promptAsync, abort: mocks.abort } });
});

afterEach(async () => {
  for (const execution of [...state.activeExecutions.values()]) {
    clearTimeout(execution.timeoutId);
    if (execution.heartbeatTimer) clearInterval(execution.heartbeatTimer);
  }
  state.activeExecutions.clear();
  setSidecarStore(null);
});

describe('attempt lifecycle (W03a)', () => {
  it('claims with the provider session, runner and model before submitting the prompt', async () => {
    const store = fakeStore();
    setSidecarStore(store);
    await expect(lifecycle.executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toEqual({ success: true });
    expect(store.claimAttempt).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'attempt-a' }), expect.objectContaining({
      sessionId: 'ses_a', runner: 'opencode', model: 'test/model',
    }));
    expect(vi.mocked(store.claimAttempt).mock.invocationCallOrder[0]).toBeLessThan(mocks.promptAsync.mock.invocationCallOrder[0] ?? 0);
    expect(store.getGitCredential).toHaveBeenCalledWith(expect.anything(), 'clone');
    expect(store.closeAttempt).not.toHaveBeenCalled();
    expect(state.activeExecutions.get('task-a')).toMatchObject({ agentRunId: 'run-a', claimed: true, taskTitle: 'Attempt fixture' });
  });

  it('releases everything without a terminal write when the claim is rejected', async () => {
    const store = fakeStore({
      claimAttempt: vi.fn(async () => { throw new HttpError(409, 'TASK_ALREADY_RUNNING', 'Task is already executing'); }),
    });
    setSidecarStore(store);
    await expect(lifecycle.executeTask({ taskId: 'task-a', userId: 'user-a' }))
      .resolves.toMatchObject({ success: false, code: 'TASK_ALREADY_RUNNING' });
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect(mocks.failExecution).not.toHaveBeenCalled();
    expect(store.writeTaskStatus).not.toHaveBeenCalled();
    expect(mocks.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'ses_a' } }));
    expect(mocks.releaseLocalWorktree).toHaveBeenCalledTimes(1);
    expect(store.closeAttempt).toHaveBeenCalledTimes(1);
    expect(state.activeExecutions.has('task-a')).toBe(false);
    expect(state.pendingExecutions.has('task-a')).toBe(false);
  });

  it('keeps 403/404/503 admission denials as errors for the route and opens no attempt work', async () => {
    for (const denial of [
      new HttpError(403, 'OWNERSHIP_REQUIRED', 'Required role is missing'),
      new HttpError(503, 'CLOUD_API_UNREACHABLE', 'OpenLinear API is unreachable'),
    ]) {
      const store = fakeStore({ startAttempt: vi.fn(async () => { throw denial; }) });
      setSidecarStore(store);
      await expect(lifecycle.executeTask({ taskId: 'task-a', userId: 'user-a' })).rejects.toBe(denial);
      expect(mocks.cloneRepository).not.toHaveBeenCalled();
      expect(state.pendingExecutions.size).toBe(0);
    }
  });

  it('releases the attempt when setup fails before the claim', async () => {
    const store = fakeStore();
    setSidecarStore(store);
    mocks.sessionCreate.mockRejectedValueOnce(new Error('agent unavailable'));
    await expect(lifecycle.executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, error: 'agent unavailable' });
    expect(store.claimAttempt).not.toHaveBeenCalled();
    expect(store.closeAttempt).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'attempt-a' }), 'setup_failed');
  });

  it('acknowledges a confirmed provider stop before finalizing a cancelled run', async () => {
    const store = fakeStore();
    setSidecarStore(store);
    await lifecycle.executeTask({ taskId: 'task-a', userId: 'user-a' });
    await expect(lifecycle.cancelTask('task-a')).resolves.toEqual({ success: true });
    expect(store.acknowledgeCancellation).toHaveBeenCalledTimes(1);
    expect(store.writeTaskStatus).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'attempt-a' }), expect.objectContaining({ status: 'cancelled' }));
    expect(store.finalizeRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'cancelled' }));
    expect(vi.mocked(store.acknowledgeCancellation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(store.finalizeRun).mock.invocationCallOrder[0] ?? 0);
    expect(store.closeAttempt).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge or finalize when the provider stop is not confirmed', async () => {
    const store = fakeStore();
    setSidecarStore(store);
    await lifecycle.executeTask({ taskId: 'task-a', userId: 'user-a' });
    mocks.abort.mockResolvedValueOnce({ data: false });
    await expect(lifecycle.cancelTask('task-a')).resolves.toMatchObject({ success: false });
    expect(store.acknowledgeCancellation).not.toHaveBeenCalled();
    expect(store.finalizeRun).not.toHaveBeenCalled();
    expect(store.closeAttempt).not.toHaveBeenCalled();
  });

  it('bounds the heartbeat interval', () => {
    expect(lifecycle.attemptHeartbeatMs({})).toBe(30_000);
    expect(lifecycle.attemptHeartbeatMs({ OPENLINEAR_ATTEMPT_HEARTBEAT_MS: '10' })).toBe(1_000);
    expect(lifecycle.attemptHeartbeatMs({ OPENLINEAR_ATTEMPT_HEARTBEAT_MS: '99999999' })).toBe(300_000);
  });
});
