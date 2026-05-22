import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  taskUpdate: vi.fn(),
  taskGroupBy: vi.fn(),
  agentRunUpdate: vi.fn(),
  broadcastToTask: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@openlinear/db', () => ({
  prisma: {
    task: {
      findMany: mocks.taskFindMany,
      update: mocks.taskUpdate,
      groupBy: mocks.taskGroupBy,
    },
    agentRun: {
      update: mocks.agentRunUpdate,
    },
  },
}));

vi.mock('@openlinear/api/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock('@openlinear/api/sse', () => ({
  broadcastToTask: mocks.broadcastToTask,
}));

const { recoverActiveBatches, recoverInFlightExecutions } = await import('./recovery');

describe('execution recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T12:00:00.000Z'));
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
  });

  it('returns zero recovery work when no tasks are in flight', async () => {
    mocks.taskFindMany.mockResolvedValue([]);

    await expect(recoverInFlightExecutions()).resolves.toEqual({ recovered: 0, orphaned: 0 });

    expect(mocks.loggerInfo).toHaveBeenCalledWith('[Recovery] no in-flight tasks to recover');
  });

  it('marks old open agent runs as orphaned and broadcasts flattened tasks', async () => {
    mocks.taskFindMany.mockResolvedValue([
      {
        id: 'task-old',
        teamId: 'team-1',
        creatorId: 'user-1',
        updatedAt: new Date('2026-05-22T10:00:00.000Z'),
        agentRuns: [{ id: 'run-1', startedAt: new Date('2026-05-22T10:00:00.000Z'), endedAt: null }],
      },
    ]);
    mocks.taskUpdate.mockResolvedValue({
      id: 'task-old',
      status: 'cancelled',
      labels: [{ label: { id: 'label-1', name: 'bug', color: '#f00' } }],
    });

    await expect(recoverInFlightExecutions()).resolves.toEqual({ recovered: 0, orphaned: 1 });

    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'task-old' },
      data: expect.objectContaining({
        status: 'cancelled',
        outcome: 'sidecar_restart_orphan',
        sessionId: null,
        executionElapsedMs: 7_200_000,
      }),
      include: { labels: { include: { label: true } } },
    });
    expect(mocks.agentRunUpdate).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: 'sidecar_restart_orphan',
      }),
    });
    expect(mocks.broadcastToTask).toHaveBeenCalledWith('task:updated', {
      id: 'task-old',
      status: 'cancelled',
      labels: [{ id: 'label-1', name: 'bug', color: '#f00' }],
    });
  });

  it('leaves fresh in-flight tasks alone for future reconnect', async () => {
    mocks.taskFindMany.mockResolvedValue([
      {
        id: 'task-fresh',
        teamId: null,
        creatorId: null,
        updatedAt: new Date('2026-05-22T11:30:00.000Z'),
        agentRuns: [{ id: 'run-fresh', startedAt: new Date('2026-05-22T11:30:00.000Z'), endedAt: null }],
      },
    ]);

    await expect(recoverInFlightExecutions()).resolves.toEqual({ recovered: 1, orphaned: 0 });

    expect(mocks.taskUpdate).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-fresh', agentRunId: 'run-fresh' }),
      '[Recovery] task in_progress within 1h window — leaving for potential reconnect (T15)',
    );
  });

  it('marks closed agent runs with stale task status as orphaned', async () => {
    mocks.taskFindMany.mockResolvedValue([
      {
        id: 'task-closed',
        teamId: null,
        creatorId: null,
        updatedAt: new Date('2026-05-22T11:50:00.000Z'),
        agentRuns: [{ id: 'run-closed', startedAt: new Date('2026-05-22T11:00:00.000Z'), endedAt: new Date() }],
      },
    ]);
    mocks.taskUpdate.mockResolvedValue({ id: 'task-closed', labels: [] });

    await expect(recoverInFlightExecutions()).resolves.toEqual({ recovered: 0, orphaned: 1 });
  });

  it('skips recovery gracefully when task lookup fails', async () => {
    mocks.taskFindMany.mockRejectedValue(new Error('db down'));

    await expect(recoverInFlightExecutions()).resolves.toEqual({ recovered: 0, orphaned: 0 });

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[Recovery] failed to query in-flight tasks; skipping recovery',
    );
  });

  it('reports stale batch members without mutating batch state', async () => {
    mocks.taskGroupBy.mockResolvedValue([
      { batchId: 'batch-1', _count: { _all: 2 } },
      { batchId: 'batch-2', _count: { _all: 1 } },
    ]);

    await expect(recoverActiveBatches()).resolves.toEqual({ recovered: 0, orphaned: 3 });

    expect(mocks.loggerWarn).toHaveBeenCalledTimes(2);
  });

  it('returns zero stale batches on query failure', async () => {
    mocks.taskGroupBy.mockRejectedValue(new Error('db down'));

    await expect(recoverActiveBatches()).resolves.toEqual({ recovered: 0, orphaned: 0 });
  });
});
