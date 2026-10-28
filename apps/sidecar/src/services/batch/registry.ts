import { batchIdFromActivityId, completionKey } from '@openlinear/execution-core';
import type { BatchState } from '@openlinear/execution-core';
import type { PrincipalCredential } from '../../auth/principal';
import { registerTaskOwnerResolver } from '../../events/publisher';

/**
 * In-memory batch state shared with the single-task path (admission checks,
 * log lookups). Deliberately free of Prisma and of the batch engine so that
 * the API-only single-task path never loads either (W03a). `shared.ts`
 * re-exports everything here for the batch engine.
 */
export const activeBatches = new Map<string, BatchState>();
export const pendingBatchTasks = new Set<string>();
export const preparingBatchTasks = new Set<string>();
export const completingBatchTasks = new Set<string>();
export const completingCombinedBatches = new Set<string>();
export const finalizingBatches = new Set<string>();
export const cancellingBatches = new Set<string>();
export const memberCancellationPromises = new Map<string, Promise<void>>();
/**
 * The credential that created each batch (memory only). Batch members are
 * re-authorized through the control plane before launch and publication; an
 * expired or revoked credential stops the batch (fail closed).
 */
export const batchCredentials = new Map<string, PrincipalCredential>();

export function batchHasPendingCancellation(batch: BatchState): boolean {
  return cancellingBatches.has(batch.id)
    || batch.tasks.some((task) => memberCancellationPromises.has(completionKey(batch.id, task.taskId)));
}

export function batchHasInFlightWork(batch: BatchState): boolean {
  return batch.tasks.some((task) => task.cancelUnconfirmed)
    || (batch.status === 'cancelled' && Boolean(batch.publication?.error))
    || batchHasPendingCancellation(batch) || completingCombinedBatches.has(batch.id) || finalizingBatches.has(batch.id)
    || batch.tasks.some((task) => preparingBatchTasks.has(completionKey(batch.id, task.taskId))
      || completingBatchTasks.has(completionKey(batch.id, task.taskId)));
}

export function taskHasActiveBatch(taskId: string, exceptBatchId?: string): boolean {
  return [...activeBatches.values()].some((batch) => batch.id !== exceptBatchId
    && (!['completed', 'failed', 'cancelled'].includes(batch.status) || batchHasInFlightWork(batch))
    && batch.tasks.some((task) => task.taskId === taskId));
}

export interface BatchLogEntry {
  timestamp: string;
  type: 'info' | 'agent' | 'tool' | 'error' | 'success';
  message: string;
  details?: string;
}
export const batchTaskLogs = new Map<string, BatchLogEntry[]>();
export const batchTaskLogOwners = new Map<string, string>();

export function getBatchExecutionLogs(taskId: string): BatchLogEntry[] {
  return batchTaskLogs.get(taskId) || [];
}

/** The user who started the batch running `taskIdOrActivityId`, if any. */
export function batchOwnerOf(taskIdOrActivityId: string): string | null {
  const batchId = batchIdFromActivityId(taskIdOrActivityId);
  if (batchId) return activeBatches.get(batchId)?.userId ?? null;
  for (const batch of activeBatches.values()) {
    if (batch.tasks.some((task) => task.taskId === taskIdOrActivityId)) return batch.userId ?? null;
  }
  return null;
}

registerTaskOwnerResolver(batchOwnerOf);
