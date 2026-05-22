import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentRunCreate: vi.fn(),
  agentRunUpdate: vi.fn(),
  taskFindUnique: vi.fn(),
  logActivity: vi.fn(),
  loggerError: vi.fn(),
}));

class DecimalMock {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return String(this.value);
  }
}

vi.mock('@openlinear/db', () => ({
  Prisma: { Decimal: DecimalMock },
  prisma: {
    agentRun: {
      create: mocks.agentRunCreate,
      update: mocks.agentRunUpdate,
    },
    task: {
      findUnique: mocks.taskFindUnique,
    },
  },
}));

vi.mock('@openlinear/api/logger', () => ({
  logger: { error: mocks.loggerError },
}));

vi.mock('@openlinear/api/activity', () => ({
  logActivity: mocks.logActivity,
}));

const {
  createAgentRun,
  finalizeAgentRun,
  recordMessageUsage,
} = await import('./agent-run');

function makeState(overrides = {}) {
  return {
    taskId: 'task-1',
    userId: 'user-1',
    agentRunId: 'run-1',
    cost: { input: 0, output: 0, total: 0 },
    tokens: { input: 0, output: 0 },
    messageUsage: new Map(),
    ...overrides,
  };
}

describe('execution agent-run helpers', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
  });

  it('creates an agent run and records start activity for users', async () => {
    mocks.agentRunCreate.mockResolvedValue({ id: 'run-1' });
    mocks.taskFindUnique.mockResolvedValue({ teamId: 'team-1', projectId: 'project-1' });

    await expect(createAgentRun({
      taskId: 'task-1',
      userId: 'user-1',
      agent: 'opencode',
      model: 'anthropic/claude',
    })).resolves.toBe('run-1');

    expect(mocks.agentRunCreate).toHaveBeenCalledWith({
      data: {
        taskId: 'task-1',
        userId: 'user-1',
        agent: 'opencode',
        model: 'anthropic/claude',
        status: 'running',
      },
      select: { id: true },
    });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      teamId: 'team-1',
      projectId: 'project-1',
      userId: 'user-1',
      action: 'agent_run_started',
    }));
  });

  it('creates agent runs without activity when no user is attached', async () => {
    mocks.agentRunCreate.mockResolvedValue({ id: 'run-1' });

    await expect(createAgentRun({
      taskId: 'task-1',
      userId: null,
      agent: 'opencode',
      model: 'unknown',
    })).resolves.toBe('run-1');

    expect(mocks.taskFindUnique).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it('records start activity with null scope when the task is missing', async () => {
    mocks.agentRunCreate.mockResolvedValue({ id: 'run-1' });
    mocks.taskFindUnique.mockResolvedValue(null);

    await expect(createAgentRun({
      taskId: 'task-1',
      userId: 'user-1',
      agent: 'opencode',
      model: 'unknown',
    })).resolves.toBe('run-1');

    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      teamId: null,
      projectId: null,
      action: 'agent_run_started',
    }));
  });

  it('returns null and logs when agent run creation fails', async () => {
    mocks.agentRunCreate.mockRejectedValue(new Error('db down'));

    await expect(createAgentRun({
      taskId: 'task-1',
      userId: null,
      agent: 'opencode',
      model: 'unknown',
    })).resolves.toBeNull();

    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it('records message usage snapshots as totals, not deltas', () => {
    const state = makeState();

    recordMessageUsage(state, 'message-1', { cost: 0.01, inputTokens: 10, outputTokens: 20 });
    recordMessageUsage(state, 'message-2', { cost: 0.02, inputTokens: 30, outputTokens: 40 });
    recordMessageUsage(state, 'message-1', { cost: 0.03, inputTokens: 50, outputTokens: 60 });

    expect(state.cost.total).toBe(0.05);
    expect(state.cost.input).toBe(0);
    expect(state.cost.output).toBe(0);
    expect(state.tokens.input).toBe(80);
    expect(state.tokens.output).toBe(100);
  });

  it('finalizes agent runs with usage, PR, error truncation, and completion activity', async () => {
    const state = makeState({
      cost: { input: 0, output: 0, total: 0.12345678 },
      tokens: { input: 111, output: 222 },
    });
    mocks.taskFindUnique.mockResolvedValue({ teamId: 'team-1', projectId: 'project-1' });

    await finalizeAgentRun(state, 'failed', {
      prUrl: 'https://github.com/acme/repo/pull/1',
      errorMessage: 'x'.repeat(1_200),
    });

    expect(mocks.agentRunUpdate).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: 'failed',
        costUsd: expect.any(DecimalMock),
        inputTokens: 111,
        outputTokens: 222,
        prUrl: 'https://github.com/acme/repo/pull/1',
        errorMessage: 'x'.repeat(1_000),
      }),
    });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent_run_completed',
      payload: expect.objectContaining({
        agentRunId: 'run-1',
        status: 'failed',
        errorMessage: 'x'.repeat(500),
      }),
    }));
  });

  it('records completion activity with null task scope when the task is missing', async () => {
    const state = makeState();
    mocks.taskFindUnique.mockResolvedValue(null);

    await finalizeAgentRun(state, 'cancelled', { errorMessage: 'cancelled' });

    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      teamId: null,
      projectId: null,
      action: 'agent_run_completed',
      payload: expect.objectContaining({ errorMessage: 'cancelled' }),
    }));
  });

  it('records successful completion activity without optional payload fields', async () => {
    const state = makeState();
    mocks.taskFindUnique.mockResolvedValue({ teamId: 'team-1', projectId: 'project-1' });

    await finalizeAgentRun(state, 'succeeded');

    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent_run_completed',
      payload: {
        agentRunId: 'run-1',
        status: 'succeeded',
      },
    }));
  });

  it('finalizes rows without optional usage, metadata, or user activity', async () => {
    const state = makeState({ userId: null });

    await finalizeAgentRun(state, 'succeeded');

    expect(mocks.agentRunUpdate).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: 'succeeded',
        endedAt: expect.any(Date),
      }),
    });
    expect(mocks.agentRunUpdate.mock.calls[0][0].data).not.toHaveProperty('costUsd');
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it('skips finalization when no agent run was created', async () => {
    await finalizeAgentRun(makeState({ agentRunId: null }), 'succeeded');

    expect(mocks.agentRunUpdate).not.toHaveBeenCalled();
  });

  it('logs and swallows finalization failures', async () => {
    const state = makeState();
    mocks.agentRunUpdate.mockRejectedValue(new Error('write failed'));

    await expect(finalizeAgentRun(state, 'succeeded')).resolves.toBeUndefined();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        taskId: 'task-1',
        agentRunId: 'run-1',
        status: 'succeeded',
      }),
      '[AgentRun] failed to finalize row',
    );
  });
});
