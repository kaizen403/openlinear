import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLocalWorktree, releaseLocalWorktree, withRepoLock } from './local-worktree';

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('local-worktree real git', () => {
  let root: string;
  let origin: string;
  let seed: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ol-wt-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OPENLINEAR_ALLOW_FILE_GIT', '1');
    vi.stubEnv('OPENLINEAR_APP_DATA', root);
    vi.stubEnv('REPOS_DIR', '');
    origin = join(root, 'origin.git');
    // Deliberately leave bare HEAD pointing to an absent default branch.
    git(root, ['init', '--bare', '--initial-branch=unused', origin]);
    seed = join(root, 'seed');
    mkdirSync(seed);
    git(seed, ['init']);
    writeFileSync(join(seed, 'README.md'), 'initial\n');
    git(seed, ['add', '.']);
    git(seed, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'init']);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-u', 'origin', 'HEAD:main']);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function acquire(runId: string, overrides: Partial<Parameters<typeof acquireLocalWorktree>[0]> = {}) {
    return acquireLocalWorktree({ owner: 'acme', name: 'repo', cloneUrl: origin, baseRef: 'main', runId, accessToken: null, ...overrides });
  }

  it('serializes eight acquires against a bare origin with no valid HEAD', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => acquire(`run-${i}`)));
    const handles = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(new Set(handles.map((h) => h.worktreePath)).size).toBe(8);
    for (const handle of handles) {
      expect(readFileSync(join(handle.worktreePath, 'README.md'), 'utf8')).toBe('initial\n');
      await releaseLocalWorktree(handle);
      expect(existsSync(handle.worktreePath)).toBe(false);
    }
  });

  it('refreshes the warm base while preserving an existing attempt checkout', async () => {
    const first = await acquire('first');
    const originalHead = git(first.worktreePath, ['rev-parse', 'HEAD']);
    writeFileSync(join(seed, 'README.md'), 'advanced\n');
    git(seed, ['add', '.']);
    git(seed, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'advance']);
    git(seed, ['push']);
    const second = await acquire('second');
    expect(readFileSync(join(second.worktreePath, 'README.md'), 'utf8')).toBe('advanced\n');
    expect(git(second.worktreePath, ['rev-parse', 'HEAD'])).toBe(git(seed, ['rev-parse', 'HEAD']));
    expect(git(first.worktreePath, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(git(first.mirrorPath, ['show-ref', '--verify', `refs/heads/${first.branch}`])).toContain(originalHead);
  });

  it('does not delete an existing attempt on duplicate acquisition', async () => {
    const first = await acquire('repeat');
    writeFileSync(join(first.worktreePath, 'unsaved.txt'), 'keep this');
    await expect(acquire('repeat')).rejects.toThrow('already exists');
    expect(readFileSync(join(first.worktreePath, 'unsaved.txt'), 'utf8')).toBe('keep this');
  });

  it('rejects traversal and symlinked paths before creating a checkout', async () => {
    await expect(acquire('../escape')).rejects.toThrow('Invalid run ID');
    await expect(acquire('valid', { owner: '../../escape' })).rejects.toThrow('Invalid repository owner');
    await expect(acquire('valid', { name: '/absolute' })).rejects.toThrow('Invalid repository name');
    mkdirSync(join(root, 'repos'), { recursive: true });
    symlinkSync(seed, join(root, 'repos', 'worktrees'), 'dir');
    await expect(acquire('valid')).rejects.toThrow('Symlink');
    expect(existsSync(join(seed, 'valid'))).toBe(false);
  });

  it('surfaces a fetch failure and releases the lock without an unhandled rejection', async () => {
    const first = await acquire('first');
    await expect(acquire('failed', { cloneUrl: join(root, 'absent.git') })).rejects.toThrow();
    const retry = await acquire('retry');
    expect(git(retry.worktreePath, ['rev-parse', 'HEAD'])).toBe(git(first.worktreePath, ['rev-parse', 'HEAD']));
  });

  it('rejects a deleted remote base instead of falling back to its stale local branch', async () => {
    git(seed, ['tag', 'main']);
    git(seed, ['push', 'origin', 'refs/tags/main']);
    await acquire('before-delete');
    git(seed, ['push', 'origin', '--delete', 'refs/heads/main']);
    await expect(acquire('after-delete')).rejects.toThrow('Base ref does not resolve');
    expect(existsSync(join(root, 'repos', 'worktrees', 'after-delete'))).toBe(false);
  });

  it('refreshes explicit tags and refuses deleted tags', async () => {
    git(seed, ['tag', 'release']);
    git(seed, ['push', 'origin', 'refs/tags/release']);
    const initial = await acquire('tag-initial', { baseRef: 'refs/tags/release' });
    writeFileSync(join(seed, 'README.md'), 'new release\n');
    git(seed, ['add', '.']);
    git(seed, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'release']);
    git(seed, ['tag', '-f', 'release']);
    git(seed, ['push', '--force', 'origin', 'refs/tags/release']);
    const updated = await acquire('tag-updated', { baseRef: 'refs/tags/release' });
    expect(git(updated.worktreePath, ['rev-parse', 'HEAD'])).not.toBe(git(initial.worktreePath, ['rev-parse', 'HEAD']));
    git(seed, ['push', 'origin', '--delete', 'refs/tags/release']);
    await expect(acquire('tag-deleted', { baseRef: 'refs/tags/release' })).rejects.toThrow('Base ref does not resolve');
  });

  it('accepts valid repository names with leading and repeated dots', async () => {
    for (const [index, name] of ['.github', '_repo', 'foo..bar'].entries()) {
      const handle = await acquire(`name-${index}`, { name });
      expect(readFileSync(join(handle.worktreePath, 'README.md'), 'utf8')).toBe('initial\n');
      await releaseLocalWorktree(handle);
    }
  });

  it('materializes a filtered mirror through a file transport that honors blob filtering', async () => {
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    const handle = await acquire('filtered', { cloneUrl: pathToFileURL(origin).href });
    expect(git(handle.mirrorPath, ['config', 'remote.origin.partialclonefilter'])).toBe('blob:none');
    expect(readFileSync(join(handle.worktreePath, 'README.md'), 'utf8')).toBe('initial\n');
    await releaseLocalWorktree(handle);
  });

  it('refuses a forged release path and retains work when inspection is requested', async () => {
    const handle = await acquire('owned');
    await expect(releaseLocalWorktree({ ...handle, worktreePath: seed })).rejects.toThrow('outside');
    expect(existsSync(join(seed, 'README.md'))).toBe(true);
    await releaseLocalWorktree(handle, { keepForInspection: true });
    expect(existsSync(handle.worktreePath)).toBe(true);
    await releaseLocalWorktree(handle);
    await releaseLocalWorktree(handle);
    expect(existsSync(handle.worktreePath)).toBe(false);
  });

  it('releases a dissociated checkout without deleting the shared mirror', async () => {
    const handle = await acquire('standalone', { dissociate: true });
    expect(readFileSync(join(handle.worktreePath, 'README.md'), 'utf8')).toBe('initial\n');
    await releaseLocalWorktree(handle);
    expect(existsSync(handle.worktreePath)).toBe(false);
    expect(existsSync(handle.mirrorPath)).toBe(true);
  });

  it('withRepoLock runs exclusive critical sections even after failure', async () => {
    const log: number[] = [];
    await Promise.all([
      withRepoLock('k', async () => {
        log.push(1);
        await new Promise((r) => setTimeout(r, 20));
        log.push(2);
        throw new Error('expected failure');
      }).catch(() => undefined),
      withRepoLock('k', async () => { log.push(3); log.push(4); }),
    ]);
    expect(log).toEqual([1, 2, 3, 4]);
  });
});
