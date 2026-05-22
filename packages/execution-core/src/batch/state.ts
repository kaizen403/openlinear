import type { BatchMode, BatchSettings, BatchState, BatchTask } from './types';

type TitleLookup = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

export interface CreateBatchStateInput {
  id: string;
  projectId: string;
  mode: BatchMode;
  taskIds: string[];
  titleByTaskId?: TitleLookup;
  settings: BatchSettings;
  mainRepoPath: string;
  accessToken: string | null;
  userId: string | null;
  createdAt?: Date;
}

export function createBatchBranchName(batchId: string): string {
  return `openlinear/batch-${batchId.slice(0, 8)}`;
}

export function createBatchTaskBranchName(taskId: string): string {
  return `openlinear/${taskId}`;
}

function lookupTitle(taskId: string, titleByTaskId: TitleLookup | undefined): string {
  if (!titleByTaskId) return 'Untitled task';
  if (titleByTaskId instanceof Map) return titleByTaskId.get(taskId) || 'Untitled task';
  return (titleByTaskId as Readonly<Record<string, string>>)[taskId] || 'Untitled task';
}

export function createBatchTasks(
  taskIds: string[],
  mode: BatchMode,
  titleByTaskId?: TitleLookup,
  batchBranch?: string,
): BatchTask[] {
  if (mode === 'combined' && !batchBranch) {
    throw new Error('batchBranch is required for combined batch tasks');
  }

  return taskIds.map(taskId => ({
    taskId,
    title: lookupTitle(taskId, titleByTaskId),
    status: 'queued',
    worktreePath: null,
    branch: mode === 'combined' ? batchBranch! : createBatchTaskBranchName(taskId),
    sessionId: null,
    error: null,
    startedAt: null,
    completedAt: null,
  }));
}

export function createBatchState(input: CreateBatchStateInput): BatchState {
  const batchBranch = createBatchBranchName(input.id);

  return {
    id: input.id,
    projectId: input.projectId,
    mode: input.mode,
    status: 'pending',
    tasks: createBatchTasks(input.taskIds, input.mode, input.titleByTaskId, batchBranch),
    settings: input.settings,
    mainRepoPath: input.mainRepoPath,
    batchBranch,
    prUrl: null,
    accessToken: input.accessToken,
    userId: input.userId,
    createdAt: input.createdAt ?? new Date(),
    completedAt: null,
  };
}
