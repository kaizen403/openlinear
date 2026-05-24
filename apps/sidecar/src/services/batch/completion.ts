import { prisma } from '@openlinear/db';
import {
  batchActivityId,
  completionKey,
  formatExecutionMode,
  getCompletedBatchTaskIds,
  hasQueuedOrRunningBatchTasks,
  findNextQueuedBatchTaskIndex,
  isBatchTaskTerminal,
} from '@openlinear/execution-core';
import type { BatchState } from '@openlinear/execution-core';
import { cleanupDeltaBuffer } from '../delta-buffer';
import { getGitIdentityEnv } from '../git-identity';
import { execFileAsync } from '../execution/exec';
import { hasCommittableChanges, stageCommittableChanges } from '../execution/git';
import { cleanupBatch, mergeBranch, createBatchBranch, pushBranch } from '../worktree';
import {
  activeBatches,
  sessionToBatch,
  completingBatchTasks,
  completingCombinedBatches,
  finalizingBatches,
  batchTaskLogs,
  broadcastBatchEvent,
  broadcastBatchProgress,
  emitBatchLog,
  updateTaskInDb,
} from './shared';

export async function handleTaskComplete(
  batchId: string,
  taskId: string,
  success: boolean,
  error?: string
): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) return;

  const task = batch.tasks.find(t => t.taskId === taskId);
  if (!task || isBatchTaskTerminal(task)) return;

  const key = completionKey(batchId, taskId);
  if (completingBatchTasks.has(key)) return;
  completingBatchTasks.add(key);

  const elapsedMs = task.startedAt ? Date.now() - task.startedAt.getTime() : 0;
  task.completedAt = new Date();

  try {
    let completionSucceeded = success;
    let completionError = error;

    if (completionSucceeded) {
      broadcastBatchProgress([taskId], 'committing', 'Committing batch changes...');
      if (task.worktreePath) {
        try {
          const env = { ...process.env, ...getGitIdentityEnv() };
          if (await hasCommittableChanges(task.worktreePath)) {
            const staged = await stageCommittableChanges(task.worktreePath);
            if (!staged) {
              completionSucceeded = false;
              completionError = 'Agent finished without committable code changes';
              console.log(`[Batch] No committable changes for task ${task.taskId.slice(0, 8)}`);
            } else {
              const commitMsg = `feat: ${task.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 50)}`;
              await execFileAsync('git', ['-C', task.worktreePath, 'commit', '-m', commitMsg], { env });
              console.log(`[Batch] Committed changes for task ${task.taskId.slice(0, 8)}`);
            }
          } else {
            completionSucceeded = false;
            completionError = 'Agent finished without making code changes';
            console.log(`[Batch] No changes for task ${task.taskId.slice(0, 8)}`);
          }
        } catch (commitErr) {
          completionSucceeded = false;
          completionError = commitErr instanceof Error ? commitErr.message : 'Failed to commit task changes';
          console.error(`[Batch] Failed to commit for task ${task.taskId.slice(0, 8)}:`, commitErr);
        }
      } else {
        completionSucceeded = false;
        completionError = 'Task completed without a worktree';
      }
    }

    if (completionSucceeded) {
      task.status = 'completed';
      broadcastBatchEvent('batch:task:completed', batchId, { taskId });
      emitBatchLog(taskId, 'success', 'Batch task completed');

      await updateTaskInDb(taskId, 'done', {
        executionElapsedMs: elapsedMs,
        executionProgress: 100,
        outcome: 'Completed via batch execution',
      });
      broadcastBatchProgress([taskId], 'done', 'Batch task complete; waiting for batch pull request');
    } else {
      task.status = 'failed';
      task.error = completionError || 'Unknown error';
      broadcastBatchEvent('batch:task:failed', batchId, { taskId, error: task.error });
      emitBatchLog(taskId, 'error', `Batch task failed: ${task.error}`);

      await updateTaskInDb(taskId, 'todo', {
        executionElapsedMs: elapsedMs,
        outcome: `Failed: ${task.error}`,
      });
      broadcastBatchProgress([taskId], 'error', task.error);
    }

    const logs = batchTaskLogs.get(taskId) || [];
    if (logs.length > 0) {
      try {
        await prisma.task.update({
          where: { id: taskId },
          data: { executionLogs: JSON.parse(JSON.stringify(logs)) },
        });
      } catch (err) {
        console.error(`[Batch] Failed to persist logs for task ${taskId.slice(0, 8)}:`, err);
      }
      batchTaskLogs.delete(taskId);
    }

    if (task.sessionId) {
      sessionToBatch.delete(task.sessionId);
    }

    if (!completionSucceeded && batch.settings.stopOnFailure) {
      const { cancelBatch } = await import('./orchestrator');
      await cancelBatch(batchId);
      return;
    }

    await advanceQueue(batch);
  } finally {
    completingBatchTasks.delete(key);
  }
}

export async function handleCombinedBatchComplete(
  batchId: string,
  success: boolean,
  error?: string
): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch || batch.mode !== 'combined') return;
  if (batch.status === 'completed' || batch.status === 'failed' || batch.status === 'cancelled') return;
  if (completingCombinedBatches.has(batchId)) return;
  completingCombinedBatches.add(batchId);

  const completedAt = new Date();
  const startedAt = batch.tasks.find(task => task.startedAt)?.startedAt ?? completedAt;
  const elapsedMs = completedAt.getTime() - startedAt.getTime();
  let completionSucceeded = success;
  let completionError = error;
  const sessionId = batch.tasks.find(task => task.sessionId)?.sessionId ?? null;
  const activityId = batchActivityId(batch.id);

  try {
    if (completionSucceeded) {
      broadcastBatchProgress(
        [activityId],
        'committing',
        'Committing Combined Execution changes...',
      );
      const worktreePath = batch.tasks.find(task => task.worktreePath)?.worktreePath;
      if (!worktreePath) {
        completionSucceeded = false;
        completionError = 'Combined batch completed without a worktree';
      } else {
        try {
          const env = { ...process.env, ...getGitIdentityEnv() };
          if (await hasCommittableChanges(worktreePath)) {
            const staged = await stageCommittableChanges(worktreePath);
            if (!staged) {
              completionSucceeded = false;
              completionError = 'Agent finished without committable code changes';
            } else {
              const commitMsg = `feat: combined batch ${batch.id.slice(0, 8)}`;
              await execFileAsync('git', ['-C', worktreePath, 'commit', '-m', commitMsg], { env });
              console.log(`[Batch] Committed combined changes for batch ${batch.id.slice(0, 8)}`);
            }
          } else {
            completionSucceeded = false;
            completionError = 'Agent finished without making code changes';
          }
        } catch (commitErr) {
          completionSucceeded = false;
          completionError = commitErr instanceof Error ? commitErr.message : 'Failed to commit combined batch changes';
          console.error(`[Batch] Failed to commit combined batch ${batch.id.slice(0, 8)}:`, commitErr);
        }
      }
    }

    if (completionSucceeded) {
      emitBatchLog(activityId, 'success', 'Combined Execution completed');
      for (const task of batch.tasks) {
        task.status = 'completed';
        task.completedAt = completedAt;
        broadcastBatchEvent('batch:task:completed', batchId, { taskId: task.taskId });
        await updateTaskInDb(task.taskId, 'done', {
          executionElapsedMs: elapsedMs,
          executionProgress: 100,
          outcome: 'Completed via Combined Execution',
        });
      }

      if (sessionId) {
        sessionToBatch.delete(sessionId);
      }

      await finalizeCombinedBatch(batchId);
      return;
    }

    batch.status = 'failed';
    batch.completedAt = completedAt;
    const failure = completionError || 'Unknown error';
    emitBatchLog(activityId, 'error', `Combined Execution failed: ${failure}`);
    broadcastBatchProgress([activityId], 'error', failure);

    for (const task of batch.tasks) {
      task.status = 'failed';
      task.error = failure;
      task.completedAt = completedAt;
      broadcastBatchEvent('batch:task:failed', batchId, { taskId: task.taskId, error: failure });
      await updateTaskInDb(task.taskId, 'todo', {
        executionElapsedMs: elapsedMs,
        outcome: `Failed: ${failure}`,
      });
    }

    if (sessionId) {
      sessionToBatch.delete(sessionId);
    }
    broadcastBatchEvent('batch:failed', batchId, { error: failure });

    try {
      await cleanupBatch(batch.projectId, batchId);
    } catch (cleanupError) {
      console.error(`[Batch] Cleanup failed for combined batch ${batchId.slice(0, 8)}:`, cleanupError);
    }
  } finally {
    cleanupDeltaBuffer(activityId);
    batchTaskLogs.delete(activityId);
    for (const task of batch.tasks) {
      cleanupDeltaBuffer(task.taskId);
      completingBatchTasks.delete(completionKey(batchId, task.taskId));
    }
    completingCombinedBatches.delete(batchId);
  }
}

export async function advanceQueue(batch: BatchState): Promise<void> {
  const hasRemaining = hasQueuedOrRunningBatchTasks(batch);
  if (!hasRemaining) {
    await finalizeBatch(batch.id);
    return;
  }

  const nextIndex = findNextQueuedBatchTaskIndex(batch);
  if (nextIndex === -1) return;

  if (batch.mode === 'parallel') {
    const { launchTask } = await import('./orchestrator');
    launchTask(batch, nextIndex);
  } else if (batch.settings.autoApprove) {
    const { launchTask } = await import('./orchestrator');
    launchTask(batch, nextIndex);
  }
}

export async function finalizeBatch(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) return;

  if (
    finalizingBatches.has(batchId)
    || batch.status === 'merging'
    || batch.status === 'completed'
    || batch.status === 'failed'
    || batch.status === 'cancelled'
  ) {
    return;
  }

  finalizingBatches.add(batchId);

  try {
    batch.status = 'merging';
    broadcastBatchEvent('batch:merging', batchId);

    const project = await prisma.repository.findUnique({ where: { id: batch.projectId } });
    const targetBranch = project?.defaultBranch || 'main';

    await createBatchBranch(batch.projectId, batch.batchBranch, targetBranch);

    let hasFatalFailure = false;

    for (const task of batch.tasks) {
      if (task.status !== 'completed') continue;

      try {
        const merged = await mergeBranch(batch.projectId, task.branch, batch.batchBranch);

        if (!merged) {
          if (batch.settings.conflictBehavior === 'fail') {
            task.status = 'failed';
            task.error = 'Merge conflict';
            hasFatalFailure = true;
            broadcastBatchEvent('batch:task:failed', batchId, { taskId: task.taskId, error: 'Merge conflict' });
            break;
          } else {
            task.status = 'skipped';
            task.error = 'Merge conflict (skipped)';
            broadcastBatchEvent('batch:task:skipped', batchId, { taskId: task.taskId });
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Merge error';
        console.error(`[Batch] Merge failed for task ${task.taskId.slice(0, 8)}:`, errorMsg);

        if (batch.settings.conflictBehavior === 'fail') {
          task.status = 'failed';
          task.error = errorMsg;
          hasFatalFailure = true;
          broadcastBatchEvent('batch:task:failed', batchId, { taskId: task.taskId, error: errorMsg });
          break;
        } else {
          task.status = 'skipped';
          task.error = errorMsg;
          broadcastBatchEvent('batch:task:skipped', batchId, { taskId: task.taskId });
        }
      }
    }

    if (hasFatalFailure) {
      batch.status = 'failed';
      batch.completedAt = new Date();
      broadcastBatchEvent('batch:failed', batchId);
    } else {
      try {
        const completedTaskIds = getCompletedBatchTaskIds(batch);
        broadcastBatchProgress(completedTaskIds, 'creating_pr', `Creating ${formatExecutionMode(batch.mode)} pull request...`);

        const proj = await prisma.repository.findUnique({ where: { id: batch.projectId } });
        if (proj) {
          await pushBranch(batch.projectId, batch.batchBranch, proj.cloneUrl, batch.accessToken);

          const completedTasks = batch.tasks.filter(t => t.status === 'completed');
          const taskTitles = completedTasks.map(t => `- ${t.title}`).join('\n');
          const prTitle = `${formatExecutionMode(batch.mode)}: ${completedTasks.length} issues`;
          const prBody = `Automated ${formatExecutionMode(batch.mode)} PR by OpenLinear\n\n## Issues\n${taskTitles}`;

          const [owner, repo] = proj.fullName.split('/');
          const compareUrl = `https://github.com/${owner}/${repo}/compare/${targetBranch}...${batch.batchBranch}`;

          if (batch.accessToken) {
            try {
              const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${batch.accessToken}`,
                  Accept: 'application/vnd.github.v3+json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  title: prTitle,
                  head: batch.batchBranch,
                  base: targetBranch,
                  body: prBody,
                }),
              });
              if (response.ok) {
                const pr = await response.json() as { html_url: string };
                batch.prUrl = pr.html_url;
              } else {
                batch.prUrl = compareUrl;
              }
            } catch {
              batch.prUrl = compareUrl;
            }
          } else {
            batch.prUrl = compareUrl;
          }
        }
      } catch (pushError) {
        console.error(`[Batch] Push/PR creation failed:`, pushError);
      }

      batch.status = 'completed';
      batch.completedAt = new Date();

      if (batch.prUrl) {
        const completedTaskIds = getCompletedBatchTaskIds(batch);
        for (const taskId of completedTaskIds) {
          await updateTaskInDb(taskId, 'done', { prUrl: batch.prUrl });
        }
        broadcastBatchProgress(completedTaskIds, 'done', `${formatExecutionMode(batch.mode)} pull request ready`, { prUrl: batch.prUrl });
      } else {
        const completedTaskIds = getCompletedBatchTaskIds(batch);
        broadcastBatchProgress(
          completedTaskIds,
          'done',
          `${formatExecutionMode(batch.mode)} completed`,
        );
      }

      broadcastBatchEvent('batch:completed', batchId, { prUrl: batch.prUrl });
    }

    try {
      await cleanupBatch(batch.projectId, batchId);
    } catch (error) {
      console.error(`[Batch] Cleanup failed for batch ${batchId.slice(0, 8)}:`, error);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Batch finalization failed';
    console.error(`[Batch] Finalization failed for batch ${batchId.slice(0, 8)}:`, error);
    batch.status = 'failed';
    batch.completedAt = new Date();
    broadcastBatchEvent('batch:failed', batchId, { error: errorMsg });
  } finally {
    for (const task of batch.tasks) {
      cleanupDeltaBuffer(task.taskId);
      completingBatchTasks.delete(completionKey(batchId, task.taskId));
    }
    finalizingBatches.delete(batchId);
  }
}

async function finalizeCombinedBatch(batchId: string): Promise<void> {
  const batch = activeBatches.get(batchId);
  if (!batch) return;

  if (
    finalizingBatches.has(batchId)
    || batch.status === 'merging'
    || batch.status === 'completed'
    || batch.status === 'failed'
    || batch.status === 'cancelled'
  ) {
    return;
  }

  finalizingBatches.add(batchId);

  try {
    batch.status = 'merging';
    broadcastBatchEvent('batch:merging', batchId);

    const proj = await prisma.repository.findUnique({ where: { id: batch.projectId } });
    const targetBranch = proj?.defaultBranch || 'main';

    if (proj) {
      try {
        const activityId = batchActivityId(batch.id);
        broadcastBatchProgress([activityId], 'creating_pr', 'Creating Combined Execution pull request...');

        await pushBranch(batch.projectId, batch.batchBranch, proj.cloneUrl, batch.accessToken);

        const completedTasks = batch.tasks.filter(t => t.status === 'completed');
        const taskTitles = completedTasks.map(t => `- ${t.title}`).join('\n');
        const prTitle = `Combined Execution: ${completedTasks.length} issues`;
        const prBody = `Automated Combined Execution PR by OpenLinear\n\n## Issues\n${taskTitles}`;

        const [owner, repo] = proj.fullName.split('/');
        const compareUrl = `https://github.com/${owner}/${repo}/compare/${targetBranch}...${batch.batchBranch}`;

        if (batch.accessToken) {
          try {
            const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${batch.accessToken}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                title: prTitle,
                head: batch.batchBranch,
                base: targetBranch,
                body: prBody,
              }),
            });
            if (response.ok) {
              const pr = await response.json() as { html_url: string };
              batch.prUrl = pr.html_url;
            } else {
              batch.prUrl = compareUrl;
            }
          } catch {
            batch.prUrl = compareUrl;
          }
        } else {
          batch.prUrl = compareUrl;
        }
      } catch (pushError) {
        console.error(`[Batch] Combined push/PR creation failed:`, pushError);
      }
    }

    batch.status = 'completed';
    batch.completedAt = new Date();
    const activityId = batchActivityId(batch.id);

    if (batch.prUrl) {
      const completedTaskIds = getCompletedBatchTaskIds(batch);
      for (const taskId of completedTaskIds) {
        await updateTaskInDb(taskId, 'done', { prUrl: batch.prUrl });
      }
      broadcastBatchProgress([activityId], 'done', 'Combined Execution pull request ready', { prUrl: batch.prUrl });
    } else {
      broadcastBatchProgress(
        [activityId],
        'done',
        'Combined Execution completed',
      );
    }

    broadcastBatchEvent('batch:completed', batchId, { prUrl: batch.prUrl });

    try {
      await cleanupBatch(batch.projectId, batchId);
    } catch (error) {
      console.error(`[Batch] Cleanup failed for combined batch ${batchId.slice(0, 8)}:`, error);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Combined batch finalization failed';
    console.error(`[Batch] Combined finalization failed for batch ${batchId.slice(0, 8)}:`, error);
    batch.status = 'failed';
    batch.completedAt = new Date();
    broadcastBatchProgress([batchActivityId(batch.id)], 'error', errorMsg);
    broadcastBatchEvent('batch:failed', batchId, { error: errorMsg });
  } finally {
    cleanupDeltaBuffer(batchActivityId(batch.id));
    batchTaskLogs.delete(batchActivityId(batch.id));
    for (const task of batch.tasks) {
      cleanupDeltaBuffer(task.taskId);
      completingBatchTasks.delete(completionKey(batchId, task.taskId));
    }
    finalizingBatches.delete(batchId);
  }
}
