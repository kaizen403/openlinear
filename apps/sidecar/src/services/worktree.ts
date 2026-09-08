import { existsSync, mkdirSync, rmSync } from 'fs';
import { logger } from '@openlinear/api/logger';
import { getGitIdentityEnv } from './git-identity';
import { assertPathInsideReposDir, buildReposPath } from './repo-storage';
import {
  assertSafeCloneUrl,
  assertSafeRefName,
  execGit,
  execGitWithCredentials,
} from './git-credentials';

export async function ensureMainRepo(
  projectId: string,
  cloneUrl: string,
  accessToken: string | null
): Promise<string> {
  assertSafeCloneUrl(cloneUrl, 'clone URL');

  const projectDir = buildReposPath(projectId);
  const mainRepoPath = buildReposPath(projectId, '.main');

  try {
    if (existsSync(mainRepoPath)) {
      logger.info(`[Worktree] Fetching latest for project ${projectId}`);
      await execGitWithCredentials(['-C', mainRepoPath, 'fetch', 'origin', '--prune'], accessToken, cloneUrl);
      logger.info(`[Worktree] Fetch complete for project ${projectId}`);
    } else {
      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
        logger.info(`[Worktree] Created project directory: ${projectDir}`);
      }

      logger.info(`[Worktree] Creating bare clone for project ${projectId}`);
      // `--` ends option parsing before the clone URL: defense in depth on
      // top of assertSafeCloneUrl() above.
      await execGitWithCredentials(['clone', '--bare', '--', cloneUrl, mainRepoPath], accessToken, cloneUrl);
      logger.info(`[Worktree] Bare clone complete for project ${projectId}`);
    }

    return mainRepoPath;
  } catch (error) {
    logger.error({ err: error, projectId }, `[Worktree] Failed to ensure main repo for project ${projectId}`);
    throw error;
  }
}

async function removeStaleWorktreeForBranch(
  mainRepoPath: string,
  branchName: string
): Promise<void> {
  try {
    const { stdout: worktreeList } = await execGit([
      '-C',
      mainRepoPath,
      'worktree',
      'list',
      '--porcelain',
    ]);
    const lines = worktreeList.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('worktree ')) {
        const wtPath = lines[i].slice('worktree '.length);
        for (let j = i + 1; j < lines.length && lines[j] !== ''; j++) {
          if (lines[j] === `branch refs/heads/${branchName}`) {
            let safeWtPath: string;
            try {
              safeWtPath = assertPathInsideReposDir(wtPath, { description: 'stale worktree path', allowRoot: false });
            } catch (error) {
              logger.error({ err: error, wtPath }, `[Worktree] Refusing to remove stale worktree outside repo storage: ${wtPath}`);
              continue;
            }
            logger.info(`[Worktree] Removing stale worktree at ${safeWtPath} for branch ${branchName}`);
            await execGit([
              '-C',
              mainRepoPath,
              'worktree',
              'remove',
              safeWtPath,
              '--force',
            ]).catch(() => {
              if (existsSync(safeWtPath)) rmSync(safeWtPath, { recursive: true, force: true });
            });
            break;
          }
        }
      }
    }
  } catch {
  }
}

async function deleteBranchIfExists(
  mainRepoPath: string,
  branchName: string
): Promise<void> {
  try {
    await execGit(['-C', mainRepoPath, 'branch', '-D', branchName]);
    logger.info(`[Worktree] Deleted stale branch ${branchName}`);
  } catch {
    // Branch doesn't exist or can't be deleted — expected for fresh repos
  }
}

export async function createWorktree(
  projectId: string,
  batchId: string,
  taskId: string,
  defaultBranch: string
): Promise<string> {
  assertSafeRefName(defaultBranch, 'default branch');

  const mainRepoPath = buildReposPath(projectId, '.main');
  const batchDir = buildReposPath(projectId, `batch-${batchId}`);
  const worktreePath = buildReposPath(projectId, `batch-${batchId}`, `task-${taskId}`);
  const branchName = `openlinear/${taskId}`;

  try {
    if (!existsSync(batchDir)) {
      mkdirSync(batchDir, { recursive: true });
      logger.info(`[Worktree] Created batch directory: ${batchDir}`);
    }

    logger.info(`[Worktree] Fetching latest before creating worktree for task ${taskId}`);
    await execGit(['-C', mainRepoPath, 'fetch', 'origin']);

    await removeStaleWorktreeForBranch(mainRepoPath, branchName);
    await deleteBranchIfExists(mainRepoPath, branchName);

    logger.info(`[Worktree] Creating worktree for task ${taskId} on branch ${branchName}`);
    // `--` ends option parsing before `defaultBranch`, the one DB-sourced
    // positional here — see assertSafeRefName() above for the primary check.
    await execGit([
      '-C',
      mainRepoPath,
      'worktree',
      'add',
      worktreePath,
      '-b',
      branchName,
      '--',
      defaultBranch,
    ]);
    logger.info(`[Worktree] Worktree created at ${worktreePath}`);

    return worktreePath;
  } catch (error) {
    logger.error({ err: error, taskId }, `[Worktree] Failed to create worktree for task ${taskId}`);
    if (existsSync(worktreePath)) {
      try {
        await execGit([
          '-C',
          mainRepoPath,
          'worktree',
          'remove',
          worktreePath,
          '--force',
        ]);
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

export async function createBatchWorktree(
  projectId: string,
  batchId: string,
  branchName: string,
  defaultBranch: string
): Promise<string> {
  assertSafeRefName(defaultBranch, 'default branch');

  const mainRepoPath = buildReposPath(projectId, '.main');
  const batchDir = buildReposPath(projectId, `batch-${batchId}`);
  const worktreePath = buildReposPath(projectId, `batch-${batchId}`, 'combined');

  try {
    if (!existsSync(batchDir)) {
      mkdirSync(batchDir, { recursive: true });
      logger.info(`[Worktree] Created batch directory: ${batchDir}`);
    }

    logger.info(`[Worktree] Fetching latest before creating combined worktree for batch ${batchId}`);
    await execGit(['-C', mainRepoPath, 'fetch', 'origin']);

    await removeStaleWorktreeForBranch(mainRepoPath, branchName);
    await deleteBranchIfExists(mainRepoPath, branchName);

    logger.info(`[Worktree] Creating combined worktree for batch ${batchId} on branch ${branchName}`);
    await execGit([
      '-C',
      mainRepoPath,
      'worktree',
      'add',
      worktreePath,
      '-b',
      branchName,
      '--',
      defaultBranch,
    ]);
    logger.info(`[Worktree] Combined worktree created at ${worktreePath}`);

    return worktreePath;
  } catch (error) {
    logger.error({ err: error, batchId }, `[Worktree] Failed to create combined worktree for batch ${batchId}`);
    if (existsSync(worktreePath)) {
      try {
        await execGit([
          '-C',
          mainRepoPath,
          'worktree',
          'remove',
          worktreePath,
          '--force',
        ]);
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }
    throw error;
  }
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
      '--force',
    ]);
    logger.info(`[Worktree] Worktree removed: ${safeWorktreePath}`);
  } catch (error) {
    logger.error({ err: error }, `[Worktree] Failed to remove worktree ${safeWorktreePath}`);
  }

  if (existsSync(safeWorktreePath)) {
    rmSync(safeWorktreePath, { recursive: true, force: true });
    logger.info(`[Worktree] Cleaned up remaining directory: ${safeWorktreePath}`);
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
    return [];
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
      rmSync(batchDir, { recursive: true, force: true });
      logger.info(`[Worktree] Removed batch directory: ${batchDir}`);
    }

    logger.info(`[Worktree] Batch ${batchId} cleanup complete`);
  } catch (error) {
    logger.error({ err: error, batchId }, `[Worktree] Failed to clean up batch ${batchId}`);
    if (existsSync(batchDir)) {
      rmSync(batchDir, { recursive: true, force: true });
    }
  }
}

export async function mergeBranch(
  projectId: string,
  taskBranch: string,
  targetBranch: string
): Promise<boolean> {
  const mainRepoPath = buildReposPath(projectId, '.main');
  const mergePath = buildReposPath(projectId, 'merge-temp');

  try {
    // Validated inside the try/catch (rather than at the top of the
    // function) so an unsafe ref name is reported the same way every other
    // failure mode here is: a `false` return, not an unhandled rejection —
    // this function's whole contract is "boolean success", never throwing.
    assertSafeRefName(taskBranch, 'task branch');
    assertSafeRefName(targetBranch, 'target branch');

    const env = { ...process.env, ...getGitIdentityEnv() };
    if (existsSync(mergePath)) {
      try {
        await execGit([
          '-C',
          mainRepoPath,
          'worktree',
          'remove',
          mergePath,
          '--force',
        ]);
      } catch {
        rmSync(mergePath, { recursive: true, force: true });
      }
    }

    logger.info(`[Worktree] Creating temp worktree for merge at ${mergePath}`);
    // `--` ends option parsing before `targetBranch`.
    await execGit([
      '-C',
      mainRepoPath,
      'worktree',
      'add',
      mergePath,
      '--',
      targetBranch,
    ]);

    try {
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

      await execGit([
        '-C',
        mainRepoPath,
        'worktree',
        'remove',
        mergePath,
        '--force',
      ]).catch(() => {
        if (existsSync(mergePath)) rmSync(mergePath, { recursive: true, force: true });
      });

      await execGit([
        '-C',
        mainRepoPath,
        'update-ref',
        `refs/heads/${targetBranch}`,
        mergeCommit,
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
    try {
      await execGit([
        '-C',
        mainRepoPath,
        'worktree',
        'remove',
        mergePath,
        '--force',
      ]);
    } catch {
      // Final cleanup — if git worktree remove fails, rm the directory directly
      if (existsSync(mergePath)) {
        rmSync(mergePath, { recursive: true, force: true });
      }
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
    defaultBranch,
  ]);
}

export async function pushBranch(
  projectId: string,
  branchName: string,
  cloneUrl: string,
  accessToken: string | null
): Promise<void> {
  assertSafeCloneUrl(cloneUrl, 'clone URL');

  const mainRepoPath = buildReposPath(projectId, '.main');
  logger.info(`[Worktree] Pushing ${branchName} to remote`);
  // `--` ends option parsing before the clone URL — defense in depth on top
  // of assertSafeCloneUrl() above.
  await execGitWithCredentials(
    ['-C', mainRepoPath, 'push', '--force-with-lease', '--', cloneUrl, branchName],
    accessToken,
    cloneUrl,
  );
  logger.info(`[Worktree] Push complete for ${branchName}`);
}
