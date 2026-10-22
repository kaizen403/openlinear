export type BatchMode = 'parallel' | 'queue' | 'combined';

export type BatchStatus = 'pending' | 'running' | 'merging' | 'completed' | 'failed' | 'cancelled';

export type BatchTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export type BatchPublicationPhase = 'prepared' | 'committed' | 'merging' | 'pushed' | 'pr_created' | 'completed' | 'failed' | 'cancelled';
export interface BatchPublication {
  phase: BatchPublicationPhase;
  branchUrl?: string;
  error?: string;
  receiptPath?: string;
}

export interface BatchTask {
  taskId: string;
  title: string;
  status: BatchTaskStatus;
  worktreePath: string | null;
  branch: string;
  sessionId: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelUnconfirmed?: boolean;
}

export interface BatchState {
  id: string;
  projectId: string;
  mode: BatchMode;
  status: BatchStatus;
  tasks: BatchTask[];
  settings: BatchSettings;
  mainRepoPath: string;
  batchBranch: string;
  prUrl: string | null;
  accessToken: string | null;
  userId: string | null;
  createdAt: Date;
  completedAt: Date | null;
  repository?: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string };
  taskProjectIds?: Record<string, string>;
  publication?: BatchPublication;
}

export interface BatchSettings {
  maxConcurrent: number;
  autoApprove: boolean;
  stopOnFailure: boolean;
  conflictBehavior: 'skip' | 'fail';
}

export interface CreateBatchParams {
  taskIds: string[];
  mode: BatchMode;
  projectId: string;
  userId: string | null;
  accessToken: string | null;
}

export type BatchEventType =
  | 'batch:created'
  | 'batch:started'
  | 'batch:progress'
  | 'batch:task:started'
  | 'batch:task:completed'
  | 'batch:task:failed'
  | 'batch:task:skipped'
  | 'batch:task:cancelled'
  | 'batch:merging'
  | 'batch:completed'
  | 'batch:failed'
  | 'batch:cancelled';

export interface BatchEvent {
  type: BatchEventType;
  batchId: string;
  taskId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface CreateBatchRequest {
  taskIds: string[];
  mode: BatchMode;
}

export interface CreateBatchResponse {
  id: string;
  status: BatchStatus;
  mode: BatchMode;
  tasks: BatchTaskSummary[];
  createdAt: string;
}

export interface BatchTaskSummary {
  taskId: string;
  title: string;
  status: BatchTaskStatus;
  branch: string;
}

export interface BatchProgressSummary {
  total: number;
  completed: number;
  failed: number;
  running: number;
  queued: number;
  skipped: number;
  cancelled: number;
  percentage: number;
}

export interface BatchStatusResponse {
  id: string;
  status: BatchStatus;
  mode: BatchMode;
  tasks: Array<{
    taskId: string;
    title: string;
    status: BatchTaskStatus;
    branch: string;
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
    cancelUnconfirmed?: boolean;
  }>;
  prUrl: string | null;
  createdAt: string;
  completedAt: string | null;
  progress: BatchProgressSummary;
  publication?: BatchPublication;
}

export type BatchExecutionProgressStatus =
  | 'cloning'
  | 'executing'
  | 'committing'
  | 'creating_pr'
  | 'done'
  | 'cancelled'
  | 'error';
