import { existsSync, mkdirSync, rmdirSync } from 'fs';
import { logger } from '@openlinear/api/logger';
import { getGitIdentityEnv } from './git-identity';
import { assertPathInsideReposDir, buildReposPath } from './repo-storage';
import {
  assertSafeCloneUrl,
  assertSafeRefName,
  execGit,
  execGitWithCredentials,
} from './git-credentials';
import { withRepoLock } from '../workspace/local-worktree';
import { createBatchTaskBranchName } from '@openlinear/execution-core';

export async function ensureMainRepo(
  projectId: string,
  cloneUrl: string,
  accessToken: string | null
): Promise<string> {
  assertSafeCloneUrl(cloneUrl, 'clone URL');

  const projectDir = buildReposPath(projectId);
  const mainRepoPath = buildReposPath(projectId, '.main');

  return withRepoLock(mainRepoPath, async () => {
    try {
      if (existsSync(mainRepoPath)) {
        logger.info(`[Worktree] Fetching latest for project ${projectId}`);

        logger.info(`[Worktree] Fetch complete for project ${projectId}`);
      } else {
        if (!existsSync(projectDir)) {
          mkdirSync(projectDir, { recursive: true });
          logger.info(`[Worktree] Created project directory: ${projectDir}`);
        }

        logger.info(`[Worktree] Creating blobless bare clone for project ${projectId}`);
        await execGitWithCredentials(
          ['clone', '--bare', '--filter=blob:none', '--', cloneUrl, mainRepoPath],
          accessToken,
          cloneUrl,
        );
        logger.info(`[Worktree] Bare clone complete for project ${projectId}`);
      }

      // Bare clones have no default refspec; refresh heads in a separate
      // namespace without overwriting active attempt branches.
      await execGitWithCredentials(['-C', mainRepoPath, 'fetch', '--prune', '--no-tags', '--', cloneUrl,
        '+refs/heads/*:refs/remotes/origin/*'], accessToken, cloneUrl);
      return mainRepoPath;
    } catch (error) {
      logger.error({ err: error, projectId }, `[Worktree] Failed to ensure main repo for project ${projectId}`);
      throw error;
    }
  });
}

export async function createWorktree(
  projectId: string,
  batchId: string,
  taskId: string,
  defaultBranch: string,
  accessToken: string | null = null,
  cloneUrl?: string,
): Promise<string> {
  assertSafeRefName(defaultBranch, 'default branch');

  const mainRepoPath = buildReposPath(projectId, '.main');
  const batchDir = buildReposPath(projectId, `batch-${batchId}`);
  const worktreePath = buildReposPath(projectId, `batch-${batchId}`, `task-${taskId}`);
  const branchName = createBatchTaskBranchName(taskId, batchId);

  assertSafeRefName(branchName, 'attempt branch');
  return withRepoLock(mainRepoPath, async () => {
  try {
    if (!existsSync(batchDir)) {
      mkdirSync(batchDir, { recursive: true });
      logger.info(`[Worktree] Created batch directory: ${batchDir}`);
    }

    if (existsSync(worktreePath)) throw new Error('Batch worktree already exists; retained work will not be replaced');

    logger.info(`[Worktree] Creating worktree for task ${taskId} on branch ${branchName}`);
    // `--` ends option parsing before `defaultBranch`, the one DB-sourced
    // positional here — see assertSafeRefName() above for the primary check.
    await execGitWithCredentials([
      '-C', mainRepoPath, 'worktree', 'add', worktreePath, '-b', branchName, '--',
      `refs/remotes/origin/${defaultBranch.replace(/^refs\/heads\//, '')}`,
    ], accessToken, cloneUrl);
    logger.info(`[Worktree] Worktree created at ${worktreePath}`);

    return worktreePath;
  } catch (error) {
    logger.error({ err: error, taskId }, '[Worktree] Failed acquisition retained for inspection');
    throw error;
  }
  });
}

export async function createBatchWorktree(
  projectId: string,
  batchId: string,
  branchName: string,
  defaultBranch: string,
  accessToken: string | null = null,
  cloneUrl?: string,
): Promise<string> {
  assertSafeRefName(defaultBranch, 'default branch');

  const mainRepoPath = buildReposPath(projectId, '.main');
  const batchDir = buildReposPath(projectId, `batch-${batchId}`);
  const worktreePath = buildReposPath(projectId, `batch-${batchId}`, 'combined');

  assertSafeRefName(branchName, 'attempt branch');
  return withRepoLock(mainRepoPath, async () => {
  try {
    if (!existsSync(batchDir)) {
      mkdirSync(batchDir, { recursive: true });
      logger.info(`[Worktree] Created batch directory: ${batchDir}`);
    }

    if (existsSync(worktreePath)) throw new Error('Combined worktree already exists; retained work will not be replaced');

    logger.info(`[Worktree] Creating combined worktree for batch ${batchId} on branch ${branchName}`);
    await execGitWithCredentials([
      '-C', mainRepoPath, 'worktree', 'add', worktreePath, '-b', branchName, '--',
      `refs/remotes/origin/${defaultBranch.replace(/^refs\/heads\//, '')}`,
    ], accessToken, cloneUrl);
    logger.info(`[Worktree] Combined worktree created at ${worktreePath}`);

    return worktreePath;
  } catch (error) {
    logger.error({ err: error, batchId }, '[Worktree] Failed combined acquisition retained for inspection');
    throw error;
  }
  });
}

export async function removeWorktree(
  projectId: string,
  worktreePath: string
): Promise<void> {
  const mainRepoPath = buildReposPath(projectId, '.main');
  const safeWorktreePath = assertPathInsideReposDir(worktreePath, { description: 'worktree path', allowRoot: false });

  try {
    logger.info(`[Worktree] Removing worktree: ${safeWorktreePath}`);
    await execGit([
      '-C',
      mainRepoPath,
      'worktree',
      'remove',
      safeWorktreePath,
    ]);
    logger.info(`[Worktree] Worktree removed: ${safeWorktreePath}`);
  } catch (error) {
    logger.error({ err: error }, `[Worktree] Failed to remove worktree ${safeWorktreePath}`);
    throw error;
  }
}

export async function listWorktrees(
  projectId: string
): Promise<string[]> {
  const mainRepoPath = buildReposPath(projectId, '.main');

  if (!existsSync(mainRepoPath)) {
    return [];
  }

  try {
    const { stdout } = await execGit([
      '-C',
      mainRepoPath,
      'worktree',
      'list',
      '--porcelain',
    ]);
    const paths: string[] = [];

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        paths.push(line.slice('worktree '.length));
      }
    }

    return paths;
  } catch (error) {
    logger.error({ err: error, projectId }, `[Worktree] Failed to list worktrees for project ${projectId}`);
    throw error;
  }
}

export async function cleanupBatch(
  projectId: string,
  batchId: string
): Promise<void> {
  const batchDir = buildReposPath(projectId, `batch-${batchId}`);

  try {
    logger.info(`[Worktree] Cleaning up batch ${batchId} for project ${projectId}`);

    const worktrees = await listWorktrees(projectId);
    for (const wt of worktrees) {
      let safeWt: string;
      try {
        safeWt = assertPathInsideReposDir(wt, { description: 'listed worktree path', allowRoot: false });
      } catch (error) {
        logger.error({ err: error, wt }, `[Worktree] Skipping cleanup for worktree outside repo storage: ${wt}`);
        continue;
      }
      if (safeWt === batchDir || safeWt.startsWith(`${batchDir}/`)) {
        await removeWorktree(projectId, safeWt);
      }
    }

    if (existsSync(batchDir)) {
      rmdirSync(batchDir);
      logger.info(`[Worktree] Removed batch directory: ${batchDir}`);
    }

    logger.info(`[Worktree] Batch ${batchId} cleanup complete`);
  } catch (error) {
    logger.error({ err: error, batchId }, `[Worktree] Failed to clean up batch ${batchId}`);
    throw error;
  }
}

export async function mergeBranch(projectId: string, taskBranch: string, targetBranch: string): Promise<boolean> {
  return withRepoLock(buildReposPath(projectId, '.main'), () => mergeBranchUnlocked(projectId, taskBranch, targetBranch));
}

async function mergeBranchUnlocked(
  projectId: string,
  taskBranch: string,
  targetBranch: string
): Promise<boolean> {
  const mainRepoPath = buildReposPath(projectId, '.main');
  const mergePath = buildReposPath(projectId, `merge-temp-${taskBranch.replace(/[^A-Za-z0-9._-]+/g, '-')}`);
  let acquired = false;

  try {
    // Validated inside the try/catch (rather than at the top of the
    // function) so an unsafe ref name is reported the same way every other
    // failure mode here is: a `false` return, not an unhandled rejection —
    // this function's whole contract is "boolean success", never throwing.
    assertSafeRefName(taskBranch, 'task branch');
    assertSafeRefName(targetBranch, 'target branch');

    const env = { ...process.env, ...getGitIdentityEnv() };
    if (existsSync(mergePath)) throw new Error('Merge workspace already exists; retained work will not be replaced');

    logger.info(`[Worktree] Creating temp worktree for merge at ${mergePath}`);
    // `--` ends option parsing before `targetBranch`.
    await execGit([
      '-C',
      mainRepoPath,
      'worktree',
      'add',
      '--detach',
      mergePath,
      '--',
      targetBranch,
    ]);
    acquired = true;

    try {
      const { stdout: originalHead } = await execGit(['-C', mergePath, 'rev-parse', 'HEAD']);
      logger.info(`[Worktree] Merging ${taskBranch} into ${targetBranch}`);
      // `-m` (and its value) are placed before `--` so they're still parsed
      // as the message flag; `--` then ends option parsing before
      // `taskBranch`, the DB-sourced positional.
      await execGit(
        [
          '-C',
          mergePath,
          'merge',
          '--no-ff',
          '-m',
          `Merge ${taskBranch}`,
          '--',
          taskBranch,
        ],
        { env }
      );
      logger.info(`[Worktree] Merge succeeded: ${taskBranch} → ${targetBranch}`);

      const { stdout: mergeHead } = await execGit([
        '-C',
        mergePath,
        'rev-parse',
        'HEAD',
      ]);
      const mergeCommit = mergeHead.trim();

      await execGit(['-C', mainRepoPath, 'worktree', 'remove', mergePath]);
      acquired = false;

      await execGit([
        '-C',
        mainRepoPath,
        'update-ref',
        `refs/heads/${targetBranch}`,
        mergeCommit,
        originalHead.trim(),
      ]);

      return true;
    } catch (mergeError) {
      logger.error({ err: mergeError }, `[Worktree] Merge conflict: ${taskBranch} → ${targetBranch}`);
      try {
        await execGit(['-C', mergePath, 'merge', '--abort']);
      } catch {
        // merge --abort can fail if there's nothing to abort — harmless
      }
      return false;
    }
  } catch (error) {
    logger.error({ err: error }, `[Worktree] Failed to merge ${taskBranch} into ${targetBranch}`);
    return false;
  } finally {
    if (acquired) {
      try { await execGit(['-C', mainRepoPath, 'worktree', 'remove', mergePath]); }
      catch (error) { logger.warn({ err: error, mergePath }, '[Worktree] Merge workspace retained after cleanup failure'); }
    }
  }
}

export async function createBatchBranch(
  projectId: string,
  batchBranch: string,
  defaultBranch: string
): Promise<void> {
  assertSafeRefName(batchBranch, 'batch branch');
  assertSafeRefName(defaultBranch, 'default branch');

  const mainRepoPath = buildReposPath(projectId, '.main');
  logger.info(`[Worktree] Creating batch branch ${batchBranch} from ${defaultBranch}`);
  // `--` ends option parsing before both positionals — see gitrevisions(7)
  // "Disambiguating" for this exact `git branch -- <name>` idiom.
  await execGit([
    '-C',
    mainRepoPath,
    'branch',
    '--',
    batchBranch,
    `refs/remotes/origin/${defaultBranch.replace(/^refs\/heads\//, '')}`,
  ]);
}

export async function pushBranch(
  projectId: string,
  branchName: string,
  cloneUrl: string,
  accessToken: string | null
): Promise<void> {
  assertSafeCloneUrl(cloneUrl, 'clone URL');
  assertSafeRefName(branchName, 'publication branch');

  const mainRepoPath = buildReposPath(projectId, '.main');
  logger.info(`[Worktree] Pushing ${branchName} to remote`);
  // `--` ends option parsing before the clone URL — defense in depth on top
  // of assertSafeCloneUrl() above.
  await execGitWithCredentials(
    ['-C', mainRepoPath, 'push', `--force-with-lease=refs/heads/${branchName}:`, '--', cloneUrl, `${branchName}:refs/heads/${branchName}`],
    accessToken,
    cloneUrl,
  );
  logger.info(`[Worktree] Push complete for ${branchName}`);
}
