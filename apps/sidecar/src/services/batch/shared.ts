import { prisma } from '@openlinear/db';
import { logger } from '../../lib/logger';
import { publishTaskEvent, publishUserEvent } from '../../events/publisher';
import {
  batchActivityId,
  batchIdFromActivityId,
  completionKey,
} from '@openlinear/execution-core';
import type {
  BatchEventType,
  BatchExecutionProgressStatus,
  BatchState,
} from '@openlinear/execution-core';
import { cleanupDeltaBuffer, flushDeltaBuffer } from '../delta-buffer';
import { broadcastProgress } from '../execution/state';
import {
  activeBatches,
  batchCredentials,
  batchHasInFlightWork,
  batchTaskLogOwners,
  batchTaskLogs,
  type BatchLogEntry,
  completingBatchTasks,
  preparingBatchTasks,
} from './registry';

// In-memory batch state lives in the Prisma-free registry (W03a); re-exported
// here so the batch engine keeps one import surface.
export {
  activeBatches,
  pendingBatchTasks,
  preparingBatchTasks,
  completingBatchTasks,
  completingCombinedBatches,
  finalizingBatches,
  cancellingBatches,
  memberCancellationPromises,
  batchHasPendingCancellation,
  batchHasInFlightWork,
  batchTaskLogs,
  batchTaskLogOwners,
  getBatchExecutionLogs,
  type BatchLogEntry,
} from './registry';

export const sessionToBatch = new Map<string, { batchId: string; taskIds: string[] }>();
export const cancellationPromises = new Map<string, Promise<void>>();
export const batchSubscriptions = new Map<string, { close: () => void }>();
export function closeBatchSubscription(activityId: string): void {
  batchSubscriptions.get(activityId)?.close();
  batchSubscriptions.delete(activityId);
}
export function batchRunningCount(batch: BatchState): number {
  return batch.tasks.filter((task) => task.status === 'running'
    || preparingBatchTasks.has(completionKey(batch.id, task.taskId))
    || completingBatchTasks.has(completionKey(batch.id, task.taskId))).length;
}

// T11 (H-12) — same ring-buffer bound as services/execution/state.ts's
// execution logs, applied to the batch task log arrays.
export const MAX_BATCH_LOG_ENTRIES = 2_000;

// T11 (H-07) — `activeBatches` was never deleted: every batch a user ever ran
// pinned its (decrypted) GitHub token in the sidecar's heap for the life of
// the process. Terminal batches are kept around for a short grace period so
// in-flight `GET /api/batches/:id` polls still see the final status, then
// released. `scheduledBatchCleanups` guards against scheduling more than one
// timer per batch.
const BATCH_RETENTION_MS = 10 * 60 * 1000;
const scheduledBatchCleanups = new Set<string>();
const TERMINAL_BATCH_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Schedules a terminal batch for removal from `activeBatches` after a grace
 * period. Safe to call multiple times for the same batch (e.g. once from the
 * event-driven completion path and once from a cleanup `finally` block) —
 * only the first call schedules a timer.
 */
export function scheduleBatchCleanup(batchId: string): void {
  const batch = activeBatches.get(batchId);
  if (!batch || !TERMINAL_BATCH_STATUSES.has(batch.status)) return;
  batch.accessToken = null;
  if (scheduledBatchCleanups.has(batchId)) return;
  scheduledBatchCleanups.add(batchId);

  const timer = setTimeout(() => {
    if (batchHasInFlightWork(batch)) {
      scheduledBatchCleanups.delete(batchId);
      scheduleBatchCleanup(batchId);
      return;
    }
    activeBatches.delete(batchId);
    batchCredentials.delete(batchId);
    for (const activityId of [...batch.tasks.map((task) => task.taskId), batchActivityId(batchId)]) {
      if (batchTaskLogOwners.get(activityId) === batchId) {
        batchTaskLogs.delete(activityId);
        batchTaskLogOwners.delete(activityId);
      }
    }
    scheduledBatchCleanups.delete(batchId);
  }, BATCH_RETENTION_MS);
  timer.unref();
}

export function broadcastBatchEvent(type: BatchEventType, batchId: string, data: Record<string, unknown> = {}): void {
  const batch = activeBatches.get(batchId);
  const payload = { batchId, ...data, timestamp: new Date().toISOString() };
  if (batch?.userId) {
    try {
      publishUserEvent(batch.userId, type, payload);
    } catch (error) {
      logger.error({ err: error, batchId }, `[Batch] Failed to broadcast ${type} for batch ${batchId.slice(0, 8)}`);
    }
  }
}

export function broadcastBatchProgress(
  taskIds: string[],
  status: BatchExecutionProgressStatus,
  message: string,
  data?: Record<string, unknown>,
): void {
  for (const taskId of taskIds) {
    const batchId = batchIdFromActivityId(taskId);
    if (batchId) {
      const batch = activeBatches.get(batchId);
      if (batch?.userId) {
        logger.info(`[Batch] ${batchId.slice(0, 8)} → ${status}: ${message}`);
        publishUserEvent(batch.userId, 'execution:progress', { taskId, status, message, ...data });
      }
      continue;
    }
    broadcastProgress(taskId, status, message, data);
  }
}

export function emitBatchLog(taskId: string, type: 'info' | 'agent' | 'tool' | 'error' | 'success', message: string, details?: string): void {
  const entry: BatchLogEntry = { timestamp: new Date().toISOString(), type, message, ...(details ? { details } : {}) };

  if (!batchTaskLogs.has(taskId)) {
    batchTaskLogs.set(taskId, []);
  }
  const logs = batchTaskLogs.get(taskId)!;
  logs.push(entry);
  // T11 (H-12) — ring-buffer rather than growing without bound. Also guards
  // against the case a task never reaches a completion path that clears its
  // log array (cancel, crash, or the C-01 misattribution this phase fixes).
  if (logs.length > MAX_BATCH_LOG_ENTRIES) {
    logs.splice(0, logs.length - MAX_BATCH_LOG_ENTRIES);
  }

  const batchId = batchIdFromActivityId(taskId);
  if (batchId) {
    const batch = activeBatches.get(batchId);
    if (batch?.userId) {
      publishUserEvent(batch.userId, 'execution:log', { taskId, entry });
    }
    return;
  }

  publishTaskEvent(taskId, 'execution:log', { taskId, entry });
}

export function emitBatchLogs(taskIds: string[], type: 'info' | 'agent' | 'tool' | 'error' | 'success', message: string, details?: string): void {
  for (const taskId of taskIds) {
    emitBatchLog(taskId, type, message, details);
  }
}

export async function updateTaskInDb(
  taskId: string,
  status: 'todo' | 'in_progress' | 'done' | 'cancelled',
  executionData?: {
    executionStartedAt?: Date;
    executionElapsedMs?: number;
    executionProgress?: number | null;
    prUrl?: string | null;
    outcome?: string | null;
  },
  expectedBatchId?: string,
): Promise<void> {
  try {
    const task = await prisma.task.update({
      where: { id: taskId, ...(expectedBatchId ? {
        batchId: expectedBatchId,
        ...(status === 'cancelled' ? {} : { status: { not: 'cancelled' as const } }),
      } : {}) },
      data: { status, ...executionData },
      include: { labels: { include: { label: true } } },
    });

    const flatTask = {
      ...task,
      labels: (task.labels as Array<{ label: { id: string; name: string; color: string } }>).map(tl => tl.label),
    };

    publishTaskEvent(taskId, 'task:updated', flatTask);
  } catch (err) {
    logger.error({ err, taskId }, `[Batch] Failed to update task ${taskId} in DB`);
    throw err;
  }
}

export async function persistBatchTaskLogs(taskId: string, expectedBatchId?: string): Promise<void> {
  if (expectedBatchId && batchTaskLogOwners.has(taskId) && batchTaskLogOwners.get(taskId) !== expectedBatchId) return;
  const logs = batchTaskLogs.get(taskId) || [];
  if (logs.length === 0) return;

  try {
    await prisma.task.update({
      where: { id: taskId, ...(expectedBatchId ? { batchId: expectedBatchId } : {}) },
      data: { executionLogs: JSON.parse(JSON.stringify(logs)) },
    });
    if (batchTaskLogs.get(taskId) === logs) batchTaskLogs.delete(taskId);
  } catch (err) {
    logger.error({ err, taskId }, `[Batch] Failed to persist logs for task ${taskId.slice(0, 8)}`);
  }
}

export function flushTaskBuffers(taskIds: string[]): void {
  for (const taskId of taskIds) {
    flushDeltaBuffer(taskId);
  }
}

export function cleanupTaskBuffers(taskIds: string[]): void {
  for (const taskId of taskIds) {
    cleanupDeltaBuffer(taskId);
  }
}
