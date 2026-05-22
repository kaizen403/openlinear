import { describe, expect, it } from 'vitest';
import {
  batchActivityId,
  batchIdFromActivityId,
  buildCombinedBatchPrompt,
  buildSingleTaskPrompt,
  completionKey,
  createBatchBranchName,
  createBatchState,
  createBatchTaskBranchName,
  createBatchTasks,
  findNextQueuedBatchTaskIndex,
  formatExecutionMode,
  getBatchProgressSummary,
  getCompletedBatchTaskIds,
  getInitialBatchLaunchIndexes,
  hasQueuedOrRunningBatchTasks,
  isBatchTaskTerminal,
  toBatchStatusResponse,
  toBatchTaskSummaries,
  toCreateBatchResponse,
} from '../index.ts';

const settings = {
  maxConcurrent: 3,
  autoApprove: false,
  stopOnFailure: false,
  conflictBehavior: 'skip',
};

function batch(overrides = {}) {
  return createBatchState({
    id: '12345678-aaaa-bbbb-cccc-123456789abc',
    projectId: 'repo-1',
    mode: 'parallel',
    taskIds: ['task-1', 'task-2', 'task-3', 'task-4'],
    titleByTaskId: {
      'task-1': 'First',
      'task-2': 'Second',
      'task-3': 'Third',
      'task-4': 'Fourth',
    },
    settings,
    mainRepoPath: '/tmp/repo',
    accessToken: null,
    userId: 'user-1',
    createdAt: new Date('2026-05-22T00:00:00.000Z'),
    ...overrides,
  });
}

describe('execution-core batch helpers', () => {
  it('uses exact activity labels for every execution mode', () => {
    expect(formatExecutionMode('parallel')).toBe('Parallel Execution');
    expect(formatExecutionMode('queue')).toBe('Queue Execution');
    expect(formatExecutionMode('combined')).toBe('Combined Execution');
  });

  it('routes combined activity through a virtual batch task id', () => {
    expect(batchActivityId('batch-1')).toBe('batch:batch-1');
    expect(batchIdFromActivityId('batch:batch-1')).toBe('batch-1');
    expect(batchIdFromActivityId('task-1')).toBeNull();
    expect(batchIdFromActivityId('')).toBeNull();
  });

  it('chooses initial launch indexes by execution mode', () => {
    expect(getInitialBatchLaunchIndexes('parallel', 4)).toEqual([0, 1, 2, 3]);
    expect(getInitialBatchLaunchIndexes('parallel', 1)).toEqual([0]);
    expect(getInitialBatchLaunchIndexes('queue', 4)).toEqual([0]);
    expect(getInitialBatchLaunchIndexes('combined', 4)).toEqual([]);
    expect(getInitialBatchLaunchIndexes('parallel', 0)).toEqual([]);
    expect(getInitialBatchLaunchIndexes('queue', -1)).toEqual([]);
  });

  it('builds branch names deterministically', () => {
    expect(createBatchBranchName('12345678-aaaa-bbbb-cccc-123456789abc')).toBe('openlinear/batch-12345678');
    expect(createBatchTaskBranchName('task-1')).toBe('openlinear/task-1');
  });

  it('constructs batch tasks from map, object, and missing title lookups', () => {
    expect(createBatchTasks(
      ['task-1', 'task-2'],
      'parallel',
      new Map([['task-1', 'From map']]),
    )).toMatchObject([
      { taskId: 'task-1', title: 'From map', branch: 'openlinear/task-1', status: 'queued' },
      { taskId: 'task-2', title: 'Untitled task', branch: 'openlinear/task-2', status: 'queued' },
    ]);

    expect(createBatchTasks(
      ['task-3'],
      'queue',
      { 'task-3': 'From object' },
    )[0]).toMatchObject({
      taskId: 'task-3',
      title: 'From object',
      branch: 'openlinear/task-3',
    });

    expect(createBatchTasks(
      ['task-1', 'task-2'],
      'combined',
      { 'task-1': 'First', 'task-2': 'Second' },
      'openlinear/batch-abcd1234',
    ).map(task => task.branch)).toEqual([
      'openlinear/batch-abcd1234',
      'openlinear/batch-abcd1234',
    ]);

    expect(() => createBatchTasks(['task-1'], 'combined')).toThrow(
      'batchBranch is required for combined batch tasks',
    );
  });

  it('constructs batch task state and branch names without side effects', () => {
    const parallel = batch();
    expect(parallel).toMatchObject({
      id: '12345678-aaaa-bbbb-cccc-123456789abc',
      projectId: 'repo-1',
      mode: 'parallel',
      status: 'pending',
      settings,
      mainRepoPath: '/tmp/repo',
      accessToken: null,
      userId: 'user-1',
      prUrl: null,
      completedAt: null,
    });
    expect(parallel.batchBranch).toBe('openlinear/batch-12345678');
    expect(parallel.tasks[0]).toMatchObject({
      taskId: 'task-1',
      title: 'First',
      status: 'queued',
      branch: 'openlinear/task-1',
      worktreePath: null,
      sessionId: null,
    });

    const combined = batch({ mode: 'combined' });
    expect(combined.tasks.map(task => task.branch)).toEqual([
      'openlinear/batch-12345678',
      'openlinear/batch-12345678',
      'openlinear/batch-12345678',
      'openlinear/batch-12345678',
    ]);
  });

  it('detects terminal and queued batch task state', () => {
    const state = batch();
    state.tasks[0].status = 'completed';
    state.tasks[1].status = 'failed';
    state.tasks[2].status = 'cancelled';
    state.tasks[3].status = 'queued';

    expect(isBatchTaskTerminal(state.tasks[0])).toBe(true);
    expect(['completed', 'failed', 'skipped', 'cancelled'].map(status => (
      isBatchTaskTerminal({ ...state.tasks[0], status })
    ))).toEqual([true, true, true, true]);
    expect(['queued', 'running'].map(status => (
      isBatchTaskTerminal({ ...state.tasks[0], status })
    ))).toEqual([false, false]);
    expect(completionKey(state.id, 'task-1')).toBe('12345678-aaaa-bbbb-cccc-123456789abc:task-1');
    expect(getCompletedBatchTaskIds(state)).toEqual(['task-1']);
    expect(hasQueuedOrRunningBatchTasks(state)).toBe(true);
    expect(findNextQueuedBatchTaskIndex(state)).toBe(3);

    state.tasks[3].status = 'skipped';
    expect(hasQueuedOrRunningBatchTasks(state)).toBe(false);
    expect(findNextQueuedBatchTaskIndex(state)).toBe(-1);
  });

  it('derives batch progress summaries and serializable responses', () => {
    const state = batch();
    state.tasks[0].status = 'completed';
    state.tasks[0].startedAt = new Date('2026-05-22T00:00:01.000Z');
    state.tasks[0].completedAt = new Date('2026-05-22T00:00:03.000Z');
    state.tasks[1].status = 'failed';
    state.tasks[2].status = 'running';
    state.tasks[3].status = 'skipped';
    state.completedAt = new Date('2026-05-22T00:00:04.000Z');

    expect(getBatchProgressSummary(state)).toEqual({
      total: 4,
      completed: 1,
      failed: 1,
      running: 1,
      queued: 0,
      skipped: 1,
      cancelled: 0,
      percentage: 75,
    });

    expect(getBatchProgressSummary({ tasks: [] })).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      running: 0,
      queued: 0,
      skipped: 0,
      cancelled: 0,
      percentage: 0,
    });

    expect(toBatchTaskSummaries(state)).toEqual([
      { taskId: 'task-1', title: 'First', status: 'completed', branch: 'openlinear/task-1' },
      { taskId: 'task-2', title: 'Second', status: 'failed', branch: 'openlinear/task-2' },
      { taskId: 'task-3', title: 'Third', status: 'running', branch: 'openlinear/task-3' },
      { taskId: 'task-4', title: 'Fourth', status: 'skipped', branch: 'openlinear/task-4' },
    ]);

    expect(toCreateBatchResponse(state)).toEqual({
      id: '12345678-aaaa-bbbb-cccc-123456789abc',
      status: 'pending',
      mode: 'parallel',
      tasks: toBatchTaskSummaries(state),
      createdAt: '2026-05-22T00:00:00.000Z',
    });

    expect(toBatchStatusResponse(state)).toMatchObject({
      id: '12345678-aaaa-bbbb-cccc-123456789abc',
      createdAt: '2026-05-22T00:00:00.000Z',
      completedAt: '2026-05-22T00:00:04.000Z',
      tasks: [
        {
          taskId: 'task-1',
          startedAt: '2026-05-22T00:00:01.000Z',
          completedAt: '2026-05-22T00:00:03.000Z',
        },
        { taskId: 'task-2', startedAt: null, completedAt: null },
        { taskId: 'task-3', startedAt: null, completedAt: null },
        { taskId: 'task-4', startedAt: null, completedAt: null },
      ],
    });
  });

  it('builds the single task prompt contract', () => {
    const prompt = buildSingleTaskPrompt(
      { title: 'Fix board drag', description: 'Stop overlapping cards.' },
      'Fallback title',
    );

    expect(prompt).toContain('Fix board drag\n\nStop overlapping cards.');
    expect(prompt).toContain('Make the requested code changes directly in this worktree');
    expect(prompt).not.toContain('Fallback title');
  });

  it('uses fallback titles for single task prompts without database titles', () => {
    expect(buildSingleTaskPrompt(null, 'Fallback title')).toContain('Fallback title');
    expect(buildSingleTaskPrompt({ title: null, description: null }, 'Fallback title')).toContain('Fallback title');
    expect(buildSingleTaskPrompt({ title: '', description: '' }, 'Fallback title')).not.toContain('\n\n\n');
  });

  it('builds combined prompts in selected task order', () => {
    const state = batch({ mode: 'combined' });
    const prompt = buildCombinedBatchPrompt(state.tasks, [
      { id: 'task-2', identifier: 'KT-2', title: 'Second from DB', description: 'Second description' },
      { id: 'task-1', identifier: 'KT-1', title: 'First from DB', description: 'First description' },
      { id: 'task-4', identifier: 'KT-4', title: null, description: '   ' },
    ]);

    expect(prompt.indexOf('Task 1: KT-1: First from DB')).toBeLessThan(
      prompt.indexOf('Task 2: KT-2: Second from DB'),
    );
    expect(prompt).toContain('Task 3: Third');
    expect(prompt).toContain('Task 4: KT-4: Fourth');
    expect(prompt).toContain('No additional description provided.');
    expect(prompt).toContain('Satisfy every listed task in this single session');
    expect(prompt).not.toContain('undefined');
    expect(prompt).not.toContain('null');
  });
});
