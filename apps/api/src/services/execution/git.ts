import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { PullRequestResult, REPOS_DIR } from './state';

const execAsync = promisify(exec);

export async function cloneRepository(
  cloneUrl: string,
  repoPath: string,
  accessToken: string | null,
  defaultBranch: string
): Promise<void> {
  console.log(`[Execution] Preparing to clone into ${repoPath}`);
  
  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true });
    console.log(`[Execution] Created repos directory: ${REPOS_DIR}`);
  }

  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
    console.log(`[Execution] Removed existing directory: ${repoPath}`);
  }

  const url = accessToken 
    ? cloneUrl.replace('https://', `https://oauth2:${accessToken}@`)
    : cloneUrl;
  
  console.log(`[Execution] Cloning ${cloneUrl} (branch: ${defaultBranch})...`);
  await execAsync(`git clone --depth 1 --branch ${defaultBranch} ${url} ${repoPath}`);
  await execAsync(`chmod -R a+rwX ${repoPath}`);
  console.log(`[Execution] Clone complete`);
}

export async function createBranch(repoPath: string, branchName: string): Promise<void> {
  console.log(`[Execution] Creating branch: ${branchName}`);
  await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath });
  console.log(`[Execution] Branch created and checked out`);
}

export async function commitAndPush(
  repoPath: string,
  branchName: string,
  taskTitle: string
): Promise<boolean> {
  try {
    console.log(`[Execution] Checking for changes in ${repoPath}`);
    const { stdout: status } = await execAsync('git status --porcelain', { cwd: repoPath });
    
    if (!status.trim()) {
      console.log(`[Execution] No changes to commit`);
      return false;
    }

    console.log(`[Execution] Changes detected, staging files...`);
    await execAsync('git add -A', { cwd: repoPath });
    
    const commitMessage = `feat: ${taskTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 50)}`;
    console.log(`[Execution] Committing: ${commitMessage}`);
    await execAsync(`git commit -m "${commitMessage}"`, { cwd: repoPath });
    
    console.log(`[Execution] Pushing to origin/${branchName}...`);
    // Force push is safe here: these are ephemeral task branches we create fresh each run
    await execAsync(`git push --force -u origin ${branchName}`, { cwd: repoPath });
    console.log(`[Execution] Push complete`);
    
    return true;
  } catch (error) {
    console.error('[Execution] Commit/push failed:', error);
    return false;
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
      // Return compare URL as fallback when API fails
      return { url: compareUrl, type: 'compare' };
    }

    const pr = (await response.json()) as { html_url: string };
    return { url: pr.html_url, type: 'pr' };
  } catch (error) {
    console.error('[Execution] PR creation error:', error);
    // Return compare URL as fallback on error
    return { url: compareUrl, type: 'compare' };
  }
}
