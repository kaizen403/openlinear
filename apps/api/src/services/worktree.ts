import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);
const REPOS_DIR = process.env.REPOS_DIR || '/tmp/openlinear-repos';

export async function ensureMainRepo(
  projectId: string,
  cloneUrl: string,
  accessToken: string | null
): Promise<string> {
  const projectDir = join(REPOS_DIR, projectId);
  const mainRepoPath = join(projectDir, '.main');

  const url = accessToken
    ? cloneUrl.replace('https://', `https://oauth2:${accessToken}@`)
    : cloneUrl;

  try {
    if (existsSync(mainRepoPath)) {
      console.log(`[Worktree] Fetching latest for project ${projectId}`);
      await execAsync(`git -C ${mainRepoPath} fetch origin --prune`);
      console.log(`[Worktree] Fetch complete for project ${projectId}`);
    } else {
      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
        console.log(`[Worktree] Created project directory: ${projectDir}`);
      }

      console.log(`[Worktree] Creating bare clone for project ${projectId}`);
      await execAsync(`git clone --bare ${url} ${mainRepoPath}`);
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
  const mainRepoPath = join(REPOS_DIR, projectId, '.main');
  const batchDir = join(REPOS_DIR, projectId, `batch-${batchId}`);
  const worktreePath = join(batchDir, `task-${taskId}`);
  const branchName = `openlinear/${taskId}`;

  try {
    if (!existsSync(batchDir)) {
      mkdirSync(batchDir, { recursive: true });
      console.log(`[Worktree] Created batch directory: ${batchDir}`);
    }

    console.log(`[Worktree] Fetching latest before creating worktree for task ${taskId}`);
    await execAsync(`git -C ${mainRepoPath} fetch origin`);

    console.log(`[Worktree] Creating worktree for task ${taskId} on branch ${branchName}`);
    await execAsync(
      `git -C ${mainRepoPath} worktree add ${worktreePath} -b ${branchName} origin/${defaultBranch}`
    );
    console.log(`[Worktree] Worktree created at ${worktreePath}`);

    return worktreePath;
  } catch (error) {
    console.error(`[Worktree] Failed to create worktree for task ${taskId}:`, error);
    if (existsSync(worktreePath)) {
      try {
        await execAsync(`git -C ${mainRepoPath} worktree remove ${worktreePath} --force`);
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
  const mainRepoPath = join(REPOS_DIR, projectId, '.main');

  try {
    console.log(`[Worktree] Removing worktree: ${worktreePath}`);
    await execAsync(`git -C ${mainRepoPath} worktree remove ${worktreePath} --force`);
    console.log(`[Worktree] Worktree removed: ${worktreePath}`);
  } catch (error) {
    console.error(`[Worktree] Failed to remove worktree ${worktreePath}:`, error);
  }

  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
    console.log(`[Worktree] Cleaned up remaining directory: ${worktreePath}`);
  }
}

export async function listWorktrees(
  projectId: string
): Promise<string[]> {
  const mainRepoPath = join(REPOS_DIR, projectId, '.main');

  if (!existsSync(mainRepoPath)) {
    return [];
  }

  try {
    const { stdout } = await execAsync(`git -C ${mainRepoPath} worktree list --porcelain`);
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
  const batchDir = join(REPOS_DIR, projectId, `batch-${batchId}`);

  try {
    console.log(`[Worktree] Cleaning up batch ${batchId} for project ${projectId}`);

    const worktrees = await listWorktrees(projectId);
    for (const wt of worktrees) {
      if (wt.includes(`batch-${batchId}/`)) {
        await removeWorktree(projectId, wt);
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
  const mainRepoPath = join(REPOS_DIR, projectId, '.main');
  const mergePath = join(REPOS_DIR, projectId, 'merge-temp');

  try {
    if (existsSync(mergePath)) {
      try {
        await execAsync(`git -C ${mainRepoPath} worktree remove ${mergePath} --force`);
      } catch {
        rmSync(mergePath, { recursive: true, force: true });
      }
    }

    console.log(`[Worktree] Creating temp worktree for merge at ${mergePath}`);
    await execAsync(`git -C ${mainRepoPath} worktree add ${mergePath} ${targetBranch}`);

    try {
      console.log(`[Worktree] Merging ${taskBranch} into ${targetBranch}`);
      await execAsync(
        `git -C ${mergePath} merge --no-ff ${taskBranch} -m "Merge ${taskBranch}"`
      );
      console.log(`[Worktree] Merge succeeded: ${taskBranch} → ${targetBranch}`);

      await execAsync(
        `git -C ${mainRepoPath} fetch ${mergePath} ${targetBranch}:${targetBranch}`
      );

      return true;
    } catch (mergeError) {
      console.error(`[Worktree] Merge conflict: ${taskBranch} → ${targetBranch}`, mergeError);
      try {
        await execAsync(`git -C ${mergePath} merge --abort`);
      } catch {
        // merge --abort may fail if merge didn't start properly
      }
      return false;
    }
  } catch (error) {
    console.error(`[Worktree] Failed to merge ${taskBranch} into ${targetBranch}:`, error);
    return false;
  } finally {
    try {
      await execAsync(`git -C ${mainRepoPath} worktree remove ${mergePath} --force`);
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
  const mainRepoPath = join(REPOS_DIR, projectId, '.main');
  console.log(`[Worktree] Creating batch branch ${batchBranch} from origin/${defaultBranch}`);
  await execAsync(`git -C ${mainRepoPath} branch ${batchBranch} origin/${defaultBranch}`);
}

export async function pushBranch(
  projectId: string,
  branchName: string,
  cloneUrl: string,
  accessToken: string | null
): Promise<void> {
  const mainRepoPath = join(REPOS_DIR, projectId, '.main');
  const url = accessToken
    ? cloneUrl.replace('https://', `https://oauth2:${accessToken}@`)
    : cloneUrl;
  console.log(`[Worktree] Pushing ${branchName} to remote`);
  await execAsync(`git -C ${mainRepoPath} push ${url} ${branchName}`);
  console.log(`[Worktree] Push complete for ${branchName}`);
}
