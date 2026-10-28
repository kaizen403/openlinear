import { EFFECT_COMMIT_TRAILER, commitCarriesEffect } from '@openlinear/execution-core';
import { assertSafeCloneUrl, assertSafeRefName, execGit, execGitWithCredentials } from '../services/git-credentials';
import { getGitIdentityEnv } from '../services/git-identity';
import { githubApiBase, isGithubPullRequestUrl, publishGithubPullRequest } from '../services/github-publication';
import { hasCommittableChanges, stageCommittableChanges } from '../services/execution/git';
import { previousWorkBase } from './workspace';

/**
 * Publication effects of a run, split so each one can be journaled and
 * reconciled on its own (W05a effect ledger):
 *
 * - commit: the commit message carries `OpenLinear-Effect: <key>`, so the
 *   commit is its own receipt (`findCommit`).
 * - push: the remote ref at the intended commit is the receipt
 *   (`remoteSha`); a repeated push of the same commit with the same lease
 *   is idempotent.
 * - pull request: an open PR for the branch is the receipt
 *   (`findPullRequest`); creation reuses the W01 POST-then-reconcile path
 *   and is never retried blindly.
 */
export interface CommitInput {
  worktree: string;
  title: string;
  runId: string;
  key: string;
}

export type CommitResult = { status: 'committed'; sha: string } | { status: 'no_changes' };

export interface PublicationPort {
  commit(input: CommitInput): Promise<CommitResult>;
  /** The HEAD commit when it carries the effect trailer, else null. */
  findCommit(input: { worktree: string; key: string }): Promise<string | null>;
  /** The remote branch's commit, or null when the branch does not exist. */
  remoteSha(input: { worktree: string; branch: string; token: string | null }): Promise<string | null>;
  push(input: { worktree: string; branch: string; sha: string; token: string | null; expectedRemote: string | null }): Promise<void>;
  findPullRequest(input: { fullName: string; branch: string; base: string; token: string | null }): Promise<string | null>;
  createPullRequest(input: { fullName: string; branch: string; base: string; title: string; body: string; token: string | null }): Promise<string>;
  /**
   * W07a: whether `ancestor` is an ancestor of `descendant` in the worktree
   * (false when either commit is unknown locally). A follow-up's push may
   * only fast-forward the run branch from a commit it built on.
   */
  isAncestor(input: { worktree: string; ancestor: string; descendant: string }): Promise<boolean>;
  /**
   * W07a: HEAD of the worktree and whether it carries commits beyond the
   * base (null when the base cannot be resolved). A follow-up that changed
   * nothing still publishes earlier unpublished commits.
   */
  branchHead(input: { worktree: string; baseRef: string | null }): Promise<{ sha: string | null; ahead: boolean | null }>;
}

export function commitMessage(title: string, runId: string, key: string): string {
  const subject = `feat: ${title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().slice(0, 50) || 'openlinear task'}`;
  return `${subject}\n\nOpenLinear-Run: ${runId}\n${EFFECT_COMMIT_TRAILER}: ${key}\n`;
}

async function originUrl(worktree: string): Promise<string> {
  const { stdout } = await execGit(['-C', worktree, 'remote', 'get-url', 'origin']);
  // W09a: origin is read from a repository the agent worked in; never hand
  // the token to a host other than the allowlisted Git host.
  return assertSafeCloneUrl(stdout.trim(), 'origin URL');
}

const SHA = /^[0-9a-f]{40,64}$/;

export function createGitPublication(): PublicationPort {
  return {
    async commit(input) {
      if (!(await hasCommittableChanges(input.worktree))) return { status: 'no_changes' };
      if (!(await stageCommittableChanges(input.worktree))) return { status: 'no_changes' };
      await execGit(['-C', input.worktree, 'commit', '-m', commitMessage(input.title, input.runId, input.key)], { env: getGitIdentityEnv() });
      const { stdout } = await execGit(['-C', input.worktree, 'rev-parse', 'HEAD']);
      return { status: 'committed', sha: stdout.trim() };
    },

    async findCommit(input) {
      const { stdout } = await execGit(['-C', input.worktree, 'log', '-1', '--format=%H%x00%B']);
      const [sha, ...body] = stdout.split('\0');
      return sha && commitCarriesEffect(body.join('\0'), input.key) ? sha.trim() : null;
    },

    async remoteSha(input) {
      const branch = assertSafeRefName(input.branch, 'branch');
      const url = await originUrl(input.worktree);
      const { stdout } = await execGitWithCredentials(['-C', input.worktree, 'ls-remote', 'origin', `refs/heads/${branch}`], input.token, url);
      const line = stdout.split('\n').find((candidate) => candidate.trim().endsWith(`refs/heads/${branch}`));
      const sha = line?.split(/\s+/)[0]?.trim();
      return sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
    },

    async push(input) {
      const branch = assertSafeRefName(input.branch, 'branch');
      if (!/^[0-9a-f]{40,64}$/.test(input.sha)) throw new Error('push: invalid commit id');
      const url = await originUrl(input.worktree);
      // Absent-target or exact-SHA lease: never clobber a concurrent writer.
      await execGitWithCredentials(
        ['-C', input.worktree, 'push', `--force-with-lease=${branch}:${input.expectedRemote ?? ''}`, 'origin', '--', `${input.sha}:refs/heads/${branch}`],
        input.token,
        url,
        { env: getGitIdentityEnv() },
      );
    },

    async findPullRequest(input) {
      if (!input.token) return null;
      const [owner, repo] = input.fullName.split('/');
      if (!owner || !repo) return null;
      const query = new URLSearchParams({ head: `${owner}:${input.branch}`, base: input.base, state: 'open' });
      const response = await fetch(`${githubApiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query.toString()}`, {
        headers: { Authorization: `Bearer ${input.token}`, Accept: 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`GitHub pull request lookup failed (HTTP ${response.status})`);
      const data: unknown = await response.json();
      if (!Array.isArray(data)) return null;
      for (const item of data) {
        if (item && typeof item === 'object' && 'html_url' in item && isGithubPullRequestUrl(item.html_url, input.fullName)) return item.html_url;
      }
      return null;
    },

    async createPullRequest(input) {
      return publishGithubPullRequest({
        fullName: input.fullName,
        branchName: input.branch,
        defaultBranch: input.base,
        title: input.title,
        body: input.body,
        accessToken: input.token,
      });
    },

    async isAncestor(input) {
      if (!SHA.test(input.ancestor) || !SHA.test(input.descendant)) return false;
      try {
        await execGit(['-C', input.worktree, 'merge-base', '--is-ancestor', input.ancestor, input.descendant]);
        return true;
      } catch {
        // Exit 1 (not an ancestor) or an unknown commit: never fast-forward over it.
        return false;
      }
    },

    async branchHead(input) {
      let sha: string | null = null;
      try {
        const { stdout } = await execGit(['-C', input.worktree, 'rev-parse', 'HEAD']);
        sha = SHA.test(stdout.trim()) ? stdout.trim() : null;
      } catch {
        return { sha: null, ahead: null };
      }
      const base = await previousWorkBase(input.worktree, input.baseRef);
      if (!base || !sha) return { sha, ahead: null };
      return { sha, ahead: base !== sha };
    },
  };
}
