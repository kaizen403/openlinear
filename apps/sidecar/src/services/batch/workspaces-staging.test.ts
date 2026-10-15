import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertStagingAllowlist, assertStagedAllowlist } from '../../engine/staging-allowlist';
import { hasCommittableChanges, stageCommittableChanges } from '../execution/git';
import { execGit } from '../git-credentials';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('batch workspace and staging with real Git', () => {
  let root: string;
  let seed: string;
  let origin: string;
  let storage: string;
  let worktrees: typeof import('../worktree');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ol-w01-git-'));
    storage = join(root, 'storage');
    mkdirSync(storage);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OPENLINEAR_ALLOW_FILE_GIT', '1');
    vi.stubEnv('REPOS_DIR', storage);
    origin = join(root, 'origin.git');
    git(root, ['init', '--bare', '--initial-branch=unused', origin]);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    seed = join(root, 'seed');
    mkdirSync(seed);
    git(seed, ['init']);
    writeFileSync(join(seed, 'README.md'), 'initial\n');
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ scripts: { test: 'echo test' }, dependencies: {} }));
    mkdirSync(join(seed, '.github'));
    writeFileSync(join(seed, '.github', 'old.yml'), 'baseline');
    mkdirSync(join(seed, 'packages', 'nested'), { recursive: true });
    writeFileSync(join(seed, 'packages', 'nested', 'package.json'), JSON.stringify({ scripts: { test: 'echo nested' } }));
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'fixture']);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-u', 'origin', 'HEAD:main']);
    vi.resetModules();
    worktrees = await import('../worktree');
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it('uses fresh remote heads even when a bare origin HEAD is invalid', async () => {
    await worktrees.ensureMainRepo('repository', pathToFileURL(origin).href, null);
    const first = await worktrees.createWorktree('repository', 'attempt-first', 'same-task', 'main', null, pathToFileURL(origin).href);
    const original = git(first, ['rev-parse', 'HEAD']);
    writeFileSync(join(seed, 'README.md'), 'advanced\n');
    git(seed, ['add', '.']); git(seed, ['commit', '-m', 'advance']); git(seed, ['push']);
    await worktrees.ensureMainRepo('repository', pathToFileURL(origin).href, null);
    const second = await worktrees.createWorktree('repository', 'attempt-second', 'same-task', 'main', null, pathToFileURL(origin).href);
    expect(readFileSync(join(second, 'README.md'), 'utf8')).toBe('advanced\n');
    expect(git(first, ['rev-parse', 'HEAD'])).toBe(original);
    expect(git(first, ['branch', '--show-current'])).not.toBe(git(second, ['branch', '--show-current']));
  });

  it('retains failed-attempt edits on same-task retry and refuses duplicate checkout allocation', async () => {
    await worktrees.ensureMainRepo('repository', pathToFileURL(origin).href, null);
    const first = await worktrees.createWorktree('repository', 'old-attempt', 'same-task', 'main');
    writeFileSync(join(first, 'unpublished.txt'), 'preserve');
    await expect(worktrees.createWorktree('repository', 'old-attempt', 'same-task', 'main')).rejects.toThrow('already exists');
    const second = await worktrees.createWorktree('repository', 'new-attempt', 'same-task', 'main');
    expect(readFileSync(join(first, 'unpublished.txt'), 'utf8')).toBe('preserve');
    expect(existsSync(join(second, 'unpublished.txt'))).toBe(false);
    expect(git(first, ['status', '--porcelain'])).toContain('unpublished.txt');
  });

  it('serializes actual concurrent checkouts and publishes only an absent remote branch', async () => {
    await worktrees.ensureMainRepo('repository', pathToFileURL(origin).href, null);
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => worktrees.createWorktree('repository', 'batch', `task-${index}`, 'main')));
    for (const result of outcomes) if (result.status === 'rejected') throw result.reason;
    const branch = 'openlinear/publication';
    await worktrees.createBatchBranch('repository', branch, 'main');
    await worktrees.pushBranch('repository', branch, pathToFileURL(origin).href, null);
    writeFileSync(join(seed, 'README.md'), 'concurrent writer\n');
    git(seed, ['add', '.']); git(seed, ['commit', '-m', 'concurrent']); git(seed, ['push']);
    git(origin, ['update-ref', `refs/heads/${branch}`, git(seed, ['rev-parse', 'HEAD'])]);
    const published = git(origin, ['rev-parse', `refs/heads/${branch}`]);
    await expect(worktrees.pushBranch('repository', branch, pathToFileURL(origin).href, null)).rejects.toThrow();
    expect(git(origin, ['rev-parse', `refs/heads/${branch}`])).toBe(published);
  });

  it('blocks quoted and newline-bearing workflow filenames', async () => {
    for (const name of ['file with spaces.yml', 'quote".yml', 'line\nbreak.yml']) {
      writeFileSync(join(seed, '.github', name), 'blocked');
      await expect(assertStagingAllowlist(seed)).rejects.toThrow('.github');
      rmSync(join(seed, '.github', name));
    }
  });

  it('checks both sides of a rename from a protected directory', async () => {
    git(seed, ['mv', '.github/old.yml', 'ordinary.yml']);
    await expect(assertStagingAllowlist(seed)).rejects.toThrow('.github');
    await expect(assertStagedAllowlist(seed)).rejects.toThrow('.github');
  });

  it('gates nested script changes and script-removing deletions', async () => {
    const nested = join(seed, 'packages', 'nested', 'package.json');
    writeFileSync(nested, JSON.stringify({ scripts: { test: 'run-dangerous-command' } }));
    await expect(stageCommittableChanges(seed)).rejects.toThrow('scripts');
    git(seed, ['checkout', '--', 'packages/nested/package.json']);
    rmSync(nested);
    await expect(assertStagingAllowlist(seed)).rejects.toThrow('scripts');
  });

  it('validates the staged snapshot independently of working tree content', async () => {
    const nested = join(seed, 'packages', 'nested', 'package.json');
    writeFileSync(nested, JSON.stringify({ scripts: { test: 'changed-command' } }));
    git(seed, ['add', 'packages/nested/package.json']);
    writeFileSync(nested, JSON.stringify({ scripts: { test: 'echo nested' } }));
    await expect(assertStagingAllowlist(seed)).resolves.toBeUndefined();
    await expect(assertStagedAllowlist(seed)).rejects.toThrow('scripts');
  });

  it('rejects symlink package manifests without following an external file', async () => {
    const nested = join(seed, 'packages', 'nested', 'package.json');
    rmSync(nested);
    const external = join(root, 'external.json');
    writeFileSync(external, JSON.stringify({ scripts: { test: 'private' } }));
    symlinkSync(external, nested);
    await expect(assertStagingAllowlist(seed)).rejects.toThrow('symlinks');
  });

  it('stages ordinary odd filenames, excludes runtime files and disables commit hooks', async () => {
    const filename = 'quoted "name" with\nnewline -> literal.txt';
    writeFileSync(join(seed, filename), 'ordinary code');
    mkdirSync(join(seed, '.sisyphus'));
    writeFileSync(join(seed, '.sisyphus', 'session.txt'), 'runtime only');
    expect(await hasCommittableChanges(seed)).toBe(true);
    expect(await stageCommittableChanges(seed)).toBe(true);
    const staged = git(seed, ['diff', '--cached', '--name-only', '-z']);
    expect(staged).toContain(filename);
    expect(staged).not.toContain('.sisyphus');
    const marker = join(root, 'hook-ran');
    const hook = join(seed, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\nprintf attempted > '${marker}'\n`);
    chmodSync(hook, 0o700);
    await execGit(['-C', seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'safe wrapper']);
    expect(existsSync(marker)).toBe(false);
  });
});
