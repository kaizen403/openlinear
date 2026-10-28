import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchState } from '@openlinear/execution-core';

function row(id: string) {
  return { id, title: id, description: 'fixture', model: 'openai/test', agent: null as string | null,
    archived: false, status: 'todo', batchId: null as string | null, projectId: 'project', identifier: id,
    teamId: null as string | null, creatorId: 'user',
    project: { id: 'project', localPath: null, defaultAgent: null,
      repository: { id: 'repo', name: 'repo', fullName: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', defaultBranch: 'main' } },
    labels: [] };
}
type Row = ReturnType<typeof row>;
const mocks = vi.hoisted(() => ({
  rows: new Map<string, Row>(), taskFindMany: vi.fn(), taskUpdate: vi.fn(), updateMany: vi.fn(), transaction: vi.fn(),
  repository: vi.fn(), ownership: vi.fn(), settings: vi.fn(),
  ensureMain: vi.fn(), createWorktree: vi.fn(), createCombined: vi.fn(), cleanup: vi.fn(),
  getClient: vi.fn(), sessionCreate: vi.fn(), prompt: vi.fn(), abort: vi.fn(), subscribe: vi.fn(),
  callbacks: new Map<string, (success: boolean, error?: string) => Promise<void>>(),
  receipt: vi.fn(), notify: vi.fn(), git: vi.fn(),
}));
vi.mock('@openlinear/db', () => ({ prisma: {
  task: { findMany: mocks.taskFindMany, update: mocks.taskUpdate, updateMany: mocks.updateMany },
  repository: { findUnique: mocks.repository }, $transaction: mocks.transaction,
} }));
// W03a: authorization via the control plane; events via the sidecar publisher.
vi.mock('../../auth/task-access', () => ({
  authorizeTaskAccess: (credential: { principal?: { userId?: string } } | null, taskId: string) =>
    mocks.ownership(taskId, credential?.principal?.userId ?? null),
}));
vi.mock('../../events/publisher', () => ({
  publishUserEvent: mocks.notify, publishTaskEvent: mocks.notify, publishGlobalEvent: vi.fn(),
  registerTaskOwnerResolver: vi.fn(), attachAttemptRelay: vi.fn(), detachAttemptRelay: vi.fn(),
}));
vi.mock('../execution/state', () => ({ activeExecutions: new Map(), pendingExecutions: new Set(), broadcastProgress: mocks.notify }));
vi.mock('../execution-settings', () => ({ getExecutionSettings: mocks.settings }));
vi.mock('../opencode-model', () => ({ ensureModelConfigured: vi.fn(async () => ({ model: 'openai/test' })) }));
vi.mock('../opencode', () => ({ getClientForUser: mocks.getClient }));
vi.mock('../worktree', () => ({
  ensureMainRepo: mocks.ensureMain, createWorktree: mocks.createWorktree, createBatchWorktree: mocks.createCombined,
  cleanupBatch: mocks.cleanup, createBatchBranch: vi.fn(), mergeBranch: vi.fn(async () => true), pushBranch: vi.fn(),
}));
vi.mock('../execution/git', () => ({ hasCommittableChanges: vi.fn(async () => true), stageCommittableChanges: vi.fn(async () => true) }));
vi.mock('../git-credentials', () => ({ execGit: mocks.git }));
vi.mock('./publication', () => ({
  writeBatchReceipt: mocks.receipt, publishBatchPullRequest: vi.fn(async () => 'https://github.com/acme/repo/pull/1'),
  safeBatchError: (_batch: unknown, error: unknown) => error instanceof Error ? error.message : 'fixture failure',
}));
vi.mock('../session-manager', () => ({
  subscribeToTaskEvents: mocks.subscribe,
  subscribeToSessionEvents: vi.fn(() => ({ ready: Promise.resolve(), close: vi.fn() })),
}));
const orchestration = await import('./orchestrator');
const shared = await import('./shared');
const state = await import('../execution/state');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function create(mode: 'parallel' | 'queue' | 'combined' = 'parallel', count = 2): Promise<BatchState> {
  const ids = Array.from({ length: count }, (_, index) => `task-${index}`);
  for (const id of ids) mocks.rows.set(id, row(id));
  return orchestration.createBatch({ taskIds: ids, mode, userId: 'user', projectId: '', accessToken: 'fixture-token' });
}

describe('batch preparation, admission and cancellation interleavings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.clear(); mocks.callbacks.clear();
    mocks.ownership.mockImplementation(async (id) => {
      const task = mocks.rows.get(id)!;
      return { id, projectId: task.projectId, teamId: task.teamId, creatorId: task.creatorId, archived: task.archived, status: task.status };
    });
    mocks.settings.mockResolvedValue({ maxBatchSize: 2, parallelLimit: 3, queueAutoApprove: false, stopOnFailure: false, conflictBehavior: 'skip' });
    mocks.ensureMain.mockResolvedValue('/owned/.main');
    mocks.createWorktree.mockImplementation(async (_repo, batch, task) => `/owned/${batch}/${task}`);
    mocks.createCombined.mockResolvedValue('/owned/combined');
    mocks.receipt.mockResolvedValue(undefined);
    mocks.git.mockResolvedValue({ stdout: '', stderr: '' });
    mocks.repository.mockResolvedValue(row('unused').project.repository);
    mocks.taskFindMany.mockImplementation(async (input) => [...mocks.rows.values()].filter((task) => input.where.id.in.includes(task.id)));
    mocks.updateMany.mockImplementation(async (input) => {
      if (input.where.OR) {
        for (const condition of input.where.OR) Object.assign(mocks.rows.get(condition.id)!, input.data);
        return { count: input.where.OR.length };
      }
      const task = mocks.rows.get(input.where.id);
      if (!task || task.batchId !== input.where.batchId || (input.where.status === 'in_progress' && task.status !== 'in_progress')) return { count: 0 };
      Object.assign(task, input.data);
      return { count: 1 };
    });
    mocks.taskUpdate.mockImplementation(async (input) => {
      const task = mocks.rows.get(input.where.id);
      if (!task || (input.where.batchId && task.batchId !== input.where.batchId)
        || (input.where.status?.not === 'cancelled' && task.status === 'cancelled')) throw new Error('Conditional task write denied');
      Object.assign(task, input.data);
      return { ...task, labels: [] };
    });
    mocks.transaction.mockImplementation(async (fn) => fn({ task: { updateMany: mocks.updateMany, findMany: mocks.taskFindMany } }));
    mocks.sessionCreate.mockImplementation(async () => ({ data: { id: `session-${mocks.sessionCreate.mock.calls.length}` } }));
    mocks.prompt.mockResolvedValue({});
    mocks.abort.mockResolvedValue({ data: true });
    mocks.getClient.mockResolvedValue({ session: { create: mocks.sessionCreate, promptAsync: mocks.prompt, abort: mocks.abort },
      config: { get: vi.fn(async () => ({ data: { model: 'openai/test' } })) } });
    mocks.subscribe.mockImplementation((_client, _session, _batch, taskId, callback) => {
      mocks.callbacks.set(taskId, callback);
      return { ready: Promise.resolve(), close: vi.fn() };
    });
  });
  afterEach(() => {
    for (const subscription of shared.batchSubscriptions.values()) subscription.close();
    for (const map of [shared.activeBatches, shared.batchSubscriptions, shared.sessionToBatch, shared.batchTaskLogs, shared.batchTaskLogOwners, shared.cancellationPromises, shared.memberCancellationPromises]) map.clear();
    for (const set of [shared.pendingBatchTasks, shared.preparingBatchTasks, shared.completingBatchTasks, shared.completingCombinedBatches, shared.finalizingBatches, shared.cancellingBatches, state.pendingExecutions]) set.clear();
  });

  it('bounds initial parallel launches and refills one free slot after completion', async () => {
    const batch = await create('parallel', 4);
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(2));
    expect(batch.tasks.filter((task) => task.status === 'queued')).toHaveLength(2);
    await mocks.callbacks.get('task-0')!(true);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(3));
    expect(batch.tasks.filter((task) => task.status === 'running')).toHaveLength(2);
    expect(batch.tasks.filter((task) => task.status === 'queued')).toHaveLength(1);
    expect(mocks.rows.get('task-0')?.status).toBe('in_progress');
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('rejects duplicate starts and simultaneous approval of a busy queue', async () => {
    const batch = await create('queue');
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(1));
    await expect(orchestration.startBatch(batch.id)).rejects.toMatchObject({ code: 'BATCH_ALREADY_STARTED' });
    await expect(orchestration.approveNextTask(batch.id)).rejects.toMatchObject({ code: 'BATCH_NOT_READY' });
    await mocks.callbacks.get('task-0')!(true);
    await vi.waitFor(() => expect(shared.batchRunningCount(batch)).toBe(0));
    const approvals = await Promise.allSettled([orchestration.approveNextTask(batch.id), orchestration.approveNextTask(batch.id)]);
    expect(approvals.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(2));
  });

  it('revalidates a queued member before creating a new checkout or session', async () => {
    const batch = await create('queue');
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(1));
    await mocks.callbacks.get('task-0')!(true);
    await vi.waitFor(() => expect(shared.batchRunningCount(batch)).toBe(0));
    mocks.rows.get('task-1')!.agent = 'codex';
    await expect(orchestration.approveNextTask(batch.id)).rejects.toMatchObject({ code: 'RUNNER_NOT_SUPPORTED' });
    expect(mocks.createWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.sessionCreate).toHaveBeenCalledTimes(1);
  });

  it('cancels during checkout and holds task ownership until setup exits', async () => {
    const gate = deferred<string>();
    mocks.createWorktree.mockReturnValueOnce(gate.promise);
    const batch = await create('queue', 1);
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.createWorktree).toHaveBeenCalled());
    await orchestration.cancelBatch(batch.id);
    await expect(orchestration.createBatch({ taskIds: ['task-0'], mode: 'queue', userId: 'user', projectId: '', accessToken: null }))
      .rejects.toMatchObject({ code: 'TASK_ALREADY_RUNNING' });
    gate.resolve('/owned/late-checkout');
    await vi.waitFor(() => expect(shared.preparingBatchTasks.size).toBe(0));
    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.rows.get('task-0')?.status).toBe('cancelled');
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('quarantines a failed late session abort and permits retry after confirmed stop', async () => {
    const gate = deferred<{ data: { id: string } }>();
    mocks.sessionCreate.mockReturnValueOnce(gate.promise);
    const batch = await create('queue', 1);
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.sessionCreate).toHaveBeenCalled());
    await orchestration.cancelBatch(batch.id);
    mocks.abort.mockRejectedValueOnce(new Error('provider unavailable'));
    gate.resolve({ data: { id: 'late-session' } });
    await vi.waitFor(() => expect(shared.preparingBatchTasks.size).toBe(0));
    expect(batch.tasks[0].cancelUnconfirmed).toBe(true);
    await expect(orchestration.createBatch({ taskIds: ['task-0'], mode: 'queue', userId: 'user', projectId: '', accessToken: null }))
      .rejects.toMatchObject({ code: 'TASK_ALREADY_RUNNING' });
    await orchestration.cancelBatch(batch.id);
    expect(batch.tasks[0].cancelUnconfirmed).toBe(false);
    expect(mocks.prompt).not.toHaveBeenCalled();
    await expect(orchestration.createBatch({ taskIds: ['task-0'], mode: 'queue', userId: 'user', projectId: '', accessToken: null })).resolves.toBeDefined();
  });

  it('aborts again when a prompt is accepted after cancellation', async () => {
    const gate = deferred<Record<string, never>>();
    mocks.prompt.mockReturnValueOnce(gate.promise);
    const batch = await create('queue', 1);
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalled());
    await orchestration.cancelBatch(batch.id);
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    gate.resolve({});
    await vi.waitFor(() => expect(mocks.abort).toHaveBeenCalledTimes(2));
    expect(mocks.rows.get('task-0')?.status).toBe('cancelled');
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('continues aborting all sessions even if one cancellation DB write fails', async () => {
    const batch = await create('parallel', 2);
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(2));
    const original = mocks.taskUpdate.getMockImplementation()!;
    mocks.taskUpdate.mockImplementation(async (input) => {
      if (input.data.status === 'cancelled' && input.where.id === 'task-0') throw new Error('database unavailable');
      return original(input);
    });
    await expect(orchestration.cancelBatch(batch.id)).rejects.toMatchObject({ code: 'CANCEL_INCOMPLETE' });
    expect(mocks.abort).toHaveBeenCalledTimes(2);
    expect(batch.tasks[0].cancelUnconfirmed).toBe(true);
    expect(batch.tasks[1].cancelUnconfirmed).toBe(false);
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it.each([{}, { data: false }, { error: { message: 'denied' } }])('keeps ownership for an unconfirmed abort response %j', async (response) => {
    const batch = await create('queue', 1);
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(1));
    mocks.abort.mockResolvedValueOnce(response);
    await expect(orchestration.cancelBatch(batch.id)).rejects.toMatchObject({ code: 'CANCEL_INCOMPLETE' });
    expect(batch.tasks[0].cancelUnconfirmed).toBe(true);
    await expect(orchestration.createBatch({ taskIds: ['task-0'], mode: 'queue', userId: 'user', projectId: '', accessToken: null }))
      .rejects.toMatchObject({ code: 'TASK_ALREADY_RUNNING' });
    await orchestration.cancelBatch(batch.id);
    expect(batch.tasks[0].cancelUnconfirmed).toBe(false);
  });

  it('defers sibling publication until member cancellation has saved its receipt', async () => {
    const batch = await create();
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(2));
    const reached = deferred<void>(); const release = deferred<void>();
    mocks.receipt.mockImplementationOnce(async () => { reached.resolve(); await release.promise; });
    const cancellation = orchestration.cancelTask(batch.id, 'task-1');
    await reached.promise;
    expect(batch.tasks[1].cancelUnconfirmed).toBe(false);
    await mocks.callbacks.get('task-0')!(true);
    expect(batch.status).toBe('running');
    expect(shared.memberCancellationPromises.size).toBe(1);
    release.resolve(); await cancellation;
    expect(batch.status).toBe('completed');
    expect(mocks.rows.get('task-0')?.status).toBe('done');
    expect(mocks.rows.get('task-1')?.status).toBe('cancelled');
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('allows retry when a member cancellation receipt cannot be saved', async () => {
    const batch = await create();
    await orchestration.startBatch(batch.id);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(2));
    mocks.receipt.mockRejectedValueOnce(new Error('receipt unavailable'));
    await expect(orchestration.cancelTask(batch.id, 'task-1')).rejects.toMatchObject({ code: 'CANCEL_INCOMPLETE' });
    expect(batch.tasks[1].cancelUnconfirmed).toBe(true);
    await orchestration.cancelTask(batch.id, 'task-1');
    expect(batch.tasks[1].cancelUnconfirmed).toBe(false);
    expect(shared.memberCancellationPromises.size).toBe(0);
  });
});
