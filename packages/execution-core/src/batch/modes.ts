import type { BatchMode } from './types';

export function formatExecutionMode(mode: BatchMode): string {
  switch (mode) {
    case 'parallel':
      return 'Parallel Execution';
    case 'queue':
      return 'Queue Execution';
    case 'combined':
      return 'Combined Execution';
  }
}

export function batchActivityId(batchId: string): string {
  return `batch:${batchId}`;
}

export function batchIdFromActivityId(taskId: string): string | null {
  return taskId.startsWith('batch:') ? taskId.slice('batch:'.length) : null;
}

export function getInitialBatchLaunchIndexes(mode: BatchMode, taskCount: number): number[] {
  if (taskCount <= 0) return [];

  switch (mode) {
    case 'parallel':
      return Array.from({ length: taskCount }, (_, index) => index);
    case 'queue':
      return [0];
    case 'combined':
      return [];
  }
}
