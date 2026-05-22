import type { BatchState, BatchTask } from './types';

export function isBatchTaskTerminal(task: BatchTask): boolean {
  return task.status === 'completed'
    || task.status === 'failed'
    || task.status === 'skipped'
    || task.status === 'cancelled';
}

export function completionKey(batchId: string, taskId: string): string {
  return `${batchId}:${taskId}`;
}

export function getCompletedBatchTaskIds(batch: Pick<BatchState, 'tasks'>): string[] {
  return batch.tasks
    .filter(task => task.status === 'completed')
    .map(task => task.taskId);
}

export function hasQueuedOrRunningBatchTasks(batch: Pick<BatchState, 'tasks'>): boolean {
  return batch.tasks.some(task => task.status === 'queued' || task.status === 'running');
}

export function findNextQueuedBatchTaskIndex(batch: Pick<BatchState, 'tasks'>): number {
  return batch.tasks.findIndex(task => task.status === 'queued');
}
