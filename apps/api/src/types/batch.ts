// Execution modes
export type BatchMode = 'parallel' | 'queue';

// Overall batch lifecycle status
export type BatchStatus = 'pending' | 'running' | 'merging' | 'completed' | 'failed' | 'cancelled';

// Individual task status within a batch
export type BatchTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

// A single task within a batch
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
}

// Full batch state (in-memory only, not persisted)
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
  createdAt: Date;
  completedAt: Date | null;
}

// Settings for batch execution (mirrors DB settings)
export interface BatchSettings {
  maxConcurrent: number;
  autoApprove: boolean;
  stopOnFailure: boolean;
  conflictBehavior: 'skip' | 'fail';
}

// Parameters for creating a batch
export interface CreateBatchParams {
  taskIds: string[];
  mode: BatchMode;
  projectId: string;
  userId: string | null;
  accessToken: string | null;
}

// SSE Event types for batch progress
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

// SSE Event payload
export interface BatchEvent {
  type: BatchEventType;
  batchId: string;
  taskId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// API request/response types
export interface CreateBatchRequest {
  taskIds: string[];
  mode: BatchMode;
}

export interface CreateBatchResponse {
  id: string;
  status: BatchStatus;
  mode: BatchMode;
  tasks: Array<{
    taskId: string;
    title: string;
    status: BatchTaskStatus;
    branch: string;
  }>;
  createdAt: string;
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
  }>;
  prUrl: string | null;
  createdAt: string;
  completedAt: string | null;
  progress: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    queued: number;
    skipped: number;
    cancelled: number;
    percentage: number;
  };
}
