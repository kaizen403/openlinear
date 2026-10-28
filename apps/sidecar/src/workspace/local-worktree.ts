import { mkdirSync, existsSync, rmSync, statSync, readdirSync, statfsSync, lstatSync, realpathSync } from 'fs';
import { join, resolve, relative, isAbsolute, dirname } from 'path';
import { homedir } from 'os';
import { execGit, execGitWithCredentials, assertSafeCloneUrl, assertSafeRefName } from '../services/git-credentials';
import { logger } from '../lib/logger';

export interface WorkspaceHandle {
  kind: 'local-worktree';
  runId: string;
  worktreePath: string;
  mirrorPath: string;
  branch: string;
  dissociated?: boolean;
  /** W11a: the base commit the checkout was created at (before any agent change). */
  baseCommit?: string;
}

export interface GcPolicy {
  maxAgeHours: number;
  maxBytes: number;
}

const repoMutexes = new Map<string, Promise<void>>();

/** Root of the sidecar's repository storage (mirrors, `worktrees/`, `verify/`). */
export function appReposDir(): string {
  if (process.env.REPOS_DIR) return resolve(process.env.REPOS_DIR);
  const root = process.env.OPENLINEAR_APP_DATA ?? (
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'OpenLinear')
      : process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenLinear')
        : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'openlinear')
  );
  return resolve(root, 'repos');
}

function assertSegment(value: string, label: string, repositoryName = false): void {
  const valid = repositoryName
    ? /^[a-zA-Z0-9._-]+$/.test(value) && value !== '.' && value !== '..'
    : /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && !value.includes('..');
  if (!valid) {
    throw new Error(`[worktree] Invalid ${label}`);
  }
}

// Reject symlink aliases as well as lexical escapes before Git or recursive removal.
function assertOwnedPath(root: string, target: string): void {
  const rel = relative(root, resolve(target));
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('[worktree] Path is outside the repository root');
  }
  let current = resolve(target);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('[worktree] Symlink paths are not allowed');
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
    }
    if (current === root) break;
    current = dirname(current);
  }
}

async function resolveBaseCommit(mirrorPath: string, baseRef: string): Promise<string> {
  const branch = baseRef.replace(/^refs\/heads\//, '');
  const pinnedCommit = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(baseRef);
  if (baseRef.startsWith('refs/') && !baseRef.startsWith('refs/heads/') && !baseRef.startsWith('refs/tags/')) {
    throw new Error('[worktree] Base ref must be a remote branch, explicit tag or commit');
  }
  const candidate = pinnedCommit || baseRef.startsWith('refs/tags/') ? baseRef : `refs/remotes/origin/${branch}`;
  try {
    const result = await execGit(['-C', mirrorPath, 'rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`]);
    return result.stdout.trim();
  } catch {
    // A missing branch must not silently select a same-name tag or stale local head.
    throw new Error(`[worktree] Base ref does not resolve to a commit: ${baseRef}`);
  }
}

async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoMutexes.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  repoMutexes.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (repoMutexes.get(key) === tail) repoMutexes.delete(key);
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
  assertSegment(input.owner, 'repository owner');
  assertSegment(input.name, 'repository name', true);
  assertSegment(input.runId, 'run ID');
  const reposRoot = appReposDir();
  const mirrorPath = join(reposRoot, input.owner, `${input.name}.git`);
  const worktreePath = join(reposRoot, 'worktrees', input.runId);
  assertOwnedPath(reposRoot, mirrorPath);
  assertOwnedPath(reposRoot, worktreePath);
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
  return withRepoLock(mirrorPath, async () => {
    assertOwnedPath(reposRoot, mirrorPath);
    assertOwnedPath(reposRoot, worktreePath);
    if (existsSync(worktreePath)) throw new Error('[worktree] Run workspace already exists');
    if (!existsSync(mirrorPath)) {
      mkdirSync(join(reposRoot, input.owner), { recursive: true, mode: 0o700 });
      await execGitWithCredentials(
        ['clone', '--bare', '--filter=blob:none', '--', input.cloneUrl, mirrorPath],
        input.accessToken,
        input.cloneUrl,
      );
    }
    // Bare clones have no default fetch refspec and origin HEAD may be unset.
    // Keep fetched heads separate from branches checked out by active attempts.
    await execGitWithCredentials(
      ['-C', mirrorPath, 'fetch', '--prune', '--no-tags', '--', input.cloneUrl, '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'],
      input.accessToken,
      input.cloneUrl,
    );
    const baseCommit = await resolveBaseCommit(mirrorPath, input.baseRef);

    const branch = `openlinear/${input.runId}`;
    mkdirSync(join(reposRoot, 'worktrees'), { recursive: true, mode: 0o700 });

    if (input.dissociate) {
      await execGitWithCredentials(
        ['clone', '--reference', mirrorPath, '--dissociate', '--', input.cloneUrl, worktreePath],
        input.accessToken,
        input.cloneUrl,
      );
      try {
        await execGitWithCredentials(['-C', worktreePath, 'checkout', '-b', branch, baseCommit], input.accessToken, input.cloneUrl);
      } catch (err) {
        assertOwnedPath(reposRoot, worktreePath);
        rmSync(worktreePath, { recursive: true, force: true });
        throw err;
      }
    } else {
      await execGit(['-C', mirrorPath, 'worktree', 'add', '--no-checkout', '-b', branch, '--', worktreePath, baseCommit]);
      try {
        // A blobless mirror can lazily fetch private blobs while materializing.
        await execGitWithCredentials(['-C', worktreePath, 'reset', '--hard', baseCommit], input.accessToken, input.cloneUrl);
      } catch (err) {
        await execGit(['-C', mirrorPath, 'worktree', 'remove', '--force', worktreePath]).catch((cleanupError: unknown) => {
          logger.warn({ err: cleanupError, worktreePath }, '[worktree] Failed acquisition retained for inspection');
        });
        throw err;
      }
    }

    return {
      kind: 'local-worktree',
      runId: input.runId,
      worktreePath,
      mirrorPath,
      branch,
      baseCommit,
      ...(input.dissociate ? { dissociated: true } : {}),
    };
  });
}

/**
 * W08a: an isolated checkout for a local-folder project. The run works in
 * its own clone at `<repos>/worktrees/<runId>` on `openlinear/<runId>`,
 * started from the folder's current HEAD; the user's working tree, index and
 * checked-out branch are never touched. A local clone hard-links the
 * folder's objects (no alternates — the agent sandbox reads only its own
 * checkout, and `git gc` in the folder can't break the run), copying them
 * only across filesystems. The clone's `origin` is the folder's own `origin`
 * (so push / pull request behave as before); without one, the clone has no
 * remote. Uncommitted changes in the folder are not part of the run
 * (`sourceDirty` says when there were some).
 */
export async function acquireLocalFolderCheckout(input: { localPath: string; runId: string }): Promise<WorkspaceHandle & { sourceDirty: boolean; origin: string | null }> {
  assertSegment(input.runId, 'run ID');
  if (!isAbsolute(input.localPath)) throw new Error('[worktree] Local project path must be absolute');
  const reposRoot = appReposDir();
  const worktreePath = join(reposRoot, 'worktrees', input.runId);
  assertOwnedPath(reposRoot, worktreePath);
  let source: string;
  try {
    source = realpathSync(input.localPath);
  } catch {
    throw new Error('[worktree] Local project folder does not exist');
  }
  const rel = relative(reposRoot, source);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('[worktree] Local project folder lies inside OpenLinear storage');
  const { stdout: top } = await execGit(['-C', source, 'rev-parse', '--show-toplevel']);
  if (realpathSync(top.trim()) !== source) throw new Error('[worktree] Local project path must be the repository root');
  const { stdout: head } = await execGit(['-C', source, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  const baseCommit = head.trim();
  const { stdout: status } = await execGit(['-C', source, 'status', '--porcelain', '--untracked-files=normal'], { maxBuffer: 4 * 1024 * 1024 });
  let origin: string | null = null;
  try {
    origin = (await execGit(['-C', source, 'remote', 'get-url', 'origin'])).stdout.trim() || null;
  } catch {
    origin = null;
  }
  mkdirSync(join(reposRoot, 'worktrees'), { recursive: true, mode: 0o700 });
  return withRepoLock(worktreePath, async () => {
    if (existsSync(worktreePath)) throw new Error('[worktree] Run workspace already exists');
    // A local clone is the `file` transport, which the hardening disables by
    // default; this one call reads the user's own folder.
    await execGit(['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--local', '--no-checkout', '--no-tags', '--', source, worktreePath]);
    try {
      const branch = `openlinear/${input.runId}`;
      await execGit(['-C', worktreePath, 'checkout', '--quiet', '-b', branch, baseCommit]);
      if (origin) await execGit(['-C', worktreePath, 'remote', 'set-url', 'origin', origin]);
      else await execGit(['-C', worktreePath, 'remote', 'remove', 'origin']);
      return {
        kind: 'local-worktree' as const,
        runId: input.runId,
        worktreePath,
        // A standalone clone: it is its own repository (release removes the directory).
        mirrorPath: worktreePath,
        branch,
        baseCommit,
        dissociated: true,
        sourceDirty: status.trim().length > 0,
        origin,
      };
    } catch (err) {
      assertOwnedPath(reposRoot, worktreePath);
      rmSync(worktreePath, { recursive: true, force: true });
      throw err;
    }
  });
}

export async function releaseLocalWorktree(handle: WorkspaceHandle, opts?: { keepForInspection?: boolean }): Promise<void> {
  if (opts?.keepForInspection) return;
  const root = appReposDir();
  assertSegment(handle.runId, 'run ID');
  assertOwnedPath(root, handle.mirrorPath);
  assertOwnedPath(root, handle.worktreePath);
  if (resolve(handle.worktreePath) !== join(root, 'worktrees', handle.runId)) {
    throw new Error('[worktree] Handle does not match its run workspace');
  }
  await withRepoLock(handle.mirrorPath, async () => {
    assertOwnedPath(root, handle.worktreePath);
    if (!existsSync(handle.worktreePath)) return;
    const { stdout } = await execGit(['-C', handle.worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const expectedCommonDir = handle.dissociated ? join(handle.worktreePath, '.git') : handle.mirrorPath;
    if (realpathSync(stdout.trim()) !== realpathSync(expectedCommonDir)) {
      throw new Error('[worktree] Workspace is not owned by this mirror');
    }
    if (handle.dissociated) {
      rmSync(handle.worktreePath, { recursive: true, force: true });
    } else {
      await execGit(['-C', handle.mirrorPath, 'worktree', 'remove', '--force', handle.worktreePath]);
    }
  });
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
