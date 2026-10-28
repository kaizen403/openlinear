import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionState } from './state';
import type { TaskSnapshot } from '../../persistence/store';
import type { TaskAuthority as OwnedTask } from '../../auth/task-access';
import { HttpError } from '../../lib/errors';
import { requireLegacyRunner, resolveAgentId } from '../../engine/resolve-agent';

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(), getScmToken: vi.fn(), updateTask: vi.fn(), getActiveRepository: vi.fn(), assertTaskOwned: vi.fn(),
  getExecutionSettings: vi.fn(), ensureModelConfigured: vi.fn(), getClientForUser: vi.fn(),
  cloneRepository: vi.fn(), createBranch: vi.fn(), releaseLocalWorktree: vi.fn(),
  createAgentRun: vi.fn(), finalizeAgentRun: vi.fn(), subscribe: vi.fn(),
  failExecution: vi.fn(), broadcastProgress: vi.fn(), updateTaskStatus: vi.fn(),
  sessionCreate: vi.fn(), promptAsync: vi.fn(), sessionAbort: vi.fn(), cleanupExecution: vi.fn(),
  activeExecutions: new Map<string, ExecutionState>(), pendingExecutions: new Set<string>(),
  sessionToTask: new Map<string, string>(), pendingBatchTasks: new Set<string>(), taskHasActiveBatch: vi.fn(),
  /** The `{ status, sessionId }` read that decides "already running" (W17a fix). */
  heldState: { status: 'todo', sessionId: null as string | null },
}));

vi.mock('../opencode', () => ({ getClientForUser: mocks.getClientForUser }));
// W03a: authorization is the control plane's decision (stubbed here with the
// previous ownership contract); the real Prisma store runs the admission
// checks against a stubbed Prisma client below.
vi.mock('../../auth/task-access', () => ({
  authorizeTaskAccess: (credential: { principal?: { userId?: string } } | null, taskId: string) =>
    mocks.assertTaskOwned(taskId, credential?.principal?.userId ?? 'user-a'),
}));
vi.mock('../opencode-model', () => ({ ensureModelConfigured: mocks.ensureModelConfigured }));
vi.mock('../execution-settings', () => ({ getExecutionSettings: mocks.getExecutionSettings }));
vi.mock('../delta-buffer', () => ({ getOrCreateBuffer: vi.fn() }));
vi.mock('../batch/registry', () => ({ pendingBatchTasks: mocks.pendingBatchTasks, taskHasActiveBatch: mocks.taskHasActiveBatch }));
vi.mock('@openlinear/db', () => ({
  decryptToken: (value: string | null) => value,
  Prisma: { Decimal: class {} },
  prisma: {
    task: {
      // `select` reads are the activity-log scope lookup, not the snapshot read.
      findUnique: ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) =>
        (select ? Promise.resolve({ teamId: null, projectId: null, ...('sessionId' in select ? mocks.heldState : {}) }) : mocks.getTask(where.id)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (data.status === 'in_progress') await mocks.updateTaskStatus(where.id, 'in_progress', data.sessionId, data);
        else await mocks.updateTask(where.id, data);
        return { id: where.id, labels: [] };
      },
    },
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ accessToken: await mocks.getScmToken(where.id) }) },
    // W17a: no blockers.
    taskDependency: { findMany: async () => [] },
    agentRun: {
      create: async ({ data }: { data: { taskId: string; userId: string; agent: string; model: string } }) =>
        ({ id: await mocks.createAgentRun({ taskId: data.taskId, userId: data.userId, agent: data.agent, model: data.model }) }),
    },
    activityLog: { create: vi.fn() },
  },
}));
vi.mock('../../workspace/local-worktree', () => ({ releaseLocalWorktree: mocks.releaseLocalWorktree }));
vi.mock('./git', () => ({ cloneRepository: mocks.cloneRepository, createBranch: mocks.createBranch }));
vi.mock('./agent-run', () => ({ createAgentRun: mocks.createAgentRun, finalizeAgentRun: mocks.finalizeAgentRun }));
vi.mock('./events', () => ({
  subscribeToSessionEvents: mocks.subscribe, failExecutionFromEventStream: mocks.failExecution, claimFinalize: vi.fn(() => true),
}));
vi.mock('./state', () => ({
  activeExecutions: mocks.activeExecutions, pendingExecutions: mocks.pendingExecutions,
  pendingExecutionOwners: new Map<string, string>(),
  sessionToTask: mocks.sessionToTask, broadcastProgress: mocks.broadcastProgress,
  updateTaskStatus: mocks.updateTaskStatus, addLogEntry: vi.fn(), estimateProgress: vi.fn(),
  persistLogs: vi.fn(), cleanupExecution: mocks.cleanupExecution, TASK_TIMEOUT_MS: 60_000,
  buildReposPath: (name: string, id: string) => `/fixture/computed/${name}/${id}`,
}));

const { executeTask, cancelTask } = await import('./lifecycle');

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'task-a', title: 'Admission fixture', description: null, model: 'test/model', agent: null,
    teamId: 'team-a', creatorId: 'user-a', workspaceId: 'workspace-a', projectId: 'project-a', labels: [],
    project: {
      id: 'project-a', localPath: null, defaultAgent: null,
      repository: { id: 'repo-a', name: 'repo', fullName: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', defaultBranch: 'main' },
    },
    ...overrides,
  };
}

function ownership(snapshot: TaskSnapshot): OwnedTask {
  return { id: snapshot.id, projectId: snapshot.projectId, teamId: snapshot.teamId,
    creatorId: snapshot.creatorId, archived: false, status: 'todo' };
}

function noAgentOrRepositoryEffects() {
  expect(mocks.ensureModelConfigured).not.toHaveBeenCalled();
  expect(mocks.getActiveRepository).not.toHaveBeenCalled();
  expect(mocks.cloneRepository).not.toHaveBeenCalled();
  expect(mocks.createBranch).not.toHaveBeenCalled();
  expect(mocks.getClientForUser).not.toHaveBeenCalled();
  expect(mocks.sessionCreate).not.toHaveBeenCalled();
  expect(mocks.promptAsync).not.toHaveBeenCalled();
  expect(mocks.createAgentRun).not.toHaveBeenCalled();
  expect(mocks.updateTaskStatus).not.toHaveBeenCalled();
  expect(mocks.updateTask).not.toHaveBeenCalled();
  expect(mocks.activeExecutions.size).toBe(0);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.heldState = { status: 'todo', sessionId: null };
  mocks.activeExecutions.clear(); mocks.pendingExecutions.clear();
  mocks.pendingBatchTasks.clear(); mocks.sessionToTask.clear();
  mocks.getTask.mockResolvedValue(task());
  mocks.assertTaskOwned.mockResolvedValue(ownership(task()));
  mocks.getScmToken.mockResolvedValue(null);
  mocks.getExecutionSettings.mockResolvedValue({ parallelLimit: 3 });
  mocks.taskHasActiveBatch.mockReturnValue(false);
  mocks.ensureModelConfigured.mockResolvedValue({ model: 'test/model', hasProvider: true });
  mocks.cloneRepository.mockResolvedValue({ kind: 'local-worktree', runId: 'attempt-a', worktreePath: '/fixture/owned/attempt-a', mirrorPath: '/fixture/mirror', branch: 'openlinear/attempt-a' });
  mocks.createBranch.mockResolvedValue(undefined);
  mocks.releaseLocalWorktree.mockResolvedValue(undefined);
  mocks.sessionCreate.mockResolvedValue({ data: { id: 'session-a' } });
  mocks.promptAsync.mockResolvedValue({});
  mocks.sessionAbort.mockResolvedValue({ data: true });
  mocks.getClientForUser.mockResolvedValue({ session: { create: mocks.sessionCreate, promptAsync: mocks.promptAsync, abort: mocks.sessionAbort } });
  mocks.createAgentRun.mockResolvedValue('run-a');
  mocks.subscribe.mockResolvedValue(undefined);
  mocks.updateTaskStatus.mockResolvedValue(undefined);
  mocks.updateTask.mockResolvedValue(undefined);
  mocks.cleanupExecution.mockImplementation(async (taskId: string) => {
    const execution = mocks.activeExecutions.get(taskId);
    if (execution) {
      clearTimeout(execution.timeoutId);
      mocks.sessionToTask.delete(execution.sessionId);
    }
    mocks.activeExecutions.delete(taskId);
  });
  mocks.failExecution.mockImplementation(async (taskId: string) => {
    const execution = mocks.activeExecutions.get(taskId);
    if (execution) { execution.cancelled = true; execution.finalized = true; }
    await mocks.cleanupExecution(taskId);
  });
});

afterEach(() => {
  for (const execution of mocks.activeExecutions.values()) {
    clearTimeout(execution.timeoutId);
    if (execution.streamTimeoutId) clearTimeout(execution.streamTimeoutId);
    if (execution.progressTimeoutId) clearTimeout(execution.progressTimeoutId);
  }
  mocks.activeExecutions.clear(); mocks.pendingExecutions.clear();
});

describe('runner selection contract', () => {
  it.each([
    { input: {}, expected: 'opencode' },
    { input: { taskAgent: null, projectDefaultAgent: null }, expected: 'opencode' },
    { input: { taskAgent: ' OpenCode ' }, expected: 'opencode' },
    { input: { taskAgent: 'OPENAI-CODEX' }, expected: 'codex' },
    { input: { projectDefaultAgent: 'openai' }, expected: 'codex' },
    { input: { projectDefaultAgent: 'claude' }, expected: 'claude-code' },
    { input: { taskAgent: 'opencode', projectDefaultAgent: 'codex' }, expected: 'opencode' },
  ])('resolves $input to $expected without replacing explicit selection', ({ input, expected }) => {
    expect(resolveAgentId(input)).toBe(expected);
  });

  it.each(['', ' ', 'not-an-agent'])('does not interpret %j as the default runner', (selection) => {
    expect(() => requireLegacyRunner({ taskAgent: selection, projectDefaultAgent: 'opencode' })).toThrowError(expect.objectContaining({ statusCode: 400, code: 'INVALID_RUNNER' }));
  });

  it.each(['codex', 'openai', 'openai-codex', 'claude', 'claude-code'])('rejects the known but inactive legacy runner %s', (selection) => {
    expect(() => requireLegacyRunner({ taskAgent: selection })).toThrowError(expect.objectContaining({ statusCode: 400, code: 'RUNNER_NOT_SUPPORTED' }));
  });
});

describe('single-task execution boundary', () => {
  it('denies an unauthorized task before repository or provider effects', async () => {
    mocks.assertTaskOwned.mockRejectedValueOnce(new HttpError(403, 'OWNERSHIP_REQUIRED', 'Forbidden'));
    // W03a: an authorization denial keeps its 403 for the route (it used to
    // be decided by the route before executeTask ran).
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).rejects.toMatchObject({ statusCode: 403, code: 'OWNERSHIP_REQUIRED' });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-a', 'user-a');
    noAgentOrRepositoryEffects();
    expect(mocks.pendingExecutions.size).toBe(0);
  });

  it.each(['projectId', 'teamId', 'creatorId'] as const)('rejects a task whose %s changed after authorization before effects', async (field) => {
    const moved = task({ [field]: 'denied-binding' });
    if (field === 'projectId') moved.project = { ...moved.project!, id: 'denied-binding',
      repository: { ...moved.project!.repository!, id: 'denied-repo', cloneUrl: 'https://github.com/denied/repo.git' } };
    mocks.getTask.mockResolvedValueOnce(moved);
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, code: 'TASK_SELECTION_CHANGED' });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-a', 'user-a');
    noAgentOrRepositoryEffects();
    expect(mocks.pendingExecutions.size).toBe(0);
  });

  it('rejects authorization bound to a different task ID before effects', async () => {
    mocks.assertTaskOwned.mockResolvedValueOnce(ownership(task({ id: 'different-task' })));
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, code: 'TASK_SELECTION_CHANGED' });
    noAgentOrRepositoryEffects();
    expect(mocks.pendingExecutions.size).toBe(0);
  });

  it.each([
    { selected: 'codex', code: 'RUNNER_NOT_SUPPORTED' },
    { selected: 'claude-code', code: 'RUNNER_NOT_SUPPORTED' },
    { selected: 'typo', code: 'INVALID_RUNNER' },
    { selected: ' ', code: 'INVALID_RUNNER' },
  ])('rejects selected task runner $selected before preflight, Git, session or task mutation', async ({ selected, code }) => {
    // Null model would invoke preflight if runner admission happened too late.
    mocks.getTask.mockResolvedValueOnce(task({ agent: selected, model: null }));
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, code });
    noAgentOrRepositoryEffects();
    expect(mocks.pendingExecutions.has('task-a')).toBe(false);
    expect(mocks.broadcastProgress.mock.calls.every((call) => call[1] === 'error')).toBe(true);
  });

  it.each(['codex', 'claude-code', 'typo'])('rejects project-default runner %s when the task inherits it', async (selected) => {
    const fixture = task({ model: null });
    fixture.project!.defaultAgent = selected;
    mocks.getTask.mockResolvedValueOnce(fixture);
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, code: selected === 'typo' ? 'INVALID_RUNNER' : 'RUNNER_NOT_SUPPORTED' });
    noAgentOrRepositoryEffects();
    expect(mocks.pendingExecutions.size).toBe(0);
  });

  it('honors explicit task OpenCode over a project Codex default and records the effective runner', async () => {
    const fixture = task({ agent: ' OpenCode ' });
    fixture.project!.defaultAgent = 'codex';
    mocks.getTask.mockResolvedValueOnce(fixture);
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toEqual({ success: true });
    expect(mocks.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-a', agent: 'opencode' }));
    expect(mocks.getClientForUser).toHaveBeenCalledWith('user-a', '/fixture/owned/attempt-a');
    expect(mocks.promptAsync).toHaveBeenCalledOnce();
    expect(mocks.pendingExecutions.size).toBe(0);
  });

  it('does not submit a prompt after cancellation while the event subscription is preparing', async () => {
    let ready: () => void = () => { throw new Error('Subscription not started'); };
    mocks.subscribe.mockReturnValueOnce(new Promise<void>((resolve) => { ready = resolve; }));
    const starting = executeTask({ taskId: 'task-a', userId: 'user-a' });
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    expect(mocks.activeExecutions.has('task-a')).toBe(true);
    await expect(cancelTask('task-a')).resolves.toEqual({ success: true });
    ready();
    await expect(starting).resolves.toMatchObject({ success: false });
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect(mocks.sessionAbort).toHaveBeenCalledOnce();
    expect(mocks.activeExecutions.size).toBe(0);
    expect(mocks.pendingExecutions.size).toBe(0);
    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-a', cancelled: true }),
      'cancelled', { errorMessage: 'cancelled by user' });
  });

  it.each(['finalized', 'removed'] as const)('does not submit after a fast subscription event leaves the attempt %s', async (terminal) => {
    let ready: () => void = () => { throw new Error('Subscription not started'); };
    mocks.subscribe.mockReturnValueOnce(new Promise<void>((resolve) => { ready = resolve; }));
    const starting = executeTask({ taskId: 'task-a', userId: 'user-a' });
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    const execution = mocks.activeExecutions.get('task-a');
    if (!execution) throw new Error('Expected a registered attempt');
    if (terminal === 'finalized') execution.finalized = true;
    else { clearTimeout(execution.timeoutId); mocks.activeExecutions.delete('task-a'); }
    ready();
    await expect(starting).resolves.toMatchObject({ success: false });
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect(mocks.pendingExecutions.size).toBe(0);
  });

  it.each([
    { error: new Error('network dropped'), headline: 'Failed to send prompt to agent', message: 'network dropped' },
    { error: new Error('401 invalid API key'), headline: 'Invalid API key — update it in Settings → AI Providers', message: '401 invalid API key' },
  ])('reports failed start when promptAsync rejects with $message', async ({ error, headline, message }) => {
    mocks.promptAsync.mockRejectedValueOnce(error);
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, error: message });
    expect(mocks.failExecution).toHaveBeenCalledWith('task-a', headline, message);
    expect(mocks.activeExecutions.size).toBe(0);
    expect(mocks.pendingExecutions.size).toBe(0);
  });

  it('reports failed start when promptAsync returns a structured provider error', async () => {
    mocks.promptAsync.mockResolvedValueOnce({ error: { data: { message: 'model rejected' } } });
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, error: 'model rejected' });
    expect(mocks.failExecution).toHaveBeenCalledWith('task-a', 'Failed to send prompt to agent', 'model rejected');
    expect(mocks.activeExecutions.size).toBe(0);
    expect(mocks.pendingExecutions.size).toBe(0);
  });

  it('clears a rejected selection reservation so a corrected task can retry', async () => {
    mocks.getTask.mockResolvedValueOnce(task({ agent: 'codex' })).mockResolvedValueOnce(task({ agent: 'opencode' }));
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, code: 'RUNNER_NOT_SUPPORTED' });
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toEqual({ success: true });
    expect(mocks.cloneRepository).toHaveBeenCalledOnce();
    expect(mocks.createAgentRun).toHaveBeenCalledOnce();
  });

  it('does not let duplicate callers release an original preparation reservation', async () => {
    let continueRead: (value: TaskSnapshot) => void = () => { throw new Error('Read not started'); };
    mocks.getTask.mockReturnValueOnce(new Promise<TaskSnapshot>((resolve) => { continueRead = resolve; }));
    const original = executeTask({ taskId: 'task-a', userId: 'user-a' });
    await vi.waitFor(() => expect(mocks.getTask).toHaveBeenCalledOnce());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, code: 'TASK_ALREADY_RUNNING' });
      expect(mocks.pendingExecutions.has('task-a')).toBe(true);
    }
    continueRead(task());
    await expect(original).resolves.toEqual({ success: true });
    expect(mocks.getTask).toHaveBeenCalledOnce();
    expect(mocks.cloneRepository).toHaveBeenCalledOnce();
    expect(mocks.promptAsync).toHaveBeenCalledOnce();
    expect(mocks.pendingExecutions.has('task-a')).toBe(false);
  });

  it('cleans up its own reservation after an early settings read throws', async () => {
    mocks.getExecutionSettings.mockRejectedValueOnce(new Error('fixture settings unavailable'));
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, error: 'fixture settings unavailable' });
    expect(mocks.pendingExecutions.size).toBe(0);
    noAgentOrRepositoryEffects();
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toEqual({ success: true });
  });

  it('counts pending single preparations toward the limit and retains their reservations', async () => {
    mocks.pendingExecutions.add('other-a'); mocks.pendingExecutions.add('other-b');
    mocks.getExecutionSettings.mockResolvedValueOnce({ parallelLimit: 2 });
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, error: 'Parallel limit reached (2 tasks max)' });
    expect([...mocks.pendingExecutions]).toEqual(['other-a', 'other-b']);
    expect(mocks.getTask).not.toHaveBeenCalled();
    noAgentOrRepositoryEffects();
  });

  it('counts an active task with a pending prompt acknowledgement only once', async () => {
    mocks.getExecutionSettings.mockResolvedValue({ parallelLimit: 2 });
    mocks.getTask.mockImplementation(async (taskId: string) => task({ id: taskId }));
    mocks.assertTaskOwned.mockImplementation(async (taskId: string) => ownership(task({ id: taskId })));
    mocks.sessionCreate.mockResolvedValueOnce({ data: { id: 'session-a' } })
      .mockResolvedValueOnce({ data: { id: 'session-b' } });
    let acknowledgePrompt: () => void = () => { throw new Error('Prompt not dispatched'); };
    const acknowledgement = new Promise<Record<string, never>>((resolve) => {
      acknowledgePrompt = () => resolve({});
    });
    mocks.promptAsync.mockReturnValueOnce(acknowledgement);

    const first = executeTask({ taskId: 'task-a', userId: 'user-a' });
    try {
      await vi.waitFor(() => expect(mocks.promptAsync).toHaveBeenCalledOnce());
      expect(mocks.activeExecutions.has('task-a')).toBe(true);
      expect(mocks.pendingExecutions.has('task-a')).toBe(true);
      await expect(executeTask({ taskId: 'task-b', userId: 'user-a' })).resolves.toEqual({ success: true });
      await expect(executeTask({ taskId: 'task-c', userId: 'user-a' })).resolves.toMatchObject({
        success: false, error: 'Parallel limit reached (2 tasks max)',
      });
      expect([...mocks.activeExecutions.keys()]).toEqual(['task-a', 'task-b']);
      expect(mocks.pendingExecutions.has('task-a')).toBe(true);
      expect(mocks.getTask).toHaveBeenCalledTimes(2);
    } finally {
      acknowledgePrompt();
      await first;
    }
    await expect(first).resolves.toEqual({ success: true });
    expect(mocks.pendingExecutions.size).toBe(0);
  });

  it('rejects a batch preparation reservation without removing it', async () => {
    mocks.pendingBatchTasks.add('task-a');
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, code: 'TASK_ALREADY_RUNNING' });
    expect(mocks.pendingBatchTasks.has('task-a')).toBe(true);
    expect(mocks.getExecutionSettings).not.toHaveBeenCalled();
    expect(mocks.getTask).not.toHaveBeenCalled();
    noAgentOrRepositoryEffects();
  });

  it('rejects active batch membership before single-task preparation', async () => {
    mocks.taskHasActiveBatch.mockReturnValueOnce(true);
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, code: 'TASK_ALREADY_RUNNING' });
    expect(mocks.taskHasActiveBatch).toHaveBeenCalledWith('task-a');
    expect(mocks.getExecutionSettings).not.toHaveBeenCalled();
    noAgentOrRepositoryEffects();
  });

  it.each([
    { archived: true, status: 'todo', sessionId: null, code: 'TASK_ARCHIVED' },
    { archived: false, status: 'in_progress', sessionId: 'ses_running', code: 'TASK_ALREADY_RUNNING' },
  ])('rejects persisted $code before preparing a single task', async ({ archived, status, sessionId, code }) => {
    mocks.assertTaskOwned.mockResolvedValueOnce({ ...task(), archived, status });
    mocks.heldState = { status, sessionId };
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, code });
    expect(mocks.getTask).not.toHaveBeenCalled();
    noAgentOrRepositoryEffects();
  });

  it('does not substitute a global active repository for an unlinked task', async () => {
    const unlinked = task({ projectId: null, project: null });
    mocks.assertTaskOwned.mockResolvedValueOnce({ ...unlinked, archived: false, status: 'todo' });
    mocks.getTask.mockResolvedValueOnce(unlinked);
    mocks.getActiveRepository.mockResolvedValueOnce(task().project!.repository);
    await expect(executeTask({ taskId: 'task-a', userId: 'user-a' })).resolves.toMatchObject({ success: false, error: 'No active project selected' });
    noAgentOrRepositoryEffects();
  });
});
