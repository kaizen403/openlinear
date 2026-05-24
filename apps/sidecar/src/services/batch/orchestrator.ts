import crypto from 'crypto';
import { prisma } from '@openlinear/db';
import {
  batchActivityId,
  buildCombinedBatchPrompt,
  buildSingleTaskPrompt,
  createBatchState,
  formatExecutionMode,
  getInitialBatchLaunchIndexes,
  isBatchTaskTerminal,
} from '@openlinear/execution-core';
import type {
  BatchSettings,
  BatchState,
  CreateBatchParams,
} from '@openlinear/execution-core';
import { getClientForUser } from '../opencode';
import { ensureMainRepo, createWorktree, createBatchWorktree, cleanupBatch } from '../worktree';
import { cleanupDeltaBuffer } from '../delta-buffer';
import { getExecutionSettings } from '../execution-settings';
import {
  activeBatches,
  sessionToBatch,
  completingBatchTasks,
  broadcastBatchEvent,
  broadcastBatchProgress,
  emitBatchLog,
  getBatchExecutionLogs,
  updateTaskInDb,
} from './shared';
import { subscribeToSessionEvents, subscribeToTaskEvents } from './event-handler';
import { handleTaskComplete, handleCombinedBatchComplete, advanceQueue } from './completion';
import { completionKey } from '@openlinear/execution-core';

export { getBatchExecutionLogs } from './shared';
export { activeBatches } from './shared';

export function getInMemoryBatchCount(): number {
  return activeBatches.size;
}

export async function createBatch(params: CreateBatchParams): Promise<BatchState> {
  const batchId = crypto.randomUUID();

  const settings = await getExecutionSettings(params.userId);
  const batchSettings: BatchSettings = {
    maxConcurrent: settings.maxBatchSize,
    autoApprove: settings.queueAutoApprove,
    stopOnFailure: settings.stopOnFailure,
    conflictBehavior: settings.conflictBehavior,
  };

  const firstTask = await prisma.task.findFirst({
    where: { id: { in: params.taskIds } },
    include: { project: { include: { repository: true } } },
  });

  if (firstTask?.project?.localPath && !firstTask?.project?.repository) {
    throw new Error(
      'Batch execution is not supported for local-path projects. Execute tasks individually, or connect a GitHub repository to the project.',
    );
  }

  let project: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null = null;

  if (firstTask?.project?.repository) {
    project = firstTask.project.repository;
  } else {
    project = await prisma.repository.findFirst({
      where: params.userId
        ? { userId: params.userId, isActive: true }
        : { userId: null, isActive: true },
    });
  }

  if (!project) {
    throw new Error('No active project selected');
  }

  const mainRepoPath = await ensureMainRepo(project.id, project.cloneUrl, params.accessToken);

  const taskRecords = await prisma.task.findMany({
    where: { id: { in: params.taskIds } },
    select: { id: true, title: true },
  });
  const titleMap = new Map(taskRecords.map(t => [t.id, t.title]));

  const batch = createBatchState({
    id: batchId,
    projectId: project.id,
    mode: params.mode,
    taskIds: params.taskIds,
    titleByTaskId: titleMap,
    settings: batchSettings,
    mainRepoPath,
    accessToken: params.accessToken,
    userId: params.userId,
  });
  const tasks = batch.tasks;

  activeBatches.set(batchId, batch);

  await prisma.task.updateMany({
    where: { id: { in: params.taskIds } },
    data: { batchId },
  });

  broadcastBatchEvent('batch:created', batchId, {
    mode: params.mode,
    status: 'running',
    tasks: tasks.map(t => ({ taskId: t.taskId, title: t.title, status: t.status })),
  });

  return batch;
}

export async function startBatch(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) {
    throw new Error(`Batch ${batchId} not found`);
  }

  batch.status = 'running';
  broadcastBatchEvent('batch:started', batchId, {
    mode: batch.mode,
    status: 'running',
    tasks: batch.tasks.map(t => ({ taskId: t.taskId, title: t.title, status: t.status })),
  });

  if (batch.mode === 'combined') {
    void startCombinedBatch(batch).catch(async (error: unknown) => {
      const errorMsg = error instanceof Error ? error.message : 'Unknown combined batch launch error';
      console.error(`[Batch] Unhandled combined batch launch failure for ${batch.id.slice(0, 8)}:`, error);
      await handleCombinedBatchComplete(batch.id, false, errorMsg);
    });
  } else {
    for (const taskIndex of getInitialBatchLaunchIndexes(batch.mode, batch.tasks.length)) {
      launchTask(batch, taskIndex);
    }
  }
}

export function launchTask(batch: BatchState, taskIndex: number): void {
  const task = batch.tasks[taskIndex];
  if (!task || isBatchTaskTerminal(task)) return;

  startTask(batch, taskIndex).catch(async (error: unknown) => {
    const errorMsg = error instanceof Error ? error.message : 'Unknown task launch error';
    console.error(`[Batch] Unhandled task launch failure for ${task.taskId.slice(0, 8)}:`, error);

    if (!isBatchTaskTerminal(task)) {
      task.status = 'failed';
      task.error = errorMsg;
      task.completedAt = new Date();
      broadcastBatchEvent('batch:task:failed', batch.id, { taskId: task.taskId, error: errorMsg });
      emitBatchLog(task.taskId, 'error', `Failed to start task: ${errorMsg}`);
      await updateTaskInDb(task.taskId, 'todo', { outcome: `Failed: ${errorMsg}` });
    }

    if (batch.settings.stopOnFailure) {
      await cancelBatch(batch.id);
      return;
    }

    await advanceQueue(batch);
  }).catch((reportError: unknown) => {
    console.error(`[Batch] Failed to report task launch failure for ${task.taskId.slice(0, 8)}:`, reportError);
  });
}

async function startTask(batch: BatchState, taskIndex: number): Promise<void> {
  const task = batch.tasks[taskIndex];
  if (!task) return;

  task.status = 'running';
  task.startedAt = new Date();

  try {
    if (!batch.userId) {
      throw new Error('Cannot start task without an authenticated user (userId is required for execution)');
    }

    const project = await prisma.repository.findUnique({ where: { id: batch.projectId } });

    const worktreePath = await createWorktree(
      batch.projectId,
      batch.id,
      task.taskId,
      project?.defaultBranch || 'main'
    );
    task.worktreePath = worktreePath;

    const client = await getClientForUser(batch.userId, worktreePath);

    const sessionResponse = await client.session.create({
      body: { title: task.title },
      query: { directory: worktreePath },
    });

    const sessionId = sessionResponse.data?.id;
    if (!sessionId) {
      throw new Error('Failed to create OpenCode session');
    }

    task.sessionId = sessionId;
    sessionToBatch.set(sessionId, { batchId: batch.id, taskIds: [task.taskId] });

    broadcastBatchEvent('batch:task:started', batch.id, { taskId: task.taskId, title: task.title });

    await updateTaskInDb(task.taskId, 'in_progress', {
      executionStartedAt: task.startedAt!,
      executionProgress: 0,
    });

    const modeLabel = formatExecutionMode(batch.mode);
    emitBatchLog(task.taskId, 'info', `${modeLabel} started for this issue`);
    broadcastBatchProgress([task.taskId], 'executing', `${modeLabel} started for this issue`);

    subscribeToTaskEvents(client, sessionId, batch.id, task.taskId, (success, error) => handleTaskComplete(batch.id, task.taskId, success, error));

    const taskRecord = await prisma.task.findUnique({
      where: { id: task.taskId },
      select: { title: true, description: true },
    });

    const prompt = buildSingleTaskPrompt(taskRecord, task.title);

    client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: prompt }] },
    }).then(() => {
      console.log(`[Batch] Prompt sent for task ${task.taskId.slice(0, 8)} in batch ${batch.id.slice(0, 8)}`);
    }).catch((err: Error) => {
      console.error(`[Batch] Failed to send prompt for task ${task.taskId.slice(0, 8)}:`, err.message);
      emitBatchLog(task.taskId, 'error', 'Failed to send prompt to agent', err.message);
      void handleTaskComplete(batch.id, task.taskId, false, err.message).catch((completeError: unknown) => {
        console.error(`[Batch] Failed to mark prompt failure for task ${task.taskId.slice(0, 8)}:`, completeError);
      });
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Batch] Failed to start task ${task.taskId.slice(0, 8)}:`, errorMsg);
    task.status = 'failed';
    task.error = errorMsg;
    task.completedAt = new Date();
    broadcastBatchEvent('batch:task:failed', batch.id, { taskId: task.taskId, error: errorMsg });
    emitBatchLog(task.taskId, 'error', `Failed to start task: ${errorMsg}`);
    await updateTaskInDb(task.taskId, 'todo', { outcome: `Failed: ${errorMsg}` });

    if (batch.settings.stopOnFailure) {
      await cancelBatch(batch.id);
      return;
    }

    await advanceQueue(batch);
  }
}

async function loadCombinedPrompt(batch: BatchState): Promise<string> {
  const taskIds = batch.tasks.map(t => t.taskId);
  const taskRecords = await prisma.task.findMany({
    where: { id: { in: taskIds } },
    select: { id: true, identifier: true, title: true, description: true },
  });
  return buildCombinedBatchPrompt(batch.tasks, taskRecords);
}

async function startCombinedBatch(batch: BatchState): Promise<void> {
  if (!batch.userId) {
    throw new Error('Cannot start combined batch without an authenticated user (userId is required for execution)');
  }

  const project = await prisma.repository.findUnique({ where: { id: batch.projectId } });
  const defaultBranch = project?.defaultBranch || 'main';
  const worktreePath = await createBatchWorktree(
    batch.projectId,
    batch.id,
    batch.batchBranch,
    defaultBranch,
  );
  const client = await getClientForUser(batch.userId, worktreePath);
  const sessionResponse = await client.session.create({
    body: { title: `Combined batch: ${batch.tasks.length} tasks` },
    query: { directory: worktreePath },
  });

  const sessionId = sessionResponse.data?.id;
  if (!sessionId) {
    throw new Error('Failed to create OpenCode session');
  }

  const startedAt = new Date();
  const taskIds = batch.tasks.map(task => task.taskId);
  const activityId = batchActivityId(batch.id);
  sessionToBatch.set(sessionId, { batchId: batch.id, taskIds });

  for (const task of batch.tasks) {
    task.status = 'running';
    task.startedAt = startedAt;
    task.worktreePath = worktreePath;
    task.branch = batch.batchBranch;
    task.sessionId = sessionId;

    broadcastBatchEvent('batch:task:started', batch.id, { taskId: task.taskId, title: task.title });
    await updateTaskInDb(task.taskId, 'in_progress', {
      executionStartedAt: startedAt,
      executionProgress: 0,
    });
  }

  emitBatchLog(activityId, 'info', `Combined Execution started for ${batch.tasks.length} selected issues`);
  broadcastBatchProgress(
    [activityId],
    'executing',
    `Combined Execution started for ${batch.tasks.length} selected issues`,
  );

  subscribeToSessionEvents({
    client,
    sessionId,
    batchId: batch.id,
    taskIds: [activityId],
    onComplete: (success, error) => handleCombinedBatchComplete(batch.id, success, error),
  });

  const prompt = await loadCombinedPrompt(batch);
  await client.session.prompt({
    path: { id: sessionId },
    body: { parts: [{ type: 'text', text: prompt }] },
  });

  console.log(`[Batch] Combined prompt sent for ${batch.tasks.length} tasks in batch ${batch.id.slice(0, 8)}`);
}

export async function cancelBatch(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) {
    throw new Error(`Batch ${batchId} not found`);
  }

  batch.status = 'cancelled';
  const combinedActivityId = batch.mode === 'combined' ? batchActivityId(batch.id) : null;
  if (combinedActivityId) {
    emitBatchLog(combinedActivityId, 'info', 'Combined Execution cancelled');
    broadcastBatchProgress([combinedActivityId], 'cancelled', 'Combined Execution cancelled');
  }

  const abortedSessionIds = new Set<string>();
  for (const task of batch.tasks) {
    if (task.status === 'running' && task.sessionId && task.worktreePath && batch.userId) {
      if (!abortedSessionIds.has(task.sessionId)) {
        try {
          const client = await getClientForUser(batch.userId, task.worktreePath);
          await client.session.abort({ path: { id: task.sessionId } });
          abortedSessionIds.add(task.sessionId);
        } catch (error) {
          console.error(`[Batch] Failed to abort session for task ${task.taskId.slice(0, 8)}:`, error);
        }
      }
      task.status = 'cancelled';
      task.completedAt = new Date();
      cleanupDeltaBuffer(task.taskId);
      completingBatchTasks.delete(completionKey(batchId, task.taskId));
      sessionToBatch.delete(task.sessionId);
      if (!combinedActivityId) {
        broadcastBatchProgress([task.taskId], 'cancelled', `${formatExecutionMode(batch.mode)} cancelled`);
      }
    } else if (task.status === 'queued') {
      task.status = 'cancelled';
      cleanupDeltaBuffer(task.taskId);
      completingBatchTasks.delete(completionKey(batchId, task.taskId));
      if (!combinedActivityId) {
        broadcastBatchProgress([task.taskId], 'cancelled', `${formatExecutionMode(batch.mode)} cancelled`);
      }
    }
  }

  broadcastBatchEvent('batch:cancelled', batchId);

  try {
    await cleanupBatch(batch.projectId, batchId);
  } catch (error) {
    console.error(`[Batch] Cleanup failed for cancelled batch ${batchId.slice(0, 8)}:`, error);
  }
}

export async function cancelTask(batchId: string, taskId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) {
    throw new Error(`Batch ${batchId} not found`);
  }

  const task = batch.tasks.find(t => t.taskId === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found in batch ${batchId}`);
  }

  if (batch.mode === 'combined') {
    await cancelBatch(batchId);
    return;
  }

  task.status = 'cancelled';
  task.completedAt = new Date();
  cleanupDeltaBuffer(taskId);
  completingBatchTasks.delete(completionKey(batchId, taskId));
  broadcastBatchProgress([taskId], 'cancelled', `${formatExecutionMode(batch.mode)} task cancelled`);

  if (task.sessionId && task.worktreePath && batch.userId) {
    try {
      const client = await getClientForUser(batch.userId, task.worktreePath);
      await client.session.abort({ path: { id: task.sessionId } });
    } catch (error) {
      console.error(`[Batch] Failed to abort session for task ${taskId.slice(0, 8)}:`, error);
    }
    sessionToBatch.delete(task.sessionId);
  }

  broadcastBatchEvent('batch:task:cancelled', batchId, { taskId });
}

export function getBatch(batchId: string): BatchState | undefined {
  return activeBatches.get(batchId);
}

export function getActiveBatches(): BatchState[] {
  return Array.from(activeBatches.values());
}

export async function approveNextTask(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) {
    throw new Error(`Batch ${batchId} not found`);
  }

  if (batch.mode === 'combined') {
    throw new Error('Combined batches do not have queued tasks to approve');
  }

  const nextIndex = batch.tasks.findIndex(t => t.status === 'queued');
  if (nextIndex === -1) {
    throw new Error('No queued tasks to approve');
  }

  launchTask(batch, nextIndex);
}
