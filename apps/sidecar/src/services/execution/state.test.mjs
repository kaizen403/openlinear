import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  taskUpdate: vi.fn(),
  taskFindUnique: vi.fn(),
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
      findUnique: mocks.taskFindUnique,
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

    state.addLogEntry('task-1', 'tool', 'Object details', { file: 'src/index.ts' });

    expect(execution.logs).toHaveLength(2);
  });

  it('ignores log entries for missing executions', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    state.addLogEntry('missing-task', 'info', 'lost');

    expect(consoleLog).toHaveBeenCalledWith(
      '[Execution] Warning: No execution found for task missing- when adding log',
    );
    expect(mocks.broadcastToTaskById).not.toHaveBeenCalled();
  });

  it('returns an empty log list when execution state is missing', () => {
    expect(state.getExecutionLogs('missing')).toEqual([]);
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

  it('retries critical progress broadcasts after transient failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.broadcastToTaskById
      .mockRejectedValueOnce(new Error('socket busy'))
      .mockResolvedValueOnce(undefined);

    state.broadcastProgress('task-1', 'done', 'Done');
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(
      '[Execution] Failed to broadcast execution:progress for task task-1 (attempt 1):',
      expect.any(Error),
    );
    expect(mocks.broadcastToTaskById).toHaveBeenCalledTimes(2);
  });

  it('stops retrying critical broadcasts after the maximum attempts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.broadcastToTaskById.mockRejectedValue(new Error('still down'));

    state.broadcastProgress('task-1', 'error', 'Failed');
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    expect(mocks.broadcastToTaskById).toHaveBeenCalledTimes(3);
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

  it('logs task status update failures without throwing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.taskUpdate.mockRejectedValue(new Error('db down'));

    await expect(state.updateTaskStatus('task-1', 'cancelled', null)).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith('[Execution] Failed to update task task-1:', expect.any(Error));
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

  it('skips log persistence when no active logs exist', async () => {
    await state.persistLogs('missing');

    const execution = makeExecution({ logs: [] });
    state.activeExecutions.set('task-1', execution);
    await state.persistLogs('task-1');

    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it('logs persist failures without throwing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const execution = makeExecution({ logs: [{ timestamp: 'now', type: 'info', message: 'Started' }] });
    state.activeExecutions.set('task-1', execution);
    mocks.executeRaw.mockRejectedValue(new Error('json write failed'));

    await expect(state.persistLogs('task-1')).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      '[Execution] Failed to persist logs for task task-1:',
      expect.any(Error),
    );
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

  it('continues cleanup when event stream cleanup throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const eventStreamCleanup = vi.fn().mockRejectedValue(new Error('stream cleanup failed'));
    const execution = makeExecution({ eventStreamCleanup });
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await state.cleanupExecution('task-1');

    expect(consoleError).toHaveBeenCalledWith(
      '[Execution] Failed to clean up event stream for task task-1:',
      expect.any(Error),
    );
    expect(state.activeExecutions.has('task-1')).toBe(false);
    expect(state.sessionToTask.has('ses_1')).toBe(false);
  });

  it('ignores cleanup for missing executions and falls back to generic task titles', async () => {
    await state.cleanupExecution('missing');

    mocks.taskFindUnique.mockResolvedValue(null);
    await expect(state.getTaskTitle('missing')).resolves.toBe('Task');

    expect(mocks.flushDeltaBuffer).not.toHaveBeenCalled();
  });

  it('uses the executionStore directly for session lookup fallback', () => {
    const { executionStore } = state;
    executionStore.reset();

    const ex = makeExecution({ taskId: 'task-2', sessionId: 'ses_fallback' });
    executionStore.set('task-2', ex);
    expect(executionStore.getBySession('ses_fallback')).toBe(ex);
    expect(executionStore.getTaskIdBySession('ses_fallback')).toBe('task-2');

    executionStore.remove('task-2');
    expect(executionStore.get('task-2')).toBeUndefined();
    expect(executionStore.getBySession('ses_fallback')).toBeUndefined();
  });

  it('covers executionStore remove for non-existent task', () => {
    const { executionStore } = state;
    executionStore.reset();
    executionStore.set('task-3', makeExecution({ taskId: 'task-3' }));
    executionStore.remove('non-existent');
    expect(executionStore.get('task-3')).toBeDefined();
  });

  it('uses executionStore fallback scan when session map is stale', () => {
    const { executionStore } = state;
    executionStore.reset();

    const ex = makeExecution({ taskId: 'task-3', sessionId: 'ses_orphan' });
    executionStore.set('task-3', ex);
    executionStore.setSessionMapping('ses_orphan', 'task-3');
    executionStore.setSessionMapping('ses_orphan', 'wrong');

    expect(executionStore.getTaskIdBySession('ses_orphan')).toBe('wrong');
    executionStore.reset();
    expect(executionStore.getTaskIdBySession('ses_orphan')).toBeUndefined();
  });

  it('covers all activeExecutions proxy trap operations', () => {
    state.activeExecutions.clear();
    const ex = makeExecution();
    state.activeExecutions.set('task-1', ex);

    const keys = [...state.activeExecutions.keys()];
    expect(keys).toContain('task-1');

    const values = [...state.activeExecutions.values()];
    expect(values).toContain(ex);

    const entries = [...state.activeExecutions.entries()];
    expect(entries).toHaveLength(1);

    const iterated = [...state.activeExecutions];
    expect(iterated).toHaveLength(1);

    let forEachCount = 0;
    state.activeExecutions.forEach(() => { forEachCount++; });
    expect(forEachCount).toBe(1);

    expect(state.activeExecutions[Symbol.toStringTag]).toBe('Map');

    state.activeExecutions.clear();
    expect(state.activeExecutions.size).toBe(0);
    expect(state.getRunningTaskCount()).toBe(0);
  });

  it('covers activeExecutions proxy delete trap', () => {
    state.activeExecutions.clear();
    const ex = makeExecution();
    state.activeExecutions.set('task-1', ex);
    expect(state.activeExecutions.delete('task-1')).toBe(true);
    expect(state.activeExecutions.has('task-1')).toBe(false);
  });

  it('covers sessionToTask proxy trap operations', () => {
    state.sessionToTask.clear();
    state.sessionToTask.set('ses_1', 'task-1');
    expect(state.sessionToTask.has('ses_1')).toBe(true);
    expect(state.sessionToTask.get('ses_1')).toBe('task-1');

    // delete is a no-op — managed by executionStore.remove()
    expect(state.sessionToTask.delete('ses_1')).toBe(true);
    expect(state.sessionToTask.has('ses_1')).toBe(true);

    state.sessionToTask.clear();
    expect(state.sessionToTask.get('ses_1')).toBeUndefined();
  });

  it('covers sessionToTask Symbol.iterator', () => {
    state.sessionToTask.clear();
    state.sessionToTask.set('ses_1', 'task-1');
    state.sessionToTask.set('ses_2', 'task-2');

    const pairs = [];
    for (const entry of state.sessionToTask) {
      pairs.push(entry);
    }
    expect(pairs).toEqual(expect.arrayContaining([['ses_1', 'task-1'], ['ses_2', 'task-2']]));
  });

  it('covers proxy default return paths for unknown properties', () => {
    expect(state.activeExecutions.unknownProp).toBeUndefined();
    expect(state.sessionToTask.unknownProp).toBeUndefined();
  });

  it('covers Symbol.toStringTag on proxies', () => {
    expect(Object.prototype.toString.call(state.activeExecutions)).toBe('[object Map]');
    expect(Object.prototype.toString.call(state.sessionToTask)).toBe('[object Map]');
  });
});
