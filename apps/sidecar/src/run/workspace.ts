import { existsSync } from 'node:fs';
import { FOLLOW_UP_LIMITS, type PreviousWork } from '@openlinear/execution-core';
import { HttpError } from '../lib/errors';
import { assertSafeCloneUrl, assertSafeRefName, execGit } from '../services/git-credentials';
import { acquireLocalFolderCheckout, acquireLocalWorktree, releaseLocalWorktree } from '../workspace/local-worktree';
import type { RunSnapshot, RunWorkspace } from './types';

/**
 * Workspace acquisition for a run. Remote repositories get an owned
 * worktree at `<repos>/worktrees/<runId>` on branch `openlinear/<runId>`
 * (deterministic from the run id, so a restarted sidecar finds it). A
 * project's `localPath` gets the same layout from an isolated clone of the
 * folder at its HEAD (W08a); the user's checkout is never modified.
 */
export type RetainedWorkspaceCheck =
  | { ok: true }
  | { ok: false; reason: 'worktree_missing' | 'not_a_checkout' | 'branch_changed'; detail?: string };

export interface WorkspacePort {
  acquire(input: { runId: string; snapshot: RunSnapshot; token: string | null }): Promise<RunWorkspace>;
  /** Remove an owned checkout: nothing was written into it (setup failure), or the W11a retention sweep expired it. */
  release(workspace: RunWorkspace): Promise<void>;
  exists(workspace: RunWorkspace): boolean;
  /**
   * W07a follow-up: whether an earlier run's workspace is still usable —
   * the checkout exists and still has the run's branch checked out.
   */
  inspectRetained(workspace: RunWorkspace): Promise<RetainedWorkspaceCheck>;
  /**
   * W07a follow-up: adopt an earlier run's workspace for a new turn (same
   * worktree, same branch). The adopted record is never released by the new
   * run (`continuedFrom`).
   */
  adopt(input: { parentRunId: string; workspace: RunWorkspace }): Promise<RunWorkspace>;
  /** W07a seeded follow-up: the work an earlier session left in the worktree. */
  diff(workspace: RunWorkspace): Promise<PreviousWork>;
}

const DIFF_MAX_BUFFER = 8 * 1024 * 1024;

async function currentBranch(worktree: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

async function resolveCommit(worktree: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(['-C', worktree, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The merge base of HEAD with the run's base branch (remote-tracking first), or null. */
export async function previousWorkBase(worktree: string, baseRef: string | null): Promise<string | null> {
  const candidates = baseRef
    ? [`refs/remotes/origin/${assertSafeRefName(baseRef, 'base ref')}`, `refs/heads/${baseRef}`]
    : ['refs/remotes/origin/HEAD'];
  for (const candidate of candidates) {
    const commit = await resolveCommit(worktree, candidate);
    if (!commit) continue;
    try {
      const { stdout } = await execGit(['-C', worktree, 'merge-base', 'HEAD', commit]);
      const sha = stdout.trim();
      if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
    } catch {
      // Unrelated histories: try the next candidate.
    }
  }
  return null;
}

export async function inspectRetainedWorkspace(workspace: RunWorkspace): Promise<RetainedWorkspaceCheck> {
  if (!existsSync(workspace.worktreePath)) return { ok: false, reason: 'worktree_missing' };
  const branch = await currentBranch(workspace.worktreePath);
  if (branch === null) return { ok: false, reason: 'not_a_checkout' };
  if (branch !== workspace.branch) return { ok: false, reason: 'branch_changed', detail: `checked out: ${branch}` };
  return { ok: true };
}

export async function collectPreviousWork(workspace: RunWorkspace): Promise<PreviousWork> {
  const worktree = workspace.worktreePath;
  const base = await previousWorkBase(worktree, workspace.baseRef);
  let diff = '';
  let truncated = false;
  try {
    const { stdout } = await execGit(['-C', worktree, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', base ?? 'HEAD', '--'], { maxBuffer: DIFF_MAX_BUFFER });
    diff = stdout;
  } catch {
    diff = '(the diff is too large to include; inspect the files in the worktree)';
    truncated = true;
  }
  if (diff.length > FOLLOW_UP_LIMITS.diffMaxChars) {
    diff = `${diff.slice(0, FOLLOW_UP_LIMITS.diffMaxChars)}\n… [diff truncated]`;
    truncated = true;
  }
  let untracked: string[] = [];
  try {
    const { stdout } = await execGit(['-C', worktree, 'ls-files', '--others', '--exclude-standard', '-z'], { maxBuffer: DIFF_MAX_BUFFER });
    untracked = stdout.split('\0').filter(Boolean).sort();
  } catch {
    untracked = [];
  }
  return { base: base ? base.slice(0, 12) : null, diff, truncated, untracked };
}

function repositoryIdentity(cloneUrl: string): { owner: string; name: string } {
  const parsed = new URL(cloneUrl.startsWith('/') ? `file://${cloneUrl}` : cloneUrl);
  const parts = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  const name = parts.pop() ?? 'repo';
  const owner = parts.pop() ?? 'local';
  return { owner, name };
}

export function createLocalWorkspace(): WorkspacePort {
  return {
    async acquire(input) {
      if (input.snapshot.localPath) {
        // W08a: an isolated clone of the folder at its HEAD (the user's checkout is never modified).
        const handle = await acquireLocalFolderCheckout({ localPath: input.snapshot.localPath, runId: input.runId });
        return {
          worktreePath: handle.worktreePath,
          branch: handle.branch,
          baseRef: null,
          owned: true,
          handle: { runId: handle.runId, mirrorPath: handle.mirrorPath, dissociated: true },
          baseCommit: handle.baseCommit ?? null,
          sourceDirty: handle.sourceDirty,
        };
      }
      const repository = input.snapshot.repository;
      if (!repository) throw new Error('No repository is linked to this task');
      assertSafeCloneUrl(repository.cloneUrl, 'clone URL');
      const { owner, name } = repositoryIdentity(repository.cloneUrl);
      const handle = await acquireLocalWorktree({
        owner,
        name,
        cloneUrl: repository.cloneUrl,
        baseRef: repository.defaultBranch,
        runId: input.runId,
        accessToken: input.token,
      });
      return {
        worktreePath: handle.worktreePath,
        branch: handle.branch,
        baseRef: repository.defaultBranch,
        owned: true,
        handle: { runId: handle.runId, mirrorPath: handle.mirrorPath, dissociated: handle.dissociated === true },
        baseCommit: handle.baseCommit && /^[0-9a-f]{40,64}$/.test(handle.baseCommit) ? handle.baseCommit : null,
      };
    },

    async release(workspace) {
      if (!workspace.owned || !workspace.handle) return;
      await releaseLocalWorktree({
        kind: 'local-worktree',
        runId: workspace.handle.runId,
        worktreePath: workspace.worktreePath,
        mirrorPath: workspace.handle.mirrorPath,
        branch: workspace.branch,
        ...(workspace.handle.dissociated ? { dissociated: true } : {}),
      });
    },

    exists(workspace) {
      return existsSync(workspace.worktreePath);
    },

    inspectRetained: inspectRetainedWorkspace,

    async adopt(input) {
      const check = await inspectRetainedWorkspace(input.workspace);
      if (!check.ok) {
        throw new HttpError(409, 'FOLLOW_UP_UNSUPPORTED', 'The previous run\'s worktree is no longer usable for a follow-up', {
          reason: check.reason,
          ...(check.detail ? { detail: check.detail } : {}),
        });
      }
      return { ...input.workspace, continuedFrom: input.workspace.continuedFrom ?? input.parentRunId };
    },

    diff: collectPreviousWork,
  };
}
