import { existsSync, mkdirSync, rmSync, accessSync, constants } from 'fs';
import { logger } from '@openlinear/api/logger';
import { PullRequestResult, REPOS_DIR } from './state';
import { getGitIdentityEnv } from '../git-identity';
import { execFileAsync } from './exec';
import { assertPathInsideReposDir } from '../repo-storage';
import { execGitWithCredentials } from '../git-credentials';

export type CommitPushResult =
  | { status: 'no_changes' }
  | { status: 'pushed' }
  | { status: 'failed'; reason: string };

const RUNTIME_ARTIFACT_PATHS = ['.sisyphus'];

function getExecErrorReason(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as { stderr?: string; message?: string };
    const stderr = err.stderr?.trim();
    if (stderr) return stderr;
    if (err.message) return err.message;
  }
  return 'Unknown git error';
}

function extractPorcelainPath(line: string): string {
  const raw = line.slice(3).trim();
  const renameTarget = raw.split(' -> ').pop();
  return (renameTarget || raw).replace(/\\/g, '/');
}

function isRuntimeArtifactPath(path: string): boolean {
  return RUNTIME_ARTIFACT_PATHS.some((artifactPath) => (
    path === artifactPath || path.startsWith(`${artifactPath}/`)
  ));
}

export async function hasCommittableChanges(repoPath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repoPath,
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);

  return stdout
    .split('\n')
    .filter(Boolean)
    .some((line) => !isRuntimeArtifactPath(extractPorcelainPath(line)));
}

export async function stageCommittableChanges(repoPath: string): Promise<boolean> {
  await execFileAsync('git', [
    '-C',
    repoPath,
    'add',
    '-A',
    '--',
    '.',
    ':(exclude).sisyphus',
    ':(exclude).sisyphus/**',
  ]);
  await execFileAsync('git', ['-C', repoPath, 'reset', '-q', '--', '.sisyphus']).catch(() => undefined);

  const { stdout } = await execFileAsync('git', [
    '-C',
    repoPath,
    'diff',
    '--cached',
    '--name-only',
  ]);

  return stdout.trim().length > 0;
}

export async function cloneRepository(
  cloneUrl: string,
  repoPath: string,
  accessToken: string | null,
  defaultBranch: string
): Promise<void> {
  const safeRepoPath = assertPathInsideReposDir(repoPath);
  logger.info(`[Execution] Preparing to clone into ${safeRepoPath}`);

  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true });
    logger.info(`[Execution] Created repos directory: ${REPOS_DIR}`);
  }

  try {
    accessSync(REPOS_DIR, constants.W_OK);
  } catch {
    throw new Error(`[Execution] No write access to ${REPOS_DIR}. Check directory ownership.`);
  }

  if (existsSync(safeRepoPath)) {
    rmSync(safeRepoPath, { recursive: true, force: true });
    logger.info(`[Execution] Removed existing directory: ${safeRepoPath}`);
  }

  logger.info(`[Execution] Cloning ${cloneUrl} (branch: ${defaultBranch})...`);
  await execGitWithCredentials(
    ['clone', '--depth', '1', '--branch', defaultBranch, cloneUrl, safeRepoPath],
    accessToken,
    cloneUrl,
  );
  await execFileAsync('chmod', ['-R', 'a+rwX', safeRepoPath]);
  logger.info(`[Execution] Clone complete`);
}

export async function createBranch(repoPath: string, branchName: string): Promise<void> {
  logger.info(`[Execution] Creating branch: ${branchName}`);
  await execFileAsync('git', ['-C', repoPath, 'checkout', '-B', branchName]);
  logger.info(`[Execution] Branch ready and checked out`);
}

export async function commitAndPush(
  repoPath: string,
  branchName: string,
  taskTitle: string,
  accessToken: string | null = null
): Promise<CommitPushResult> {
  try {
    const env = { ...process.env, ...getGitIdentityEnv() };

    logger.info(`[Execution] Checking for changes in ${repoPath}`);
    if (!(await hasCommittableChanges(repoPath))) {
      logger.info(`[Execution] No changes to commit`);
      return { status: 'no_changes' };
    }

    logger.info(`[Execution] Changes detected, staging files...`);
    const staged = await stageCommittableChanges(repoPath);
    if (!staged) {
      logger.info(`[Execution] No committable changes after excluding runtime artifacts`);
      return { status: 'no_changes' };
    }

    const commitMessage = `feat: ${taskTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 50)}`;
    logger.info(`[Execution] Committing: ${commitMessage}`);
    await execFileAsync('git', ['-C', repoPath, 'commit', '-m', commitMessage], { env });

    logger.info(`[Execution] Pushing to origin/${branchName}...`);
    const { stdout: originUrl } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    await execGitWithCredentials(
      ['-C', repoPath, 'push', '--force-with-lease', '-u', 'origin', branchName],
      accessToken,
      originUrl.trim(),
      { env },
    );
    logger.info(`[Execution] Push complete`);

    return { status: 'pushed' };
  } catch (error) {
    const reason = getExecErrorReason(error);
    logger.error({ err: error }, '[Execution] Commit/push failed');
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
    logger.info('[Execution] No access token - returning compare URL for manual PR creation');
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
      logger.error({ err: error }, '[Execution] PR creation failed');
      return { url: compareUrl, type: 'compare' };
    }

    const pr = (await response.json()) as { html_url: string };
    return { url: pr.html_url, type: 'pr' };
  } catch (error) {
    logger.error({ err: error }, '[Execution] PR creation error');
    return { url: compareUrl, type: 'compare' };
  }
}

export interface IGitService {
  clone(cloneUrl: string, repoPath: string, accessToken: string | null, defaultBranch: string): Promise<void>;
  createBranch(repoPath: string, branchName: string): Promise<void>;
  commitAndPush(repoPath: string, branchName: string, taskTitle: string, accessToken?: string | null): Promise<CommitPushResult>;
  createPullRequest(fullName: string, branchName: string, defaultBranch: string, taskTitle: string, taskDescription: string | null, accessToken: string | null): Promise<PullRequestResult>;
  hasChanges(repoPath: string): Promise<boolean>;
  stageChanges(repoPath: string): Promise<boolean>;
}

export class GitService implements IGitService {
  async clone(cloneUrl: string, repoPath: string, accessToken: string | null, defaultBranch: string): Promise<void> {
    return cloneRepository(cloneUrl, repoPath, accessToken, defaultBranch);
  }

  async createBranch(repoPath: string, branchName: string): Promise<void> {
    return createBranch(repoPath, branchName);
  }

  async commitAndPush(repoPath: string, branchName: string, taskTitle: string, accessToken: string | null = null): Promise<CommitPushResult> {
    return commitAndPush(repoPath, branchName, taskTitle, accessToken);
  }

  async createPullRequest(fullName: string, branchName: string, defaultBranch: string, taskTitle: string, taskDescription: string | null, accessToken: string | null): Promise<PullRequestResult> {
    return createPullRequest(fullName, branchName, defaultBranch, taskTitle, taskDescription, accessToken);
  }

  async hasChanges(repoPath: string): Promise<boolean> {
    return hasCommittableChanges(repoPath);
  }

  async stageChanges(repoPath: string): Promise<boolean> {
    return stageCommittableChanges(repoPath);
  }
}

export const gitService = new GitService();
