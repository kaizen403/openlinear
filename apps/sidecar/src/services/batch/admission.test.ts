import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatchState, type BatchMode, type BatchState } from '@openlinear/execution-core';
import { HttpError } from '../../lib/errors';
import type { TaskAuthority as OwnedTask } from '../../auth/task-access';
import type { BatchMemberSnapshot, BatchRepositorySnapshot } from './admission';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), updateMany: vi.fn(), transaction: vi.fn(), assertTaskOwned: vi.fn(),
  settings: vi.fn(), ensureModelConfigured: vi.fn(), ensureMainRepo: vi.fn(),
  createWorktree: vi.fn(), createBatchWorktree: vi.fn(), getClientForUser: vi.fn(),
  broadcastBatchEvent: vi.fn(), updateTaskInDb: vi.fn(), writeBatchReceipt: vi.fn(), batchHasInFlightWork: vi.fn(),
  activeBatches: new Map<string, BatchState>(), pendingBatchTasks: new Set<string>(),
  activeExecutions: new Map<string, unknown>(), pendingExecutions: new Set<string>(),
}));

vi.mock('@openlinear/db', () => ({
  prisma: { task: { findMany: mocks.findMany, updateMany: mocks.updateMany }, $transaction: mocks.transaction },
}));
// W03a: member authorization is the control plane's decision.
vi.mock('../../auth/task-access', () => ({
  authorizeTaskAccess: (credential: { principal?: { userId?: string } } | null, taskId: string) =>
    mocks.assertTaskOwned(taskId, credential?.principal?.userId ?? 'user-a'),
}));
vi.mock('../execution/state', () => ({ activeExecutions: mocks.activeExecutions, pendingExecutions: mocks.pendingExecutions }));
vi.mock('./shared', () => ({
  activeBatches: mocks.activeBatches, pendingBatchTasks: mocks.pendingBatchTasks,
  batchHasInFlightWork: mocks.batchHasInFlightWork,
  sessionToBatch: new Map(), completingBatchTasks: new Set(),
  batchTaskLogOwners: new Map(), batchTaskLogs: new Map(),
  broadcastBatchEvent: mocks.broadcastBatchEvent, broadcastBatchProgress: vi.fn(), emitBatchLog: vi.fn(),
  getBatchExecutionLogs: vi.fn(), scheduleBatchCleanup: vi.fn(), updateTaskInDb: mocks.updateTaskInDb,
}));
vi.mock('../execution-settings', () => ({ getExecutionSettings: mocks.settings }));
vi.mock('../opencode-model', () => ({ ensureModelConfigured: mocks.ensureModelConfigured }));
vi.mock('../opencode', () => ({ getClientForUser: mocks.getClientForUser }));
vi.mock('../worktree', () => ({
  ensureMainRepo: mocks.ensureMainRepo, createWorktree: mocks.createWorktree,
  createBatchWorktree: mocks.createBatchWorktree, cleanupBatch: vi.fn(),
}));
vi.mock('../delta-buffer', () => ({ cleanupDeltaBuffer: vi.fn() }));
vi.mock('../session-manager', () => ({ subscribeToSessionEvents: vi.fn(), subscribeToTaskEvents: vi.fn() }));
vi.mock('./completion', () => ({ handleTaskComplete: vi.fn(), handleCombinedBatchComplete: vi.fn(), advanceQueue: vi.fn() }));
vi.mock('./publication', async (importOriginal) => ({
  ...await importOriginal<typeof import('./publication')>(),
  writeBatchReceipt: mocks.writeBatchReceipt,
}));

const { validateBatchRequest, validateBatchSelection, reserveBatchTasks, taskHasActiveBatch } = await import('./admission');
// W03a: in-memory batch state lives in the Prisma-free registry; share its
// instances with the mocked `./shared` surface the orchestrator imports.
const registry = await import('./registry');
mocks.activeBatches = registry.activeBatches;
mocks.pendingBatchTasks = registry.pendingBatchTasks;
const { createBatch } = await import('./orchestrator');
let records: BatchMemberSnapshot[];

function repository(overrides: Partial<BatchRepositorySnapshot> = {}): BatchRepositorySnapshot {
  return { id: 'repo-a', name: 'repo', fullName: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', defaultBranch: 'main', ...overrides };
}

function member(id: string, overrides: Partial<BatchMemberSnapshot> = {}): BatchMemberSnapshot {
  return {
    id, title: `Task ${id}`, description: null, model: 'test/model', agent: null,
    archived: false, status: 'todo', batchId: null, projectId: 'project-a', teamId: 'team-a', creatorId: 'user-a',
    project: { id: 'project-a', localPath: null, defaultAgent: null, repository: repository() },
    ...overrides,
  };
}

function ownership(task: BatchMemberSnapshot): OwnedTask {
  return { id: task.id, projectId: task.projectId, teamId: task.teamId, creatorId: task.creatorId,
    archived: task.archived, status: task.status };
}

function batch(overrides: Partial<BatchState> = {}): BatchState {
  return {
    ...createBatchState({
      id: 'batch-a', projectId: 'repo-a', mode: 'queue', taskIds: ['task-a', 'task-b'],
      mainRepoPath: '/fixture/mirror', accessToken: null, userId: 'user-a',
      settings: { maxConcurrent: 2, autoApprove: false, stopOnFailure: false, conflictBehavior: 'fail' },
    }),
    repository: repository(), taskProjectIds: { 'task-a': 'project-a', 'task-b': 'project-a' },
    ...overrides,
  };
}

function create(taskIds = ['task-a', 'task-b'], mode: BatchMode = 'queue') {
  return createBatch({ taskIds, mode, projectId: '', userId: 'user-a', accessToken: null });
}

function expectNoAdmissionEffects() {
  expect(mocks.ensureModelConfigured).not.toHaveBeenCalled();
  expect(mocks.settings).not.toHaveBeenCalled();
  expect(mocks.ensureMainRepo).not.toHaveBeenCalled();
  expect(mocks.createWorktree).not.toHaveBeenCalled();
  expect(mocks.createBatchWorktree).not.toHaveBeenCalled();
  expect(mocks.getClientForUser).not.toHaveBeenCalled();
  expect(mocks.updateMany).not.toHaveBeenCalled();
  expect(mocks.updateTaskInDb).not.toHaveBeenCalled();
  expect(mocks.writeBatchReceipt).not.toHaveBeenCalled();
  expect(mocks.broadcastBatchEvent).not.toHaveBeenCalled();
  expect(mocks.activeBatches.size).toBe(0);
  expect(mocks.pendingBatchTasks.size).toBe(0);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.activeBatches.clear(); mocks.pendingBatchTasks.clear();
  mocks.activeExecutions.clear(); mocks.pendingExecutions.clear();
  records = [member('task-a'), member('task-b')];
  mocks.assertTaskOwned.mockImplementation(async (id: string) => ownership(records.find((task) => task.id === id) ?? member(id)));
  mocks.batchHasInFlightWork.mockReturnValue(false);
  mocks.findMany.mockImplementation(async (query: { where: { id: { in: string[] } } }) => records.filter((record) => query.where.id.in.includes(record.id)));
  mocks.settings.mockResolvedValue({ maxBatchSize: 2, queueAutoApprove: false, stopOnFailure: false, conflictBehavior: 'fail' });
  mocks.ensureModelConfigured.mockResolvedValue({ model: 'test/model', hasProvider: true });
  mocks.ensureMainRepo.mockResolvedValue('/fixture/mirror');
  mocks.updateMany.mockResolvedValue({ count: 2 });
  mocks.writeBatchReceipt.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async (operation: (tx: { task: { updateMany: typeof mocks.updateMany } }) => Promise<unknown>) => operation({ task: { updateMany: mocks.updateMany } }));
});

describe('batch request boundary', () => {
  it.each<BatchMode>(['parallel', 'queue', 'combined'])('normalizes IDs without reordering %s selections', (mode) => {
    expect(validateBatchRequest([' task-b ', 'task-a'], mode)).toEqual(['task-b', 'task-a']);
  });

  it.each([
    { ids: [], code: 'INVALID_BATCH' },
    { ids: Array.from({ length: 21 }, (_, index) => `task-${index}`), code: 'INVALID_BATCH' },
    { ids: ['task-a', ' task-a '], code: 'DUPLICATE_BATCH_TASK' },
    { ids: [''], code: 'INVALID_BATCH' },
    { ids: [' \n '], code: 'INVALID_BATCH' },
    { ids: ['task\0a'], code: 'INVALID_BATCH' },
    { ids: ['a'.repeat(201)], code: 'INVALID_BATCH' },
  ])('rejects malformed selection $ids before reads or effects', async ({ ids, code }) => {
    await expect(create(ids)).rejects.toMatchObject({ statusCode: 400, code });
    expect(mocks.assertTaskOwned).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
    expectNoAdmissionEffects();
  });

  it('rejects an unsupported mode at the service boundary', () => {
    expect(() => validateBatchRequest(['task-a'], 'invalid' as BatchMode)).toThrowError(expect.objectContaining({ code: 'INVALID_BATCH' }));
  });
});

describe('authorization and complete member validation', () => {
  it('requires an authenticated actor before reading members', async () => {
    await expect(validateBatchSelection({ taskIds: ['task-a'], userId: null })).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
    expect(mocks.assertTaskOwned).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('authorizes every selected task and propagates a denied member before any side effects', async () => {
    const denied = new HttpError(403, 'OWNERSHIP_REQUIRED', 'Forbidden');
    mocks.assertTaskOwned.mockImplementation(async (id: string) => {
      if (id === 'task-b') throw denied;
      return ownership(records.find((task) => task.id === id) ?? member(id));
    });
    await expect(create()).rejects.toBe(denied);
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-a', 'user-a');
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-b', 'user-a');
    expect(mocks.findMany).not.toHaveBeenCalled();
    expectNoAdmissionEffects();
  });

  it('rejects a member deleted after authorization rather than constructing a partial batch', async () => {
    records = [member('task-a')];
    await expect(create()).rejects.toMatchObject({ statusCode: 404, code: 'TASK_NOT_FOUND' });
    expectNoAdmissionEffects();
  });

  it.each(['projectId', 'teamId', 'creatorId'] as const)('rejects a member whose %s changes after authorization before any effects', async (field) => {
    mocks.findMany.mockImplementationOnce(async (query: { where: { id: { in: string[] } } }) => {
      records[1][field] = 'denied-binding';
      if (field === 'projectId') {
        records[1].project = { id: 'denied-binding', localPath: null, defaultAgent: null,
          repository: repository({ id: 'denied-repo', cloneUrl: 'https://github.com/denied/repo.git' }) };
      }
      return records.filter((task) => query.where.id.in.includes(task.id));
    });
    await expect(create()).rejects.toMatchObject({ code: 'BATCH_SELECTION_CHANGED' });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-b', 'user-a');
    expectNoAdmissionEffects();
  });

  it('rejects an authorization result bound to a different task ID before effects', async () => {
    mocks.assertTaskOwned.mockResolvedValueOnce(ownership(member('different-task')));
    await expect(create()).rejects.toMatchObject({ code: 'BATCH_SELECTION_CHANGED' });
    expectNoAdmissionEffects();
  });

  it.each([
    { patch: { archived: true }, code: 'TASK_ARCHIVED', statusCode: 409 },
    { patch: { status: 'in_progress' as const }, code: 'TASK_ALREADY_RUNNING', statusCode: 409 },
    { patch: { agent: 'codex' }, code: 'RUNNER_NOT_SUPPORTED', statusCode: 400 },
    { patch: { agent: 'claude-code' }, code: 'RUNNER_NOT_SUPPORTED', statusCode: 400 },
    { patch: { agent: 'invented-runner' }, code: 'INVALID_RUNNER', statusCode: 400 },
    { patch: { agent: ' ' }, code: 'INVALID_RUNNER', statusCode: 400 },
    { patch: { project: null, projectId: null }, code: 'BATCH_REPOSITORY_REQUIRED', statusCode: 400 },
    { patch: { project: { id: 'project-a', localPath: null, defaultAgent: null, repository: null } }, code: 'BATCH_REPOSITORY_REQUIRED', statusCode: 400 },
    { patch: { project: { id: 'project-a', localPath: '/local/repo', defaultAgent: null, repository: repository() } }, code: 'LOCAL_BATCH_NOT_SUPPORTED', statusCode: 400 },
    { patch: { project: { id: 'project-a', localPath: null, defaultAgent: 'codex', repository: repository() } }, code: 'RUNNER_NOT_SUPPORTED', statusCode: 400 },
  ])('rejects a later member with $code before repository preparation', async ({ patch, code, statusCode }) => {
    records[1] = member('task-b', patch);
    await expect(create()).rejects.toMatchObject({ statusCode, code });
    expectNoAdmissionEffects();
  });

  it.each(['id', 'cloneUrl', 'defaultBranch', 'fullName'] as const)('rejects a conflicting repository %s', async (field) => {
    records[1] = member('task-b', { project: { id: 'project-a', localPath: null, defaultAgent: null, repository: repository({ [field]: 'different' }) } });
    await expect(create()).rejects.toMatchObject({ code: 'BATCH_REPOSITORY_MISMATCH' });
    expectNoAdmissionEffects();
  });

  it('allows fully authorized different projects on the same repository and preserves caller order', async () => {
    records[1] = member('task-b', { projectId: 'project-b', project: { id: 'project-b', localPath: null, defaultAgent: 'codex', repository: repository() }, agent: 'opencode' });
    const admitted = await create([' task-b ', 'task-a']);
    expect(admitted.tasks.map((task) => task.taskId)).toEqual(['task-b', 'task-a']);
    expect(admitted.tasks.map((task) => task.title)).toEqual(['Task task-b', 'Task task-a']);
    expect(admitted.taskProjectIds).toEqual({ 'task-b': 'project-b', 'task-a': 'project-a' });
    expect(admitted.repository).toEqual(repository());
    expect(mocks.ensureMainRepo).toHaveBeenCalledOnce();
    expect(mocks.writeBatchReceipt).toHaveBeenCalledWith(admitted, 'prepared');
    expect(mocks.activeBatches.get(admitted.id)).toBe(admitted);
    expect(mocks.pendingBatchTasks.size).toBe(0);
  });

  it('allows done/cancelled tasks and historical batch IDs to be deliberately retried', async () => {
    records = [member('task-a', { status: 'done', batchId: 'historical' }), member('task-b', { status: 'cancelled', batchId: 'historical' })];
    mocks.activeBatches.set('historical', batch({ id: 'historical', status: 'completed' }));
    const selected = await validateBatchSelection({ taskIds: ['task-a', 'task-b'], userId: 'user-a' });
    expect(selected.tasks.map((task) => task.id)).toEqual(['task-a', 'task-b']);
  });

  it('rejects incompatible combined model selections before preflight or Git', async () => {
    records[1] = member('task-b', { model: 'another/model' });
    await expect(create(undefined, 'combined')).rejects.toMatchObject({ code: 'BATCH_MODEL_MISMATCH' });
    expectNoAdmissionEffects();
  });
});

describe('launch snapshot revalidation', () => {
  beforeEach(() => { records = records.map((task) => ({ ...task, batchId: 'batch-a' })); });

  it('excludes the same batch from active-membership conflicts', async () => {
    const expected = batch({ status: 'running' });
    mocks.activeBatches.set(expected.id, expected);
    records[0].status = 'in_progress';
    await expect(validateBatchSelection({ taskIds: ['task-b', 'task-a'], userId: 'user-a', expected })).resolves.toMatchObject({ tasks: [{ id: 'task-b' }, { id: 'task-a' }] });
  });

  it.each(['batchId', 'projectId', 'cloneUrl', 'defaultBranch'] as const)('rejects changed %s before a queued launch', async (field) => {
    const task = records[0];
    if (field === 'batchId') task.batchId = 'another-batch';
    else if (field === 'projectId') { task.projectId = 'project-b'; task.project!.id = 'project-b'; }
    else task.project!.repository![field] = 'changed';
    await expect(validateBatchSelection({ taskIds: ['task-a'], userId: 'user-a', expected: batch() })).rejects.toMatchObject({ statusCode: 409, code: 'BATCH_SELECTION_CHANGED' });
    expect(mocks.ensureMainRepo).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks current permission and selected runner', async () => {
    records[0].agent = 'codex';
    await expect(validateBatchSelection({ taskIds: ['task-a'], userId: 'user-a', expected: batch() })).rejects.toMatchObject({ code: 'RUNNER_NOT_SUPPORTED' });
    expect(mocks.assertTaskOwned).toHaveBeenCalledWith('task-a', 'user-a');
    expect(mocks.createWorktree).not.toHaveBeenCalled();
    expect(mocks.getClientForUser).not.toHaveBeenCalled();
  });
});

describe('reservation ownership and failed preparation', () => {
  it.each(['todo', 'done', 'cancelled'] as const)('binds the exact authorized %s status and ownership snapshot in its final CAS', async (status) => {
    records[0] = member('task-a', { status, batchId: 'historical', teamId: 'team-snapshot', creatorId: 'creator-snapshot' });
    await create();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [
        expect.objectContaining({ id: 'task-a', projectId: 'project-a', teamId: 'team-snapshot',
          creatorId: 'creator-snapshot', batchId: 'historical', status, archived: false, agent: null, model: 'test/model' }),
        expect.objectContaining({ id: 'task-b', projectId: 'project-a', teamId: 'team-a',
          creatorId: 'user-a', batchId: null, status: 'todo', archived: false, agent: null, model: 'test/model' }),
      ] },
    }));
  });

  it('reserves all members atomically and cannot steal an overlapping reservation', () => {
    const release = reserveBatchTasks(['task-a', 'task-b']);
    expect(() => reserveBatchTasks(['task-b', 'task-c'])).toThrowError(expect.objectContaining({ code: 'TASK_ALREADY_RUNNING' }));
    expect([...mocks.pendingBatchTasks]).toEqual(['task-a', 'task-b']);
    release();
    expect(mocks.pendingBatchTasks.size).toBe(0);
  });

  it('a released reservation cannot later release a new owner of the same task', () => {
    const releaseOld = reserveBatchTasks(['task-a']);
    releaseOld();
    const releaseNew = reserveBatchTasks(['task-a']);
    releaseOld();
    expect(mocks.pendingBatchTasks.has('task-a')).toBe(true);
    releaseNew();
  });

  it.each(['pending-single', 'active-single', 'active-batch'] as const)('rejects %s conflicts without reserving other members', (kind) => {
    if (kind === 'pending-single') mocks.pendingExecutions.add('task-b');
    else if (kind === 'active-single') mocks.activeExecutions.set('task-b', {});
    else mocks.activeBatches.set('other', batch({ id: 'other', status: 'pending' }));
    expect(() => reserveBatchTasks(['task-a', 'task-b'])).toThrowError(expect.objectContaining({ code: 'TASK_ALREADY_RUNNING' }));
    expect(mocks.pendingBatchTasks.size).toBe(0);
  });

  it('holds reservation across async preparation and releases it when Git fails', async () => {
    let fail: (error: Error) => void = () => { throw new Error('Preparation not started'); };
    mocks.ensureMainRepo.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    const preparing = create();
    await vi.waitFor(() => expect(mocks.ensureMainRepo).toHaveBeenCalledOnce());
    expect(mocks.pendingBatchTasks.has('task-a')).toBe(true);
    expect(mocks.pendingBatchTasks.has('task-b')).toBe(true);
    await expect(create(['task-b'])).rejects.toMatchObject({ code: 'TASK_ALREADY_RUNNING' });
    expect(mocks.pendingBatchTasks.has('task-b')).toBe(true);
    fail(new Error('fixture fetch failed'));
    await expect(preparing).rejects.toThrow('fixture fetch failed');
    expect(mocks.pendingBatchTasks.size).toBe(0);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.activeBatches.size).toBe(0);
    expect(mocks.broadcastBatchEvent).not.toHaveBeenCalled();
  });

  it('does not expose a batch when the final conditional binding detects changed members', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(create()).rejects.toMatchObject({ statusCode: 409, code: 'BATCH_SELECTION_CHANGED' });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.activeBatches.size).toBe(0);
    expect(mocks.pendingBatchTasks.size).toBe(0);
    expect(mocks.broadcastBatchEvent).not.toHaveBeenCalled();
  });

  it('does not bind members or expose a batch if its prepared receipt cannot be saved', async () => {
    mocks.writeBatchReceipt.mockRejectedValueOnce(new Error('fixture receipt unavailable'));
    await expect(create()).rejects.toThrow('fixture receipt unavailable');
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.activeBatches.size).toBe(0);
    expect(mocks.pendingBatchTasks.size).toBe(0);
    expect(mocks.broadcastBatchEvent).not.toHaveBeenCalled();
  });

  it('keeps a terminal batch blocking admission while its callbacks still own in-flight work', () => {
    // W03a: the real registry predicate decides; an unconfirmed member stop
    // is in-flight work.
    const old = batch({ id: 'old', status: 'cancelled' });
    mocks.activeBatches.set('old', old);
    old.tasks[0]!.cancelUnconfirmed = true;
    expect(() => reserveBatchTasks(['task-a'])).toThrowError(expect.objectContaining({ code: 'TASK_ALREADY_RUNNING' }));
    expect(mocks.pendingBatchTasks.size).toBe(0);
    old.tasks[0]!.cancelUnconfirmed = false;
    const release = reserveBatchTasks(['task-a']);
    expect(mocks.pendingBatchTasks.has('task-a')).toBe(true);
    release();
  });

  it('recognizes active batches without treating terminal history as an active lease', () => {
    mocks.activeBatches.set('old', batch({ id: 'old', status: 'failed' }));
    expect(taskHasActiveBatch('task-a')).toBe(false);
    mocks.activeBatches.set('current', batch({ id: 'current', status: 'merging' }));
    expect(taskHasActiveBatch('task-a')).toBe(true);
    expect(taskHasActiveBatch('task-a', 'current')).toBe(false);
  });
});
