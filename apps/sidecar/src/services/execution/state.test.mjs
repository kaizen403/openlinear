import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  taskUpdate: vi.fn(),
  executeRaw: vi.fn(),
  broadcastToTask: vi.fn(),
  broadcastToTaskById: vi.fn(),
  flushDeltaBuffer: vi.fn(),
  cleanupDeltaBuffer: vi.fn(),
}));

vi.mock('@openlinear/db', () => ({
  prisma: {
    task: {
      update: mocks.taskUpdate,
      findUnique: vi.fn(),
    },
    $executeRaw: mocks.executeRaw,
  },
}));

vi.mock('@openlinear/api/sse', () => ({
  broadcastToTask: mocks.broadcastToTask,
  broadcastToTaskById: mocks.broadcastToTaskById,
}));

vi.mock('../delta-buffer', () => ({
  flushDeltaBuffer: mocks.flushDeltaBuffer,
  cleanupDeltaBuffer: mocks.cleanupDeltaBuffer,
}));

const state = await import('./state');

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
    streamTimeoutId: setTimeout(() => undefined, 10_000),
    status: 'executing',
    logs: [],
    client: { session: { abort: vi.fn() } },
    startedAt: new Date('2026-05-22T00:00:00.000Z'),
    filesChanged: 0,
    toolsExecuted: 0,
    promptSent: false,
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

describe('execution state helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T00:05:00.000Z'));
    state.activeExecutions.clear();
    state.sessionToTask.clear();
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.broadcastToTaskById.mockResolvedValue(undefined);
  });

  afterEach(() => {
    state.activeExecutions.clear();
    state.sessionToTask.clear();
    vi.useRealTimers();
  });

  it('tracks active execution state and session lookup fallback', () => {
    const execution = makeExecution({ taskId: 'task-1', sessionId: 'ses_1' });
    state.activeExecutions.set('task-1', execution);

    expect(state.getRunningTaskCount()).toBe(1);
    expect(state.isTaskRunning('task-1')).toBe(true);
    expect(state.getExecutionStatus('task-1')).toBe(execution);
    expect(state.findTaskBySessionId('ses_1')).toBe('task-1');
    expect(state.sessionToTask.get('ses_1')).toBe('task-1');
    expect(state.findTaskBySessionId('missing')).toBeUndefined();
  });

  it('adds logs and broadcasts them for active executions', () => {
    const execution = makeExecution();
    state.activeExecutions.set('task-1', execution);

    state.addLogEntry('task-1', 'info', 'Started', 'details');

    expect(execution.logs).toHaveLength(1);
    expect(execution.logs[0]).toMatchObject({ type: 'info', message: 'Started', details: 'details' });
    expect(mocks.broadcastToTaskById).toHaveBeenCalledWith('task-1', 'execution:log', {
      taskId: 'task-1',
      entry: execution.logs[0],
    });
  });

  it('broadcasts progress payloads with task id and extra data', () => {
    state.broadcastProgress('task-1', 'executing', 'Running', { percentage: 50 });

    expect(mocks.broadcastToTaskById).toHaveBeenCalledWith('task-1', 'execution:progress', {
      taskId: 'task-1',
      status: 'executing',
      message: 'Running',
      percentage: 50,
    });
  });

  it('updates task status, flattens labels, and broadcasts task updates', async () => {
    mocks.taskUpdate.mockResolvedValue({
      id: 'task-1',
      status: 'in_progress',
      labels: [{ label: { id: 'label-1', name: 'bug', color: '#f00' } }],
    });

    await state.updateTaskStatus('task-1', 'in_progress', 'ses_1', { executionProgress: 10 });

    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'in_progress', sessionId: 'ses_1', executionProgress: 10 },
      include: { labels: { include: { label: true } } },
    });
    expect(mocks.broadcastToTask).toHaveBeenCalledWith('task:updated', {
      id: 'task-1',
      status: 'in_progress',
      labels: [{ id: 'label-1', name: 'bug', color: '#f00' }],
    });
  });

  it('estimates progress from tools, files, and elapsed time with a cap', () => {
    expect(state.estimateProgress(makeExecution({
      toolsExecuted: 3,
      filesChanged: 2,
      startedAt: new Date('2026-05-22T00:00:00.000Z'),
    }))).toBe(50);

    expect(state.estimateProgress(makeExecution({
      toolsExecuted: 100,
      filesChanged: 100,
      startedAt: new Date('2026-05-21T00:00:00.000Z'),
    }))).toBe(90);
  });

  it('persists logs through the raw JSON update path', async () => {
    const execution = makeExecution({ logs: [{ timestamp: 'now', type: 'info', message: 'Started' }] });
    state.activeExecutions.set('task-1', execution);
    mocks.executeRaw.mockResolvedValue(1);

    await state.persistLogs('task-1');

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
  });

  it('cleans up timers, buffers, streams, and active maps', async () => {
    const eventStreamCleanup = vi.fn();
    const execution = makeExecution({ eventStreamCleanup });
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await state.cleanupExecution('task-1');

    expect(mocks.flushDeltaBuffer).toHaveBeenCalledWith('task-1');
    expect(mocks.cleanupDeltaBuffer).toHaveBeenCalledWith('task-1');
    expect(eventStreamCleanup).toHaveBeenCalledTimes(1);
    expect(state.activeExecutions.has('task-1')).toBe(false);
    expect(state.sessionToTask.has('ses_1')).toBe(false);
  });
});
