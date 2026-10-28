import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalWorkspace } from '../run/workspace';
import { fakeSnapshot } from '../run/test-support';
import { acquireLocalFolderCheckout, releaseLocalWorktree } from './local-worktree';

/**
 * W08a with real git: a local-folder project runs in an isolated clone; the
 * user's folder — checked-out branch, working tree, index, branch list,
 * worktree metadata — is never modified, and the clone is self-contained.
 */

let root = '';

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-local-folder-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim();
}

let counter = 0;

function userRepo(options: { origin?: string | null; dirty?: boolean } = {}) {
  counter += 1;
  const path = join(root, `user-${counter}`);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'app.txt'), 'v1\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'base');
  if (options.origin !== null) git(path, 'remote', 'add', 'origin', options.origin ?? 'https://github.com/acme/app.git');
  if (options.dirty) writeFileSync(join(path, 'app.txt'), 'uncommitted edit\n');
  return { path, head: git(path, 'rev-parse', 'HEAD') };
}

function useReposRoot(): string {
  const repos = join(root, `repos-${counter}`);
  vi.stubEnv('REPOS_DIR', repos);
  return repos;
}

describe('W08a isolated checkouts for local-folder projects', () => {
  it('works in its own clone at the folder HEAD and never touches the folder', async () => {
    const user = userRepo({ dirty: true });
    const repos = useReposRoot();
    const before = { branch: git(user.path, 'branch', '--show-current'), branches: git(user.path, 'branch', '--list'), status: git(user.path, 'status', '--porcelain') };

    const handle = await acquireLocalFolderCheckout({ localPath: user.path, runId: 'run-a' });
    expect(handle).toMatchObject({ worktreePath: join(repos, 'worktrees', 'run-a'), branch: 'openlinear/run-a', baseCommit: user.head, dissociated: true, sourceDirty: true, origin: 'https://github.com/acme/app.git' });
    expect(git(handle.worktreePath, 'branch', '--show-current')).toBe('openlinear/run-a');
    expect(git(handle.worktreePath, 'rev-parse', 'HEAD')).toBe(user.head);
    expect(git(handle.worktreePath, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/app.git');
    // Committed content only: the folder's uncommitted edit is not in the run.
    expect(readFileSync(join(handle.worktreePath, 'app.txt'), 'utf8')).toBe('v1\n');
    // Self-contained: no alternates into the user's object store.
    expect(existsSync(join(handle.worktreePath, '.git', 'objects', 'info', 'alternates'))).toBe(false);

    // The agent works and commits in the clone.
    writeFileSync(join(handle.worktreePath, 'feature.txt'), 'new\n');
    git(handle.worktreePath, 'add', '-A');
    git(handle.worktreePath, 'commit', '-q', '-m', 'agent');

    // The user's folder is exactly as it was.
    expect(git(user.path, 'branch', '--show-current')).toBe(before.branch);
    expect(git(user.path, 'branch', '--list')).toBe(before.branches);
    expect(git(user.path, 'status', '--porcelain')).toBe(before.status);
    expect(readFileSync(join(user.path, 'app.txt'), 'utf8')).toBe('uncommitted edit\n');
    expect(existsSync(join(user.path, 'feature.txt'))).toBe(false);
    expect(git(user.path, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(user.path, 'rev-parse', 'HEAD')).toBe(user.head);

    await releaseLocalWorktree(handle);
    expect(existsSync(handle.worktreePath)).toBe(false);
    expect(existsSync(user.path)).toBe(true);
  });

  it('a folder without a remote gets a clone without one; a clean folder is not flagged', async () => {
    const user = userRepo({ origin: null });
    useReposRoot();
    const handle = await acquireLocalFolderCheckout({ localPath: user.path, runId: 'run-b' });
    expect(handle).toMatchObject({ sourceDirty: false, origin: null });
    expect(git(handle.worktreePath, 'remote')).toBe('');
  });

  it('refuses a relative path, a sub-folder of the repository, and a folder inside OpenLinear storage', async () => {
    const user = userRepo();
    const repos = useReposRoot();
    await expect(acquireLocalFolderCheckout({ localPath: 'relative/path', runId: 'run-c' })).rejects.toThrow(/must be absolute/);
    mkdirSync(join(user.path, 'sub'), { recursive: true });
    await expect(acquireLocalFolderCheckout({ localPath: join(user.path, 'sub'), runId: 'run-c' })).rejects.toThrow(/repository root/);
    mkdirSync(join(repos, 'inside'), { recursive: true });
    await expect(acquireLocalFolderCheckout({ localPath: join(repos, 'inside'), runId: 'run-c' })).rejects.toThrow(/inside OpenLinear storage/);
  });

  it('the run engine workspace port uses it for local projects (owned, released like any run checkout)', async () => {
    const user = userRepo({ dirty: true });
    const repos = useReposRoot();
    const port = createLocalWorkspace();
    const workspace = await port.acquire({ runId: 'run-d', snapshot: fakeSnapshot('task-d', { localPath: user.path, repository: null }), token: null });
    expect(workspace).toMatchObject({ worktreePath: join(repos, 'worktrees', 'run-d'), branch: 'openlinear/run-d', owned: true, baseCommit: user.head, sourceDirty: true });
    expect(await port.inspectRetained(workspace)).toEqual({ ok: true });
    await port.release(workspace);
    expect(existsSync(workspace.worktreePath)).toBe(false);
    expect(git(user.path, 'branch', '--show-current')).toBe('main');
  });
});
