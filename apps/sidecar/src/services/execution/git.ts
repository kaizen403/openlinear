import { existsSync, mkdirSync, rmSync, accessSync, constants } from 'fs';
import { PullRequestResult, REPOS_DIR } from './state';
import { getGitIdentityEnv } from '../git-identity';
import { execFileAsync } from './exec';
import { assertPathInsideReposDir } from '../repo-storage';
import { execGitWithCredentials } from '../git-credentials';

export type CommitPushResult =
  | { status: 'no_changes' }
  | { status: 'pushed' }
  | { status: 'failed'; reason: string };

function getExecErrorReason(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as { stderr?: string; message?: string };
    const stderr = err.stderr?.trim();
    if (stderr) return stderr;
    if (err.message) return err.message;
  }
  return 'Unknown git error';
}

export async function cloneRepository(
  cloneUrl: string,
  repoPath: string,
  accessToken: string | null,
  defaultBranch: string
): Promise<void> {
  const safeRepoPath = assertPathInsideReposDir(repoPath);
  console.log(`[Execution] Preparing to clone into ${safeRepoPath}`);

  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true });
    console.log(`[Execution] Created repos directory: ${REPOS_DIR}`);
  }

  try {
    accessSync(REPOS_DIR, constants.W_OK);
  } catch {
    throw new Error(`[Execution] No write access to ${REPOS_DIR}. Check directory ownership.`);
  }

  if (existsSync(safeRepoPath)) {
    rmSync(safeRepoPath, { recursive: true, force: true });
    console.log(`[Execution] Removed existing directory: ${safeRepoPath}`);
  }

  console.log(`[Execution] Cloning ${cloneUrl} (branch: ${defaultBranch})...`);
  await execGitWithCredentials(
    ['clone', '--depth', '1', '--branch', defaultBranch, cloneUrl, safeRepoPath],
    accessToken,
    cloneUrl,
  );
  await execFileAsync('chmod', ['-R', 'a+rwX', safeRepoPath]);
  console.log(`[Execution] Clone complete`);
}

export async function createBranch(repoPath: string, branchName: string): Promise<void> {
  console.log(`[Execution] Creating branch: ${branchName}`);
  await execFileAsync('git', ['-C', repoPath, 'checkout', '-B', branchName]);
  console.log(`[Execution] Branch ready and checked out`);
}

export async function commitAndPush(
  repoPath: string,
  branchName: string,
  taskTitle: string,
  accessToken: string | null = null
): Promise<CommitPushResult> {
  try {
    const env = { ...process.env, ...getGitIdentityEnv() };

    console.log(`[Execution] Checking for changes in ${repoPath}`);
    const { stdout: status } = await execFileAsync('git', ['-C', repoPath, 'status', '--porcelain']);

    if (!status.trim()) {
      console.log(`[Execution] No changes to commit`);
      return { status: 'no_changes' };
    }

    console.log(`[Execution] Changes detected, staging files...`);
    await execFileAsync('git', ['-C', repoPath, 'add', '-A']);

    const commitMessage = `feat: ${taskTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 50)}`;
    console.log(`[Execution] Committing: ${commitMessage}`);
    await execFileAsync('git', ['-C', repoPath, 'commit', '-m', commitMessage], { env });

    console.log(`[Execution] Pushing to origin/${branchName}...`);
    const { stdout: originUrl } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    await execGitWithCredentials(
      ['-C', repoPath, 'push', '--force-with-lease', '-u', 'origin', branchName],
      accessToken,
      originUrl.trim(),
      { env },
    );
    console.log(`[Execution] Push complete`);

    return { status: 'pushed' };
  } catch (error) {
    const reason = getExecErrorReason(error);
    console.error('[Execution] Commit/push failed:', reason);
    return { status: 'failed', reason };
  }
}

export async function createPullRequest(
  fullName: string,
  branchName: string,
  defaultBranch: string,
  taskTitle: string,
  taskDescription: string | null,
  accessToken: string | null
): Promise<PullRequestResult> {
  const [owner, repo] = fullName.split('/');
  const compareUrl = `https://github.com/${owner}/${repo}/compare/${defaultBranch}...${branchName}`;

  if (!accessToken) {
    console.log('[Execution] No access token - returning compare URL for manual PR creation');
    return { url: compareUrl, type: 'compare' };
  }

  const body = {
    title: taskTitle,
    head: branchName,
    base: defaultBranch,
    body: taskDescription || `Automated PR created by OpenLinear\n\n## Task\n${taskTitle}`,
  };

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Execution] PR creation failed:', error);
      return { url: compareUrl, type: 'compare' };
    }

    const pr = (await response.json()) as { html_url: string };
    return { url: pr.html_url, type: 'pr' };
  } catch (error) {
    console.error('[Execution] PR creation error:', error);
    return { url: compareUrl, type: 'compare' };
  }
}
