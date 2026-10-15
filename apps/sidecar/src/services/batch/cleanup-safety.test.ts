import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [
    '-c', 'init.defaultBranch=main', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('batch cleanup preserves retained artifacts with real Git', () => {
  let root: string;
  let storage: string;
  let originUrl: string;
  let main: string;
  let worktrees: typeof import('../worktree');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ol-batch-cleanup-'));
    storage = join(root, 'storage');
    mkdirSync(storage);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OPENLINEAR_ALLOW_FILE_GIT', '1');
    vi.stubEnv('REPOS_DIR', storage);

    const origin = join(root, 'origin.git');
    git(root, ['init', '--bare', '--initial-branch=main', origin]);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    const seed = join(root, 'seed');
    mkdirSync(seed);
    git(seed, ['init']);
    writeFileSync(join(seed, 'README.md'), 'initial fixture\n');
    git(seed, ['add', 'README.md']);
    git(seed, ['commit', '-m', 'fixture']);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-u', 'origin', 'main']);
    originUrl = pathToFileURL(origin).href;
    vi.resetModules();
    worktrees = await import('../worktree');
    main = await worktrees.ensureMainRepo('repository', originUrl, null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function checkout(batchId = 'attempt', taskId = 'task'): Promise<string> {
    return worktrees.createWorktree('repository', batchId, taskId, 'main', null, originUrl);
  }

  it('surfaces a locked worktree removal failure without deleting its files or registration', async () => {
    const path = await checkout();
    const marker = join(path, 'unpublished.txt');
    writeFileSync(marker, 'retained changes');
    git(main, ['worktree', 'lock', '--reason', 'retain unpublished changes', path]);

    await expect(worktrees.removeWorktree('repository', path)).rejects.toThrow();

    expect(readFileSync(marker, 'utf8')).toBe('retained changes');
    const registered = git(main, ['worktree', 'list', '--porcelain']);
    expect(registered).toContain(`worktree ${path}`);
    expect(registered).toContain('locked retain unpublished changes');
  });

  it('does not recursively erase a batch when a registered worktree refuses cleanup', async () => {
    const path = await checkout();
    const marker = join(path, 'unpublished.txt');
    const retainedNote = join(dirname(path), 'retention-note.txt');
    writeFileSync(marker, 'retained changes');
    writeFileSync(retainedNote, 'inspect before cleanup');
    git(main, ['worktree', 'lock', '--reason', 'retained batch', path]);

    await expect(worktrees.cleanupBatch('repository', 'attempt')).rejects.toThrow();

    expect(readFileSync(marker, 'utf8')).toBe('retained changes');
    expect(readFileSync(retainedNote, 'utf8')).toBe('inspect before cleanup');
    expect(git(main, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${path}`);
  });

  it('preserves the batch if Git cannot enumerate its worktrees', async () => {
    const path = await checkout();
    const marker = join(path, 'unpublished.txt');
    const retainedNote = join(dirname(path), 'retention-note.txt');
    writeFileSync(marker, 'retained changes');
    writeFileSync(retainedNote, 'enumeration failed');
    const savedMain = `${main}-retained`;
    renameSync(main, savedMain);
    // An existing directory that is not a Git repository exercises a real
    // worktree-list failure, rather than a mock returning an empty list.
    mkdirSync(main);
    try {
      await expect(worktrees.listWorktrees('repository')).rejects.toThrow();
      await expect(worktrees.cleanupBatch('repository', 'attempt')).rejects.toThrow();
      expect(readFileSync(marker, 'utf8')).toBe('retained changes');
      expect(readFileSync(retainedNote, 'utf8')).toBe('enumeration failed');
    } finally {
      rmSync(main, { recursive: true, force: true });
      renameSync(savedMain, main);
    }
    expect(git(main, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${path}`);
  });

  it('removes a registered checkout but retains unknown files in its batch directory', async () => {
    const path = await checkout();
    const retainedNote = join(dirname(path), 'unowned-artifact.txt');
    writeFileSync(retainedNote, 'not owned by worktree cleanup');

    await expect(worktrees.cleanupBatch('repository', 'attempt')).rejects.toThrow();

    expect(existsSync(path)).toBe(false);
    expect(readFileSync(retainedNote, 'utf8')).toBe('not owned by worktree cleanup');
    expect(git(main, ['worktree', 'list', '--porcelain'])).not.toContain(`worktree ${path}`);
  });

  it('preserves an existing merge directory and leaves the target branch unchanged', async () => {
    const path = await checkout();
    const taskBranch = git(path, ['branch', '--show-current']);
    writeFileSync(join(path, 'README.md'), 'candidate fixture\n');
    git(path, ['add', 'README.md']);
    git(path, ['commit', '-m', 'candidate changes']);
    const targetBranch = 'openlinear/merge-target';
    await worktrees.createBatchBranch('repository', targetBranch, 'main');
    const original = git(main, ['rev-parse', targetBranch]);
    const mergePath = join(storage, 'repository', `merge-temp-${taskBranch.replace(/[^A-Za-z0-9._-]+/g, '-')}`);
    mkdirSync(mergePath);
    const marker = join(mergePath, 'retained-merge.txt');
    writeFileSync(marker, 'previous merge attempt');

    await expect(worktrees.mergeBranch('repository', taskBranch, targetBranch)).resolves.toBe(false);

    expect(readFileSync(marker, 'utf8')).toBe('previous merge attempt');
    expect(git(main, ['rev-parse', targetBranch])).toBe(original);
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('candidate fixture\n');
  });

  it('still cleans an owned batch completely while preserving a neighboring attempt', async () => {
    const owned = await checkout();
    const neighbor = await checkout('another-attempt', 'another-task');
    const marker = join(neighbor, 'unpublished.txt');
    writeFileSync(marker, 'other attempt');

    await expect(worktrees.cleanupBatch('repository', 'attempt')).resolves.toBeUndefined();

    expect(existsSync(owned)).toBe(false);
    expect(existsSync(dirname(owned))).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('other attempt');
    const registered = git(main, ['worktree', 'list', '--porcelain']);
    expect(registered).not.toContain(`worktree ${owned}`);
    expect(registered).toContain(`worktree ${neighbor}`);
  });
});
