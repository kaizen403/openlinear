import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BatchState, BatchPublicationPhase } from '@openlinear/execution-core';
import { buildReposPath, assertPathInsideReposDir } from '../repo-storage';
import { withRepoLock } from '../../workspace/local-worktree';
import { publishGithubPullRequest } from '../github-publication';

export function safeBatchError(batch: BatchState, error: unknown): string {
  let message = error instanceof Error ? error.message : 'Batch execution failed';
  if (batch.accessToken) {
    for (const secret of [batch.accessToken, encodeURIComponent(batch.accessToken), Buffer.from(batch.accessToken).toString('base64')]) {
      message = message.split(secret).join('[REDACTED]');
    }
  }
  return message.slice(0, 2048);
}

/** A small atomic receipt survives map eviction; it contains no credentials. */
export async function writeBatchReceipt(batch: BatchState, phase: BatchPublicationPhase, error?: string): Promise<void> {
  const receiptPath = buildReposPath(batch.projectId, '.receipts', `batch-${batch.id}.json`);
  return withRepoLock(receiptPath, async () => {
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
    assertPathInsideReposDir(receiptPath, { description: 'batch receipt', allowRoot: false });
    batch.publication = {
      ...batch.publication, phase: batch.status === 'cancelled' ? 'cancelled' : phase,
      receiptPath, ...(error ? { error: safeBatchError(batch, new Error(error)) } : {}),
    };
    const receipt = {
      schemaVersion: 1, batchId: batch.id, repositoryId: batch.projectId, userId: batch.userId,
      mode: batch.mode, status: batch.status, batchBranch: batch.batchBranch, prUrl: batch.prUrl,
      publication: batch.publication, createdAt: batch.createdAt, completedAt: batch.completedAt,
      tasks: batch.tasks.map((task) => ({
        taskId: task.taskId, projectId: batch.taskProjectIds?.[task.taskId], status: task.status,
        branch: task.branch, worktreePath: task.worktreePath, sessionId: task.sessionId,
        cancelUnconfirmed: task.cancelUnconfirmed ?? false,
        error: task.error ? safeBatchError(batch, new Error(task.error)) : null,
        startedAt: task.startedAt, completedAt: task.completedAt,
      })),
    };
    const temporary = `${receiptPath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(receipt, null, 2)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, receiptPath);
      // Persist the rename as well as the file contents on supported filesystems.
      if (process.platform !== 'win32') {
        const directory = await open(dirname(receiptPath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await rm(temporary, { force: true }); }
  });
}

/** A compare link is retained evidence, never a substitute for an opened PR. */
export async function publishBatchPullRequest(
  batch: BatchState,
  repository: { fullName: string; defaultBranch: string },
  assertActive: () => void,
): Promise<string> {
  return publishGithubPullRequest({
    fullName: repository.fullName, defaultBranch: repository.defaultBranch,
    branchName: batch.batchBranch, accessToken: batch.accessToken, assertActive,
    title: `${batch.mode === 'combined' ? 'Combined' : batch.mode === 'parallel' ? 'Parallel' : 'Queue'} Execution: ${batch.tasks.filter((task) => task.status === 'completed').length} issues`,
    body: `Automated batch by OpenLinear\n\n${batch.tasks.filter((task) => task.status === 'completed').map((task) => '- ' + task.title).join('\n')}`,
  });
}
