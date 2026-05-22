import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn(),
  repositoryFindFirst: vi.fn(),
  executeRaw: vi.fn(),
  decryptToken: vi.fn((value) => value ? `decrypted:${value}` : null),
  getClientForUser: vi.fn(),
  getOrCreateBuffer: vi.fn(),
  cleanupDeltaBuffer: vi.fn(),
  flushDeltaBuffer: vi.fn(),
  getExecutionSettings: vi.fn(),
  cloneRepository: vi.fn(),
  createBranch: vi.fn(),
  subscribeToSessionEvents: vi.fn(),
  createAgentRun: vi.fn(),
  finalizeAgentRun: vi.fn(),
  broadcastToTask: vi.fn(),
  broadcastToTaskById: vi.fn(),
  buildReposPath: vi.fn((projectName, shortId) => `/repos/${projectName}/${shortId}`),
}));

vi.mock('@openlinear/db', () => ({
  decryptToken: mocks.decryptToken,
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: {
      findUnique: mocks.taskFindUnique,
      update: mocks.taskUpdate,
    },
    repository: { findFirst: mocks.repositoryFindFirst },
    $executeRaw: mocks.executeRaw,
  },
}));

vi.mock('@openlinear/api/sse', () => ({
  broadcastToTask: mocks.broadcastToTask,
  broadcastToTaskById: mocks.broadcastToTaskById,
}));

vi.mock('../opencode', () => ({ getClientForUser: mocks.getClientForUser }));
vi.mock('../delta-buffer', () => ({
  getOrCreateBuffer: mocks.getOrCreateBuffer,
  flushDeltaBuffer: mocks.flushDeltaBuffer,
  cleanupDeltaBuffer: mocks.cleanupDeltaBuffer,
}));
vi.mock('../execution-settings', () => ({ getExecutionSettings: mocks.getExecutionSettings }));
vi.mock('../repo-storage', () => ({
  REPOS_DIR: '/tmp/openlinear-repos',
  buildReposPath: mocks.buildReposPath,
  assertPathInsideReposDir: vi.fn((path) => path),
}));
vi.mock('./git', () => ({
  cloneRepository: mocks.cloneRepository,
  createBranch: mocks.createBranch,
}));
vi.mock('./events', () => ({ subscribeToSessionEvents: mocks.subscribeToSessionEvents }));
vi.mock('./agent-run', () => ({
  createAgentRun: mocks.createAgentRun,
  finalizeAgentRun: mocks.finalizeAgentRun,
}));

const lifecycle = await import('./lifecycle');
const state = await import('./state');

function makeClient(overrides = {}) {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } }),
      prompt: vi.fn().mockResolvedValue({}),
      abort: vi.fn().mockResolvedValue({}),
    },
    config: {
      get: vi.fn().mockResolvedValue({ data: { model: 'openai/gpt-5' } }),
    },
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-12345678',
    title: 'Fix execution',
    description: 'Make it reliable',
    model: 'anthropic/claude-sonnet',
    labels: [{ label: { name: 'backend' } }],
    project: {
      id: 'project-1',
      localPath: null,
      repository: {
        id: 'repo-1',
        name: 'repo',
        fullName: 'acme/repo',
        cloneUrl: 'https://github.com/acme/repo.git',
        defaultBranch: 'main',
      },
    },
    ...overrides,
  };
}

function makeExecution(overrides = {}) {
  return {
    taskId: 'task-1',
    projectId: 'repo-1',
    sessionId: 'ses_1',
    repoPath: '/repo',
    branchName: 'openlinear/task-1',
    userId: 'user-1',
    accessToken: null,
    timeoutId: setTimeout(() => undefined, 10_000),
    streamTimeoutId: null,
    status: 'executing',
    logs: [],
    client: makeClient(),
    startedAt: new Date('2026-05-22T00:00:00.000Z'),
    filesChanged: 1,
    toolsExecuted: 1,
    promptSent: true,
    backgroundTaskRunning: false,
    backgroundTaskFailure: null,
    backgroundTaskIds: [],
    backgroundTaskResultBuffer: '',
    completedToolKeys: new Set(),
    cancelled: false,
    agentRunId: 'run-1',
    cost: { input: 0, output: 0, total: 0 },
    tokens: { input: 0, output: 0 },
    messageUsage: new Map(),
    ...overrides,
  };
}

async function waitFor(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for lifecycle side effect');
}

describe('execution lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T00:01:00.000Z'));
    state.activeExecutions.clear();
    state.sessionToTask.clear();
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.broadcastToTaskById.mockResolvedValue(undefined);
    mocks.decryptToken.mockImplementation((value) => value ? `decrypted:${value}` : null);
    mocks.getExecutionSettings.mockResolvedValue({
      parallelLimit: 3,
      maxBatchSize: 3,
      queueAutoApprove: false,
      stopOnFailure: false,
      conflictBehavior: 'skip',
    });
    mocks.taskUpdate.mockResolvedValue({ id: 'task-12345678', labels: [] });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.cloneRepository.mockResolvedValue(undefined);
    mocks.createBranch.mockResolvedValue(undefined);
    mocks.createAgentRun.mockResolvedValue('run-1');
  });

  afterEach(() => {
    for (const execution of state.activeExecutions.values()) {
      clearTimeout(execution.timeoutId);
      if (execution.streamTimeoutId) clearTimeout(execution.streamTimeoutId);
    }
    state.activeExecutions.clear();
    state.sessionToTask.clear();
    vi.useRealTimers();
  });

  it('rejects duplicate and over-limit executions before touching the database', async () => {
    state.activeExecutions.set('task-1', makeExecution({ taskId: 'task-1' }));

    await expect(lifecycle.executeTask({ taskId: 'task-1', userId: 'user-1' })).resolves.toEqual({
      success: false,
      error: 'Task is already running',
    });

    state.activeExecutions.clear();
    state.activeExecutions.set('other-task', makeExecution({ taskId: 'other-task' }));
    mocks.getExecutionSettings.mockResolvedValueOnce({
      parallelLimit: 1,
      maxBatchSize: 3,
      queueAutoApprove: false,
      stopOnFailure: false,
      conflictBehavior: 'skip',
    });

    await expect(lifecycle.executeTask({ taskId: 'task-1', userId: 'user-1' })).resolves.toEqual({
      success: false,
      error: 'Parallel limit reached (1 tasks max)',
    });
    expect(mocks.taskFindUnique).not.toHaveBeenCalled();
  });

  it('returns task not found when the requested task does not exist', async () => {
    mocks.taskFindUnique.mockResolvedValue(null);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: false,
      error: 'Task not found',
    });
  });

  it('starts a repository-backed OpenCode execution and stores active state', async () => {
    const client = makeClient();
    mocks.userFindUnique.mockResolvedValue({ accessToken: 'secret' });
    mocks.taskFindUnique.mockResolvedValue(makeTask());
    mocks.getClientForUser.mockResolvedValue(client);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });

    expect(mocks.cloneRepository).toHaveBeenCalledWith(
      'https://github.com/acme/repo.git',
      '/repos/repo/task-123',
      'decrypted:secret',
      'main',
    );
    expect(mocks.createBranch).toHaveBeenCalledWith('/repos/repo/task-123', 'openlinear/task-123');
    expect(mocks.getClientForUser).toHaveBeenCalledWith('user-1', '/repos/repo/task-123');
    expect(mocks.createAgentRun).toHaveBeenCalledWith({
      taskId: 'task-12345678',
      userId: 'user-1',
      agent: 'opencode',
      model: 'anthropic/claude-sonnet',
    });
    expect(state.activeExecutions.get('task-12345678')).toMatchObject({
      taskId: 'task-12345678',
      projectId: 'repo-1',
      sessionId: 'ses_1',
      repoPath: '/repos/repo/task-123',
      branchName: 'openlinear/task-123',
      status: 'executing',
    });
    expect(state.sessionToTask.get('ses_1')).toBe('task-12345678');
    expect(mocks.subscribeToSessionEvents).toHaveBeenCalledWith('task-12345678', client, 'ses_1');
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      body: {
        parts: [{
          type: 'text',
          text: expect.stringContaining('Fix execution\n\nMake it reliable\n\nLabels: backend'),
        }],
        model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      },
    });
  });

  it('records buffered agent messages during execution setup', async () => {
    const client = makeClient();
    mocks.userFindUnique.mockResolvedValue({ accessToken: 'secret' });
    mocks.taskFindUnique.mockResolvedValue(makeTask());
    mocks.getClientForUser.mockResolvedValue(client);
    mocks.getOrCreateBuffer.mockImplementationOnce((_taskId, emit) => {
      emit('agent booted');
    });

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });

    expect(state.activeExecutions.get('task-12345678').logs).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'agent', message: 'agent booted' })]),
    );
  });

  it('continues with a null token when decryption fails', async () => {
    const client = makeClient();
    mocks.userFindUnique.mockResolvedValue({ accessToken: 'secret' });
    mocks.decryptToken.mockImplementationOnce(() => {
      throw new Error('bad token');
    });
    mocks.taskFindUnique.mockResolvedValue(makeTask());
    mocks.getClientForUser.mockResolvedValue(client);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });

    expect(mocks.cloneRepository).toHaveBeenCalledWith(
      'https://github.com/acme/repo.git',
      '/repos/repo/task-123',
      null,
      'main',
    );
  });

  it('starts execution against a project localPath without cloning', async () => {
    const client = makeClient({
      config: { get: vi.fn().mockRejectedValue(new Error('no config')) },
    });
    mocks.taskFindUnique.mockResolvedValue(makeTask({
      model: null,
      project: {
        id: 'project-1',
        localPath: '/local/repo',
        repository: null,
      },
    }));
    mocks.getClientForUser.mockResolvedValue(client);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });

    expect(mocks.cloneRepository).not.toHaveBeenCalled();
    expect(mocks.createBranch).toHaveBeenCalledWith('/local/repo', 'openlinear/task-123');
    expect(mocks.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ model: 'unknown' }));
  });

  it('uses the local project id fallback when localPath projects have no id', async () => {
    const client = makeClient();
    mocks.taskFindUnique.mockResolvedValue(makeTask({
      project: {
        localPath: '/local/repo',
        repository: null,
      },
    }));
    mocks.getClientForUser.mockResolvedValue(client);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });

    expect(state.activeExecutions.get('task-12345678')).toMatchObject({ projectId: 'local' });
  });

  it('keeps the model unknown when OpenCode config has no selected model', async () => {
    const client = makeClient({
      config: { get: vi.fn().mockResolvedValue({ data: {} }) },
    });
    mocks.taskFindUnique.mockResolvedValue(makeTask({ model: null }));
    mocks.getClientForUser.mockResolvedValue(client);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });

    expect(mocks.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ model: 'unknown' }));
  });

  it('builds prompts without optional description, labels, or model override', async () => {
    const client = makeClient({
      config: { get: vi.fn().mockResolvedValue({ data: {} }) },
    });
    mocks.taskFindUnique.mockResolvedValue(makeTask({
      description: null,
      model: null,
      labels: [],
    }));
    mocks.getClientForUser.mockResolvedValue(client);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });

    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      body: {
        parts: [{
          type: 'text',
          text: expect.not.stringContaining('Labels:'),
        }],
      },
    });
  });

  it('returns a clear error when no project or repository can be resolved', async () => {
    mocks.taskFindUnique.mockResolvedValue(makeTask({
      project: null,
    }));
    mocks.repositoryFindFirst.mockResolvedValue(null);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: false,
      error: 'No active project selected',
    });
  });

  it('uses the anonymous active repository fallback but rejects execution without a user id', async () => {
    mocks.taskFindUnique.mockResolvedValue(makeTask({ project: null }));
    mocks.repositoryFindFirst.mockResolvedValue({
      id: 'repo-1',
      name: 'repo',
      fullName: 'acme/repo',
      cloneUrl: 'https://github.com/acme/repo.git',
      defaultBranch: 'main',
    });

    await expect(lifecycle.executeTask({ taskId: 'task-12345678' })).resolves.toEqual({
      success: false,
      error: 'userId is required for execution',
    });

    expect(mocks.repositoryFindFirst).toHaveBeenCalledWith({ where: { userId: null, isActive: true } });
  });

  it('returns execution setup errors from the outer catch', async () => {
    mocks.taskFindUnique.mockResolvedValue(makeTask({
      project: {
        id: 'project-1',
        localPath: '/local/repo',
        repository: null,
      },
    }));
    mocks.createBranch.mockRejectedValue(new Error('branch failed'));

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: false,
      error: 'branch failed',
    });
  });

  it('returns an unknown setup error for non-Error failures', async () => {
    mocks.taskFindUnique.mockResolvedValue(makeTask({
      project: {
        id: 'project-1',
        localPath: '/local/repo',
        repository: null,
      },
    }));
    mocks.createBranch.mockRejectedValue('branch failed');

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: false,
      error: 'Unknown error',
    });
  });

  it('returns a session creation error when OpenCode omits the session id', async () => {
    const client = makeClient({
      session: {
        create: vi.fn().mockResolvedValue({ data: {} }),
        prompt: vi.fn().mockResolvedValue({}),
        abort: vi.fn().mockResolvedValue({}),
      },
    });
    mocks.taskFindUnique.mockResolvedValue(makeTask());
    mocks.getClientForUser.mockResolvedValue(client);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: false,
      error: 'Failed to create OpenCode session',
    });
  });

  it('cancels long-running tasks when their execution timeout fires', async () => {
    const client = makeClient();
    mocks.taskFindUnique.mockResolvedValue(makeTask());
    mocks.getClientForUser.mockResolvedValue(client);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(expect.any(Object), 'cancelled', {
      errorMessage: 'cancelled by user',
    });
    expect(state.activeExecutions.has('task-12345678')).toBe(false);
  });

  it('cleans up when prompt submission fails with a non-auth error', async () => {
    const client = makeClient({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } }),
        prompt: vi.fn().mockRejectedValue(new Error('network dropped')),
        abort: vi.fn().mockResolvedValue({}),
      },
    });
    mocks.taskFindUnique.mockResolvedValue(makeTask());
    mocks.getClientForUser.mockResolvedValue(client);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });
    await waitFor(() => !state.activeExecutions.has('task-12345678'));

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(expect.any(Object), 'failed', {
      errorMessage: 'network dropped',
    });
    expect(mocks.broadcastToTaskById).toHaveBeenCalledWith(
      'task-12345678',
      'execution:progress',
      expect.objectContaining({ message: 'Failed to send prompt to agent' }),
    );
  });

  it('surfaces auth and unknown prompt submission failures', async () => {
    const authClient = makeClient({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } }),
        prompt: vi.fn().mockRejectedValue(new Error('401 invalid API key')),
        abort: vi.fn().mockResolvedValue({}),
      },
    });
    mocks.taskFindUnique.mockResolvedValue(makeTask());
    mocks.getClientForUser.mockResolvedValue(authClient);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });
    await waitFor(() => !state.activeExecutions.has('task-12345678'));

    expect(mocks.broadcastToTaskById).toHaveBeenCalledWith(
      'task-12345678',
      'execution:progress',
      expect.objectContaining({ message: 'Invalid API key — update it in Settings → AI Providers' }),
    );

    const unknownClient = makeClient({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } }),
        prompt: vi.fn().mockRejectedValue({}),
        abort: vi.fn().mockResolvedValue({}),
      },
    });
    mocks.taskFindUnique.mockResolvedValue(makeTask());
    mocks.getClientForUser.mockResolvedValue(unknownClient);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-1' })).resolves.toEqual({
      success: true,
    });
    await waitFor(() => !state.activeExecutions.has('task-12345678'));

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(expect.any(Object), 'failed', {
      errorMessage: 'Unknown error',
    });
  });

  it('cancels active executions, aborts the session, and clears active state', async () => {
    const client = makeClient();
    const execution = makeExecution({ client, startedAt: new Date('2026-05-22T00:00:00.000Z') });
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await expect(lifecycle.cancelTask('task-1')).resolves.toEqual({ success: true });

    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'cancelled', {
      errorMessage: 'cancelled by user',
    });
    expect(mocks.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1' },
      data: expect.objectContaining({
        status: 'cancelled',
        sessionId: null,
        executionElapsedMs: 60_000,
      }),
    }));
    expect(state.activeExecutions.has('task-1')).toBe(false);
    expect(state.sessionToTask.has('ses_1')).toBe(false);
  });

  it('still completes cancellation when the OpenCode abort call fails', async () => {
    const client = makeClient({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } }),
        prompt: vi.fn().mockResolvedValue({}),
        abort: vi.fn().mockRejectedValue(new Error('abort failed')),
      },
    });
    const execution = makeExecution({ client });
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await expect(lifecycle.cancelTask('task-1')).resolves.toEqual({ success: true });

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'cancelled', {
      errorMessage: 'cancelled by user',
    });
    expect(state.activeExecutions.has('task-1')).toBe(false);
  });

  it('returns a clear error when cancelling a task that is not running', async () => {
    await expect(lifecycle.cancelTask('missing')).resolves.toEqual({
      success: false,
      error: 'Task is not running',
    });
  });
});
