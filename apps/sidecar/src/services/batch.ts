import crypto from 'crypto';
import { prisma } from '@openlinear/db';
import { broadcastToTask, broadcastToTaskById, broadcastToUser } from '@openlinear/api/sse';
import { getClientForUser } from './opencode';
import { ensureMainRepo, createWorktree, cleanupBatch, mergeBranch, createBatchBranch, pushBranch } from './worktree';
import type { BatchState, BatchTask, BatchSettings, CreateBatchParams, BatchEventType } from '../types/batch';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { getOrCreateBuffer, appendTextDelta, appendReasoningDelta, flushDeltaBuffer, cleanupDeltaBuffer, markThinking } from './delta-buffer';
import { getGitIdentityEnv } from './git-identity';
import { execFileAsync } from './execution/exec';
import { hasCommittableChanges, stageCommittableChanges } from './execution/git';
import { getExecutionSettings } from './execution-settings';

const activeBatches = new Map<string, BatchState>();
const sessionToBatch = new Map<string, { batchId: string; taskId: string }>();
const completingBatchTasks = new Set<string>();
const finalizingBatches = new Set<string>();
const BATCH_EVENT_TIMEOUT_MS = 30_000;
const BATCH_BACKGROUND_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const BATCH_BACKGROUND_BUFFER_LIMIT = 4_000;
const BATCH_EVENT_TIMEOUT_REASON = 'Event stream timed out';
const BATCH_BACKGROUND_TASK_TIMEOUT_REASON = 'Background subtask timed out';

/**
 * T14 — On sidecar restart, `activeBatches` is empty (in-memory only). Any
 * task that was mid-batch is recovered via `recoverInFlightExecutions()` in
 * `services/execution/recovery.ts`. This export exists so the boot sequence
 * has a symmetric API surface and to give future Batch persistence work a
 * stable hook to extend without changing call sites.
 */
export function getInMemoryBatchCount(): number {
  return activeBatches.size;
}

interface BatchLogEntry {
  timestamp: string;
  type: 'info' | 'agent' | 'tool' | 'error' | 'success';
  message: string;
  details?: string;
}
const batchTaskLogs = new Map<string, BatchLogEntry[]>();

function extractBackgroundTaskId(output: string): string | null {
  return output.match(/(?:task_id|Background Task ID):\s*([A-Za-z0-9_-]+)/i)?.[1] ?? null;
}

function isBackgroundTaskLaunch(toolName: string, output: string): boolean {
  if (toolName !== 'task') return false;
  const lower = output.toLowerCase();
  return lower.includes('background task started')
    || lower.includes('background task launched')
    || (lower.includes('state: running') && lower.includes('task_status'));
}

function isBackgroundTaskCancellation(toolName: string, output: string): boolean {
  const lower = `${toolName}\n${output}`.toLowerCase();
  return toolName === 'background_cancel'
    || lower.includes('task cancelled successfully')
    || lower.includes('task canceled successfully')
    || lower.includes('background task cancelled')
    || lower.includes('background task canceled');
}

function isBackgroundTaskCompletion(output: string): boolean {
  return /Background task completed:/i.test(output) || /\bTask Completed\b/i.test(output);
}

function isBackgroundTaskFailure(output: string): boolean {
  return /Background task failed:/i.test(output) || /\bTask Failed\b/i.test(output);
}

function broadcastBatchEvent(type: BatchEventType, batchId: string, data: Record<string, unknown> = {}): void {
  const batch = activeBatches.get(batchId);
  const payload = { batchId, ...data, timestamp: new Date().toISOString() };
  if (batch?.userId) {
    try {
      broadcastToUser(batch.userId, type, payload);
    } catch (error) {
      console.error(`[Batch] Failed to broadcast ${type} for batch ${batchId.slice(0, 8)}:`, error);
    }
  }
}

function isBatchTaskTerminal(task: BatchTask): boolean {
  return task.status === 'completed'
    || task.status === 'failed'
    || task.status === 'skipped'
    || task.status === 'cancelled';
}

function completionKey(batchId: string, taskId: string): string {
  return `${batchId}:${taskId}`;
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

  // Try to get repository from tasks' project first
  const firstTask = await prisma.task.findFirst({
    where: { id: { in: params.taskIds } },
    include: { project: { include: { repository: true } } },
  });

  // Local-path projects are not supported by batch execution yet — worktree
  // operations against the user's actual checkout could damage uncommitted
  // work. Surface this as a clear error instead of silently falling back to
  // the user's global active repository (which would be even more confusing).
  if (firstTask?.project?.localPath && !firstTask?.project?.repository) {
    throw new Error(
      'Batch execution is not supported for local-path projects. Execute tasks individually, or connect a GitHub repository to the project.',
    );
  }

  let project: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null = null;

  if (firstTask?.project?.repository) {
    project = firstTask.project.repository;
  } else {
    // Fallback: global active repository
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

  const tasks: BatchTask[] = params.taskIds.map(taskId => ({
    taskId,
    title: titleMap.get(taskId) || 'Untitled task',
    status: 'queued',
    worktreePath: null,
    branch: `openlinear/${taskId}`,
    sessionId: null,
    error: null,
    startedAt: null,
    completedAt: null,
  }));

  const batch: BatchState = {
    id: batchId,
    projectId: project.id,
    mode: params.mode,
    status: 'pending',
    tasks,
    settings: batchSettings,
    mainRepoPath,
    batchBranch: `openlinear/batch-${batchId.slice(0, 8)}`,
    prUrl: null,
    accessToken: params.accessToken,
    userId: params.userId,
    createdAt: new Date(),
    completedAt: null,
  };

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

  if (batch.mode === 'parallel') {
    const count = Math.min(batch.settings.maxConcurrent, batch.tasks.length);
    for (let i = 0; i < count; i++) {
      launchTask(batch, i);
    }
  } else {
    launchTask(batch, 0);
  }
}

function launchTask(batch: BatchState, taskIndex: number): void {
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
    sessionToBatch.set(sessionId, { batchId: batch.id, taskId: task.taskId });

    broadcastBatchEvent('batch:task:started', batch.id, { taskId: task.taskId, title: task.title });

    await updateTaskInDb(task.taskId, 'in_progress', {
      executionStartedAt: task.startedAt!,
      executionProgress: 0,
    });

    emitBatchLog(task.taskId, 'info', `Batch task started in ${batch.mode} mode`);

    subscribeToTaskEvents(client, sessionId, batch.id, task.taskId);

    const taskRecord = await prisma.task.findUnique({
      where: { id: task.taskId },
      select: { title: true, description: true },
    });

    let prompt = taskRecord?.title || task.title;
    if (taskRecord?.description) {
      prompt += `\n\n${taskRecord.description}`;
    }
    prompt += [
      '',
      '',
      'Execution contract:',
      '- Make the requested code changes directly in this worktree before finishing.',
      '- If you use a background subtask, wait for its result and apply any required changes before completing.',
      '- Do not mark the task complete unless the worktree contains the requested changes or you can explain why no code change is valid.',
    ].join('\n');

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

function emitBatchLog(taskId: string, type: 'info' | 'agent' | 'tool' | 'error' | 'success', message: string, details?: string): void {
  const entry: BatchLogEntry = { timestamp: new Date().toISOString(), type, message, ...(details ? { details } : {}) };

  if (!batchTaskLogs.has(taskId)) {
    batchTaskLogs.set(taskId, []);
  }
  batchTaskLogs.get(taskId)!.push(entry);

  broadcastToTaskById(taskId, 'execution:log', { taskId, entry }).catch((error: unknown) => {
    console.error(`[Batch] Failed to broadcast log for task ${taskId.slice(0, 8)}:`, error);
  });
}

function subscribeToTaskEvents(
  client: OpencodeClient,
  sessionId: string,
  batchId: string,
  taskId: string
): void {
  let promptSent = false;
  let timedOut = false;
  let timeoutId: NodeJS.Timeout | null = null;
  let backgroundTaskRunning = false;
  let backgroundTaskFailure: string | null = null;
  let backgroundTaskResultBuffer = '';

  const clearEventTimeout = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  const resetEventTimeout = (
    timeoutMs = BATCH_EVENT_TIMEOUT_MS,
    timeoutReason = BATCH_EVENT_TIMEOUT_REASON,
  ) => {
    clearEventTimeout();
    const waitingForBackgroundTask =
      backgroundTaskRunning
      && timeoutMs === BATCH_EVENT_TIMEOUT_MS
      && timeoutReason === BATCH_EVENT_TIMEOUT_REASON;
    const effectiveTimeoutMs = waitingForBackgroundTask ? BATCH_BACKGROUND_TASK_TIMEOUT_MS : timeoutMs;
    const effectiveTimeoutReason = waitingForBackgroundTask ? BATCH_BACKGROUND_TASK_TIMEOUT_REASON : timeoutReason;

    timeoutId = setTimeout(() => {
      timedOut = true;
      flushDeltaBuffer(taskId);
      cleanupDeltaBuffer(taskId);
      emitBatchLog(taskId, 'error', 'Execution timed out waiting for agent events', effectiveTimeoutReason);
      void handleTaskComplete(batchId, taskId, false, effectiveTimeoutReason).catch((error: unknown) => {
        console.error(`[Batch] Failed to complete timed out task ${taskId.slice(0, 8)}:`, error);
      });
    }, effectiveTimeoutMs);
    timeoutId.unref();
  };

  const clearBackgroundTaskWait = (
    status: 'completed' | 'cancelled' | 'failed',
    details?: string,
  ) => {
    if (!backgroundTaskRunning) return;

    backgroundTaskRunning = false;
    backgroundTaskFailure = status === 'failed' ? (details || 'Background subtask failed') : null;

    if (status === 'failed') {
      emitBatchLog(taskId, 'error', 'Background subtask failed', backgroundTaskFailure ?? undefined);
      return;
    }

    emitBatchLog(
      taskId,
      'info',
      status === 'cancelled'
        ? 'Background subtask cancelled; continuing execution'
        : 'Background subtask completed; waiting for final agent response',
      details,
    );
    resetEventTimeout();
  };

  const observeBackgroundTaskText = (text: string) => {
    if (!text) return;
    backgroundTaskResultBuffer = (backgroundTaskResultBuffer + text).slice(-BATCH_BACKGROUND_BUFFER_LIMIT);
    if (isBackgroundTaskCancellation('text', backgroundTaskResultBuffer)) {
      clearBackgroundTaskWait('cancelled', backgroundTaskResultBuffer.slice(-1_000));
      return;
    }
    if (isBackgroundTaskFailure(backgroundTaskResultBuffer)) {
      clearBackgroundTaskWait('failed', backgroundTaskResultBuffer.slice(-1_000));
      return;
    }
    if (isBackgroundTaskCompletion(backgroundTaskResultBuffer)) {
      clearBackgroundTaskWait('completed', backgroundTaskResultBuffer.slice(-1_000));
    }
  };

  getOrCreateBuffer(taskId, (msg) => emitBatchLog(taskId, 'agent', msg));

  (async () => {
    try {
      const events = await client.event.subscribe();
      resetEventTimeout();

      for await (const event of events.stream) {
        if (timedOut) break;
        resetEventTimeout();
        const type = event.type as string;
        const props = (event.properties || {}) as Record<string, unknown>;

        if (type === 'server.heartbeat') continue;

        // Terminal events
        if (type === 'session.completed' || type === 'session.idle') {
          if (!promptSent) continue;
          if (backgroundTaskFailure) {
            clearEventTimeout();
            flushDeltaBuffer(taskId);
            cleanupDeltaBuffer(taskId);
            await handleTaskComplete(batchId, taskId, false, `Background subtask failed: ${backgroundTaskFailure}`);
            break;
          }
          if (backgroundTaskRunning) {
            emitBatchLog(taskId, 'info', 'Agent is waiting on a background subtask');
            resetEventTimeout(BATCH_BACKGROUND_TASK_TIMEOUT_MS, BATCH_BACKGROUND_TASK_TIMEOUT_REASON);
            continue;
          }
          clearEventTimeout();
          flushDeltaBuffer(taskId);
          cleanupDeltaBuffer(taskId);
          emitBatchLog(taskId, 'success', 'Agent completed work');
          await handleTaskComplete(batchId, taskId, true);
          break;
        }

        if (type === 'session.error') {
          clearEventTimeout();
          flushDeltaBuffer(taskId);
          cleanupDeltaBuffer(taskId);
          const errorMsg = String(props.error || 'Session error');
          emitBatchLog(taskId, 'error', 'Execution failed', errorMsg);
          await handleTaskComplete(batchId, taskId, false, errorMsg);
          break;
        }

        // Status events
        if (type === 'session.status') {
          const status = props.status as { type?: string; message?: string } | undefined;
          if (status?.type === 'busy') {
            promptSent = true;
            if (markThinking(taskId)) {
              emitBatchLog(taskId, 'agent', 'Agent is thinking...');
            }
          } else if (status?.type === 'retry') {
            emitBatchLog(taskId, 'info', `Retrying: ${status.message || 'unknown reason'}`);
          }
          continue;
        }

        // Message part updates — agent text, tool calls, reasoning
        if (type === 'message.part.updated') {
          const part = props.part as { type?: string; text?: string; tool?: string; state?: { status?: string; title?: string; output?: string } } | undefined;
          const delta = props.delta as string | undefined;

          if (part?.type === 'text' && delta) {
            appendTextDelta(taskId, delta);
            observeBackgroundTaskText(delta);
          } else if (part?.type === 'tool') {
            flushDeltaBuffer(taskId);
            const toolName = part.tool || 'unknown tool';
            const state = part.state;
            if (state?.status === 'running') {
              emitBatchLog(taskId, 'tool', `Running: ${state.title || toolName}`);
            } else if (state?.status === 'completed') {
              const rawOutput = state.output || '';
              if (isBackgroundTaskLaunch(toolName, rawOutput)) {
                backgroundTaskRunning = true;
                backgroundTaskFailure = null;
                backgroundTaskResultBuffer = rawOutput.slice(-BATCH_BACKGROUND_BUFFER_LIMIT);
                const backgroundTaskId = extractBackgroundTaskId(rawOutput);
                resetEventTimeout(BATCH_BACKGROUND_TASK_TIMEOUT_MS, BATCH_BACKGROUND_TASK_TIMEOUT_REASON);
                emitBatchLog(
                  taskId,
                  'info',
                  'Background subtask launched; waiting for it to finish',
                  backgroundTaskId ? `Task ID: ${backgroundTaskId}` : rawOutput.slice(0, 100),
                );
              } else if (isBackgroundTaskCancellation(toolName, rawOutput)) {
                clearBackgroundTaskWait('cancelled', rawOutput.slice(-1_000));
                emitBatchLog(taskId, 'success', `Completed: ${toolName}`, rawOutput.slice(0, 100));
              } else {
                observeBackgroundTaskText(rawOutput);
                emitBatchLog(taskId, 'success', `Completed: ${toolName}`, rawOutput.slice(0, 100));
              }
            } else if (state?.status === 'error') {
              emitBatchLog(taskId, 'error', `Failed: ${toolName}`, state.output);
            }
          } else if (part?.type === 'reasoning') {
            if (delta && delta.length > 0) {
              appendReasoningDelta(taskId, delta);
            }
          }
          continue;
        }

        // Tool execution events
        if (type === 'tool.execute.before') {
          flushDeltaBuffer(taskId);
          const tool = props.tool as string | undefined;
          if (tool) {
            emitBatchLog(taskId, 'tool', `Starting: ${tool}`);
          }
          continue;
        }

        if (type === 'tool.execute.after') {
          const tool = props.tool as string | undefined;
          const output = props.output as string | undefined;
          if (tool) {
            if (isBackgroundTaskCancellation(tool, output || '')) {
              clearBackgroundTaskWait('cancelled', output?.slice(-1_000));
            } else {
              observeBackgroundTaskText(output || '');
            }
            emitBatchLog(taskId, 'success', `Finished: ${tool}`, output?.slice(0, 100));
          }
          continue;
        }

        // File edits
        if (type === 'file.edited') {
          const file = props.file as string | undefined;
          if (file) {
            emitBatchLog(taskId, 'success', `Edited file: ${file}`);
          }
          continue;
        }
      }
    } catch (error) {
      cleanupDeltaBuffer(taskId);
      clearEventTimeout();
      console.error(`[Batch] Event subscription error for task ${taskId.slice(0, 8)}:`, error);
      await handleTaskComplete(batchId, taskId, false, 'Event subscription failed');
    } finally {
      clearEventTimeout();
    }
  })();
}

async function updateTaskInDb(
  taskId: string,
  status: 'todo' | 'in_progress' | 'done' | 'cancelled',
  executionData?: {
    executionStartedAt?: Date;
    executionElapsedMs?: number;
    executionProgress?: number | null;
    prUrl?: string | null;
    outcome?: string | null;
  }
): Promise<void> {
  try {
    const task = await prisma.task.update({
      where: { id: taskId },
      data: { status, ...executionData },
      include: { labels: { include: { label: true } } },
    });

    const flatTask = {
      ...task,
      labels: (task.labels as Array<{ label: { id: string; name: string; color: string } }>).map(tl => tl.label),
    };

    broadcastToTask('task:updated', flatTask);
  } catch (err) {
    console.error(`[Batch] Failed to update task ${taskId} in DB:`, err);
  }
}

async function handleTaskComplete(
  batchId: string,
  taskId: string,
  success: boolean,
  error?: string
): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) return;

  const task = batch.tasks.find(t => t.taskId === taskId);
  if (!task || isBatchTaskTerminal(task)) return;

  const key = completionKey(batchId, taskId);
  if (completingBatchTasks.has(key)) return;
  completingBatchTasks.add(key);

  const elapsedMs = task.startedAt ? Date.now() - task.startedAt.getTime() : 0;
  task.completedAt = new Date();

  try {
    let completionSucceeded = success;
    let completionError = error;

    if (completionSucceeded) {
      // Commit changes from worktree
      if (task.worktreePath) {
        try {
          const env = { ...process.env, ...getGitIdentityEnv() };
          if (await hasCommittableChanges(task.worktreePath)) {
            const staged = await stageCommittableChanges(task.worktreePath);
            if (!staged) {
              completionSucceeded = false;
              completionError = 'Agent finished without committable code changes';
              console.log(`[Batch] No committable changes for task ${task.taskId.slice(0, 8)}`);
            } else {
              const commitMsg = `feat: ${task.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 50)}`;
              await execFileAsync('git', ['-C', task.worktreePath, 'commit', '-m', commitMsg], { env });
              console.log(`[Batch] Committed changes for task ${task.taskId.slice(0, 8)}`);
            }
          } else {
            completionSucceeded = false;
            completionError = 'Agent finished without making code changes';
            console.log(`[Batch] No changes for task ${task.taskId.slice(0, 8)}`);
          }
        } catch (commitErr) {
          completionSucceeded = false;
          completionError = commitErr instanceof Error ? commitErr.message : 'Failed to commit task changes';
          console.error(`[Batch] Failed to commit for task ${task.taskId.slice(0, 8)}:`, commitErr);
        }
      } else {
        completionSucceeded = false;
        completionError = 'Task completed without a worktree';
      }
    }

    if (completionSucceeded) {
      task.status = 'completed';
      broadcastBatchEvent('batch:task:completed', batchId, { taskId });
      emitBatchLog(taskId, 'success', 'Batch task completed');

      await updateTaskInDb(taskId, 'done', {
        executionElapsedMs: elapsedMs,
        executionProgress: 100,
        outcome: 'Completed via batch execution',
      });
    } else {
      task.status = 'failed';
      task.error = completionError || 'Unknown error';
      broadcastBatchEvent('batch:task:failed', batchId, { taskId, error: task.error });
      emitBatchLog(taskId, 'error', `Batch task failed: ${task.error}`);

      await updateTaskInDb(taskId, 'todo', {
        executionElapsedMs: elapsedMs,
        outcome: `Failed: ${task.error}`,
      });
    }

    const logs = batchTaskLogs.get(taskId) || [];
    if (logs.length > 0) {
      try {
        await prisma.task.update({
          where: { id: taskId },
          data: { executionLogs: JSON.parse(JSON.stringify(logs)) },
        });
      } catch (err) {
        console.error(`[Batch] Failed to persist logs for task ${taskId.slice(0, 8)}:`, err);
      }
      batchTaskLogs.delete(taskId);
    }

    if (task.sessionId) {
      sessionToBatch.delete(task.sessionId);
    }

    if (!completionSucceeded && batch.settings.stopOnFailure) {
      await cancelBatch(batchId);
      return;
    }

    await advanceQueue(batch);
  } finally {
    completingBatchTasks.delete(key);
  }
}

async function advanceQueue(batch: BatchState): Promise<void> {
  const hasRemaining = batch.tasks.some(t => t.status === 'queued' || t.status === 'running');
  if (!hasRemaining) {
    await finalizeBatch(batch.id);
    return;
  }

  const nextIndex = batch.tasks.findIndex(t => t.status === 'queued');
  if (nextIndex === -1) return;

  if (batch.mode === 'parallel') {
    launchTask(batch, nextIndex);
  } else if (batch.settings.autoApprove) {
    launchTask(batch, nextIndex);
  }
}

async function finalizeBatch(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) return;

  if (
    finalizingBatches.has(batchId)
    || batch.status === 'merging'
    || batch.status === 'completed'
    || batch.status === 'failed'
    || batch.status === 'cancelled'
  ) {
    return;
  }

  finalizingBatches.add(batchId);

  try {
    batch.status = 'merging';
    broadcastBatchEvent('batch:merging', batchId);

    const project = await prisma.repository.findUnique({ where: { id: batch.projectId } });
    const targetBranch = project?.defaultBranch || 'main';

    await createBatchBranch(batch.projectId, batch.batchBranch, targetBranch);

    let hasFatalFailure = false;

    for (const task of batch.tasks) {
      if (task.status !== 'completed') continue;

      try {
        const merged = await mergeBranch(batch.projectId, task.branch, batch.batchBranch);

        if (!merged) {
          if (batch.settings.conflictBehavior === 'fail') {
            task.status = 'failed';
            task.error = 'Merge conflict';
            hasFatalFailure = true;
            broadcastBatchEvent('batch:task:failed', batchId, { taskId: task.taskId, error: 'Merge conflict' });
            break;
          } else {
            task.status = 'skipped';
            task.error = 'Merge conflict (skipped)';
            broadcastBatchEvent('batch:task:skipped', batchId, { taskId: task.taskId });
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Merge error';
        console.error(`[Batch] Merge failed for task ${task.taskId.slice(0, 8)}:`, errorMsg);

        if (batch.settings.conflictBehavior === 'fail') {
          task.status = 'failed';
          task.error = errorMsg;
          hasFatalFailure = true;
          broadcastBatchEvent('batch:task:failed', batchId, { taskId: task.taskId, error: errorMsg });
          break;
        } else {
          task.status = 'skipped';
          task.error = errorMsg;
          broadcastBatchEvent('batch:task:skipped', batchId, { taskId: task.taskId });
        }
      }
    }

    if (hasFatalFailure) {
      batch.status = 'failed';
      batch.completedAt = new Date();
      broadcastBatchEvent('batch:failed', batchId);
    } else {
      try {
        const proj = await prisma.repository.findUnique({ where: { id: batch.projectId } });
        if (proj) {
          await pushBranch(batch.projectId, batch.batchBranch, proj.cloneUrl, batch.accessToken);

          const completedTasks = batch.tasks.filter(t => t.status === 'completed');
          const taskTitles = completedTasks.map(t => `- ${t.title}`).join('\n');
          const prTitle = `Batch: ${completedTasks.length} tasks`;
          const prBody = `Automated batch PR by OpenLinear\n\n## Tasks\n${taskTitles}`;

          const [owner, repo] = proj.fullName.split('/');
          const compareUrl = `https://github.com/${owner}/${repo}/compare/${targetBranch}...${batch.batchBranch}`;

          if (batch.accessToken) {
            try {
              const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${batch.accessToken}`,
                  Accept: 'application/vnd.github.v3+json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  title: prTitle,
                  head: batch.batchBranch,
                  base: targetBranch,
                  body: prBody,
                }),
              });
              if (response.ok) {
                const pr = await response.json() as { html_url: string };
                batch.prUrl = pr.html_url;
              } else {
                batch.prUrl = compareUrl;
              }
            } catch {
              batch.prUrl = compareUrl;
            }
          } else {
            batch.prUrl = compareUrl;
          }
        }
      } catch (pushError) {
        console.error(`[Batch] Push/PR creation failed:`, pushError);
      }

      batch.status = 'completed';
      batch.completedAt = new Date();

      if (batch.prUrl) {
        const completedTaskIds = batch.tasks
          .filter(t => t.status === 'completed')
          .map(t => t.taskId);
        for (const taskId of completedTaskIds) {
          await updateTaskInDb(taskId, 'done', { prUrl: batch.prUrl });
        }
      }

      broadcastBatchEvent('batch:completed', batchId, { prUrl: batch.prUrl });
    }

    try {
      await cleanupBatch(batch.projectId, batchId);
    } catch (error) {
      console.error(`[Batch] Cleanup failed for batch ${batchId.slice(0, 8)}:`, error);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Batch finalization failed';
    console.error(`[Batch] Finalization failed for batch ${batchId.slice(0, 8)}:`, error);
    batch.status = 'failed';
    batch.completedAt = new Date();
    broadcastBatchEvent('batch:failed', batchId, { error: errorMsg });
  } finally {
    for (const task of batch.tasks) {
      cleanupDeltaBuffer(task.taskId);
      completingBatchTasks.delete(completionKey(batchId, task.taskId));
    }
    finalizingBatches.delete(batchId);
  }
}

export async function cancelBatch(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) {
    throw new Error(`Batch ${batchId} not found`);
  }

  batch.status = 'cancelled';

  for (const task of batch.tasks) {
    if (task.status === 'running' && task.sessionId && task.worktreePath && batch.userId) {
      try {
        const client = await getClientForUser(batch.userId, task.worktreePath);
        await client.session.abort({ path: { id: task.sessionId } });
      } catch (error) {
        console.error(`[Batch] Failed to abort session for task ${task.taskId.slice(0, 8)}:`, error);
      }
      task.status = 'cancelled';
      task.completedAt = new Date();
      cleanupDeltaBuffer(task.taskId);
      completingBatchTasks.delete(completionKey(batchId, task.taskId));
      sessionToBatch.delete(task.sessionId);
    } else if (task.status === 'queued') {
      task.status = 'cancelled';
      cleanupDeltaBuffer(task.taskId);
      completingBatchTasks.delete(completionKey(batchId, task.taskId));
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

  task.status = 'cancelled';
  task.completedAt = new Date();
  cleanupDeltaBuffer(taskId);
  completingBatchTasks.delete(completionKey(batchId, taskId));

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

  const nextIndex = batch.tasks.findIndex(t => t.status === 'queued');
  if (nextIndex === -1) {
    throw new Error('No queued tasks to approve');
  }

  launchTask(batch, nextIndex);
}
