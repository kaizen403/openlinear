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

// W03a: one publication point (local owner streams + the attempt relay)
// replaces the cloud API SSE module.
vi.mock('../../events/publisher', () => ({
  publishTaskEvent: mocks.broadcastToTask,
  registerTaskOwnerResolver: vi.fn(),
  attachAttemptRelay: vi.fn(),
  detachAttemptRelay: vi.fn(),
}));

// state.ts has used the structured logger (not console.*) since the 38eb4c4
// migration; mock it the same way agent-run.test.mjs does rather than
// spying on console, which the real logger never writes to directly.
vi.mock('../../lib/logger', () => ({
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

  it('adds logs and publishes them without a per-line database lookup (T7, W03a)', () => {
    const execution = makeExecution({ teamId: 'team-9', creatorId: 'user-9' });
    state.activeExecutions.set('task-1', execution);

    state.addLogEntry('task-1', 'info', 'Started', 'details');

    expect(execution.logs).toHaveLength(1);
    expect(execution.logs[0]).toMatchObject({ type: 'info', message: 'Started', details: 'details' });
    // T7 (H-02) / W03a: published synchronously to the run owner's local
    // streams and the attempt relay — no per-log-line DB lookup.
    expect(mocks.broadcastToTask).toHaveBeenCalledWith(
      'task-1',
      'execution:log',
      { taskId: 'task-1', entry: execution.logs[0] },
    );
    expect(mocks.taskFindUnique).not.toHaveBeenCalled();
    expect(state.singleExecutionOwner('task-1')).toBe('user-1');

    state.addLogEntry('task-1', 'tool', 'Object details', { file: 'src/index.ts' });

    expect(execution.logs).toHaveLength(2);
  });

  it('publishes progress for an unknown task without a database lookup (no owner, so no local delivery)', () => {
    // No `activeExecutions.set(...)` — the publisher resolves no owner and
    // delivers nothing locally (fail closed); there is no DB fallback.
    state.broadcastProgress('task-1', 'executing', 'Running', { percentage: 50 });

    expect(mocks.broadcastToTask).toHaveBeenCalledWith('task-1', 'execution:progress', {
      taskId: 'task-1',
      status: 'executing',
      message: 'Running',
      percentage: 50,
    });
    expect(mocks.taskFindUnique).not.toHaveBeenCalled();
    expect(state.singleExecutionOwner('task-1')).toBeNull();
  });

  it('ignores log entries for missing executions', () => {
    state.addLogEntry('missing-task', 'info', 'lost');

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      '[Execution] Warning: No execution found for task missing- when adding log',
    );
    expect(mocks.broadcastToTask).not.toHaveBeenCalled();
  });

  it('returns an empty log list when execution state is missing', () => {
    expect(state.getExecutionLogs('missing')).toEqual([]);
  });

  it('broadcasts progress payloads with task id and extra data', () => {
    state.broadcastProgress('task-1', 'executing', 'Running', { percentage: 50 });

    expect(mocks.broadcastToTask).toHaveBeenCalledWith('task-1', 'execution:progress', {
      taskId: 'task-1',
      status: 'executing',
      message: 'Running',
      percentage: 50,
    });
  });

  it('publishes critical progress exactly once; delivery retries belong to the attempt relay', () => {
    // W03a: the per-broadcast DB lookup + retry loop is gone. Local delivery
    // is synchronous; cloud delivery of critical progress is retried with
    // backoff and kept preferentially by events/relay.ts (relay.test.ts).
    state.broadcastProgress('task-1', 'done', 'Done');
    state.broadcastProgress('task-1', 'error', 'Failed');

    expect(mocks.broadcastToTask).toHaveBeenCalledTimes(2);
    expect(mocks.broadcastToTask).toHaveBeenNthCalledWith(1, 'task-1', 'execution:progress', { taskId: 'task-1', status: 'done', message: 'Done' });
    expect(mocks.loggerError).not.toHaveBeenCalled();
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
    expect(mocks.broadcastToTask).toHaveBeenCalledWith('task-1', 'task:updated', {
      id: 'task-1',
      status: 'in_progress',
      labels: [{ id: 'label-1', name: 'bug', color: '#f00' }],
    }, { ownerUserId: null });
  });

  it('propagates task status update failures after logging', async () => {
    mocks.taskUpdate.mockRejectedValue(new Error('db down'));

    await expect(state.updateTaskStatus('task-1', 'cancelled', null)).rejects.toThrow('db down');

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

  it('does not remove a replacement execution while old stream cleanup settles', async () => {
    let releaseCleanup;
    const cleanupPending = new Promise((resolve) => { releaseCleanup = resolve; });
    const execution = makeExecution({ eventStreamCleanup: vi.fn(() => cleanupPending) });
    state.activeExecutions.set('task-1', execution);
    const cleanup = state.cleanupExecution('task-1');
    const replacement = makeExecution({ sessionId: 'ses_replacement' });
    state.activeExecutions.set('task-1', replacement);
    releaseCleanup();
    await cleanup;

    expect(state.activeExecutions.get('task-1') === replacement).toBe(true);
    expect(state.findTaskBySessionId('ses_replacement')).toBe('task-1');
    clearTimeout(replacement.timeoutId);
    clearTimeout(replacement.streamTimeoutId);
  });

  it('ignores stale-owner log persistence and cleanup against a replacement', async () => {
    const old = makeExecution();
    const replacement = makeExecution({
      sessionId: 'ses_replacement',
      logs: [{ timestamp: 'now', type: 'info', message: 'Replacement is running' }],
    });
    state.activeExecutions.set('task-1', replacement);

    await state.persistLogs('task-1', old);
    await state.cleanupExecution('task-1', old);

    expect(mocks.executeRaw.mock.calls.length).toBe(0);
    expect(mocks.cleanupDeltaBuffer.mock.calls.length).toBe(0);
    expect(state.activeExecutions.get('task-1') === replacement).toBe(true);
    for (const execution of [old, replacement]) {
      clearTimeout(execution.timeoutId);
      clearTimeout(execution.streamTimeoutId);
    }
  });

  it('denies a stale-owner cancellation projection after its session is replaced', async () => {
    const old = makeExecution({ taskProjectId: 'project-1' });
    const replacement = makeExecution({ sessionId: 'ses_replacement', taskProjectId: 'project-1' });
    const row = { status: 'in_progress', sessionId: 'ses_replacement', projectId: 'project-1', teamId: 'team-1', creatorId: 'user-1' };
    state.activeExecutions.set('task-1', replacement);
    mocks.taskUpdate.mockImplementation(async ({ where, data }) => {
      for (const field of ['sessionId', 'status', 'projectId', 'teamId', 'creatorId']) {
        if (field in where && where[field] !== row[field]) throw new Error('Stale execution');
      }
      Object.assign(row, data);
      return { id: 'task-1', ...row, labels: [] };
    });

    await expect(state.updateTaskStatus('task-1', 'cancelled', null, undefined, old)).rejects.toThrow();

    expect(row.status).toBe('in_progress');
    expect(row.sessionId).toBe('ses_replacement');
    for (const execution of [old, replacement]) {
      clearTimeout(execution.timeoutId);
      clearTimeout(execution.streamTimeoutId);
    }
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
