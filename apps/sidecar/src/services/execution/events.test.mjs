import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  repositoryFindUnique: vi.fn(),
  projectFindUnique: vi.fn(),
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn(),
  executeRaw: vi.fn(),
  commitAndPush: vi.fn(),
  createPullRequest: vi.fn(),
  hasCommittableChanges: vi.fn(),
  finalizeAgentRun: vi.fn(),
  recordMessageUsage: vi.fn(),
  appendTextDelta: vi.fn(),
  appendReasoningDelta: vi.fn(),
  flushDeltaBuffer: vi.fn(),
  cleanupDeltaBuffer: vi.fn(),
  markThinking: vi.fn(() => true),
  broadcastToTask: vi.fn(),
  broadcastToTaskById: vi.fn(),
}));

vi.mock('@openlinear/db', () => ({
  prisma: {
    repository: { findUnique: mocks.repositoryFindUnique },
    project: { findUnique: mocks.projectFindUnique },
    task: {
      findUnique: mocks.taskFindUnique,
      update: mocks.taskUpdate,
    },
    $executeRaw: mocks.executeRaw,
  },
}));

vi.mock('@openlinear/api/sse', () => ({
  broadcastToTask: mocks.broadcastToTask,
  broadcastToTaskById: mocks.broadcastToTaskById,
}));

vi.mock('../delta-buffer', () => ({
  appendTextDelta: mocks.appendTextDelta,
  appendReasoningDelta: mocks.appendReasoningDelta,
  flushDeltaBuffer: mocks.flushDeltaBuffer,
  cleanupDeltaBuffer: mocks.cleanupDeltaBuffer,
  markThinking: mocks.markThinking,
}));

vi.mock('../repo-storage', () => ({
  REPOS_DIR: '/tmp/openlinear-repos',
  buildReposPath: vi.fn((projectName, shortId) => `/repos/${projectName}/${shortId}`),
  assertPathInsideReposDir: vi.fn((path) => path),
}));

vi.mock('./git', () => ({
  commitAndPush: mocks.commitAndPush,
  createPullRequest: mocks.createPullRequest,
  hasCommittableChanges: mocks.hasCommittableChanges,
}));

vi.mock('./agent-run', () => ({
  finalizeAgentRun: mocks.finalizeAgentRun,
  recordMessageUsage: mocks.recordMessageUsage,
}));

const { subscribeToSessionEvents } = await import('./events');
const state = await import('./state');

function makeExecution(overrides = {}) {
  return {
    taskId: 'task-1',
    projectId: 'repo-1',
    sessionId: 'ses_1',
    repoPath: '/repo',
    branchName: 'openlinear/task-1',
    userId: 'user-1',
    accessToken: 'token',
    timeoutId: setTimeout(() => undefined, 10_000),
    streamTimeoutId: null,
    status: 'executing',
    logs: [],
    client: { session: { abort: vi.fn().mockResolvedValue({}) } },
    startedAt: new Date(Date.now() - 60_000),
    filesChanged: 0,
    toolsExecuted: 0,
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

function clientFor(events) {
  return {
    event: {
      subscribe: vi.fn().mockResolvedValue({
        stream: {
          async *[Symbol.asyncIterator]() {
            for (const event of events) {
              yield event;
            }
          },
          return: vi.fn(),
        },
      }),
    },
    session: {
      abort: vi.fn().mockResolvedValue({}),
    },
  };
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 500) {
      throw new Error('Timed out waiting for event processing');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('execution event workflow', () => {
  beforeEach(() => {
    state.activeExecutions.clear();
    state.sessionToTask.clear();
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.broadcastToTaskById.mockResolvedValue(undefined);
    mocks.markThinking.mockReturnValue(true);
    mocks.taskUpdate.mockResolvedValue({ id: 'task-1', labels: [] });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.commitAndPush.mockResolvedValue({ status: 'pushed' });
    mocks.createPullRequest.mockResolvedValue({ url: 'https://github.com/acme/repo/pull/1', type: 'pr' });
    mocks.repositoryFindUnique.mockResolvedValue({ fullName: 'acme/repo', defaultBranch: 'main' });
    mocks.taskFindUnique.mockResolvedValue({ title: 'Fix execution', description: 'Body', projectId: 'project-1' });
  });

  afterEach(async () => {
    for (const taskId of [...state.activeExecutions.keys()]) {
      await state.cleanupExecution(taskId);
    }
    state.activeExecutions.clear();
    state.sessionToTask.clear();
  });

  it('processes session events into logs, counts, PR creation, and cleanup', async () => {
    const execution = makeExecution();
    const client = clientFor([
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'text' }, delta: 'Working...' } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'tool', tool: 'edit', state: { status: 'completed', output: 'ok' } } } },
      { type: 'file.edited', properties: { sessionID: 'ses_1', file: 'src/index.ts' } },
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);
    execution.client = client;
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => !state.activeExecutions.has('task-1'));

    expect(mocks.appendTextDelta).toHaveBeenCalledWith('task-1', 'Working...');
    expect(mocks.commitAndPush).toHaveBeenCalledWith('/repo', 'openlinear/task-1', 'Fix execution', 'token');
    expect(mocks.createPullRequest).toHaveBeenCalledWith(
      'acme/repo',
      'openlinear/task-1',
      'main',
      'Fix execution',
      'Body',
      'token',
    );
    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'succeeded', {
      prUrl: 'https://github.com/acme/repo/pull/1',
    });
    expect(mocks.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1' },
      data: expect.objectContaining({
        status: 'done',
        sessionId: null,
        executionProgress: 100,
        prUrl: 'https://github.com/acme/repo/pull/1',
      }),
    }));
    expect(mocks.cleanupDeltaBuffer).toHaveBeenCalledWith('task-1');
  });

  it('turns session auth errors into cancelled task state', async () => {
    const execution = makeExecution();
    const client = clientFor([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { data: { message: 'Unauthorized API key', statusCode: 401 } },
        },
      },
    ]);
    execution.client = client;
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => !state.activeExecutions.has('task-1'));

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Unauthorized API key',
    });
    expect(mocks.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'cancelled',
        sessionId: null,
      }),
    }));
    expect(mocks.broadcastToTaskById).toHaveBeenCalledWith(
      'task-1',
      'execution:progress',
      expect.objectContaining({
        status: 'error',
        message: 'Invalid API key — update it in Settings → AI Providers',
      }),
    );
  });

  it('waits for launched background subtasks before completing the session', async () => {
    const execution = makeExecution();
    let releaseStream = () => undefined;
    const stream = {
      return: vi.fn(() => {
        releaseStream();
        return Promise.resolve();
      }),
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_1',
            part: {
              type: 'tool',
              tool: 'task',
              state: { status: 'completed', output: 'Background task started\nBackground Task ID: bg_123\nstate: running' },
            },
          },
        };
        yield { type: 'session.completed', properties: { sessionID: 'ses_1' } };
        await new Promise((resolve) => {
          releaseStream = resolve;
        });
      },
    };
    const client = {
      event: {
        subscribe: vi.fn().mockResolvedValue({ stream }),
      },
      session: {
        abort: vi.fn().mockResolvedValue({}),
      },
    };
    execution.client = client;
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => execution.backgroundTaskRunning === true);

    expect(execution.backgroundTaskIds).toEqual(['bg_123']);
    expect(state.activeExecutions.has('task-1')).toBe(true);
    expect(mocks.commitAndPush).not.toHaveBeenCalled();

    execution.cancelled = true;
    await state.cleanupExecution('task-1');
  });
});
