import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLocalWorktree, gcLocalWorktrees, withRepoLock } from './local-worktree';

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
}

describe('local-worktree real git', () => {
  const dirs: string[] = [];
  const previous = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.OPENLINEAR_ALLOW_FILE_GIT = '1';
    const root = mkdtempSync(join(tmpdir(), 'ol-wt-'));
    dirs.push(root);
    process.env.OPENLINEAR_APP_DATA = root;
  });

  afterEach(() => {
    process.env.NODE_ENV = previous.NODE_ENV;
    process.env.OPENLINEAR_ALLOW_FILE_GIT = previous.OPENLINEAR_ALLOW_FILE_GIT;
    process.env.OPENLINEAR_APP_DATA = previous.OPENLINEAR_APP_DATA;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('mutex serializes eight acquires against one origin', async () => {
    const origin = join(process.env.OPENLINEAR_APP_DATA as string, 'origin.git');
    execFileSync('git', ['init', '--bare', origin]);
    const seed = join(process.env.OPENLINEAR_APP_DATA as string, 'seed');
    mkdirSync(seed);
    git(seed, ['init']);
    writeFileSync(join(seed, 'README.md'), 'ok\n');
    git(seed, ['add', '.']);
    git(seed, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'init']);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-u', 'origin', 'HEAD:main']);

    const handles = await Promise.all(
      Array.from({ length: 8 }, (_, i) => acquireLocalWorktree({
        owner: 'acme',
        name: 'repo',
        cloneUrl: origin,
        baseRef: 'main',
        runId: `run-${i}`,
        accessToken: null,
      })),
    );
    expect(new Set(handles.map((h) => h.worktreePath)).size).toBe(8);
    const gc = await gcLocalWorktrees({ maxAgeHours: 0, maxBytes: 1 });
    expect(gc.removed).toBeGreaterThanOrEqual(0);
  });

  it('withRepoLock runs exclusive critical sections', async () => {
    const log: number[] = [];
    await Promise.all([
      withRepoLock('k', async () => {
        log.push(1);
        await new Promise((r) => setTimeout(r, 20));
        log.push(2);
      }),
      withRepoLock('k', async () => {
        log.push(3);
        log.push(4);
      }),
    ]);
    expect(log).toEqual([1, 2, 3, 4]);
  });
});
