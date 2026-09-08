import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  taskUpdate: vi.fn(),
  taskFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  broadcastToTask: vi.fn(),
  broadcastToTaskById: vi.fn(),
  flushDeltaBuffer: vi.fn(),
  cleanupDeltaBuffer: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
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

// state.ts has used the structured logger (not console.*) since the 38eb4c4
// migration; mock it the same way agent-run.test.mjs does rather than
// spying on console, which the real logger never writes to directly.
vi.mock('@openlinear/api/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
    debug: mocks.loggerDebug,
  },
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
    teamId: 'team-1',
    creatorId: 'user-1',
    timeoutId: setTimeout(() => undefined, 10_000),
    streamTimeoutId: setTimeout(() => undefined, 10_000),
    progressTimeoutId: null,
    watchdogSuspended: false,
    finalized: false,
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
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
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

  it('adds logs and broadcasts them via the cached execution routing metadata (T7)', () => {
    const execution = makeExecution({ teamId: 'team-9', creatorId: 'user-9' });
    state.activeExecutions.set('task-1', execution);

    state.addLogEntry('task-1', 'info', 'Started', 'details');

    expect(execution.logs).toHaveLength(1);
    expect(execution.logs[0]).toMatchObject({ type: 'info', message: 'Started', details: 'details' });
    // T7 (H-02): when the execution is cached, broadcast synchronously via
    // the routing metadata already on hand — no per-log-line DB lookup.
    expect(mocks.broadcastToTask).toHaveBeenCalledWith(
      'execution:log',
      { id: 'task-1', teamId: 'team-9', creatorId: 'user-9' },
      { taskId: 'task-1', entry: execution.logs[0] },
    );
    expect(mocks.broadcastToTaskById).not.toHaveBeenCalled();

    state.addLogEntry('task-1', 'tool', 'Object details', { file: 'src/index.ts' });

    expect(execution.logs).toHaveLength(2);
  });

  it('falls back to the DB-lookup broadcast when no execution is cached', () => {
    // No `activeExecutions.set(...)` — simulates a broadcast for a taskId
    // the in-memory store doesn't know about.
    state.broadcastProgress('task-1', 'executing', 'Running', { percentage: 50 });

    expect(mocks.broadcastToTaskById).toHaveBeenCalledWith('task-1', 'execution:progress', {
      taskId: 'task-1',
      status: 'executing',
      message: 'Running',
      percentage: 50,
    });
    expect(mocks.broadcastToTask).not.toHaveBeenCalled();
  });

  it('ignores log entries for missing executions', () => {
    state.addLogEntry('missing-task', 'info', 'lost');

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      '[Execution] Warning: No execution found for task missing- when adding log',
    );
    expect(mocks.broadcastToTaskById).not.toHaveBeenCalled();
    expect(mocks.broadcastToTask).not.toHaveBeenCalled();
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
    mocks.broadcastToTaskById
      .mockRejectedValueOnce(new Error('socket busy'))
      .mockResolvedValueOnce(undefined);

    state.broadcastProgress('task-1', 'done', 'Done');
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: expect.any(Error), event: 'execution:progress', attempt: 1 },
      '[Execution] Failed to broadcast execution:progress for task task-1 (attempt 1)',
    );
    expect(mocks.broadcastToTaskById).toHaveBeenCalledTimes(2);
  });

  it('stops retrying critical broadcasts after the maximum attempts', async () => {
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
    mocks.taskUpdate.mockRejectedValue(new Error('db down'));

    await expect(state.updateTaskStatus('task-1', 'cancelled', null)).resolves.toBeUndefined();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: expect.any(Error), taskId: 'task-1' },
      '[Execution] Failed to update task task-1',
    );
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
    const execution = makeExecution({ logs: [{ timestamp: 'now', type: 'info', message: 'Started' }] });
    state.activeExecutions.set('task-1', execution);
    mocks.executeRaw.mockRejectedValue(new Error('json write failed'));

    await expect(state.persistLogs('task-1')).resolves.toBeUndefined();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: expect.any(Error), taskId: 'task-1' },
      '[Execution] Failed to persist logs for task task-1',
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
    const eventStreamCleanup = vi.fn().mockRejectedValue(new Error('stream cleanup failed'));
    const execution = makeExecution({ eventStreamCleanup });
    state.activeExecutions.set('task-1', execution);
    state.sessionToTask.set('ses_1', 'task-1');

    await state.cleanupExecution('task-1');

    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: expect.any(Error), taskId: 'task-1' },
      '[Execution] Failed to clean up event stream for task task-1',
    );
    expect(state.activeExecutions.has('task-1')).toBe(false);
    expect(state.sessionToTask.has('ses_1')).toBe(false);
  });

  it('clears the no-progress watchdog timer on cleanup', async () => {
    const progressTimeoutId = setTimeout(() => undefined, 10_000);
    const execution = makeExecution({ progressTimeoutId });
    state.activeExecutions.set('task-1', execution);

    await state.cleanupExecution('task-1');

    expect(execution.progressTimeoutId).toBeNull();
  });

  it('ignores cleanup for missing executions and falls back to generic task titles', async () => {
    await state.cleanupExecution('missing');

    mocks.taskFindUnique.mockResolvedValue(null);
    await expect(state.getTaskTitle('missing')).resolves.toBe('Task');

    expect(mocks.flushDeltaBuffer).not.toHaveBeenCalled();
  });

  describe('T11 — execution log ring buffer', () => {
    it('caps the log array at MAX_EXECUTION_LOG_ENTRIES, dropping the oldest', () => {
      const execution = makeExecution();
      state.activeExecutions.set('task-1', execution);

      for (let i = 0; i < state.MAX_EXECUTION_LOG_ENTRIES + 5; i++) {
        state.addLogEntry('task-1', 'info', `entry-${i}`);
      }

      expect(execution.logs).toHaveLength(state.MAX_EXECUTION_LOG_ENTRIES);
      expect(execution.logs[0].message).toBe('entry-5');
      expect(execution.logs.at(-1).message).toBe(`entry-${state.MAX_EXECUTION_LOG_ENTRIES + 4}`);
    });
  });

  describe('T10 — secret redaction in addLogEntry', () => {
    it('redacts a GitHub token appearing in a single log message', () => {
      const execution = makeExecution();
      state.activeExecutions.set('task-1', execution);

      state.addLogEntry('task-1', 'info', 'token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 done');

      expect(execution.logs[0].message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      expect(execution.logs[0].message).toContain('[REDACTED]');
    });

    it('redacts known secret env assignments in details', () => {
      const execution = makeExecution();
      state.activeExecutions.set('task-1', execution);

      state.addLogEntry('task-1', 'tool', 'env dump', 'DATABASE_URL=postgres://u:p@host:5432/db JWT_SECRET=abc123supersecret');

      expect(execution.logs[0].details).not.toContain('supersecret');
      expect(execution.logs[0].details).toContain('[REDACTED]');
    });

    it('catches a secret split across two addLogEntry calls (stateful across chunk boundaries)', () => {
      const execution = makeExecution();
      state.activeExecutions.set('task-1', execution);

      // "sk-abcdefghijklmnop" split mid-token across two chunks.
      state.addLogEntry('task-1', 'agent', 'here is a key sk-abcdefg');
      state.addLogEntry('task-1', 'agent', 'hijklmnopqrstuvwxyz more text after');

      const combined = execution.logs.map((l) => l.message).join(' ');
      expect(combined).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    });

    it('does not mangle ordinary log text with no secrets', () => {
      const execution = makeExecution();
      state.activeExecutions.set('task-1', execution);

      state.addLogEntry('task-1', 'info', 'Running: pnpm install');

      expect(execution.logs[0].message).toBe('Running: pnpm install');
    });

    it('clears per-task redaction carry state on cleanup', async () => {
      const execution = makeExecution();
      state.activeExecutions.set('task-1', execution);
      state.addLogEntry('task-1', 'info', 'sk-partial');

      await state.cleanupExecution('task-1');

      // Re-registering the same taskId after cleanup must not treat leftover
      // carry state from the previous run as a secret continuation.
      const second = makeExecution();
      state.activeExecutions.set('task-1', second);
      state.addLogEntry('task-1', 'info', 'token-completely-unrelated-text');

      expect(second.logs[0].message).toBe('token-completely-unrelated-text');
    });
  });
});
