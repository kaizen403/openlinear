import { beforeEach, describe, expect, it, vi } from 'vitest';

// W03a: AgentRun rows are created by the attempt claim and finalized through
// the SidecarStore. In test mode the store is the Prisma store, so these
// cases still observe the row and activity writes — the activity row is now
// written directly (the cloud API's `logActivity` is no longer imported).
const mocks = vi.hoisted(() => ({
  agentRunCreate: vi.fn(),
  agentRunUpdate: vi.fn(),
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn(),
  activityLogCreate: vi.fn(),
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
  decryptToken: vi.fn(),
  prisma: {
    agentRun: {
      create: mocks.agentRunCreate,
      update: mocks.agentRunUpdate,
    },
    task: {
      findUnique: mocks.taskFindUnique,
      update: mocks.taskUpdate,
    },
    activityLog: { create: mocks.activityLogCreate },
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { finalizeAgentRun, recordMessageUsage } = await import('./agent-run');
const { getSidecarStore } = await import('../../persistence/store');

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

const attempt = { taskId: 'task-1', userId: 'user-1', attemptId: null, client: null, credential: null };
const claimInput = { sessionId: 'ses_1', runner: 'opencode', model: 'anthropic/claude', executionStartedAt: new Date('2026-05-22T00:00:00Z') };

describe('execution agent-run helpers', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.taskUpdate.mockResolvedValue({ id: 'task-1', labels: [] });
  });

  it('creates an agent run at claim time and records start activity for the initiator', async () => {
    mocks.agentRunCreate.mockResolvedValue({ id: 'run-1' });
    mocks.taskFindUnique.mockResolvedValue({ teamId: 'team-1', projectId: 'project-1' });

    const store = await getSidecarStore();
    await expect(store.claimAttempt(attempt, claimInput)).resolves.toMatchObject({ agentRunId: 'run-1' });

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
    expect(mocks.activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: 'task-1',
        teamId: 'team-1',
        projectId: 'project-1',
        userId: 'user-1',
        action: 'agent_run_started',
      }),
    });
  });

  it('records start activity with null scope when the task is missing', async () => {
    mocks.agentRunCreate.mockResolvedValue({ id: 'run-1' });
    mocks.taskFindUnique.mockResolvedValue(null);

    const store = await getSidecarStore();
    await expect(store.claimAttempt(attempt, claimInput)).resolves.toMatchObject({ agentRunId: 'run-1' });

    expect(mocks.activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ teamId: null, projectId: null, action: 'agent_run_started' }),
    });
  });

  it('continues the claim without capture and logs when agent run creation fails', async () => {
    mocks.agentRunCreate.mockRejectedValue(new Error('db down'));

    const store = await getSidecarStore();
    await expect(store.claimAttempt(attempt, claimInput)).resolves.toMatchObject({ agentRunId: null });

    expect(mocks.loggerError).toHaveBeenCalled();
    expect(mocks.taskUpdate).toHaveBeenCalled();
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
    expect(String(mocks.agentRunUpdate.mock.calls[0][0].data.costUsd)).toBe('0.123457');
    expect(mocks.activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'agent_run_completed',
        teamId: 'team-1',
        projectId: 'project-1',
        payload: expect.objectContaining({
          agentRunId: 'run-1',
          status: 'failed',
          errorMessage: 'x'.repeat(500),
        }),
      }),
    });
  });

  it('records completion activity with null task scope when the task is missing', async () => {
    const state = makeState();
    mocks.taskFindUnique.mockResolvedValue(null);

    await finalizeAgentRun(state, 'cancelled', { errorMessage: 'cancelled' });

    expect(mocks.activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teamId: null,
        projectId: null,
        action: 'agent_run_completed',
        payload: expect.objectContaining({ errorMessage: 'cancelled' }),
      }),
    });
  });

  it('records successful completion activity without optional payload fields', async () => {
    const state = makeState();
    mocks.taskFindUnique.mockResolvedValue({ teamId: 'team-1', projectId: 'project-1' });

    await finalizeAgentRun(state, 'succeeded');

    expect(mocks.activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'agent_run_completed',
        payload: {
          agentRunId: 'run-1',
          status: 'succeeded',
        },
      }),
    });
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
    expect(mocks.activityLogCreate).not.toHaveBeenCalled();
  });

  it('carries the cache/reasoning split when message usage was captured', async () => {
    const state = makeState({
      tokens: { input: 5, output: 6, reasoning: 7, cacheRead: 8, cacheWrite: 9 },
      messageUsage: new Map([['m', {}]]),
    });

    await finalizeAgentRun(state, 'succeeded');

    expect(mocks.agentRunUpdate.mock.calls[0][0].data).toMatchObject({
      cachedInputTokens: 8,
      cacheWriteTokens: 9,
      reasoningTokens: 7,
      costBasis: 'opencode.message.updated',
    });
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
