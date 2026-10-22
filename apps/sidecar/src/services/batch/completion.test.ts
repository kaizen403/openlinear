import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completionKey, createBatchState, type BatchMode, type BatchPublicationPhase, type BatchState, type BatchTaskStatus } from '@openlinear/execution-core';

interface TaskUpdate {
  where: { id: string; batchId?: string; status?: string | { not: string } };
  data: Record<string, unknown>;
}

interface TaskRow {
  id: string;
  batchId: string;
  status: string;
  outcome: string | null;
  prUrl: string | null;
  labels: [];
}

interface TaskUpdateMany {
  where: {
    id?: string | { in: string[] };
    batchId?: string;
    status?: string | { not: string };
  };
  data: Record<string, unknown>;
}

interface TaskFindMany {
  where?: { id?: { in: string[] }; batchId?: string };
}

interface TransactionClient {
  task: {
    updateMany: (input: TaskUpdateMany) => Promise<{ count: number }>;
    findMany: (input?: TaskFindMany) => Promise<TaskRow[]>;
  };
}

const mocks = vi.hoisted(() => ({
  repositoryFindUnique: vi.fn(),
  assertTaskOwned: vi.fn(),
  taskUpdate: vi.fn<(input: TaskUpdate) => Promise<TaskRow>>(),
  taskUpdateMany: vi.fn<(input: TaskUpdateMany) => Promise<{ count: number }>>(),
  taskFindMany: vi.fn<(input?: TaskFindMany) => Promise<TaskRow[]>>(),
  transactionTaskUpdateMany: vi.fn<(input: TaskUpdateMany) => Promise<{ count: number }>>(),
  transaction: vi.fn<(callback: (tx: TransactionClient) => Promise<unknown>, options?: unknown) => Promise<unknown>>(),
  hasCommittableChanges: vi.fn(),
  stageCommittableChanges: vi.fn(),
  execGit: vi.fn(),
  execGitWithCredentials: vi.fn(),
  rawExec: vi.fn(),
  createBatchBranch: vi.fn(),
  mergeBranch: vi.fn(),
  pushBranch: vi.fn(),
  cleanupBatch: vi.fn(),
  removeWorktree: vi.fn(),
  launchTask: vi.fn(),
  cancelBatch: vi.fn(),
  stopBatchSessions: vi.fn<(batch: BatchState, taskIds: string[]) => Promise<void>>(),
  abort: vi.fn(),
  broadcastToTask: vi.fn(),
  broadcastToTaskById: vi.fn(),
  broadcastToUser: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  writeReceipt: vi.fn(),
}));

vi.mock('@openlinear/db', () => ({
  prisma: {
    repository: { findUnique: mocks.repositoryFindUnique },
    task: { update: mocks.taskUpdate, updateMany: mocks.taskUpdateMany, findMany: mocks.taskFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@openlinear/api/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@openlinear/api/sse', () => ({
  broadcastToTask: mocks.broadcastToTask,
  broadcastToTaskById: mocks.broadcastToTaskById,
  broadcastToUser: mocks.broadcastToUser,
}));
vi.mock('@openlinear/api/ownership', () => ({ assertTaskOwned: mocks.assertTaskOwned }));
vi.mock('../repo-storage', () => ({
  REPOS_DIR: '/owned/repos',
  buildReposPath: (...segments: string[]) => ['/owned/repos', ...segments].join('/'),
  assertPathInsideReposDir: (path: string) => path,
}));
vi.mock('../delta-buffer', () => ({
  cleanupDeltaBuffer: vi.fn(),
  flushDeltaBuffer: vi.fn(),
}));
vi.mock('../git-identity', () => ({ getGitIdentityEnv: () => ({ GIT_AUTHOR_NAME: 'OpenLinear Test' }) }));
vi.mock('../git-credentials', () => ({
  execGit: mocks.execGit,
  execGitWithCredentials: mocks.execGitWithCredentials,
  assertSafeCloneUrl: (value: string) => value,
  assertSafeRefName: (value: string) => value,
}));
vi.mock('../execution/exec', () => ({ execFileAsync: mocks.rawExec }));
vi.mock('../execution/git', async (importOriginal) => ({
  ...await importOriginal<typeof import('../execution/git')>(),
  hasCommittableChanges: mocks.hasCommittableChanges,
  stageCommittableChanges: mocks.stageCommittableChanges,
}));
vi.mock('../worktree', () => ({
  createBatchBranch: mocks.createBatchBranch,
  mergeBranch: mocks.mergeBranch,
  pushBranch: mocks.pushBranch,
  cleanupBatch: mocks.cleanupBatch,
  removeWorktree: mocks.removeWorktree,
}));
vi.mock('../opencode', () => ({
  getClientForUser: async () => ({ session: { abort: mocks.abort } }),
}));
vi.mock('./orchestrator', () => ({
  launchTask: mocks.launchTask,
  cancelBatch: mocks.cancelBatch,
  stopBatchSessions: mocks.stopBatchSessions,
}));
vi.mock('./publication', async (importOriginal) => ({
  ...await importOriginal<typeof import('./publication')>(),
  writeBatchReceipt: mocks.writeReceipt,
}));

const completion = await import('./completion');
const shared = await import('./shared');

const repository = {
  id: 'repo-1', name: 'repo', fullName: 'acme/repo',
  cloneUrl: 'https://github.com/acme/repo.git', defaultBranch: 'main',
};
const prUrl = 'https://github.com/acme/repo/pull/101';
const accessToken = 'super-secret-github-token';
let nextBatch = 0;
let rows = new Map<string, TaskRow>();

function applyUpdate(target: Map<string, TaskRow>, input: TaskUpdate): TaskRow {
  const row = target.get(input.where.id);
  if (!row) throw new Error(`Missing fixture task ${input.where.id}`);
  if (input.where.batchId !== undefined && input.where.batchId !== row.batchId) throw new Error('Task batch changed');
  if (typeof input.where.status === 'string' && input.where.status !== row.status) throw new Error('Task status changed');
  if (typeof input.where.status === 'object' && input.where.status.not === row.status) throw new Error('Task status changed');
  const updated = { ...row, ...input.data };
  target.set(input.where.id, updated);
  return updated;
}

function applyMany(target: Map<string, TaskRow>, input: TaskUpdateMany): { count: number } {
  let count = 0;
  for (const [id, row] of target) {
    if (typeof input.where.id === 'string' && input.where.id !== id) continue;
    if (typeof input.where.id === 'object' && !input.where.id.in.includes(id)) continue;
    if (input.where.batchId !== undefined && input.where.batchId !== row.batchId) continue;
    if (typeof input.where.status === 'string' && input.where.status !== row.status) continue;
    if (typeof input.where.status === 'object' && input.where.status.not === row.status) continue;
    target.set(id, { ...row, ...input.data });
    count += 1;
  }
  return { count };
}

function findMany(target: Map<string, TaskRow>, input?: TaskFindMany): TaskRow[] {
  return [...target.values()].filter((row) => (
    (!input?.where?.id || input.where.id.in.includes(row.id)) &&
    (!input?.where?.batchId || input.where.batchId === row.batchId)
  ));
}

function makeBatch(mode: BatchMode = 'parallel', statuses: BatchTaskStatus[] = ['completed', 'completed']): BatchState {
  const id = `completion-fixture-${++nextBatch}`;
  const batch = createBatchState({
    id, projectId: repository.id, mode,
    taskIds: statuses.map((_status, index) => `task-${index + 1}`),
    settings: { maxConcurrent: 2, autoApprove: false, stopOnFailure: false, conflictBehavior: 'fail' },
    mainRepoPath: `/owned/${id}/.main`, accessToken, userId: 'user-1',
  });
  batch.status = 'running';
  batch.repository = repository;
  batch.batchBranch = `openlinear/${id}`;
  for (const [index, task] of batch.tasks.entries()) {
    task.status = statuses[index];
    task.title = `Task ${index + 1}`;
    task.worktreePath = mode === 'combined' ? `/owned/${id}/combined` : `/owned/${id}/${task.taskId}`;
    task.sessionId = mode === 'combined' ? 'ses_combined' : `ses_${task.taskId}`;
    task.startedAt = new Date(Date.now() - 60_000);
    if (mode === 'combined') task.branch = batch.batchBranch;
    rows.set(task.taskId, { id: task.taskId, batchId: batch.id, status: 'in_progress', outcome: null, prUrl: null, labels: [] });
  }
  shared.activeBatches.set(batch.id, batch);
  return batch;
}

function gate<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 1_000, interval: 5 });
}

function doneWrites(): Array<TaskUpdate | TaskUpdateMany> {
  return [...mocks.taskUpdate.mock.calls, ...mocks.taskUpdateMany.mock.calls, ...mocks.transactionTaskUpdateMany.mock.calls]
    .map(([input]) => input).filter((input) => input.data.status === 'done');
}

function doneProgressCount(): number {
  const taskProgress = mocks.broadcastToTaskById.mock.calls
    .filter(([_id, event]) => event === 'execution:progress').map(([_id, _event, payload]) => payload);
  const userProgress = mocks.broadcastToUser.mock.calls
    .filter(([_id, event]) => event === 'execution:progress').map(([_id, _event, payload]) => payload);
  return [...taskProgress, ...userProgress].filter((payload: { status?: string }) => payload.status === 'done').length;
}

function completedEventCount(): number {
  return mocks.broadcastToUser.mock.calls.filter(([_userId, type]) => type === 'batch:completed').length;
}

function expectRetainedFailure(batch: BatchState): void {
  expect(batch.status).toBe('failed');
  expect(mocks.cleanupBatch).not.toHaveBeenCalled();
  expect(doneProgressCount()).toBe(0);
  expect(completedEventCount()).toBe(0);
  for (const task of batch.tasks.filter((item) => item.status !== 'cancelled' && item.status !== 'skipped')) {
    expect(task.status).toBe('failed');
    const row = rows.get(task.taskId);
    expect(row?.status).toBe('todo');
    expect(row?.outcome).toContain(task.branch);
    expect(row?.outcome).toContain(task.worktreePath);
  }
}

async function finish(batch: BatchState): Promise<void> {
  if (batch.mode === 'combined') await completion.handleCombinedBatchComplete(batch.id, true);
  else await completion.finalizeBatch(batch.id);
}

function setCancelled(batch: BatchState): void {
  batch.status = 'cancelled';
  for (const task of batch.tasks) {
    task.status = 'cancelled';
    const row = rows.get(task.taskId);
    if (row) row.status = 'cancelled';
  }
}

async function recordReceipt(batch: BatchState, phase: BatchPublicationPhase, error?: string): Promise<void> {
  batch.publication = {
    ...batch.publication,
    phase: batch.status === 'cancelled' ? 'cancelled' : phase,
    receiptPath: `/owned/receipts/${batch.id}.json`,
    ...(error ? { error } : {}),
  };
}

describe('batch completion publication and retention', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rows = new Map();
    shared.activeBatches.clear();
    shared.sessionToBatch.clear();
    shared.completingBatchTasks.clear();
    shared.completingCombinedBatches.clear();
    shared.finalizingBatches.clear();
    shared.batchTaskLogs.clear();
    mocks.repositoryFindUnique.mockResolvedValue(repository);
    mocks.assertTaskOwned.mockResolvedValue(undefined);
    mocks.taskUpdate.mockImplementation(async (input) => applyUpdate(rows, input));
    mocks.taskUpdateMany.mockImplementation(async (input) => applyMany(rows, input));
    mocks.taskFindMany.mockImplementation(async (input) => findMany(rows, input));
    mocks.transaction.mockImplementation(async (callback) => {
      // Commit the fixture database only if the whole callback succeeds.
      // This lets tests observe real all-or-nothing terminal persistence.
      const staged = new Map([...rows].map(([id, row]) => [id, { ...row }]));
      mocks.transactionTaskUpdateMany.mockImplementation(async (input) => applyMany(staged, input));
      const result = await callback({
        task: {
          updateMany: mocks.transactionTaskUpdateMany,
          findMany: async (input) => findMany(staged, input),
        },
      });
      rows = staged;
      return result;
    });
    mocks.hasCommittableChanges.mockResolvedValue(true);
    mocks.stageCommittableChanges.mockResolvedValue(true);
    mocks.execGit.mockResolvedValue({ stdout: '', stderr: '' });
    mocks.execGitWithCredentials.mockResolvedValue({ stdout: '', stderr: '' });
    mocks.rawExec.mockResolvedValue({ stdout: '', stderr: '' });
    mocks.mergeBranch.mockResolvedValue(true);
    mocks.createBatchBranch.mockResolvedValue(undefined);
    mocks.pushBranch.mockResolvedValue(undefined);
    mocks.cleanupBatch.mockResolvedValue(undefined);
    mocks.removeWorktree.mockResolvedValue(undefined);
    mocks.abort.mockResolvedValue(undefined);
    mocks.stopBatchSessions.mockImplementation(async (batch, taskIds) => {
      for (const task of batch.tasks) {
        if (taskIds.includes(task.taskId)) task.cancelUnconfirmed = false;
      }
    });
    mocks.writeReceipt.mockImplementation(recordReceipt);
    mocks.broadcastToTaskById.mockResolvedValue(undefined);
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ html_url: prUrl }), { status: 201 }));
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    shared.activeBatches.clear();
    shared.sessionToBatch.clear();
    shared.completingBatchTasks.clear();
    shared.completingCombinedBatches.clear();
    shared.finalizingBatches.clear();
    shared.batchTaskLogs.clear();
    vi.unstubAllGlobals();
  });

  it('keeps a locally committed queue member in progress until publication', async () => {
    const batch = makeBatch('queue', ['running', 'queued']);

    await completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, true);

    expect(batch.tasks[0].status).toBe('completed');
    expect(rows.get(batch.tasks[0].taskId)?.status).toBe('in_progress');
    expect(doneWrites()).toEqual([]);
    expect(doneProgressCount()).toBe(0);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.execGit).toHaveBeenCalledWith(
      expect.arrayContaining(['-C', batch.tasks[0].worktreePath, 'commit']), expect.anything(),
    );
    expect(mocks.rawExec).not.toHaveBeenCalled();
  });

  it('publishes first, then commits all member done states in one transaction and broadcasts', async () => {
    const batch = makeBatch();
    const pushed = gate<void>();
    mocks.pushBranch.mockReturnValueOnce(pushed.promise);
    const pending = completion.finalizeBatch(batch.id);
    await until(() => mocks.pushBranch.mock.calls.length === 1);

    expect(doneWrites()).toEqual([]);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(doneProgressCount()).toBe(0);
    expect(completedEventCount()).toBe(0);
    pushed.resolve();
    await pending;

    expect(batch.status).toBe('completed');
    expect(batch.prUrl).toBe(prUrl);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transactionTaskUpdateMany.mock.calls.filter(([input]) => input.data.status === 'done')).toHaveLength(2);
    expect(mocks.taskUpdate.mock.calls.filter(([input]) => input.data.status === 'done')).toHaveLength(0);
    expect(mocks.taskUpdateMany.mock.calls.filter(([input]) => input.data.status === 'done')).toHaveLength(0);
    for (const [input] of mocks.transactionTaskUpdateMany.mock.calls.filter(([write]) => write.data.status === 'done')) {
      expect(input.where).toMatchObject({ batchId: batch.id, status: 'in_progress' });
    }
    expect([...rows.values()].map((row) => row.status)).toEqual(['done', 'done']);
    expect(completedEventCount()).toBe(1);
    expect(mocks.cleanupBatch).toHaveBeenCalledTimes(1);
  });

  it('waits for every member\'s local persistence before publishing a parallel batch', async () => {
    const batch = makeBatch('parallel', ['running', 'running']);
    const persisted = gate<void>();
    mocks.taskUpdate.mockImplementation(async (input) => {
      if (input.where.id === batch.tasks[0].taskId && input.data.status === 'in_progress') await persisted.promise;
      return applyUpdate(rows, input);
    });
    const first = completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, true);
    await until(() => mocks.taskUpdate.mock.calls.some(([input]) => input.where.id === batch.tasks[0].taskId && input.data.status === 'in_progress'));
    const second = completion.handleTaskComplete(batch.id, batch.tasks[1].taskId, true);
    try {
      await until(() => batch.tasks[1].status === 'completed');
      // Let the ready member's continuation run while its sibling's write
      // remains deliberately blocked. No publication is yet safe.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mocks.pushBranch).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(doneWrites()).toEqual([]);
    } finally {
      persisted.resolve();
      await Promise.all([first, second]);
    }
    expect(batch.status).toBe('completed');
    expect([...rows.values()].map((row) => row.status)).toEqual(['done', 'done']);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('uses the same publication transaction and hardened commit for a combined batch', async () => {
    const batch = makeBatch('combined', ['running', 'running']);

    await completion.handleCombinedBatchComplete(batch.id, true);

    expect(batch.status).toBe('completed');
    expect([...rows.values()].map((row) => row.status)).toEqual(['done', 'done']);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.pushBranch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.rawExec).not.toHaveBeenCalled();
    expect(mocks.execGit).toHaveBeenCalledWith(
      expect.arrayContaining(['-C', batch.tasks[0].worktreePath, 'commit']), expect.anything(),
    );
    expect(mocks.cleanupBatch).toHaveBeenCalledTimes(1);
  });

  it.each<BatchMode>(['parallel', 'combined'])('retains %s artifacts and never reports done when push fails', async (mode) => {
    const batch = makeBatch(mode, mode === 'combined' ? ['running', 'running'] : ['completed', 'completed']);
    mocks.pushBranch.mockRejectedValueOnce(new Error('remote push rejected'));

    await finish(batch);

    expectRetainedFailure(batch);
    expect(doneWrites()).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('redacts the Git credential from persisted failure outcomes and receipt errors', async () => {
    const batch = makeBatch();
    mocks.pushBranch.mockRejectedValueOnce(new Error(`Push rejected credential ${accessToken}`));

    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    for (const task of batch.tasks) {
      expect(task.error).not.toContain(accessToken);
      expect(rows.get(task.taskId)?.outcome).not.toContain(accessToken);
    }
    expect(batch.publication?.error).not.toContain(accessToken);
    for (const [_batch, _phase, error] of mocks.writeReceipt.mock.calls) {
      if (typeof error === 'string') expect(error).not.toContain(accessToken);
    }
  });

  it('requires PR credentials before dispatching a push', async () => {
    const batch = makeBatch();
    batch.accessToken = null;

    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['no code changes', () => mocks.hasCommittableChanges.mockResolvedValueOnce(false)],
    ['no staged changes', () => mocks.stageCommittableChanges.mockResolvedValueOnce(false)],
    ['commit rejection', () => mocks.execGit.mockRejectedValueOnce(new Error('commit rejected'))],
  ])('retains a failed member after %s without attempting publication', async (_name, arrange) => {
    const batch = makeBatch('parallel', ['running']);
    arrange();

    await completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, true);

    expectRetainedFailure(batch);
    expect(doneWrites()).toEqual([]);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.stopBatchSessions).toHaveBeenCalledWith(batch, [batch.tasks[0].taskId]);
    expect(shared.completingBatchTasks.size).toBe(0);
  });

  it('keeps a failing session owned until its stop request settles', async () => {
    const batch = makeBatch('parallel', ['running']);
    const stopped = gate<void>();
    mocks.stopBatchSessions.mockImplementationOnce(async (current, taskIds) => {
      await stopped.promise;
      for (const task of current.tasks) {
        if (taskIds.includes(task.taskId)) task.cancelUnconfirmed = false;
      }
    });
    const pending = completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, false, 'provider execution failed');
    await until(() => mocks.stopBatchSessions.mock.calls.length === 1);

    expect(batch.tasks[0].cancelUnconfirmed).toBe(true);
    expect(shared.batchHasInFlightWork(batch)).toBe(true);
    expect(rows.get(batch.tasks[0].taskId)?.status).toBe('in_progress');
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    stopped.resolve();
    await pending;

    expectRetainedFailure(batch);
    expect(batch.tasks[0].cancelUnconfirmed).toBe(false);
    expect(shared.batchHasInFlightWork(batch)).toBe(false);
    expect(shared.completingBatchTasks.size).toBe(0);
  });

  it('retains ownership after a failed session stop cannot be confirmed', async () => {
    const batch = makeBatch('parallel', ['running']);
    // The stop helper retains this flag when the provider rejects/times out.
    mocks.stopBatchSessions.mockResolvedValueOnce(undefined);

    await completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, false, 'provider execution failed');

    expectRetainedFailure(batch);
    expect(batch.tasks[0].cancelUnconfirmed).toBe(true);
    expect(shared.completingBatchTasks.size).toBe(0);
    expect(shared.batchHasInFlightWork(batch)).toBe(true);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(doneWrites()).toEqual([]);
  });

  it.each([
    ['HTTP rejection', () => Promise.resolve(new Response('permission denied', { status: 403 }))],
    ['missing PR URL', () => Promise.resolve(new Response('{}', { status: 201 }))],
    ['network rejection', () => Promise.reject(new Error('connection lost'))],
  ])('retains pushed artifacts instead of accepting a compare link after %s', async (_name, response) => {
    const batch = makeBatch();
    mocks.fetch.mockImplementation(response);

    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    expect(doneWrites()).toEqual([]);
    expect(mocks.pushBranch).toHaveBeenCalledTimes(1);
  });

  it('does not treat a successful response containing a compare URL as a pull request', async () => {
    const batch = makeBatch();
    const compare = `https://github.com/acme/repo/compare/main...${batch.batchBranch}`;
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ html_url: compare }), { status: 201 }));

    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    expect(doneWrites()).toEqual([]);
  });

  it('rejects a PR receipt for a different repository', async () => {
    const batch = makeBatch();
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ html_url: 'https://github.com/other/repository/pull/101' }), { status: 201 }));

    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    expect(doneWrites()).toEqual([]);
  });

  it.each([
    ['duplicate PR response', () => Promise.resolve(new Response('already exists', { status: 422 }))],
    ['ambiguous network response', () => Promise.reject(new TypeError('connection lost'))],
  ])('reconciles %s with one read instead of another PR mutation', async (_name, response) => {
    const batch = makeBatch();
    mocks.fetch.mockImplementationOnce(response).mockResolvedValueOnce(
      new Response(JSON.stringify([{ html_url: prUrl }]), { status: 200 }),
    );

    await completion.finalizeBatch(batch.id);

    expect(batch.status).toBe('completed');
    expect(batch.prUrl).toBe(prUrl);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls.filter(([_url, options]) => options?.method === 'POST')).toHaveLength(1);
    const [lookup, lookupOptions] = mocks.fetch.mock.calls[1];
    expect(String(lookup)).toContain('head=');
    expect(String(lookup)).toContain(encodeURIComponent(`acme:${batch.batchBranch}`));
    expect(lookupOptions?.method).not.toBe('POST');
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(completedEventCount()).toBe(1);
  });

  it('does not accept an unconfirmed duplicate PR response', async () => {
    const batch = makeBatch();
    mocks.fetch.mockResolvedValueOnce(new Response('already exists', { status: 422 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));

    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    expect(doneWrites()).toEqual([]);
  });

  it('fails and retains work if the repository disappeared before publication', async () => {
    const batch = makeBatch();
    batch.repository = undefined;
    mocks.repositoryFindUnique.mockResolvedValueOnce(null);

    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not publish an empty success branch when all members failed', async () => {
    const batch = makeBatch('parallel', ['failed', 'failed']);
    for (const row of rows.values()) row.status = 'todo';

    await completion.finalizeBatch(batch.id);

    expect(batch.status).toBe('failed');
    expect(doneWrites()).toEqual([]);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.cleanupBatch).not.toHaveBeenCalled();
  });

  it('persists failure for all unpublished committed members after a fatal merge conflict', async () => {
    const batch = makeBatch();
    mocks.mergeBranch.mockResolvedValueOnce(false);

    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(doneWrites()).toEqual([]);
  });

  it('publishes only merged members and retains the skipped worktree after a skippable conflict', async () => {
    const batch = makeBatch();
    batch.settings.conflictBehavior = 'skip';
    mocks.mergeBranch.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await completion.finalizeBatch(batch.id);

    expect(batch.status).toBe('completed');
    expect(batch.tasks[0].status).toBe('skipped');
    expect(rows.get(batch.tasks[0].taskId)?.status).toBe('todo');
    expect(rows.get(batch.tasks[0].taskId)?.outcome).toContain(batch.tasks[0].worktreePath);
    expect(rows.get(batch.tasks[1].taskId)?.status).toBe('done');
    expect(doneWrites()).toHaveLength(1);
    expect(mocks.cleanupBatch).not.toHaveBeenCalled();
    expect(mocks.removeWorktree.mock.calls.every(([_repoId, path]) => path !== batch.tasks[0].worktreePath)).toBe(true);
  });

  it('retains the published artifact when the terminal database transaction fails', async () => {
    const batch = makeBatch();
    mocks.transaction.mockRejectedValueOnce(new Error('database unavailable'));

    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    expect([...rows.values()].every((row) => row.status !== 'done')).toBe(true);
    expect(mocks.pushBranch).toHaveBeenCalledTimes(1);
    expect(batch.prUrl).toBe(prUrl);
    expect(batch.publication?.branchUrl).toContain('/compare/');
  });

  it('preserves confirmed publication and done rows if the final receipt refresh fails', async () => {
    const batch = makeBatch();
    mocks.writeReceipt.mockImplementation(async (current: BatchState, phase: BatchPublicationPhase, error?: string) => {
      if (phase === 'completed') throw new Error('receipt disk unavailable');
      await recordReceipt(current, phase, error);
    });

    await completion.finalizeBatch(batch.id);

    expect(batch.status).toBe('completed');
    expect(batch.prUrl).toBe(prUrl);
    expect([...rows.values()].map((row) => row.status)).toEqual(['done', 'done']);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(completedEventCount()).toBe(1);
    expect(mocks.cleanupBatch).not.toHaveBeenCalled();
    expect(mocks.taskUpdateMany.mock.calls.filter(([input]) => input.data.status === 'todo')).toEqual([]);
  });

  it('rolls back terminal writes if a member was cancelled before the publication transaction', async () => {
    const batch = makeBatch();
    mocks.fetch.mockImplementationOnce(async () => {
      const cancelled = rows.get(batch.tasks[0].taskId);
      if (!cancelled) throw new Error('Missing fixture task');
      cancelled.status = 'cancelled';
      return new Response(JSON.stringify({ html_url: prUrl }), { status: 201 });
    });

    await completion.finalizeBatch(batch.id);

    expect(batch.status).toBe('failed');
    expect(rows.get(batch.tasks[0].taskId)?.status).toBe('cancelled');
    expect(rows.get(batch.tasks[1].taskId)?.status).not.toBe('done');
    expect(completedEventCount()).toBe(0);
    expect(mocks.cleanupBatch).not.toHaveBeenCalled();
  });

  it.each<BatchMode>(['parallel', 'combined'])('claims one %s completion across concurrent duplicate callbacks', async (mode) => {
    const batch = makeBatch(mode, ['running']);
    const committed = gate<{ stdout: string; stderr: string }>();
    mocks.execGit.mockReturnValueOnce(committed.promise);
    const start = () => mode === 'combined'
      ? completion.handleCombinedBatchComplete(batch.id, true)
      : completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, true);
    const first = start();
    await until(() => mocks.execGit.mock.calls.length === 1);
    const duplicate = start();
    committed.resolve({ stdout: '', stderr: '' });
    await Promise.all([first, duplicate]);

    expect(mocks.execGit.mock.calls.filter(([args]) => args.includes('commit'))).toHaveLength(1);
    expect(mocks.pushBranch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(shared.completingBatchTasks.size).toBe(0);
    expect(shared.completingCombinedBatches.size).toBe(0);
    expect(completedEventCount()).toBe(1);
  });

  it('does not release another callback\'s completion claim when cancelled mid-commit', async () => {
    const batch = makeBatch('parallel', ['running']);
    const committed = gate<{ stdout: string; stderr: string }>();
    mocks.execGit.mockReturnValueOnce(committed.promise);
    const first = completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, true);
    await until(() => mocks.execGit.mock.calls.length === 1);
    const claim = completionKey(batch.id, batch.tasks[0].taskId);
    expect(shared.completingBatchTasks.has(claim)).toBe(true);

    setCancelled(batch);
    await completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, true);
    expect(shared.completingBatchTasks.has(claim)).toBe(true);
    committed.resolve({ stdout: '', stderr: '' });
    await first;

    expect(batch.status).toBe('cancelled');
    expect(batch.tasks[0].status).toBe('cancelled');
    expect(doneWrites()).toEqual([]);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.cleanupBatch).not.toHaveBeenCalled();
    expect(shared.completingBatchTasks.has(claim)).toBe(false);
  });

  it('does not overwrite a persisted cancellation with a late pending-publication update', async () => {
    const batch = makeBatch('parallel', ['running']);
    const persisted = gate<void>();
    mocks.taskUpdate.mockImplementation(async (input) => {
      if (input.data.status === 'in_progress') await persisted.promise;
      return applyUpdate(rows, input);
    });
    const pending = completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, true);
    await until(() => mocks.taskUpdate.mock.calls.some(([input]) => input.data.status === 'in_progress'));
    setCancelled(batch);
    persisted.resolve();
    await pending;

    expect(batch.status).toBe('cancelled');
    expect(rows.get(batch.tasks[0].taskId)?.status).toBe('cancelled');
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(doneWrites()).toEqual([]);
    expect(mocks.cleanupBatch).not.toHaveBeenCalled();
    expect(shared.completingBatchTasks.size).toBe(0);
  });

  it.each<BatchMode>(['parallel', 'combined'])('stops new effects after %s cancellation while a push is in flight', async (mode) => {
    const batch = makeBatch(mode, mode === 'combined' ? ['running', 'running'] : ['completed', 'completed']);
    const pushed = gate<void>();
    mocks.pushBranch.mockReturnValueOnce(pushed.promise);
    const pending = finish(batch);
    await until(() => mocks.pushBranch.mock.calls.length === 1);
    setCancelled(batch);
    pushed.resolve();
    await pending;

    expect(batch.status).toBe('cancelled');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(doneWrites()).toEqual([]);
    expect(completedEventCount()).toBe(0);
    expect(mocks.cleanupBatch).not.toHaveBeenCalled();
    expect(batch.publication?.branchUrl).toContain('/compare/');
    expect(shared.finalizingBatches.has(batch.id)).toBe(false);
    expect(shared.completingCombinedBatches.has(batch.id)).toBe(false);
  });

  it('preserves cancellation instead of recording success when an already-started PR request resolves', async () => {
    const batch = makeBatch();
    const requested = gate<Response>();
    mocks.fetch.mockReturnValueOnce(requested.promise);
    const pending = completion.finalizeBatch(batch.id);
    await until(() => mocks.fetch.mock.calls.length === 1);
    setCancelled(batch);
    requested.resolve(new Response(JSON.stringify({ html_url: prUrl }), { status: 201 }));
    await pending;

    expect(batch.status).toBe('cancelled');
    expect(doneWrites()).toEqual([]);
    expect(completedEventCount()).toBe(0);
    expect(mocks.cleanupBatch).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(batch.prUrl).toBe(prUrl);
    expect(mocks.writeReceipt).toHaveBeenCalledWith(batch, 'pr_created');
  });

  it('does not restart finalization from a late callback after publication failed', async () => {
    const batch = makeBatch('parallel', ['running']);
    mocks.pushBranch.mockRejectedValueOnce(new Error('push failed'));
    await completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, true);

    await completion.handleTaskComplete(batch.id, batch.tasks[0].taskId, true);
    await completion.finalizeBatch(batch.id);

    expectRetainedFailure(batch);
    expect(mocks.pushBranch).toHaveBeenCalledTimes(1);
    expect(mocks.execGit.mock.calls.filter(([args]) => args.includes('commit'))).toHaveLength(1);
    expect(completedEventCount()).toBe(0);
  });
});
