import { prisma } from '@openlinear/db';
import { broadcastToTask, broadcastToTaskById, broadcastToUser } from '@openlinear/api/sse';
import { logger } from '@openlinear/api/logger';
import {
  batchActivityId,
  batchIdFromActivityId,
  getCompletedBatchTaskIds,
} from '@openlinear/execution-core';
import type {
  BatchEventType,
  BatchExecutionProgressStatus,
  BatchState,
} from '@openlinear/execution-core';
import { cleanupDeltaBuffer, flushDeltaBuffer } from '../delta-buffer';
import { broadcastProgress } from '../execution/state';

export const activeBatches = new Map<string, BatchState>();
export const sessionToBatch = new Map<string, { batchId: string; taskIds: string[] }>();
export const completingBatchTasks = new Set<string>();
export const completingCombinedBatches = new Set<string>();
export const finalizingBatches = new Set<string>();

export interface BatchLogEntry {
  timestamp: string;
  type: 'info' | 'agent' | 'tool' | 'error' | 'success';
  message: string;
  details?: string;
}
export const batchTaskLogs = new Map<string, BatchLogEntry[]>();

export function broadcastBatchEvent(type: BatchEventType, batchId: string, data: Record<string, unknown> = {}): void {
  const batch = activeBatches.get(batchId);
  const payload = { batchId, ...data, timestamp: new Date().toISOString() };
  if (batch?.userId) {
    try {
      broadcastToUser(batch.userId, type, payload);
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
        broadcastToUser(batch.userId, 'execution:progress', { taskId, status, message, ...data });
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
  batchTaskLogs.get(taskId)!.push(entry);

  const batchId = batchIdFromActivityId(taskId);
  if (batchId) {
    const batch = activeBatches.get(batchId);
    if (batch?.userId) {
      broadcastToUser(batch.userId, 'execution:log', { taskId, entry });
    }
    return;
  }

  broadcastToTaskById(taskId, 'execution:log', { taskId, entry }).catch((error: unknown) => {
    logger.error({ err: error, taskId }, `[Batch] Failed to broadcast log for task ${taskId.slice(0, 8)}`);
  });
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
    logger.error({ err, taskId }, `[Batch] Failed to update task ${taskId} in DB`);
  }
}

export async function persistBatchTaskLogs(taskId: string): Promise<void> {
  const logs = batchTaskLogs.get(taskId) || [];
  if (logs.length === 0) return;

  try {
    await prisma.task.update({
      where: { id: taskId },
      data: { executionLogs: JSON.parse(JSON.stringify(logs)) },
    });
  } catch (err) {
    logger.error({ err, taskId }, `[Batch] Failed to persist logs for task ${taskId.slice(0, 8)}`);
  }
  batchTaskLogs.delete(taskId);
}

export function getBatchExecutionLogs(taskId: string): BatchLogEntry[] {
  return batchTaskLogs.get(taskId) || [];
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
