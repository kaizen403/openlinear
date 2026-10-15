import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@openlinear/db';
import { createBatchState } from '@openlinear/execution-core';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { ExecutionState } from '../execution/state';

vi.mock('@openlinear/api/sse', () => ({
  broadcastToTask: vi.fn(), broadcastToUser: vi.fn(), broadcastToTaskById: vi.fn(async () => undefined),
}));
const effects = vi.hoisted(() => ({ prepare: vi.fn(), receipt: vi.fn(), push: vi.fn(), publish: vi.fn() }));
vi.mock('@openlinear/api/ownership', () => ({
  assertTaskOwned: async (id: string) => prisma.task.findUniqueOrThrow({ where: { id } }),
}));
vi.mock('../execution-settings', () => ({ getExecutionSettings: async () => ({ maxBatchSize: 2, queueAutoApprove: false, stopOnFailure: false, conflictBehavior: 'fail' }) }));
vi.mock('../worktree', () => ({
  ensureMainRepo: effects.prepare, createBatchBranch: vi.fn(), mergeBranch: vi.fn(async () => true), pushBranch: effects.push,
  cleanupBatch: vi.fn(), createWorktree: vi.fn(), createBatchWorktree: vi.fn(),
}));
vi.mock('./publication', () => ({
  writeBatchReceipt: effects.receipt, publishBatchPullRequest: effects.publish,
  safeBatchError: (_batch: unknown, error: unknown) => error instanceof Error ? error.message : String(error),
}));
const shared = await import('./shared');
const orchestration = await import('./orchestrator');
const completion = await import('./completion');
const single = await import('../execution/state');
const ids: string[] = [];
const users: string[] = [];
const projects: string[] = [];
async function task(batchId = randomUUID()) {
  const row = await prisma.task.create({ data: { title: 'W01 isolated SQL fixture', status: 'in_progress', batchId } });
  ids.push(row.id);
  return row;
}
function executionFixture(taskId: string, overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    taskId, projectId: 'repo', taskProjectId: null, sessionId: 'ses_old', repoPath: '/fixture', branchName: 'openlinear/fixture',
    userId: 'user', accessToken: null, teamId: null, creatorId: null,
    timeoutId: setTimeout(() => undefined, 60_000), streamTimeoutId: null, progressTimeoutId: null,
    watchdogSuspended: false, finalized: true, status: 'creating_pr', logs: [],
    client: createOpencodeClient({ baseUrl: 'http://127.0.0.1:1' }), startedAt: new Date(), filesChanged: 1, toolsExecuted: 1,
    promptSent: true, backgroundTaskRunning: false, backgroundTaskFailure: null, backgroundTaskIds: [],
    backgroundTaskResultBuffer: '', completedToolKeys: new Set(), cancelled: false, agentRunId: null,
    cost: { input: 0, output: 0, total: 0 }, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messageUsage: new Map(),
    ...overrides,
  };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  for (const id of ids) await single.cleanupExecution(id);
  await prisma.task.deleteMany({ where: { id: { in: ids.splice(0) } } });
  await prisma.project.deleteMany({ where: { id: { in: projects.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  shared.activeBatches.clear(); shared.finalizingBatches.clear();
  shared.batchTaskLogs.clear(); shared.batchTaskLogOwners.clear();
  vi.clearAllMocks();
});
afterAll(async () => { await prisma.$disconnect(); });

async function batchFixture(status: 'todo' | 'in_progress') {
  const user = await prisma.user.create({ data: { username: `w01-${randomUUID()}` } }); users.push(user.id);
  const repository = await prisma.repository.create({ data: {
    userId: user.id, githubRepoId: 1, name: 'fixture', fullName: 'acme/fixture', cloneUrl: 'https://github.com/acme/fixture.git',
  } });
  const project = await prisma.project.create({ data: { name: 'W01 fixture', repositoryId: repository.id } }); projects.push(project.id);
  const batchId = randomUUID();
  const tasks = await Promise.all([0, 1].map(async (index) => {
    const row = await prisma.task.create({ data: { title: `W01 member ${index}`, model: 'fixture/model', projectId: project.id, creatorId: user.id, status, batchId: status === 'in_progress' ? batchId : null } });
    ids.push(row.id); return row;
  }));
  return { user, repository, project, tasks, batchId };
}

describe('batch guarded writes against PostgreSQL', () => {
  it.each([
    ['done', 'cancelled'], ['done', 'new-session'], ['done', 'project-moved'],
    ['cancelled', 'cancelled'], ['cancelled', 'new-session'], ['cancelled', 'project-moved'],
  ] as const)('rejects single-task %s writes after %s replaced the active session', async (status, replacement) => {
    const row = await task();
    const execution = executionFixture(row.id);
    single.activeExecutions.set(row.id, execution);
    let movedProject: string | undefined;
    if (replacement === 'project-moved') {
      const project = await prisma.project.create({ data: { name: 'W01 moved task fixture' } });
      projects.push(project.id); movedProject = project.id;
    }
    await prisma.task.update({ where: { id: row.id }, data: replacement === 'cancelled'
      ? { status: 'cancelled', sessionId: null } : replacement === 'project-moved'
        ? { status: 'in_progress', sessionId: 'ses_old', projectId: movedProject } : { status: 'in_progress', sessionId: 'ses_new' } });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    await expect(single.updateTaskStatus(row.id, status, null, { prUrl: 'https://github.com/acme/repo/pull/1', outcome: 'stale terminal write' }))
      .rejects.toMatchObject({ code: 'P2025' });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
  });

  it.each([
    ['done', 'team-moved'], ['done', 'creator-changed'],
    ['cancelled', 'team-moved'], ['cancelled', 'creator-changed'],
  ] as const)('rejects single-task %s writes after the captured %s binding changed', async (status, replacement) => {
    const fixture = await batchFixture('in_progress');
    const row = fixture.tasks[0];
    const team = await prisma.team.create({ data: { projectId: fixture.project.id, name: 'W01 binding team', key: 'WBT' } });
    const execution = executionFixture(row.id, {
      taskProjectId: fixture.project.id, teamId: team.id, creatorId: fixture.user.id,
      logs: [{ timestamp: new Date().toISOString(), type: 'agent', message: 'bound session logs' }],
    });
    single.activeExecutions.set(row.id, execution);
    await prisma.task.update({ where: { id: row.id }, data: { sessionId: execution.sessionId, teamId: team.id } });
    await single.persistLogs(row.id, execution);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).executionLogs).toEqual(execution.logs);

    await prisma.task.update({ where: { id: row.id }, data: {
      ...(replacement === 'team-moved' ? { teamId: null } : { creatorId: null }),
      executionLogs: [{ message: 'replacement resource logs' }],
    } });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    await expect(single.updateTaskStatus(row.id, status, null, { outcome: 'stale resource write' }, execution))
      .rejects.toMatchObject({ code: 'P2025' });
    await single.persistLogs(row.id, execution);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
  });

  it.each(['done', 'cancelled'] as const)('persists captured logs before and after a confirmed %s transition', async (status) => {
    const row = await task();
    await prisma.task.update({ where: { id: row.id }, data: { sessionId: 'ses_old' } });
    const execution = executionFixture(row.id, {
      logs: [{ timestamp: new Date().toISOString(), type: 'agent', message: 'owned session log' }],
    });
    single.activeExecutions.set(row.id, execution);
    await single.persistLogs(row.id, execution);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).executionLogs).toEqual(execution.logs);

    await single.updateTaskStatus(row.id, status, null, { outcome: 'confirmed terminal outcome' }, execution);
    expect(execution.taskStatusPersisted).toBe(status);
    execution.logs.push({ timestamp: new Date().toISOString(), type: 'info', message: 'owned terminal log' });
    await single.persistLogs(row.id, execution);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status, sessionId: null, executionLogs: execution.logs,
    });
  });

  it.each(['new-session', 'project-moved', 'unconfirmed-terminal'] as const)('does not persist captured logs after %s changed the database binding', async (replacement) => {
    const row = await task();
    const execution = executionFixture(row.id, {
      logs: [{ timestamp: new Date().toISOString(), type: 'agent', message: 'stale session log' }],
    });
    single.activeExecutions.set(row.id, execution);
    let movedProject: string | undefined;
    if (replacement === 'project-moved') {
      const project = await prisma.project.create({ data: { name: 'W01 log movement fixture' } });
      projects.push(project.id); movedProject = project.id;
    }
    await prisma.task.update({ where: { id: row.id }, data: {
      ...(replacement === 'new-session' ? { sessionId: 'ses_new' }
        : replacement === 'project-moved' ? { sessionId: 'ses_old', projectId: movedProject }
          : { status: 'cancelled', sessionId: null }),
      executionLogs: [{ message: 'replacement-owned logs' }],
    } });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    await single.persistLogs(row.id, execution);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
  });

  it.each(['new-session', 'project-moved'] as const)('does not persist confirmed terminal logs after %s replaced the resource binding', async (replacement) => {
    const row = await task();
    await prisma.task.update({ where: { id: row.id }, data: { sessionId: 'ses_old' } });
    const execution = executionFixture(row.id, {
      logs: [{ timestamp: new Date().toISOString(), type: 'agent', message: 'old terminal log' }],
    });
    single.activeExecutions.set(row.id, execution);
    await single.updateTaskStatus(row.id, 'cancelled', null, { outcome: 'old cancellation' }, execution);
    let movedProject: string | undefined;
    if (replacement === 'project-moved') {
      const project = await prisma.project.create({ data: { name: 'W01 terminal log movement fixture' } });
      projects.push(project.id); movedProject = project.id;
    }
    await prisma.task.update({ where: { id: row.id }, data: {
      ...(replacement === 'new-session' ? { status: 'in_progress', sessionId: 'ses_new' } : { projectId: movedProject }),
      outcome: 'replacement outcome', executionLogs: [{ message: 'replacement terminal logs' }],
    } });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    await single.persistLogs(row.id, execution);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
  });

  it('rejects captured callbacks before a repeated terminal marker can bypass replacement ownership', async () => {
    const row = await task();
    const stale = executionFixture(row.id, {
      taskStatusPersisted: 'cancelled',
      logs: [{ timestamp: new Date().toISOString(), type: 'agent', message: 'stale captured log' }],
    });
    const replacementCleanup = vi.fn();
    const replacement = executionFixture(row.id, { sessionId: 'ses_new', eventStreamCleanup: replacementCleanup });
    single.activeExecutions.set(row.id, replacement);
    await prisma.task.update({ where: { id: row.id }, data: {
      sessionId: replacement.sessionId, outcome: 'replacement outcome', executionLogs: [{ message: 'replacement logs' }],
    } });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    try {
      await expect(single.updateTaskStatus(row.id, 'cancelled', null, { outcome: 'stale cancellation' }, stale))
        .rejects.toThrow('Execution no longer owns task status');
      await single.persistLogs(row.id, stale);
      await single.cleanupExecution(row.id, stale);
      expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
      expect(single.activeExecutions.get(row.id)).toBe(replacement);
      expect(replacementCleanup).not.toHaveBeenCalled();
    } finally { clearTimeout(stale.timeoutId); }
  });

  it('does not remove a replacement installed while captured cleanup awaits its old stream', async () => {
    const row = await task();
    const reached = gate(); const release = gate();
    const stale = executionFixture(row.id, {
      eventStreamCleanup: async () => { reached.resolve(); await release.promise; },
    });
    single.activeExecutions.set(row.id, stale);
    const cleanup = single.cleanupExecution(row.id, stale);
    await reached.promise;
    const replacementCleanup = vi.fn();
    const replacement = executionFixture(row.id, { sessionId: 'ses_new', eventStreamCleanup: replacementCleanup });
    try {
      single.activeExecutions.set(row.id, replacement);
      await prisma.task.update({ where: { id: row.id }, data: { sessionId: replacement.sessionId, outcome: 'replacement survives' } });
    } finally { release.resolve(); }
    await cleanup;
    expect(single.activeExecutions.get(row.id)).toBe(replacement);
    expect(replacementCleanup).not.toHaveBeenCalled();
    expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'in_progress', sessionId: replacement.sessionId, outcome: 'replacement survives',
    });
  });

  it('does not rewrite a confirmed cancellation on retry', async () => {
    const row = await task();
    await prisma.task.update({ where: { id: row.id }, data: { sessionId: 'ses_old' } });
    const execution = executionFixture(row.id);
    single.activeExecutions.set(row.id, execution);
    await single.updateTaskStatus(row.id, 'cancelled', null, { outcome: 'first confirmed cancellation', executionElapsedMs: 7 }, execution);
    expect(execution.taskStatusPersisted).toBe('cancelled');
    const before = await prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    await single.updateTaskStatus(row.id, 'cancelled', null, { outcome: 'retry must not rewrite', executionElapsedMs: 99 }, execution);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
  });

  it('rolls back all admission bindings if one snapshot status changed during preparation', async () => {
    const fixture = await batchFixture('todo');
    const reached = gate(); const release = gate();
    effects.prepare.mockImplementationOnce(async () => { reached.resolve(); await release.promise; return '/fixture/.main'; });
    effects.receipt.mockResolvedValue(undefined);
    const admission = orchestration.createBatch({ taskIds: fixture.tasks.map((row) => row.id), mode: 'queue', userId: fixture.user.id, projectId: '', accessToken: 'fixture-token' });
    const denial = expect(admission).rejects.toMatchObject({ code: 'BATCH_SELECTION_CHANGED' });
    await reached.promise;
    try { await prisma.task.update({ where: { id: fixture.tasks[1].id }, data: { status: 'cancelled' } }); }
    finally { release.resolve(); }
    await denial;
    const rows = await prisma.task.findMany({ where: { id: { in: fixture.tasks.map((row) => row.id) } }, orderBy: { title: 'asc' } });
    expect(rows.map((row) => [row.status, row.batchId])).toEqual([['todo', null], ['cancelled', null]]);
    expect(shared.activeBatches.size).toBe(0);
  });

  it('does not expose one member as done while terminal publication waits on a cancelled member', async () => {
    const fixture = await batchFixture('in_progress');
    const batch = createBatchState({
      id: fixture.batchId, projectId: fixture.repository.id, taskIds: fixture.tasks.map((row) => row.id), mode: 'parallel',
      mainRepoPath: '/fixture/.main', userId: fixture.user.id, accessToken: 'fixture-token',
      settings: { maxConcurrent: 2, autoApprove: false, stopOnFailure: false, conflictBehavior: 'fail' },
    });
    batch.status = 'running'; batch.repository = fixture.repository;
    batch.taskProjectIds = Object.fromEntries(fixture.tasks.map((row) => [row.id, fixture.project.id]));
    for (const member of batch.tasks) { member.status = 'completed'; member.worktreePath = '/fixture/retained'; }
    shared.activeBatches.set(batch.id, batch);
    effects.receipt.mockResolvedValue(undefined); effects.push.mockResolvedValue(undefined);
    effects.publish.mockResolvedValue('https://github.com/acme/fixture/pull/1');
    const locked = gate(); const release = gate();
    const cancellation = prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: fixture.tasks[1].id }, data: { status: 'cancelled' } });
      locked.resolve(); await release.promise;
    }, { timeout: 10_000 });
    await locked.promise;
    const finalization = completion.finalizeBatch(batch.id);
    try {
      await vi.waitFor(async () => {
        const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        expect(Number(waiting[0].count)).toBeGreaterThan(0);
      });
      expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.tasks[0].id } })).status).toBe('in_progress');
    } finally { release.resolve(); }
    await cancellation; await finalization;
    const rows = await prisma.task.findMany({ where: { id: { in: fixture.tasks.map((row) => row.id) } } });
    expect(rows.some((row) => row.status === 'done')).toBe(false);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.tasks[1].id } })).status).toBe('cancelled');
    expect(batch.status).toBe('failed');
  });
  it('cannot resurrect a cancellation after waiting for its row lock', async () => {
    const row = await task();
    const locked = gate();
    const release = gate();
    const cancellation = prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: row.id }, data: { status: 'cancelled' } });
      locked.resolve();
      await release.promise;
    }, { timeout: 10_000 });
    await locked.promise;
    const update = shared.updateTaskInDb(row.id, 'in_progress', { executionProgress: 95 }, row.batchId!);
    const denied = expect(update).rejects.toMatchObject({ code: 'P2025' });
    try {
      await vi.waitFor(async () => {
        const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
        `;
        expect(Number(waiting[0].count)).toBeGreaterThan(0);
      });
    } finally { release.resolve(); }
    await cancellation;
    await denied;
    expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'cancelled', executionProgress: null });
  });

  it('rejects a callback bound to an older attempt', async () => {
    const row = await task();
    await prisma.task.update({ where: { id: row.id }, data: { batchId: 'new-attempt', outcome: 'new attempt' } });
    await expect(shared.updateTaskInDb(row.id, 'done', { prUrl: 'https://github.com/acme/repo/pull/1' }, row.batchId!))
      .rejects.toMatchObject({ code: 'P2025' });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: row.id } }))
      .toMatchObject({ batchId: 'new-attempt', status: 'in_progress', outcome: 'new attempt', prUrl: null });
  });

  it('retains old in-memory logs when their conditional persistence is rejected', async () => {
    const row = await task();
    const oldLogs = [{ timestamp: new Date().toISOString(), type: 'info' as const, message: 'old attempt' }];
    shared.batchTaskLogs.set(row.id, oldLogs); shared.batchTaskLogOwners.set(row.id, row.batchId!);
    await prisma.task.update({ where: { id: row.id }, data: { batchId: 'new-attempt', executionLogs: [{ message: 'new attempt' }] } });
    await shared.persistBatchTaskLogs(row.id, row.batchId!);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).executionLogs).toEqual([{ message: 'new attempt' }]);
    expect(shared.batchTaskLogs.get(row.id)).toBe(oldLogs);
  });

  it('persists only logs owned by the current attempt', async () => {
    const row = await task();
    const logs = [{ timestamp: new Date().toISOString(), type: 'agent' as const, message: 'current attempt' }];
    shared.batchTaskLogs.set(row.id, logs); shared.batchTaskLogOwners.set(row.id, row.batchId!);
    await shared.persistBatchTaskLogs(row.id, 'stale-attempt');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).executionLogs).toBeNull();
    await shared.persistBatchTaskLogs(row.id, row.batchId!);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: row.id } })).executionLogs).toEqual(logs);
    expect(shared.batchTaskLogs.has(row.id)).toBe(false);
  });
});
