import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  getClientForUser: vi.fn(),
  sessionCreate: vi.fn(),
  promptAsync: vi.fn(),
  abort: vi.fn(),
  taskUpdate: vi.fn(),
  failExecution: vi.fn(),
  closeAttempt: vi.fn(),
  claimAttempt: vi.fn(),
}));

vi.mock('@openlinear/db', () => ({
  prisma: {
    task: { update: mocks.taskUpdate },
    $executeRaw: vi.fn(async () => 1),
  },
}));
vi.mock('../../events/publisher', () => ({
  publishTaskEvent: vi.fn(),
  registerTaskOwnerResolver: vi.fn(),
  attachAttemptRelay: vi.fn(),
  detachAttemptRelay: vi.fn(),
}));
vi.mock('../opencode', () => ({ getClientForUser: mocks.getClientForUser }));
vi.mock('../opencode-model', () => ({ ensureModelConfigured: vi.fn() }));
vi.mock('../execution-settings', () => ({
  getExecutionSettings: vi.fn(async () => ({ parallelLimit: 3 })),
}));
// W03a store stand-in: the attempt start snapshots the task; only the
// persistence/agent boundaries are faked, real Git does the rest.
vi.mock('../../persistence/store', () => ({
  getSidecarStore: vi.fn(async () => ({
    mode: 'prisma',
    startAttempt: async (input: { taskId: string; userId: string; admit: (settings: { parallelLimit: number }) => string | null }) => {
      const task = await mocks.getTask(input.taskId);
      const settings = { parallelLimit: 3, maxBatchSize: 3, queueAutoApprove: false, stopOnFailure: false, conflictBehavior: 'skip' };
      const rejected = input.admit(settings);
      if (rejected) return { ok: false, error: rejected };
      return {
        ok: true,
        attempt: { taskId: input.taskId, userId: input.userId, attemptId: null, client: null, credential: null },
        task,
        authority: { id: task.id, projectId: task.project?.id ?? null, teamId: task.teamId, creatorId: task.creatorId, archived: false, status: 'todo' },
        settings,
      };
    },
    getGitCredential: async () => null,
    claimAttempt: mocks.claimAttempt,
    writeTaskStatus: async () => ({ id: 'task-12345678' }),
    persistLogs: async () => undefined,
    finalizeRun: async () => undefined,
    closeAttempt: mocks.closeAttempt,
  })),
}));
vi.mock('./agent-run', () => ({
  finalizeAgentRun: vi.fn(async () => undefined),
}));
vi.mock('./events', () => ({
  subscribeToSessionEvents: vi.fn(async () => undefined),
  failExecutionFromEventStream: mocks.failExecution,
  claimFinalize: vi.fn(() => true),
}));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('single-task lifecycle with real worktrees', () => {
  let root: string;
  let origin: string;
  let seed: string;
  let lifecycle: typeof import('./lifecycle');
  let state: typeof import('./state');
  const acquired: string[] = [];
  const client = {
    session: {
      create: mocks.sessionCreate,
      promptAsync: mocks.promptAsync,
      abort: mocks.abort,
    },
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ol-lifecycle-wt-'));
    origin = join(root, 'origin.git');
    seed = join(root, 'seed');
    mkdirSync(seed);
    git(root, ['init', '--bare', '--initial-branch=main', origin]);
    git(seed, ['init', '--initial-branch=main']);
    writeFileSync(join(seed, 'README.md'), 'fixture\n');
    git(seed, ['add', '.']);
    git(seed, ['-c', 'user.name=OpenLinear Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed']);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', 'origin', 'main']);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OPENLINEAR_ALLOW_FILE_GIT', '1');
    vi.stubEnv('OPENLINEAR_APP_DATA', join(root, 'appdata'));
    vi.stubEnv('REPOS_DIR', join(root, 'appdata', 'repos'));
    lifecycle = await import('./lifecycle');
    state = await import('./state');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    acquired.length = 0;
    mocks.getTask.mockResolvedValue({
      id: 'task-12345678',
      title: 'Exercise a real checkout',
      description: null,
      model: 'openai/test-model',
      agent: 'opencode',
      teamId: 'team-test',
      creatorId: 'user-test',
      labels: [],
      project: {
        id: 'project-test',
        localPath: null,
        repository: {
          id: 'repo-test',
          name: 'fixture',
          fullName: 'acme/fixture',
          cloneUrl: origin,
          defaultBranch: 'main',
        },
      },
    });
    mocks.getClientForUser.mockImplementation(async (_userId: string, directory: string) => {
      // Real git checks the directory, so a fabricated/computed path cannot
      // pass simply because a workspace mock echoed it back.
      expect(git(directory, ['rev-parse', '--show-toplevel'])).toBe(realpathSync(directory));
      acquired.push(directory);
      return client;
    });
    mocks.sessionCreate.mockImplementation(async ({ query }: { query: { directory: string } }) => {
      expect(readFileSync(join(query.directory, 'README.md'), 'utf8')).toBe('fixture\n');
      return { data: { id: 'ses_real_worktree_test' } };
    });
    mocks.promptAsync.mockResolvedValue({});
    mocks.abort.mockResolvedValue({ data: true });
    mocks.taskUpdate.mockResolvedValue({ id: 'task-12345678', labels: [] });
    mocks.failExecution.mockResolvedValue(undefined);
    mocks.claimAttempt.mockResolvedValue({ agentRunId: 'run-integration', task: null });
    mocks.closeAttempt.mockImplementation(async (attempt: { closed?: boolean }) => { attempt.closed = true; });
  });

  afterEach(async () => {
    for (const execution of [...state.activeExecutions.values()]) {
      await state.cleanupExecution(execution.taskId);
    }
    for (const directory of acquired) {
      if (!existsSync(directory)) continue;
      const mirror = git(directory, ['rev-parse', '--git-common-dir']);
      git(root, ['-C', mirror, 'worktree', 'remove', '--force', directory]);
    }
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the acquired checkout for branch, directory-bound client, session and execution state', async () => {
    const computedPath = state.buildReposPath('fixture', 'task-123');
    expect(existsSync(computedPath)).toBe(false);

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-test' })).resolves.toEqual({ success: true });

    const execution = state.activeExecutions.get('task-12345678');
    expect(execution).toBeDefined();
    if (!execution) throw new Error('execution was not registered');
    expect(execution.repoPath).not.toBe(computedPath);
    expect(execution.repoPath).toBe(acquired[0]);
    expect(git(execution.repoPath, ['branch', '--show-current'])).toBe(execution.branchName);
    expect(execution.branchName).toMatch(/^openlinear\/[0-9a-f-]{36}$/);
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      body: { title: 'Exercise a real checkout' },
      query: { directory: execution.repoPath },
    });
    expect(existsSync(computedPath)).toBe(false);
  });

  it('releases Git worktree registration when session setup fails and uses a fresh attempt on retry', async () => {
    mocks.sessionCreate.mockRejectedValue(new Error('agent unavailable'));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-test' })).resolves.toEqual({
        success: false,
        error: 'agent unavailable',
      });
      expect(existsSync(acquired[attempt])).toBe(false);
      expect(state.activeExecutions.has('task-12345678')).toBe(false);
    }
    expect(acquired[0]).not.toBe(acquired[1]);
    // W03a: each failed setup releases its control-plane attempt.
    expect(mocks.closeAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.claimAttempt).not.toHaveBeenCalled();
    const mirror = join(root, 'appdata', 'repos', root.split('/').pop() ?? '', 'origin.git');
    const registered = git(root, ['-C', mirror, 'worktree', 'list', '--porcelain']);
    for (const directory of acquired) expect(registered).not.toContain(directory);
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  it('releases the acquired checkout when session.create resolves without an id', async () => {
    mocks.sessionCreate.mockResolvedValue({ data: {} });

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-test' })).resolves.toEqual({
      success: false,
      error: 'Failed to create OpenCode session',
    });
    expect(existsSync(acquired[0])).toBe(false);
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  it('preserves a user-owned local checkout when session setup fails', async () => {
    mocks.getTask.mockResolvedValue({
      id: 'task-12345678', title: 'Local checkout', description: null, model: 'openai/test-model',
      labels: [], teamId: 'team-test', creatorId: 'user-test',
      project: { id: 'local-project', localPath: seed, repository: null },
    });
    mocks.sessionCreate.mockRejectedValue(new Error('agent unavailable'));

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-test' })).resolves.toEqual({
      success: false,
      error: 'agent unavailable',
    });
    expect(readFileSync(join(seed, 'README.md'), 'utf8')).toBe('fixture\n');
    expect(existsSync(join(seed, '.git'))).toBe(true);
    // afterEach removes only owned remote worktrees.
    acquired.splice(0, acquired.length);
  });

  it('retains modified work after a dispatched prompt loses its acknowledgement', async () => {
    mocks.promptAsync.mockImplementationOnce(async () => {
      writeFileSync(join(acquired[0], 'lost-response.txt'), 'work written before acknowledgement was lost\n');
      throw new TypeError('prompt response lost');
    });
    // The provider has stopped and normal failure finalization releases the
    // active state. That must not make dispatched work disposable setup.
    mocks.failExecution.mockImplementationOnce(async (id: string) => { await state.cleanupExecution(id); });

    await expect(lifecycle.executeTask({ taskId: 'task-12345678', userId: 'user-test' }))
      .resolves.toMatchObject({ success: false, error: 'prompt response lost' });

    expect(state.activeExecutions.has('task-12345678')).toBe(false);
    expect(existsSync(acquired[0])).toBe(true);
    expect(readFileSync(join(acquired[0], 'lost-response.txt'), 'utf8')).toContain('work written before acknowledgement');
    const mirror = git(acquired[0], ['rev-parse', '--git-common-dir']);
    expect(git(root, ['-C', mirror, 'worktree', 'list', '--porcelain'])).toContain(acquired[0]);
  });
});
