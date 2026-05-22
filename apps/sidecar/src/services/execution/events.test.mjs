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

async function runEvents(events, executionOverrides = {}) {
  const execution = makeExecution(executionOverrides);
  const client = clientFor(events);
  execution.client = client;
  state.activeExecutions.set(execution.taskId, execution);
  state.sessionToTask.set(execution.sessionId, execution.taskId);

  await subscribeToSessionEvents(execution.taskId, client, execution.sessionId);
  await waitFor(() => !state.activeExecutions.has(execution.taskId));
  return { client, execution };
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

  it('fails completion immediately when a background task failure is already recorded', async () => {
    const { execution } = await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ], { backgroundTaskFailure: 'background failed before completion' });

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Background subtask failed: background failed before completion',
    });
  });

  it('ignores events that cannot be associated with a session', async () => {
    const execution = makeExecution({ cancelled: true });
    const client = clientFor([
      { type: 'message.part.updated', properties: { part: { type: 'text' }, delta: 'ignored' } },
    ]);
    execution.client = client;
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await Promise.resolve();

    expect(mocks.appendTextDelta).not.toHaveBeenCalledWith('task-1', 'ignored');
    await state.cleanupExecution('task-1');
  });

  it('creates compare-link completions when GitHub PR creation falls back', async () => {
    mocks.createPullRequest.mockResolvedValueOnce({
      url: 'https://github.com/acme/repo/compare/main...openlinear/task-1',
      type: 'compare',
    });

    await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ], { filesChanged: 2, toolsExecuted: 3 });

    expect(mocks.broadcastToTaskById).toHaveBeenCalledWith(
      'task-1',
      'execution:progress',
      expect.objectContaining({
        status: 'done',
        message: 'Changes pushed successfully',
        prUrl: 'https://github.com/acme/repo/compare/main...openlinear/task-1',
        isCompareLink: true,
      }),
    );
  });

  it('fails completed sessions when no committable changes remain', async () => {
    mocks.commitAndPush.mockResolvedValueOnce({ status: 'no_changes' });

    const { execution } = await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Agent finished without making code changes',
    });
    expect(mocks.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'cancelled',
        outcome: 'Agent finished without making code changes',
      }),
    }));
  });

  it('fails completed sessions when commit and push fail', async () => {
    mocks.commitAndPush.mockResolvedValueOnce({ status: 'failed', reason: 'push denied' });

    const { execution } = await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Commit/push failed: push denied',
    });
  });

  it('fails completed sessions when repository metadata cannot be resolved', async () => {
    mocks.repositoryFindUnique.mockResolvedValueOnce(null);
    mocks.taskFindUnique
      .mockResolvedValueOnce({ title: 'Fix execution' })
      .mockResolvedValueOnce({ title: 'Fix execution', description: null, projectId: null });

    const { execution } = await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.projectFindUnique).not.toHaveBeenCalled();
    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Changes committed but no repository linked to create PR',
    });
  });

  it('resolves repository metadata through the task project fallback', async () => {
    mocks.repositoryFindUnique.mockResolvedValueOnce(null);
    mocks.projectFindUnique.mockResolvedValueOnce({
      repository: { fullName: 'fallback/repo', defaultBranch: 'trunk' },
    });

    await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.createPullRequest).toHaveBeenCalledWith(
      'fallback/repo',
      'openlinear/task-1',
      'trunk',
      'Fix execution',
      'Body',
      'token',
    );
  });

  it('records post-execution errors when PR creation throws', async () => {
    mocks.createPullRequest.mockRejectedValueOnce(new Error('github down'));

    const { execution } = await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'github down',
    });
    expect(mocks.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'cancelled',
        outcome: 'github down',
      }),
    }));
  });

  it('recovers committable work when the event stream fails after changes', async () => {
    const execution = makeExecution({
      client: { session: { abort: vi.fn().mockRejectedValue(new Error('abort failed')) } },
    });
    const stream = {
      async *[Symbol.asyncIterator]() {
        throw new Error('socket closed');
      },
      return: vi.fn(),
    };
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
      session: execution.client.session,
    };
    execution.client = client;
    mocks.hasCommittableChanges.mockResolvedValueOnce(true);
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => !state.activeExecutions.has('task-1'));

    expect(mocks.hasCommittableChanges).toHaveBeenCalledWith('/repo');
    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'succeeded', {
      prUrl: 'https://github.com/acme/repo/pull/1',
    });
  });

  it('cancels executions when event subscription itself fails', async () => {
    const execution = makeExecution();
    const client = {
      event: { subscribe: vi.fn().mockRejectedValue(new Error('subscribe failed')) },
      session: { abort: vi.fn().mockRejectedValue(new Error('abort failed')) },
    };
    execution.client = client;
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Failed to subscribe to agent events: subscribe failed',
    });
    expect(state.activeExecutions.has('task-1')).toBe(false);
  });

  it('tracks background task completion, tool states, reasoning, and retry status', async () => {
    const { execution } = await runEvents([
      { type: 'server.heartbeat', properties: { sessionID: 'ses_1' } },
      { type: 'session.status', properties: { id: 'ses_1', status: { type: 'retry', message: 'network busy' } } },
      {
        type: 'message.part.updated',
        properties: {
          info: { id: 'ses_1' },
          part: { type: 'tool', tool: 'task', state: { status: 'completed', output: 'Background task started\nBackground Task ID: bg_42\nstate: running' } },
        },
      },
      { type: 'message.part.updated', properties: { session: { id: 'ses_1' }, part: { type: 'text' }, delta: 'Background task completed: all good' } },
      { type: 'message.part.updated', properties: { part: { sessionID: 'ses_1', type: 'reasoning' }, delta: 'thinking' } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'tool', tool: 'edit', state: { status: 'running', title: 'Patch file' } } } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'tool', tool: 'edit', state: { status: 'error', output: 'bad patch' } } } },
      { type: 'tool.execute.before', properties: { sessionID: 'ses_1', tool: 'write' } },
      { type: 'tool.execute.after', properties: { sessionID: 'ses_1', tool: 'write', output: 'done' } },
      { type: 'file.edited', properties: { info: { sessionID: 'ses_1' }, file: 'src/app.ts' } },
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.appendReasoningDelta).toHaveBeenCalledWith('task-1', 'thinking');
    expect(execution.backgroundTaskIds).toEqual(['bg_42']);
    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'succeeded', expect.any(Object));
  });

  it('fails when a launched background task reports failure', async () => {
    const { execution } = await runEvents([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'task', state: { status: 'completed', output: 'Background task started\nBackground Task ID: bg_fail\nstate: running' } },
        },
      },
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'text' }, delta: 'Background task failed: tests failed' } },
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: expect.stringContaining('Background task failed'),
    });
  });

  it('continues when a launched background task is cancelled', async () => {
    await runEvents([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'task', state: { status: 'completed', output: 'Background task started\nBackground Task ID: bg_cancel\nstate: running' } },
        },
      },
      { type: 'tool.execute.after', properties: { sessionID: 'ses_1', tool: 'background_cancel', output: 'Task cancelled successfully' } },
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(expect.any(Object), 'succeeded', expect.any(Object));
  });

  it('completes idle terminal sessions like completed events', async () => {
    const { execution } = await runEvents([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'succeeded', expect.any(Object));
  });

  it('handles background cancellation reported through completed tool parts', async () => {
    await runEvents([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'task', state: { status: 'completed', output: 'Background task started\nBackground Task ID: bg_cancel\nstate: running' } },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'background_cancel', state: { status: 'completed', output: 'background task cancelled' } },
        },
      },
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(expect.any(Object), 'succeeded', expect.any(Object));
  });

  it('ignores terminal session events before prompt send or after cancellation', async () => {
    const notPrompted = makeExecution({ promptSent: false });
    const client = clientFor([
      { type: 'unknown.event', properties: { sessionID: 'ses_1' } },
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);
    notPrompted.client = client;
    state.activeExecutions.set('task-1', notPrompted);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => !state.activeExecutions.has('task-1'));

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(notPrompted, 'failed', {
      errorMessage: 'Agent event stream ended unexpectedly',
    });

    mocks.finalizeAgentRun.mockClear();
    const cancelled = makeExecution({ cancelled: true });
    const cancelledClient = clientFor([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);
    cancelled.client = cancelledClient;
    state.activeExecutions.set('task-1', cancelled);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', cancelledClient, 'ses_1');
    await Promise.resolve();

    expect(mocks.finalizeAgentRun).not.toHaveBeenCalled();
    await state.cleanupExecution('task-1');
  });

  it('skips late session errors once post-processing has started', async () => {
    const execution = makeExecution({ status: 'committing' });
    const client = clientFor([
      { type: 'session.error', properties: { sessionID: 'ses_1', error: 'late error' } },
    ]);
    execution.client = client;
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => !state.activeExecutions.has('task-1'));

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Agent event stream ended unexpectedly',
    });
  });

  it('normalizes rate-limit session errors from message-shaped payloads', async () => {
    const { execution } = await runEvents([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { message: '429 rate limit exceeded' },
        },
      },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: '429 rate limit exceeded',
    });
    expect(mocks.broadcastToTaskById).toHaveBeenCalledWith(
      'task-1',
      'execution:progress',
      expect.objectContaining({ message: 'Rate limit exceeded — try again later' }),
    );
  });

  it('normalizes plain string and missing session errors', async () => {
    const plain = await runEvents([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: 'plain failure',
        },
      },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(plain.execution, 'failed', {
      errorMessage: 'plain failure',
    });

    mocks.finalizeAgentRun.mockClear();
    const missing = await runEvents([
      {
        type: 'session.error',
        properties: { sessionID: 'ses_1' },
      },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(missing.execution, 'failed', {
      errorMessage: 'Unknown error',
    });
  });

  it('normalizes nested and unknown session errors', async () => {
    const nested = await runEvents([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { error: { message: 'provider API key missing' } },
        },
      },
    ], { taskId: 'task-1', sessionId: 'ses_1' });

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(nested.execution, 'failed', {
      errorMessage: 'provider API key missing',
    });

    mocks.finalizeAgentRun.mockClear();
    const unknown = await runEvents([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { code: 'wat' },
        },
      },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(unknown.execution, 'failed', {
      errorMessage: '{"code":"wat"}',
    });

    mocks.finalizeAgentRun.mockClear();
    const nestedWithoutMessage = await runEvents([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { error: {} },
        },
      },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(nestedWithoutMessage.execution, 'failed', {
      errorMessage: '{"error":{}}',
    });

    mocks.finalizeAgentRun.mockClear();
    const dataWithoutMessage = await runEvents([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { data: {} },
        },
      },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(dataWithoutMessage.execution, 'failed', {
      errorMessage: '{"data":{}}',
    });

    mocks.finalizeAgentRun.mockClear();
    const dataWithoutStatus = await runEvents([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { data: { message: 'quota exceeded' } },
        },
      },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(dataWithoutStatus.execution, 'failed', {
      errorMessage: 'quota exceeded',
    });

    mocks.finalizeAgentRun.mockClear();
    const plainMessage = await runEvents([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { message: 'plain provider failure' },
        },
      },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(plainMessage.execution, 'failed', {
      errorMessage: 'plain provider failure',
    });
  });

  it('ignores events when no task can be matched to the session', async () => {
    let done = false;
    const execution = makeExecution({ sessionId: 'ses_other', cancelled: true });
    state.activeExecutions.set('task-1', execution);
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
        yield { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'text' }, delta: 'ignored' } };
        yield { type: 'tool.execute.before', properties: { sessionID: 'ses_1', tool: 'write' } };
        yield { type: 'tool.execute.after', properties: { sessionID: 'ses_1', tool: 'write', output: 'done' } };
        yield { type: 'file.edited', properties: { sessionID: 'ses_1', file: 'src/app.ts' } };
        yield { type: 'session.completed', properties: { sessionID: 'ses_1' } };
        done = true;
        yield { type: 'session.error', properties: { sessionID: 'ses_1', error: 'ignored' } };
      },
    };
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
      session: { abort: vi.fn().mockResolvedValue({}) },
    };

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => done);

    expect(mocks.appendTextDelta).not.toHaveBeenCalled();
    expect(mocks.finalizeAgentRun).not.toHaveBeenCalled();
    await state.cleanupExecution('task-1');
  });

  it('handles session mappings that outlive active execution state', async () => {
    state.sessionToTask.set('ses_1', 'task-1');
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
      },
    };
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
      session: { abort: vi.fn().mockResolvedValue({}) },
    };

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => mocks.markThinking.mock.calls.length > 0);

    expect(mocks.markThinking).toHaveBeenCalledWith('task-1');
  });

  it('exercises stale session mappings for completed tool, error, and file events', async () => {
    for (const event of [
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'task', state: { status: 'completed', output: 'Background task launched\nstate: running' } },
        },
      },
      { type: 'session.error', properties: { sessionID: 'ses_1', error: 'stale failure' } },
      { type: 'file.edited', properties: { sessionID: 'ses_1', file: 'src/app.ts' } },
    ]) {
      state.sessionToTask.set('ses_1', 'task-1');
      const client = clientFor([event]);

      await subscribeToSessionEvents('task-1', client, 'ses_1');
      await Promise.resolve();
      state.sessionToTask.clear();
    }

    expect(mocks.finalizeAgentRun).not.toHaveBeenCalledWith(undefined, expect.anything(), expect.anything());
  });

  it('ignores unmatched events without properties while a cancelled execution is still present', async () => {
    const execution = makeExecution({ sessionId: 'ses_other', cancelled: true });
    state.activeExecutions.set('task-1', execution);
    const client = clientFor([{ type: 'unknown.event' }]);

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await Promise.resolve();
    await state.cleanupExecution('task-1');

    expect(mocks.finalizeAgentRun).not.toHaveBeenCalled();
  });

  it('subscribes cleanly when execution state is already missing', async () => {
    const client = clientFor([]);

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await Promise.resolve();

    expect(client.event.subscribe).toHaveBeenCalledTimes(1);
  });

  it('cleans up event streams that do not expose return', async () => {
    const execution = makeExecution();
    const stream = {
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
    };
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
      session: { abort: vi.fn().mockResolvedValue({}) },
    };
    execution.client = client;
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await state.cleanupExecution('task-1');

    expect(state.activeExecutions.has('task-1')).toBe(false);
  });

  it('covers fallback tool names, duplicate background ids, empty deltas, and retry defaults', async () => {
    mocks.markThinking.mockReturnValueOnce(false);

    const { execution } = await runEvents([
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'retry' } } },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', state: { status: 'running' } },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'task', state: { status: 'completed', output: 'Background task launched\nstate: running' } },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'task', state: { status: 'completed', output: 'task_status\nstate: running\nBackground Task ID: bg_same' } },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'task', state: { status: 'completed', output: 'task_status\nstate: running\nBackground Task ID: bg_same' } },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'edit', state: { status: 'completed' } },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { type: 'tool', tool: 'edit', state: { status: 'queued', output: 'noop' } },
        },
      },
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'reasoning' }, delta: '' } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'unknown' }, delta: 'ignored' } },
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
      { type: 'tool.execute.before', properties: { sessionID: 'ses_1' } },
      { type: 'tool.execute.after', properties: { sessionID: 'ses_1' } },
      { type: 'tool.execute.after', properties: { sessionID: 'ses_1', tool: 'background_cancel' } },
      { type: 'tool.execute.after', properties: { sessionID: 'ses_1', tool: 'write' } },
      { type: 'file.edited', properties: { sessionID: 'ses_1' } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'text' }, delta: 'background task canceled successfully' } },
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(execution.backgroundTaskIds).toEqual(['bg_same']);
    expect(mocks.appendReasoningDelta).not.toHaveBeenCalledWith('task-1', '');
    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'succeeded', expect.any(Object));
  });

  it('fails normally when a recoverable stream error cannot inspect the worktree', async () => {
    const execution = makeExecution();
    const stream = {
      async *[Symbol.asyncIterator]() {
        throw new Error('socket closed');
      },
      return: vi.fn(),
    };
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
      session: { abort: vi.fn().mockResolvedValue({}) },
    };
    execution.client = client;
    mocks.hasCommittableChanges.mockRejectedValueOnce(new Error('status failed'));
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => !state.activeExecutions.has('task-1'));

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Agent event stream failed: socket closed',
    });
  });

  it('fails executions when the event stream goes idle past the watchdog timeout', async () => {
    vi.useFakeTimers();
    const execution = makeExecution();
    const stream = {
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
      return: vi.fn(),
    };
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
      session: { abort: vi.fn().mockResolvedValue({}) },
    };
    execution.client = client;
    mocks.hasCommittableChanges.mockResolvedValueOnce(false);
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Agent event stream timed out',
    });
    vi.useRealTimers();
  });

  it('ignores subscription failures after execution state has already gone away', async () => {
    const client = {
      event: { subscribe: vi.fn().mockRejectedValue(new Error('subscribe failed')) },
      session: { abort: vi.fn().mockResolvedValue({}) },
    };

    await subscribeToSessionEvents('task-1', client, 'ses_1');

    expect(mocks.finalizeAgentRun).not.toHaveBeenCalled();
  });

  it('handles string stream and subscription failures', async () => {
    const execution = makeExecution();
    const stream = {
      async *[Symbol.asyncIterator]() {
        throw 'socket closed';
      },
      return: vi.fn(),
    };
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
      session: { abort: vi.fn().mockResolvedValue({}) },
    };
    execution.client = client;
    mocks.hasCommittableChanges.mockResolvedValueOnce(false);
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', client, 'ses_1');
    await waitFor(() => !state.activeExecutions.has('task-1'));

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Agent event stream failed: socket closed',
    });

    const second = makeExecution();
    const badClient = {
      event: { subscribe: vi.fn().mockRejectedValue('subscribe failed') },
      session: { abort: vi.fn().mockResolvedValue({}) },
    };
    second.client = badClient;
    state.activeExecutions.set('task-1', second);
    state.sessionToTask.set('ses_1', 'task-1');

    await subscribeToSessionEvents('task-1', badClient, 'ses_1');

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(second, 'failed', {
      errorMessage: 'Failed to subscribe to agent events: subscribe failed',
    });
  });

  it('falls back when project metadata lookup returns no repository', async () => {
    mocks.repositoryFindUnique.mockResolvedValueOnce(null);
    mocks.taskFindUnique
      .mockResolvedValueOnce({ title: 'Fix execution', description: 'Body', projectId: 'project-1' })
      .mockResolvedValueOnce({ title: 'Fix execution', description: 'Body', projectId: 'project-1' });
    mocks.projectFindUnique.mockResolvedValueOnce({ repository: null });

    const { execution } = await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Changes committed but no repository linked to create PR',
    });
  });

  it('records generic post-execution failures from non-Error throws', async () => {
    mocks.createPullRequest.mockRejectedValueOnce('github down');

    const { execution } = await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.finalizeAgentRun).toHaveBeenCalledWith(execution, 'failed', {
      errorMessage: 'Post-execution failed',
    });
  });

  it('uses generic task metadata when PR creation runs after a missing task lookup', async () => {
    mocks.taskFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await runEvents([
      { type: 'session.completed', properties: { sessionID: 'ses_1' } },
    ]);

    expect(mocks.commitAndPush).toHaveBeenCalledWith('/repo', 'openlinear/task-1', 'Task', 'token');
    expect(mocks.createPullRequest).toHaveBeenCalledWith(
      'acme/repo',
      'openlinear/task-1',
      'main',
      'Task',
      null,
      'token',
    );
  });
});
