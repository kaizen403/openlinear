import { prisma } from '@openlinear/db';
import { logger } from '../../lib/logger';
import { authorizeTaskAccess } from '../../auth/task-access';
import { publishTaskEvent } from '../../events/publisher';
import { batchCredentials } from './registry';
import {
  batchActivityId, completionKey, formatExecutionMode, hasQueuedOrRunningBatchTasks,
} from '@openlinear/execution-core';
import type { BatchState, BatchTask } from '@openlinear/execution-core';
import { cleanupDeltaBuffer } from '../delta-buffer';
import { getGitIdentityEnv } from '../git-identity';
import { execGit } from '../git-credentials';
import { hasCommittableChanges, stageCommittableChanges } from '../execution/git';
import { cleanupBatch, mergeBranch, createBatchBranch, pushBranch } from '../worktree';
import { safeBatchError, writeBatchReceipt, publishBatchPullRequest } from './publication';
import {
  activeBatches, sessionToBatch, completingBatchTasks, completingCombinedBatches, finalizingBatches,
  broadcastBatchEvent, broadcastBatchProgress, emitBatchLog, scheduleBatchCleanup,
  updateTaskInDb, persistBatchTaskLogs, closeBatchSubscription,
  batchRunningCount,
  preparingBatchTasks,
  batchHasPendingCancellation,
  batchTaskLogs,
  batchTaskLogOwners,
  MAX_BATCH_LOG_ENTRIES,
} from './shared';

class BatchCancelled extends Error {}
function isCancelled(batch: BatchState, task?: BatchTask): boolean {
  return batch.status === 'cancelled' || task?.status === 'cancelled';
}
function assertActive(batch: BatchState, task?: BatchTask): void {
  if (activeBatches.get(batch.id) !== batch || isCancelled(batch, task)) {
    throw new BatchCancelled('Batch execution was cancelled');
  }
}
function retainedOutcome(task: BatchTask, reason: string): string {
  return `${reason}. Work retained on branch ${task.branch}${task.worktreePath ? ' at ' + task.worktreePath : ''}`;
}

async function failTask(batch: BatchState, task: BatchTask, reason: string, status: 'failed' | 'skipped' = 'failed'): Promise<void> {
  if (batch.status === 'cancelled' || task.status === 'cancelled') return;
  if (task.status === 'running' && task.sessionId) {
    task.cancelUnconfirmed = true;
    const { stopBatchSessions } = await import('./orchestrator');
    await stopBatchSessions(batch, [task.taskId]);
    if (isCancelled(batch, task)) return;
  }
  task.status = status;
  task.error = reason;
  task.completedAt = new Date();
  // Never overwrite a concurrently persisted cancellation or a new attempt.
  const result = await prisma.task.updateMany({
    where: { id: task.taskId, batchId: batch.id, status: { not: 'cancelled' } },
    data: { status: 'todo', executionProgress: null,
      executionElapsedMs: task.startedAt ? Date.now() - task.startedAt.getTime() : 0,
      outcome: retainedOutcome(task, `Failed: ${reason}`),
    },
  });
  if (result.count !== 1) throw new Error('Task outcome could not be persisted for this batch');
  assertActive(batch, task);
  broadcastBatchEvent(status === 'skipped' ? 'batch:task:skipped' : 'batch:task:failed', batch.id, { taskId: task.taskId, error: reason });
  emitBatchLog(task.taskId, 'error', reason);
  broadcastBatchProgress([task.taskId], 'error', reason, { branch: task.branch, retained: true });
}

async function commitWorktree(batch: BatchState, worktreePath: string | null, title: string, task?: BatchTask): Promise<void> {
  assertActive(batch, task);
  if (!worktreePath) throw new Error('Execution completed without a worktree');
  const changed = await hasCommittableChanges(worktreePath);
  assertActive(batch, task);
  if (!changed) throw new Error('Agent finished without making code changes');
  const staged = await stageCommittableChanges(worktreePath);
  assertActive(batch, task);
  if (!staged) throw new Error('Agent finished without committable code changes');
  await execGit(['-C', worktreePath, 'commit', '-m', `feat: ${title.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 50)}`], {
    env: getGitIdentityEnv(),
  });
  assertActive(batch, task);
}

async function failBatch(batch: BatchState, error: unknown): Promise<void> {
  if (batch.status === 'completed' || batch.status === 'cancelled' || error instanceof BatchCancelled) return;
  const reason = safeBatchError(batch, error);
  const runningTaskIds = batch.tasks.filter((task) => task.status === 'running').map((task) => task.taskId);
  for (const task of batch.tasks) {
    if (runningTaskIds.includes(task.taskId) && task.sessionId) task.cancelUnconfirmed = true;
  }
  batch.status = 'failed';
  batch.completedAt = new Date();
  if (runningTaskIds.length) {
    const { stopBatchSessions } = await import('./orchestrator');
    await stopBatchSessions(batch, runningTaskIds);
  }
  for (const task of batch.tasks) {
    if (task.status === 'completed' || task.status === 'running' || task.status === 'queued') {
      try { await failTask(batch, task, reason); }
      catch (persistError) { logger.error({ err: persistError, taskId: task.taskId }, '[Batch] Failure outcome persistence failed; retaining receipt'); }
    }
  }
  try { await writeBatchReceipt(batch, 'failed', reason); }
  catch (receiptError) { logger.error({ err: receiptError, batchId: batch.id }, '[Batch] Could not persist failure receipt'); }
  broadcastBatchProgress(batch.mode === 'combined' ? [batchActivityId(batch.id)] : batch.tasks.map((task) => task.taskId),
    'error', reason, { branch: batch.batchBranch, retained: true, prUrl: batch.prUrl });
  broadcastBatchEvent('batch:failed', batch.id, { error: reason, retained: true, publication: batch.publication });
}

export async function handleTaskComplete(batchId: string, taskId: string, success: boolean, error?: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  const task = batch?.tasks.find((member) => member.taskId === taskId);
  if (!batch || !task || batch.status !== 'running' || task.status !== 'running') return;
  const key = completionKey(batchId, taskId);
  if (completingBatchTasks.has(key)) return;
  completingBatchTasks.add(key);
  try {
    if (!success) throw new Error(error || 'Agent execution failed');
    broadcastBatchProgress([taskId], 'committing', 'Committing batch changes...');
    await commitWorktree(batch, task.worktreePath, task.title, task);
    assertActive(batch, task);
    task.completedAt = new Date();
    await updateTaskInDb(taskId, 'in_progress', {
      executionElapsedMs: task.startedAt ? task.completedAt.getTime() - task.startedAt.getTime() : 0,
      executionProgress: 95, outcome: retainedOutcome(task, 'Local commit ready; publication pending'),
    }, batchId);
    assertActive(batch, task);
    await writeBatchReceipt(batch, 'committed');
    assertActive(batch, task);
    task.status = 'completed'; // Publish-ready only after local persistence.
    emitBatchLog(taskId, 'info', 'Local commit ready; waiting for batch publication');
    broadcastBatchEvent('batch:progress', batchId, { taskId, phase: 'committed' });
  } catch (failure) {
    if (!(failure instanceof BatchCancelled) && !isCancelled(batch, task)) {
      try { await failTask(batch, task, safeBatchError(batch, failure)); }
      catch (persistError) { await failBatch(batch, persistError); }
      if (batch.settings.stopOnFailure && batch.status === 'running') {
        const { cancelBatch } = await import('./orchestrator');
        await cancelBatch(batchId);
      }
    }
  } finally {
    closeBatchSubscription(taskId);
    if (task.sessionId) sessionToBatch.delete(task.sessionId);
    await persistBatchTaskLogs(taskId, batchId);
    completingBatchTasks.delete(key);
  }
  await advanceQueue(batch);
}

export async function handleCombinedBatchComplete(batchId: string, success: boolean, error?: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch || batch.mode !== 'combined' || batch.status !== 'running' || completingCombinedBatches.has(batchId)) return;
  completingCombinedBatches.add(batchId);
  const activityId = batchActivityId(batch.id);
  try {
    if (!success) throw new Error(error || 'Combined agent execution failed');
    broadcastBatchProgress([activityId], 'committing', 'Committing combined changes...');
    await commitWorktree(batch, batch.tasks.find((task) => task.worktreePath)?.worktreePath ?? null, `combined batch ${batch.id}`);
    assertActive(batch);
    for (const task of batch.tasks) {
      task.completedAt = new Date();
      await updateTaskInDb(task.taskId, 'in_progress', {
        executionElapsedMs: task.startedAt ? task.completedAt.getTime() - task.startedAt.getTime() : 0,
        executionProgress: 95, outcome: retainedOutcome(task, 'Local commit ready; publication pending'),
      }, batchId);
      assertActive(batch);
    }
    await writeBatchReceipt(batch, 'committed');
    assertActive(batch);
    for (const task of batch.tasks) task.status = 'completed';
    await finalizeBatch(batchId);
  } catch (failure) { await failBatch(batch, failure); }
  finally {
    closeBatchSubscription(activityId);
    for (const task of batch.tasks) {
      if (task.sessionId) sessionToBatch.delete(task.sessionId);
      cleanupDeltaBuffer(task.taskId);
    }
    // Combined logs belong to the same attempt, but persist on each real task.
    const activityLogs = batchTaskLogs.get(activityId);
    for (const task of batch.tasks) {
      if (activityLogs?.length && batchTaskLogOwners.get(task.taskId) === batchId) {
        batchTaskLogs.set(task.taskId, [...(batchTaskLogs.get(task.taskId) ?? []), ...activityLogs].slice(-MAX_BATCH_LOG_ENTRIES));
      }
      await persistBatchTaskLogs(task.taskId, batchId);
    }
    completingCombinedBatches.delete(batchId);
    cleanupDeltaBuffer(activityId);
    scheduleBatchCleanup(batchId);
  }
}

export async function advanceQueue(batch: BatchState): Promise<void> {
  if (batch.status !== 'running') return;
  if (!hasQueuedOrRunningBatchTasks(batch)) {
    await finalizeBatch(batch.id);
    return;
  }
  if (batch.mode === 'combined') return;
  if (batch.mode === 'queue' && (!batch.settings.autoApprove || batch.tasks.some((task) => task.status === 'running'))) return;
  const { launchTask } = await import('./orchestrator');
  for (let index = 0; index < batch.tasks.length; index += 1) {
    if (batch.tasks[index].status !== 'queued') continue;
    const limit = batch.mode === 'queue' ? 1 : batch.settings.maxConcurrent;
    if (batchRunningCount(batch) >= limit) break;
    launchTask(batch, index); // launchTask synchronously reserves queued -> running.
  }
}

export async function finalizeBatch(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch || batch.status !== 'running' || finalizingBatches.has(batchId) || hasQueuedOrRunningBatchTasks(batch)
    || batchHasPendingCancellation(batch)
    || batch.tasks.some((task) => completingBatchTasks.has(completionKey(batchId, task.taskId))
      || preparingBatchTasks.has(completionKey(batchId, task.taskId)))) return;
  finalizingBatches.add(batchId);
  try {
    assertActive(batch);
    let completed = batch.tasks.filter((task) => task.status === 'completed');
    if (!completed.length) throw new Error('No successfully committed tasks to publish');
    if (batch.tasks.some((task) => task.cancelUnconfirmed)) throw new Error('Provider stop is unconfirmed; publication is blocked and work is retained');
    const repository = await prisma.repository.findUnique({ where: { id: batch.projectId } });
    assertActive(batch);
    if (!repository) throw new Error('The batch repository no longer exists');
    if (batch.repository && (repository.cloneUrl !== batch.repository.cloneUrl || repository.defaultBranch !== batch.repository.defaultBranch
      || repository.fullName !== batch.repository.fullName)) throw new Error('Repository settings changed before publication');
    if (!batch.userId) throw new Error('The batch has no authenticated owner');
    await Promise.all(completed.map(async (task) => {
      const authority = await authorizeTaskAccess(batchCredentials.get(batch.id), task.taskId, 'write');
      const expectedProject = batch.taskProjectIds?.[task.taskId];
      if (expectedProject !== undefined && authority.projectId !== expectedProject) throw new Error('Task access scope changed before publication');
    }));
    assertActive(batch);
    batch.status = 'merging';
    await writeBatchReceipt(batch, 'merging');
    assertActive(batch);
    broadcastBatchEvent('batch:merging', batchId);

    if (batch.mode !== 'combined') {
      await createBatchBranch(batch.projectId, batch.batchBranch, repository.defaultBranch);
      assertActive(batch);
      for (const task of completed) {
        const merged = await mergeBranch(batch.projectId, task.branch, batch.batchBranch);
        assertActive(batch, task);
        if (!merged) {
          await failTask(batch, task, 'Merge conflict', batch.settings.conflictBehavior === 'skip' ? 'skipped' : 'failed');
          assertActive(batch);
          if (batch.settings.conflictBehavior === 'fail') throw new Error('Batch merge failed; local commits retained');
        }
      }
    }
    completed = batch.tasks.filter((task) => task.status === 'completed');
    if (!completed.length) throw new Error('No successfully merged tasks to publish');
    if (!batch.accessToken) throw new Error('GitHub authentication is required for batch publication');
    broadcastBatchProgress(batch.mode === 'combined' ? [batchActivityId(batch.id)] : completed.map((task) => task.taskId),
      'creating_pr', `Creating ${formatExecutionMode(batch.mode)} pull request...`);
    assertActive(batch);
    await pushBranch(batch.projectId, batch.batchBranch, repository.cloneUrl, batch.accessToken);
    batch.publication = { ...batch.publication, phase: 'pushed',
      branchUrl: `https://github.com/${repository.fullName}/compare/${encodeURIComponent(repository.defaultBranch)}...${encodeURIComponent(batch.batchBranch)}` };
    await writeBatchReceipt(batch, 'pushed');
    assertActive(batch);
    batch.prUrl = await publishBatchPullRequest(batch, repository, () => assertActive(batch));
    // Record an accepted external result even if cancellation happened in flight.
    await writeBatchReceipt(batch, 'pr_created');
    assertActive(batch);

    const updated = await prisma.$transaction(async (tx) => {
      assertActive(batch);
      for (const task of completed) {
        const result = await tx.task.updateMany({
          where: { id: task.taskId, batchId: batch.id, status: 'in_progress',
            ...(batch.taskProjectIds?.[task.taskId] ? { projectId: batch.taskProjectIds[task.taskId] } : {}),
          },
          data: { status: 'done', prUrl: batch.prUrl, executionProgress: 100,
            outcome: `Completed via ${formatExecutionMode(batch.mode)}; pull request ${batch.prUrl}` },
        });
        assertActive(batch, task);
        if (result.count !== 1) throw new Error('Task ownership or execution status changed before completion');
      }
      const records = await tx.task.findMany({
        where: { id: { in: completed.map((task) => task.taskId) }, batchId: batch.id },
        include: { labels: { include: { label: true } } },
      });
      assertActive(batch);
      return records;
    });
    assertActive(batch);
    batch.status = 'completed';
    batch.completedAt = new Date();
    let receiptRecorded = true;
    try { await writeBatchReceipt(batch, 'completed'); }
    catch (receiptError) {
      receiptRecorded = false;
      logger.warn({ err: receiptError, batchId }, '[Batch] Publication and DB completion confirmed; retaining workspace because receipt update failed');
    }
    for (const task of updated) {
      try { publishTaskEvent(task.id, 'task:updated', { ...task, labels: task.labels.map((relation) => relation.label) }); }
      catch (broadcastError) { logger.warn({ err: broadcastError }, '[Batch] Completed task broadcast failed'); }
    }
    for (const task of completed) {
      broadcastBatchEvent('batch:task:completed', batchId, { taskId: task.taskId, prUrl: batch.prUrl });
      emitBatchLog(task.taskId, 'success', 'Batch pull request ready');
    }
    broadcastBatchProgress(batch.mode === 'combined' ? [batchActivityId(batch.id)] : completed.map((task) => task.taskId),
      'done', 'Batch pull request ready', { prUrl: batch.prUrl });
    broadcastBatchEvent('batch:completed', batchId, { prUrl: batch.prUrl, publication: batch.publication });
    // A skipped/failed/cancelled member retains its artifact for inspection.
    if (receiptRecorded && batch.tasks.every((task) => task.status === 'completed' && !task.cancelUnconfirmed)) {
      try { await cleanupBatch(batch.projectId, batchId); }
      catch (cleanupError) { logger.warn({ err: cleanupError, batchId }, '[Batch] Published batch cleanup failed'); }
    }
  } catch (failure) { await failBatch(batch, failure); }
  finally {
    for (const task of batch.tasks) {
      cleanupDeltaBuffer(task.taskId);
      await persistBatchTaskLogs(task.taskId, batchId);
    }
    cleanupDeltaBuffer(batchActivityId(batch.id));
    finalizingBatches.delete(batchId);
    scheduleBatchCleanup(batchId);
  }
}
