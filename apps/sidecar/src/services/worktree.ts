import { existsSync, mkdirSync, rmSync } from 'fs';
import { getGitIdentityEnv } from './git-identity';
import { execFileAsync } from './execution/exec';
import { assertPathInsideReposDir, buildReposPath } from './repo-storage';
import { execGitWithCredentials } from './git-credentials';

export async function ensureMainRepo(
  projectId: string,
  cloneUrl: string,
  accessToken: string | null
): Promise<string> {
  const projectDir = buildReposPath(projectId);
  const mainRepoPath = buildReposPath(projectId, '.main');

  try {
    if (existsSync(mainRepoPath)) {
      console.log(`[Worktree] Fetching latest for project ${projectId}`);
      await execGitWithCredentials(['-C', mainRepoPath, 'fetch', 'origin', '--prune'], accessToken, cloneUrl);
      console.log(`[Worktree] Fetch complete for project ${projectId}`);
    } else {
      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
        console.log(`[Worktree] Created project directory: ${projectDir}`);
      }

      console.log(`[Worktree] Creating bare clone for project ${projectId}`);
      await execGitWithCredentials(['clone', '--bare', cloneUrl, mainRepoPath], accessToken, cloneUrl);
      console.log(`[Worktree] Bare clone complete for project ${projectId}`);
    }

    return mainRepoPath;
  } catch (error) {
    console.error(`[Worktree] Failed to ensure main repo for project ${projectId}:`, error);
    throw error;
  }
}

export async function createWorktree(
  projectId: string,
  batchId: string,
  taskId: string,
  defaultBranch: string
): Promise<string> {
  const mainRepoPath = buildReposPath(projectId, '.main');
  const batchDir = buildReposPath(projectId, `batch-${batchId}`);
  const worktreePath = buildReposPath(projectId, `batch-${batchId}`, `task-${taskId}`);
  const branchName = `openlinear/${taskId}`;

  try {
    if (!existsSync(batchDir)) {
      mkdirSync(batchDir, { recursive: true });
      console.log(`[Worktree] Created batch directory: ${batchDir}`);
    }

    console.log(`[Worktree] Fetching latest before creating worktree for task ${taskId}`);
    await execFileAsync('git', ['-C', mainRepoPath, 'fetch', 'origin']);

    try {
      const { stdout: worktreeList } = await execFileAsync('git', [
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
                safeWtPath = assertPathInsideReposDir(wtPath, 'stale worktree path');
              } catch (error) {
                console.error(`[Worktree] Refusing to remove stale worktree outside repo storage: ${wtPath}`, error);
                continue;
              }
              console.log(`[Worktree] Removing stale worktree at ${safeWtPath} for branch ${branchName}`);
              await execFileAsync('git', [
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

    try {
      await execFileAsync('git', ['-C', mainRepoPath, 'branch', '-D', branchName]);
      console.log(`[Worktree] Deleted stale branch ${branchName}`);
    } catch {
    }

    console.log(`[Worktree] Creating worktree for task ${taskId} on branch ${branchName}`);
    await execFileAsync('git', [
      '-C',
      mainRepoPath,
      'worktree',
      'add',
      worktreePath,
      '-b',
      branchName,
      defaultBranch,
    ]);
    console.log(`[Worktree] Worktree created at ${worktreePath}`);

    return worktreePath;
  } catch (error) {
    console.error(`[Worktree] Failed to create worktree for task ${taskId}:`, error);
    if (existsSync(worktreePath)) {
      try {
        await execFileAsync('git', [
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
  const safeWorktreePath = assertPathInsideReposDir(worktreePath, 'worktree path');

  try {
    console.log(`[Worktree] Removing worktree: ${safeWorktreePath}`);
    await execFileAsync('git', [
      '-C',
      mainRepoPath,
      'worktree',
      'remove',
      safeWorktreePath,
      '--force',
    ]);
    console.log(`[Worktree] Worktree removed: ${safeWorktreePath}`);
  } catch (error) {
    console.error(`[Worktree] Failed to remove worktree ${safeWorktreePath}:`, error);
  }

  if (existsSync(safeWorktreePath)) {
    rmSync(safeWorktreePath, { recursive: true, force: true });
    console.log(`[Worktree] Cleaned up remaining directory: ${safeWorktreePath}`);
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
    const { stdout } = await execFileAsync('git', [
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
    console.error(`[Worktree] Failed to list worktrees for project ${projectId}:`, error);
    return [];
  }
}

export async function cleanupBatch(
  projectId: string,
  batchId: string
): Promise<void> {
  const batchDir = buildReposPath(projectId, `batch-${batchId}`);

  try {
    console.log(`[Worktree] Cleaning up batch ${batchId} for project ${projectId}`);

    const worktrees = await listWorktrees(projectId);
    for (const wt of worktrees) {
      let safeWt: string;
      try {
        safeWt = assertPathInsideReposDir(wt, 'listed worktree path');
      } catch (error) {
        console.error(`[Worktree] Skipping cleanup for worktree outside repo storage: ${wt}`, error);
        continue;
      }
      if (safeWt === batchDir || safeWt.startsWith(`${batchDir}/`)) {
        await removeWorktree(projectId, safeWt);
      }
    }

    if (existsSync(batchDir)) {
      rmSync(batchDir, { recursive: true, force: true });
      console.log(`[Worktree] Removed batch directory: ${batchDir}`);
    }

    console.log(`[Worktree] Batch ${batchId} cleanup complete`);
  } catch (error) {
    console.error(`[Worktree] Failed to clean up batch ${batchId}:`, error);
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
    const env = { ...process.env, ...getGitIdentityEnv() };
    if (existsSync(mergePath)) {
      try {
        await execFileAsync('git', [
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

    console.log(`[Worktree] Creating temp worktree for merge at ${mergePath}`);
    await execFileAsync('git', [
      '-C',
      mainRepoPath,
      'worktree',
      'add',
      mergePath,
      targetBranch,
    ]);

    try {
      console.log(`[Worktree] Merging ${taskBranch} into ${targetBranch}`);
      await execFileAsync(
        'git',
        [
          '-C',
          mergePath,
          'merge',
          '--no-ff',
          taskBranch,
          '-m',
          `Merge ${taskBranch}`,
        ],
        { env }
      );
      console.log(`[Worktree] Merge succeeded: ${taskBranch} → ${targetBranch}`);

      const { stdout: mergeHead } = await execFileAsync('git', [
        '-C',
        mergePath,
        'rev-parse',
        'HEAD',
      ]);
      const mergeCommit = mergeHead.trim();

      await execFileAsync('git', [
        '-C',
        mainRepoPath,
        'worktree',
        'remove',
        mergePath,
        '--force',
      ]).catch(() => {
        if (existsSync(mergePath)) rmSync(mergePath, { recursive: true, force: true });
      });

      await execFileAsync('git', [
        '-C',
        mainRepoPath,
        'update-ref',
        `refs/heads/${targetBranch}`,
        mergeCommit,
      ]);

      return true;
    } catch (mergeError) {
      console.error(`[Worktree] Merge conflict: ${taskBranch} → ${targetBranch}`, mergeError);
      try {
        await execFileAsync('git', ['-C', mergePath, 'merge', '--abort']);
      } catch {
      }
      return false;
    }
  } catch (error) {
    console.error(`[Worktree] Failed to merge ${taskBranch} into ${targetBranch}:`, error);
    return false;
  } finally {
    try {
      await execFileAsync('git', [
        '-C',
        mainRepoPath,
        'worktree',
        'remove',
        mergePath,
        '--force',
      ]);
    } catch {
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
  const mainRepoPath = buildReposPath(projectId, '.main');
  console.log(`[Worktree] Creating batch branch ${batchBranch} from ${defaultBranch}`);
  await execFileAsync('git', [
    '-C',
    mainRepoPath,
    'branch',
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
  const mainRepoPath = buildReposPath(projectId, '.main');
  console.log(`[Worktree] Pushing ${branchName} to remote`);
  await execGitWithCredentials(
    ['-C', mainRepoPath, 'push', '--force-with-lease', cloneUrl, branchName],
    accessToken,
    cloneUrl,
  );
  console.log(`[Worktree] Push complete for ${branchName}`);
}
