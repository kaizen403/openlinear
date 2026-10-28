import crypto from 'crypto';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { prisma } from '@openlinear/db';
import { logger } from '../../lib/logger';
import { HttpError } from '../../lib/errors';
import type { PrincipalCredential } from '../../auth/principal';
import { validateBatchRequest, reserveBatchTasks, validateBatchSelection } from './admission';
import { batchCredentials } from './registry';
import { ensureModelConfigured } from '../opencode-model';
import {
  batchActivityId,
  buildCombinedBatchPrompt,
  buildSingleTaskPrompt,
  createBatchState,
  formatExecutionMode,
  getInitialBatchLaunchIndexes,
  parseModelOverride,
} from '@openlinear/execution-core';
import type {
  BatchSettings,
  BatchState,
  CreateBatchParams,
  ModelOverride,
} from '@openlinear/execution-core';
import { getClientForUser } from '../opencode';
import { ensureMainRepo, createWorktree, createBatchWorktree } from '../worktree';
import { cleanupDeltaBuffer } from '../delta-buffer';
import { getExecutionSettings } from '../execution-settings';
import {
  activeBatches,
  sessionToBatch,
  preparingBatchTasks,
  batchSubscriptions,
  closeBatchSubscription,
  batchRunningCount,
  cancellingBatches,
  cancellationPromises,
  memberCancellationPromises,
  batchTaskLogOwners,
  batchTaskLogs,
  broadcastBatchEvent,
  broadcastBatchProgress,
  emitBatchLog,
  getBatchExecutionLogs,
  scheduleBatchCleanup,
  updateTaskInDb,
} from './shared';
import { subscribeToSessionEvents, subscribeToTaskEvents } from '../session-manager';
import { handleTaskComplete, handleCombinedBatchComplete, advanceQueue } from './completion';
import { completionKey } from '@openlinear/execution-core';
import { writeBatchReceipt, safeBatchError } from './publication';

export { getBatchExecutionLogs } from './shared';
export { activeBatches } from './shared';

export function getInMemoryBatchCount(): number {
  return activeBatches.size;
}

/**
 * T9 (H-05/M-01) — batch execution previously ignored `Task.model` entirely;
 * every batch task ran on whatever OpenCode's global default happened to be.
 * Shares the same `provider/model` parsing (`parseModelOverride`) the
 * single-task path uses (lifecycle.ts), falling back to the session's
 * `config.get()` default only when the task has no per-task override.
 */
async function resolveBatchTaskModel(
  modelStr: string | null | undefined,
  client: OpencodeClient,
): Promise<{ override: ModelOverride; label: string } | undefined> {
  let resolved = modelStr;
  if (!resolved) {
    try {
      const config = await client.config.get();
      resolved = config.data?.model;
    } catch (err) {
      logger.debug({ err }, '[Batch] Could not read model config');
    }
  }
  const override = parseModelOverride(resolved);
  if (!override) return undefined;
  return { override, label: resolved as string };
}

export async function createBatch(params: CreateBatchParams, credential: PrincipalCredential | null = null): Promise<BatchState> {
  const taskIds = validateBatchRequest(params.taskIds, params.mode);
  const releaseReservation = reserveBatchTasks(taskIds);
  try {
    const selected = await validateBatchSelection({ taskIds, userId: params.userId, credential });
    if (params.mode === 'combined' && new Set(selected.tasks.map((task) => task.model)).size > 1) {
      throw new HttpError(400, 'BATCH_MODEL_MISMATCH', 'A combined session requires the same model selection for every member');
    }
    if (selected.tasks.some((task) => !task.model)) {
      const preflight = await ensureModelConfigured(params.userId!);
      if (!preflight.model) throw new HttpError(400, 'MODEL_NOT_CONFIGURED', 'Select a model before executing this batch');
    }
    const settings = await getExecutionSettings(params.userId);
    if (!Number.isSafeInteger(settings.maxBatchSize) || settings.maxBatchSize < 1 || settings.maxBatchSize > 20) {
      throw new HttpError(500, 'INVALID_EXECUTION_LIMIT', 'Configured batch concurrency must be between 1 and 20');
    }
    const batchSettings: BatchSettings = {
      maxConcurrent: settings.maxBatchSize,
      autoApprove: settings.queueAutoApprove,
      stopOnFailure: settings.stopOnFailure,
      conflictBehavior: settings.conflictBehavior,
    };
    const repository = selected.repository;
    const batchId = crypto.randomUUID();
    const mainRepoPath = await ensureMainRepo(repository.id, repository.cloneUrl, params.accessToken);
    const batch = createBatchState({
      id: batchId, projectId: repository.id, mode: params.mode, taskIds,
      titleByTaskId: new Map(selected.tasks.map((task) => [task.id, task.title])),
      settings: batchSettings, mainRepoPath, accessToken: params.accessToken, userId: params.userId,
    });
    batch.repository = { ...repository };
    batch.taskProjectIds = Object.fromEntries(selected.tasks.map((task) => [task.id, task.projectId!]));
    if (credential) batchCredentials.set(batchId, credential);

    await writeBatchReceipt(batch, 'prepared');

    // Bind all members together, and reject edits/deletion since the snapshot.
    try {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.task.updateMany({
          where: { OR: selected.tasks.map((task) => ({
            id: task.id, projectId: task.projectId, teamId: task.teamId, creatorId: task.creatorId, batchId: task.batchId,
            archived: false, status: task.status, agent: task.agent, model: task.model,
            project: { is: { localPath: null, defaultAgent: task.project!.defaultAgent,
              repository: { is: { id: repository.id, fullName: repository.fullName, cloneUrl: repository.cloneUrl, defaultBranch: repository.defaultBranch } },
            } },
          })) },
          data: { batchId, status: 'todo', outcome: 'Batch queued', executionProgress: 0, prUrl: null },
        });
        if (updated.count !== taskIds.length) throw new HttpError(409, 'BATCH_SELECTION_CHANGED', 'Selected tasks changed before admission completed');
      });
    } catch (error) {
      batch.status = 'failed'; batch.completedAt = new Date();
      try { await writeBatchReceipt(batch, 'failed', safeBatchError(batch, error)); }
      catch (receiptError) { logger.warn({ err: receiptError, batchId }, '[Batch] Could not record rejected admission receipt'); }
      throw error;
    }
    for (const activityId of [...taskIds, batchActivityId(batchId)]) {
      batchTaskLogOwners.set(activityId, batchId);
      batchTaskLogs.delete(activityId);
    }
    activeBatches.set(batchId, batch);
    broadcastBatchEvent('batch:created', batchId, {
      mode: params.mode, status: batch.status,
      tasks: batch.tasks.map((task) => ({ taskId: task.taskId, title: task.title, status: task.status })),
    });
    return batch;
  } finally {
    releaseReservation();
  }
}

function launchIsActive(batch: BatchState, task?: BatchState['tasks'][number]): boolean {
  return activeBatches.get(batch.id) === batch && batch.status === 'running' && (!task || task.status === 'running');
}

async function abortSession(client: OpencodeClient, sessionId: string, batch: BatchState, tasks: BatchState['tasks']): Promise<boolean> {
  let confirmed = false;
  try {
    const response = await client.session.abort({ path: { id: sessionId }, signal: AbortSignal.timeout(5_000) });
    if (response.error || response.data !== true) throw new Error('Provider did not confirm abort');
    confirmed = true;
  } catch (error) {
    logger.warn({ err: error, sessionId }, '[Batch] Abort could not be confirmed; workspace retained');
  }
  for (const task of tasks) task.cancelUnconfirmed = !confirmed;
  if (!confirmed) {
    batch.publication = { ...batch.publication, phase: 'cancelled', error: 'Provider abort could not be confirmed' };
    await writeBatchReceipt(batch, 'cancelled', batch.publication.error);
  }
  return confirmed;
}

export async function stopBatchSessions(batch: BatchState, taskIds: string[]): Promise<void> {
  const tasks = batch.tasks.filter((task) => taskIds.includes(task.taskId));
  for (const task of tasks) {
    closeBatchSubscription(batch.mode === 'combined' ? batchActivityId(batch.id) : task.taskId);
    if (task.sessionId) task.cancelUnconfirmed = true;
  }
  const stopped = new Set<string>();
  for (const task of tasks) {
    if (!task.sessionId || stopped.has(task.sessionId) || !task.worktreePath || !batch.userId) continue;
    stopped.add(task.sessionId);
    try {
      const client = await getClientForUser(batch.userId, task.worktreePath);
      await abortSession(client, task.sessionId, batch, tasks.filter((member) => member.sessionId === task.sessionId));
    } catch (error) {
      logger.warn({ err: error, taskId: task.taskId }, '[Batch] Failed session remains quarantined until stop is confirmed');
    }
  }
}

export async function startBatch(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) throw new HttpError(404, 'NOT_FOUND', 'Batch not found');
  if (batch.status !== 'pending') throw new HttpError(409, 'BATCH_ALREADY_STARTED', 'This batch has already started or terminated');
  batch.status = 'running';
  broadcastBatchEvent('batch:started', batchId, {
    mode: batch.mode, status: 'running',
    tasks: batch.tasks.map((task) => ({ taskId: task.taskId, title: task.title, status: task.status })),
  });
  if (batch.mode === 'combined') {
    // Reserve all members before the first preparation await.
    for (const task of batch.tasks) { task.status = 'running'; task.startedAt = new Date(); }
    for (const task of batch.tasks) preparingBatchTasks.add(completionKey(batchId, task.taskId));
    void startCombinedBatch(batch).finally(async () => {
      for (const task of batch.tasks) preparingBatchTasks.delete(completionKey(batchId, task.taskId));
      await advanceQueue(batch);
    }).catch(async (error: unknown) => {
      await handleCombinedBatchComplete(batch.id, false, error instanceof Error ? error.message : 'Combined launch failed');
    }).catch((error: unknown) => logger.error({ err: error, batchId }, '[Batch] Combined launch failure could not be persisted'));
  } else {
    for (const index of getInitialBatchLaunchIndexes(batch.mode, batch.tasks.length, batch.settings.maxConcurrent)) launchTask(batch, index);
  }
}

export function launchTask(batch: BatchState, taskIndex: number): void {
  const task = batch.tasks[taskIndex];
  const limit = batch.mode === 'queue' ? 1 : batch.settings.maxConcurrent;
  if (!task || task.status !== 'queued' || batch.mode === 'combined' || !launchIsActive(batch) || batchRunningCount(batch) >= limit) return;
  task.status = 'running';
  task.startedAt = new Date();
  const key = completionKey(batch.id, task.taskId);
  preparingBatchTasks.add(key);
  void startTask(batch, taskIndex).catch((error: unknown) => {
    logger.error({ err: error, taskId: task.taskId }, '[Batch] Launch outcome could not be persisted');
  }).finally(async () => {
    preparingBatchTasks.delete(key);
    await advanceQueue(batch);
  }).catch((error: unknown) => logger.error({ err: error, batchId: batch.id }, '[Batch] Queue advancement failed'));
}

async function startTask(batch: BatchState, taskIndex: number): Promise<void> {
  const task = batch.tasks[taskIndex];
  if (!task || !launchIsActive(batch, task)) return;
  let client: OpencodeClient | undefined;
  try {
    const selected = await validateBatchSelection({ taskIds: [task.taskId], userId: batch.userId, expected: batch });
    if (!launchIsActive(batch, task)) return;
    const repository = selected.repository;
    task.worktreePath = await createWorktree(batch.projectId, batch.id, task.taskId, repository.defaultBranch, batch.accessToken, repository.cloneUrl);
    if (!launchIsActive(batch, task)) { await writeBatchReceipt(batch, 'cancelled'); return; }
    client = await getClientForUser(batch.userId!, task.worktreePath);
    if (!launchIsActive(batch, task)) return;
    const response = await client.session.create({ body: { title: task.title }, query: { directory: task.worktreePath }, signal: AbortSignal.timeout(30_000) });
    const sessionId = response.data?.id;
    if (!sessionId) throw new Error('Failed to create OpenCode session');
    task.sessionId = sessionId;
    if (!launchIsActive(batch, task)) { await abortSession(client, sessionId, batch, [task]); return; }
    sessionToBatch.set(sessionId, { batchId: batch.id, taskIds: [task.taskId] });
    await updateTaskInDb(task.taskId, 'in_progress', {
      executionStartedAt: task.startedAt!, executionProgress: 0,
    }, batch.id);
    if (!launchIsActive(batch, task)) { await abortSession(client, sessionId, batch, [task]); return; }
    broadcastBatchEvent('batch:task:started', batch.id, { taskId: task.taskId, title: task.title });
    emitBatchLog(task.taskId, 'info', `${formatExecutionMode(batch.mode)} started for this issue`);
    broadcastBatchProgress([task.taskId], 'executing', 'Starting the selected OpenCode session');

    const subscribed = subscribeToTaskEvents(client, sessionId, batch.id, task.taskId,
      (success, error) => handleTaskComplete(batch.id, task.taskId, success, error));
    batchSubscriptions.set(task.taskId, subscribed);
    await subscribed.ready;
    if (!launchIsActive(batch, task)) return;
    const current = await validateBatchSelection({ taskIds: [task.taskId], userId: batch.userId, expected: batch });
    if (!launchIsActive(batch, task)) return;
    const modelInfo = await resolveBatchTaskModel(current.tasks[0].model, client);
    if (!launchIsActive(batch, task)) return;
    if (modelInfo) emitBatchLog(task.taskId, 'info', `Using model: ${modelInfo.label}`);
    const accepted = await client.session.promptAsync({
      path: { id: sessionId },
      signal: AbortSignal.timeout(30_000),
      body: { parts: [{ type: 'text', text: buildSingleTaskPrompt(current.tasks[0], task.title) }],
        ...(modelInfo ? { model: modelInfo.override } : {}) },
    });
    if (!launchIsActive(batch, task)) { await abortSession(client, sessionId, batch, [task]); return; }
    if (accepted.error) throw new Error('OpenCode rejected the task prompt');
  } catch (error) {
    if (launchIsActive(batch, task)) {
      if (client && task.sessionId) await abortSession(client, task.sessionId, batch, [task]);
      await handleTaskComplete(batch.id, task.taskId, false, safeBatchError(batch, error));
    }
  }
}

async function startCombinedBatch(batch: BatchState): Promise<void> {
  const taskIds = batch.tasks.map((task) => task.taskId);
  let client: OpencodeClient | undefined;
  let sessionId: string | undefined;
  try {
    const selected = await validateBatchSelection({ taskIds, userId: batch.userId, expected: batch });
    if (!launchIsActive(batch)) return;
    if (new Set(selected.tasks.map((task) => task.model)).size > 1) throw new Error('Combined model selections changed');
    const worktreePath = await createBatchWorktree(batch.projectId, batch.id, batch.batchBranch,
      selected.repository.defaultBranch, batch.accessToken, selected.repository.cloneUrl);
    for (const task of batch.tasks) { task.worktreePath = worktreePath; task.branch = batch.batchBranch; }
    if (!launchIsActive(batch)) { await writeBatchReceipt(batch, 'cancelled'); return; }
    client = await getClientForUser(batch.userId!, worktreePath);
    if (!launchIsActive(batch)) return;
    const response = await client.session.create({ body: { title: `Combined batch: ${taskIds.length} tasks` }, query: { directory: worktreePath }, signal: AbortSignal.timeout(30_000) });
    sessionId = response.data?.id;
    if (!sessionId) throw new Error('Failed to create OpenCode session');
    for (const task of batch.tasks) task.sessionId = sessionId;
    if (!launchIsActive(batch)) { await abortSession(client, sessionId, batch, batch.tasks); return; }
    sessionToBatch.set(sessionId, { batchId: batch.id, taskIds });
    for (const task of batch.tasks) {
      await updateTaskInDb(task.taskId, 'in_progress', { executionStartedAt: task.startedAt!, executionProgress: 0 }, batch.id);
      if (!launchIsActive(batch)) { await abortSession(client, sessionId, batch, batch.tasks); return; }
      broadcastBatchEvent('batch:task:started', batch.id, { taskId: task.taskId, title: task.title });
    }
    const activityId = batchActivityId(batch.id);
    const subscribed = subscribeToSessionEvents({
      client, sessionId, batchId: batch.id, taskIds: [activityId],
      onComplete: (success, error) => handleCombinedBatchComplete(batch.id, success, error),
    });
    batchSubscriptions.set(activityId, subscribed);
    await subscribed.ready;
    if (!launchIsActive(batch)) return;
    const current = await validateBatchSelection({ taskIds, userId: batch.userId, expected: batch });
    if (!launchIsActive(batch)) return;
    if (new Set(current.tasks.map((task) => task.model)).size > 1) throw new Error('Combined model selections changed');
    const modelInfo = await resolveBatchTaskModel(current.tasks[0].model, client);
    if (!launchIsActive(batch)) return;
    const accepted = await client.session.promptAsync({
      path: { id: sessionId },
      signal: AbortSignal.timeout(30_000),
      body: { parts: [{ type: 'text', text: buildCombinedBatchPrompt(batch.tasks, current.tasks) }],
        ...(modelInfo ? { model: modelInfo.override } : {}) },
    });
    if (!launchIsActive(batch)) { await abortSession(client, sessionId, batch, batch.tasks); return; }
    if (accepted.error) throw new Error('OpenCode rejected the combined prompt');
  } catch (error) {
    if (launchIsActive(batch)) {
      if (client && sessionId) await abortSession(client, sessionId, batch, batch.tasks);
      await handleCombinedBatchComplete(batch.id, false, safeBatchError(batch, error));
    }
  }
}

async function cancelMembers(batch: BatchState, taskIds: string[]): Promise<void> {
  const selected = batch.tasks.filter((task) => taskIds.includes(task.taskId));
  const now = new Date();
  // Fence all preparation/completion callbacks before any abort or DB await.
  for (const task of selected) {
    if (task.status !== 'failed' && task.status !== 'skipped') { task.status = 'cancelled'; task.completedAt = now; }
    task.cancelUnconfirmed = true;
  }
  const sessionIds = new Set<string>();
  const errors: unknown[] = [];
  for (const task of selected) {
    closeBatchSubscription(batch.mode === 'combined' ? batchActivityId(batch.id) : task.taskId);
    cleanupDeltaBuffer(task.taskId);
    if (task.sessionId) sessionToBatch.delete(task.sessionId);
    let persisted = true;
    try { if (task.status === 'cancelled') await updateTaskInDb(task.taskId, 'cancelled', {
      executionElapsedMs: task.startedAt ? now.getTime() - task.startedAt.getTime() : 0,
      executionProgress: null,
      outcome: `Cancelled; work retained on ${task.branch}${task.worktreePath ? ' at ' + task.worktreePath : ''}`,
    }, batch.id); } catch (error) { persisted = false; errors.push(error); }
    if (task.sessionId && task.worktreePath && batch.userId && !sessionIds.has(task.sessionId)) {
      sessionIds.add(task.sessionId);
      try {
        const sameSession = selected.filter((member) => member.sessionId === task.sessionId);
        if (!await abortSession(await getClientForUser(batch.userId, task.worktreePath), task.sessionId, batch, sameSession)) errors.push(new Error('Provider abort could not be confirmed'));
      } catch (error) { errors.push(error); }
    } else if (!task.sessionId) { task.cancelUnconfirmed = false; }
    if (!persisted) task.cancelUnconfirmed = true;
    broadcastBatchEvent('batch:task:cancelled', batch.id, { taskId: task.taskId });
    broadcastBatchProgress([task.taskId], 'cancelled', 'Execution cancelled; work retained', { branch: task.branch, retained: true });
  }
  // Claims belong to callbacks; cancellation never deletes them.
  if (!errors.length && batch.publication?.phase === 'cancelled') delete batch.publication.error;
  const reason = errors.length ? errors.map((error) => safeBatchError(batch, error)).join('; ') : undefined;
  if (reason) batch.publication = { ...batch.publication, phase: 'cancelled', error: reason };
  await writeBatchReceipt(batch, batch.status === 'completed' ? 'completed' : batch.status === 'failed' ? 'failed' : batch.status === 'cancelled' ? 'cancelled' : 'committed', reason);
  if (errors.length) throw new HttpError(503, 'CANCEL_INCOMPLETE', 'Cancellation was requested, but some persistence or provider operations could not be confirmed', { retained: true });
}

export function cancelBatch(batchId: string): Promise<void> {
  const existing = cancellationPromises.get(batchId);
  if (existing) return existing;
  const batch = activeBatches.get(batchId);
  if (!batch) return Promise.reject(new HttpError(404, 'NOT_FOUND', 'Batch not found'));
  const cleanupOnly = batch.status === 'completed' || batch.status === 'failed';
  if ((cleanupOnly && !batch.tasks.some((task) => task.cancelUnconfirmed))
    || (batch.status === 'cancelled' && !batch.publication?.error && !batch.tasks.some((task) => task.cancelUnconfirmed))) return Promise.resolve();
  cancellingBatches.add(batchId);
  if (!cleanupOnly) { batch.status = 'cancelled'; batch.completedAt = new Date(); }
  const operation = (async () => {
    try {
      await cancelMembers(batch, batch.tasks.filter((task) => !cleanupOnly || task.cancelUnconfirmed).map((task) => task.taskId));
      broadcastBatchEvent(cleanupOnly ? 'batch:progress' : 'batch:cancelled', batchId, { retained: true, publication: batch.publication });
    } catch (error) {
      batch.publication = { ...batch.publication, phase: batch.status === 'cancelled' ? 'cancelled' : batch.publication?.phase ?? 'failed', error: safeBatchError(batch, error) };
      throw error;
    } finally {
      cancellationPromises.delete(batchId);
      cancellingBatches.delete(batchId);
      scheduleBatchCleanup(batchId);
    }
  })();
  cancellationPromises.set(batchId, operation);
  return operation;
}

export async function cancelTask(batchId: string, taskId: string): Promise<void> {
  const key = completionKey(batchId, taskId);
  const existing = memberCancellationPromises.get(key);
  if (existing) { await existing; return; }
  const batch = activeBatches.get(batchId);
  if (!batch || !batch.tasks.some((task) => task.taskId === taskId)) throw new HttpError(404, 'NOT_FOUND', 'Task not found in this batch');
  if (batch.status !== 'running') throw new HttpError(409, 'BATCH_NOT_RUNNING', 'This batch is not accepting member cancellation');
  if (batch.mode === 'combined') { await cancelBatch(batchId); return; }
  const task = batch.tasks.find((task) => task.taskId === taskId)!;
  if (task.status === 'cancelled' && !task.cancelUnconfirmed) return;
  if (task.status !== 'queued' && task.status !== 'running' && !task.cancelUnconfirmed) throw new HttpError(409, 'TASK_NOT_RUNNING', 'This member has already finished');
  const operation = (async () => {
    try { await cancelMembers(batch, [taskId]); }
    catch (error) {
      task.cancelUnconfirmed = true;
      batch.publication = { ...batch.publication, phase: 'cancelled', error: safeBatchError(batch, error) };
      throw new HttpError(503, 'CANCEL_INCOMPLETE', 'Member cancellation could not be confirmed; work retained');
    }
    finally { memberCancellationPromises.delete(key); }
    await advanceQueue(batch);
  })();
  memberCancellationPromises.set(key, operation);
  await operation;
}

export function getBatch(batchId: string): BatchState | undefined { return activeBatches.get(batchId); }
export function getActiveBatches(): BatchState[] { return [...activeBatches.values()]; }

export async function approveNextTask(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) throw new HttpError(404, 'NOT_FOUND', 'Batch not found');
  if (batch.mode !== 'queue' || batch.status !== 'running' || batchRunningCount(batch) > 0) {
    throw new HttpError(409, 'BATCH_NOT_READY', 'Approve only an idle, running queue batch');
  }
  const nextIndex = batch.tasks.findIndex((task) => task.status === 'queued');
  if (nextIndex === -1) throw new HttpError(409, 'NO_QUEUED_TASK', 'There are no queued members to approve');
  await validateBatchSelection({ taskIds: [batch.tasks[nextIndex].taskId], userId: batch.userId, expected: batch });
  // Another approval or cancellation may have run while validation awaited.
  if (batch.status !== 'running' || batchRunningCount(batch) > 0 || batch.tasks[nextIndex].status !== 'queued') {
    throw new HttpError(409, 'BATCH_NOT_READY', 'Queue state changed while approval was checked');
  }
  launchTask(batch, nextIndex);
}
