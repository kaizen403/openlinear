import type {
  BatchProgressSummary,
  BatchState,
  BatchStatusResponse,
  BatchTaskStatus,
  BatchTaskSummary,
  CreateBatchResponse,
} from './types';

export function getBatchProgressSummary(batch: Pick<BatchState, 'tasks'>): BatchProgressSummary {
  const total = batch.tasks.length;
  const counts: Record<BatchTaskStatus, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };

  for (const task of batch.tasks) {
    counts[task.status] += 1;
  }

  const finished = counts.completed + counts.failed + counts.skipped + counts.cancelled;

  return {
    total,
    completed: counts.completed,
    failed: counts.failed,
    running: counts.running,
    queued: counts.queued,
    skipped: counts.skipped,
    cancelled: counts.cancelled,
    percentage: total > 0 ? Math.round((finished / total) * 100) : 0,
  };
}

export function toBatchTaskSummaries(batch: Pick<BatchState, 'tasks'>): BatchTaskSummary[] {
  return batch.tasks.map(task => ({
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    branch: task.branch,
  }));
}

export function toCreateBatchResponse(batch: BatchState): CreateBatchResponse {
  return {
    id: batch.id,
    status: batch.status,
    mode: batch.mode,
    tasks: toBatchTaskSummaries(batch),
    createdAt: batch.createdAt.toISOString(),
  };
}

export function toBatchStatusResponse(batch: BatchState): BatchStatusResponse {
  return {
    id: batch.id,
    status: batch.status,
    mode: batch.mode,
    tasks: batch.tasks.map(task => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      branch: task.branch,
      error: task.error,
      startedAt: task.startedAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
    })),
    prUrl: batch.prUrl,
    createdAt: batch.createdAt.toISOString(),
    completedAt: batch.completedAt?.toISOString() ?? null,
    progress: getBatchProgressSummary(batch),
  };
}
