import { prisma, type Prisma } from '@openlinear/db';
import { HttpError } from '../../lib/errors';
import { authorizeTaskAccess } from '../../auth/task-access';
import type { PrincipalCredential } from '../../auth/principal';
import type { BatchMode, BatchState } from '@openlinear/execution-core';
import { requireLegacyRunner } from '../../engine/resolve-agent';
import { activeExecutions, pendingExecutions } from '../execution/state';
import { batchCredentials, pendingBatchTasks, taskHasActiveBatch } from './registry';

export { taskHasActiveBatch } from './registry';

const taskSelection = {
  id: true, title: true, description: true, model: true, agent: true,
  archived: true, status: true, batchId: true, projectId: true, teamId: true, creatorId: true,
  project: { select: {
    id: true, localPath: true, defaultAgent: true,
    repository: { select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true } },
  } },
} satisfies Prisma.TaskSelect;

export type BatchMemberSnapshot = Prisma.TaskGetPayload<{ select: typeof taskSelection }>;
export type BatchRepositorySnapshot = NonNullable<NonNullable<BatchMemberSnapshot['project']>['repository']>;

export function validateBatchRequest(taskIds: string[], mode: BatchMode): string[] {
  if (!['parallel', 'queue', 'combined'].includes(mode) || !Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > 20) {
    throw new HttpError(400, 'INVALID_BATCH', 'Select between 1 and 20 tasks and a supported execution mode');
  }
  const ids = taskIds.map((id) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || id.includes('\0')) {
      throw new HttpError(400, 'INVALID_BATCH', 'Batch task IDs must be nonblank strings');
    }
    return id.trim();
  });
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'DUPLICATE_BATCH_TASK', 'A batch cannot contain the same task more than once');
  return ids;
}

export function reserveBatchTasks(taskIds: string[]): () => void {
  if (taskIds.some((id) => pendingBatchTasks.has(id) || pendingExecutions.has(id) || activeExecutions.has(id) || taskHasActiveBatch(id))) {
    throw new HttpError(409, 'TASK_ALREADY_RUNNING', 'A selected task is already executing or reserved');
  }
  for (const id of taskIds) pendingBatchTasks.add(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of taskIds) pendingBatchTasks.delete(id);
  };
}

function repositoryMatches(actual: BatchRepositorySnapshot, expected: BatchRepositorySnapshot): boolean {
  return actual.id === expected.id && actual.cloneUrl === expected.cloneUrl
    && actual.defaultBranch === expected.defaultBranch && actual.fullName === expected.fullName;
}

/** Read and authorize every member before any filesystem/provider mutation. */
export async function validateBatchSelection(input: {
  taskIds: string[];
  userId: string | null;
  /** The request credential; authorization is decided by the control plane. */
  credential?: PrincipalCredential | null;
  expected?: BatchState;
}): Promise<{ tasks: BatchMemberSnapshot[]; repository: BatchRepositorySnapshot }> {
  if (!input.userId) throw new HttpError(401, 'AUTH_REQUIRED', 'An authenticated user is required for batch execution');
  const credential = input.credential ?? (input.expected ? batchCredentials.get(input.expected.id) : undefined) ?? null;
  const authorized = await Promise.all(input.taskIds.map((id) => authorizeTaskAccess(credential, id, 'write')));
  const authorityById = new Map(authorized.map((task) => [task.id, task]));
  const records = await prisma.task.findMany({ where: { id: { in: input.taskIds } }, select: taskSelection });
  const byId = new Map(records.map((record) => [record.id, record]));
  if (byId.size !== input.taskIds.length || input.taskIds.some((id) => !byId.has(id))) {
    throw new HttpError(404, 'TASK_NOT_FOUND', 'One or more selected tasks no longer exist');
  }
  const tasks = input.taskIds.map((id) => byId.get(id)!);
  let repository: BatchRepositorySnapshot | undefined;
  for (const task of tasks) {
    const authority = authorityById.get(task.id);
    if (!authority || task.projectId !== authority.projectId || task.teamId !== authority.teamId || task.creatorId !== authority.creatorId) {
      throw new HttpError(409, 'BATCH_SELECTION_CHANGED', 'Task access scope changed while admission was checked');
    }
    if (task.archived) throw new HttpError(409, 'TASK_ARCHIVED', 'Archived tasks cannot execute');
    if (pendingExecutions.has(task.id) || activeExecutions.has(task.id) || taskHasActiveBatch(task.id, input.expected?.id)
      || (task.status === 'in_progress' && (!input.expected || task.batchId !== input.expected.id))) {
      throw new HttpError(409, 'TASK_ALREADY_RUNNING', 'A selected task is already executing');
    }
    requireLegacyRunner({ taskAgent: task.agent, projectDefaultAgent: task.project?.defaultAgent });
    if (task.project?.localPath) throw new HttpError(400, 'LOCAL_BATCH_NOT_SUPPORTED', 'Local-path projects cannot run in a remote batch');
    if (!task.project?.repository) throw new HttpError(400, 'BATCH_REPOSITORY_REQUIRED', 'Every selected task must have an explicit remote repository');
    if (repository && !repositoryMatches(task.project.repository, repository)) {
      throw new HttpError(400, 'BATCH_REPOSITORY_MISMATCH', 'All selected tasks must use the same remote repository and base branch');
    }
    repository = task.project.repository;
    if (input.expected && (task.batchId !== input.expected.id
      || task.projectId !== input.expected.taskProjectIds?.[task.id]
      || !input.expected.repository || !repositoryMatches(repository, input.expected.repository))) {
      throw new HttpError(409, 'BATCH_SELECTION_CHANGED', 'Task or repository settings changed after this batch was admitted');
    }
  }
  return { tasks, repository: repository! };
}
