import { mkdirSync, existsSync, rmSync, statSync, readdirSync, statfsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execGit, execGitWithCredentials, assertSafeCloneUrl, assertSafeRefName } from '../services/git-credentials';
import { logger } from '@openlinear/api/logger';

export interface WorkspaceHandle {
  kind: 'local-worktree';
  runId: string;
  worktreePath: string;
  mirrorPath: string;
  branch: string;
}

export interface GcPolicy {
  maxAgeHours: number;
  maxBytes: number;
}

const repoMutexes = new Map<string, Promise<void>>();
const inFlightFetch = new Map<string, Promise<void>>();

function appReposDir(): string {
  const root = process.env.OPENLINEAR_APP_DATA
    ?? join(homedir(), 'Library', 'Application Support', 'OpenLinear');
  return join(root, 'repos');
}

async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoMutexes.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  repoMutexes.set(key, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function acquireLocalWorktree(input: {
  owner: string;
  name: string;
  cloneUrl: string;
  baseRef: string;
  runId: string;
  accessToken: string | null;
  dissociate?: boolean;
}): Promise<WorkspaceHandle> {
  assertSafeCloneUrl(input.cloneUrl, 'clone URL');
  assertSafeRefName(input.baseRef, 'base ref');
  const reposRoot = appReposDir();
  mkdirSync(reposRoot, { recursive: true, mode: 0o700 });
  try {
    const disk = statfsSync(reposRoot);
    const free = Number(disk.bavail) * Number(disk.bsize);
    if (free < 512 * 1024 * 1024) {
      throw new Error('[worktree] Not enough disk space for a local worktree (need 512MB)');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Not enough disk space')) throw err;
  }
  const key = `${input.owner}/${input.name}`;
  const mirrorPath = join(reposRoot, input.owner, `${input.name}.git`);

  return withRepoLock(key, async () => {
    if (!existsSync(mirrorPath)) {
      mkdirSync(join(reposRoot, input.owner), { recursive: true, mode: 0o700 });
      await execGitWithCredentials(
        ['clone', '--bare', '--filter=blob:none', '--', input.cloneUrl, mirrorPath],
        input.accessToken,
        input.cloneUrl,
      );
    } else {
      let fetch = inFlightFetch.get(key);
      if (!fetch) {
        fetch = execGitWithCredentials(
          ['-C', mirrorPath, 'fetch', '--prune', '--', 'origin'],
          input.accessToken,
          input.cloneUrl,
        ).then(() => undefined);
        inFlightFetch.set(key, fetch);
        void fetch.finally(() => inFlightFetch.delete(key));
      }
      await fetch;
    }

    const branch = `openlinear/${input.runId}`;
    const worktreePath = join(reposRoot, 'worktrees', input.runId);
    mkdirSync(join(reposRoot, 'worktrees'), { recursive: true, mode: 0o700 });
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }

    if (input.dissociate) {
      await execGitWithCredentials(
        ['clone', '--reference', mirrorPath, '--dissociate', '--', input.cloneUrl, worktreePath],
        input.accessToken,
        input.cloneUrl,
      );
      await execGit(['-C', worktreePath, 'checkout', '-B', branch, input.baseRef]);
    } else {
      await execGit(['-C', mirrorPath, 'worktree', 'add', '--no-checkout', '-b', branch, '--', worktreePath, input.baseRef]);
      await execGit(['-C', worktreePath, 'reset', '--hard', input.baseRef]);
    }

    return {
      kind: 'local-worktree',
      runId: input.runId,
      worktreePath,
      mirrorPath,
      branch,
    };
  });
}

export async function releaseLocalWorktree(handle: WorkspaceHandle, opts?: { keepForInspection?: boolean }): Promise<void> {
  if (opts?.keepForInspection) return;
  try {
    await execGit(['-C', handle.mirrorPath, 'worktree', 'remove', '--force', handle.worktreePath]);
  } catch {
    if (existsSync(handle.worktreePath)) {
      rmSync(handle.worktreePath, { recursive: true, force: true });
    }
  }
}

export async function gcLocalWorktrees(policy: GcPolicy): Promise<{ removed: number }> {
  const worktrees = join(appReposDir(), 'worktrees');
  if (!existsSync(worktrees)) return { removed: 0 };
  const cutoff = Date.now() - policy.maxAgeHours * 3600_000;
  let removed = 0;
  for (const entry of readdirSync(worktrees)) {
    const path = join(worktrees, entry);
    try {
      const st = statSync(path);
      if (st.mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
        removed += 1;
      }
    } catch (err) {
      logger.debug({ err, path }, '[worktree] gc skip');
    }
  }
  return { removed };
}

export { withRepoLock };
