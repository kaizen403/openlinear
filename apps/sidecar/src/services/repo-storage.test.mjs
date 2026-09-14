import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

// repo-storage.ts performs real fs checks (lstat/mkdir) at import time —
// point REPOS_DIR at a private, real (non-symlinked) temp dir before
// importing so the module under test never touches the real per-user app
// data directory during tests, and so realpath-based comparisons inside the
// module agree with the lexical `resolve()` calls used below (macOS aliases
// /tmp -> /private/tmp, which would otherwise make every equality check
// below flaky).
const testReposDir = mkdtempSync(join(realpathSync(tmpdir()), 'openlinear-repo-storage-test-'));
process.env.REPOS_DIR = testReposDir;

const { REPOS_DIR, assertPathInsideReposDir, buildReposPath } = await import('./repo-storage');

const cleanupDirs = [testReposDir];
afterAll(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('repo storage path safety', () => {
  it('builds paths inside repository storage', () => {
    expect(buildReposPath('project-1', '.main')).toBe(resolve(REPOS_DIR, 'project-1', '.main'));
  });

  it('allows the repository root and descendants', () => {
    expect(assertPathInsideReposDir(REPOS_DIR)).toBe(resolve(REPOS_DIR));
    expect(assertPathInsideReposDir(resolve(REPOS_DIR, 'project-1'))).toBe(resolve(REPOS_DIR, 'project-1'));
  });

  it('rejects traversal outside repository storage', () => {
    expect(() => assertPathInsideReposDir(resolve(REPOS_DIR, '..', 'outside'), 'test path')).toThrow(
      '[Sidecar] Refusing test path outside repository storage',
    );
  });

  it('still accepts a string as the description for backwards compatibility', () => {
    expect(assertPathInsideReposDir(REPOS_DIR, 'root path')).toBe(resolve(REPOS_DIR));
  });

  it('allows the bare repository root by default', () => {
    expect(assertPathInsideReposDir(REPOS_DIR)).toBe(resolve(REPOS_DIR));
  });

  it('refuses the bare repository root for destructive callers', () => {
    expect(() => assertPathInsideReposDir(REPOS_DIR, { allowRoot: false })).toThrow(
      '[Sidecar] Refusing repository path: repository storage root is not a valid target',
    );
    expect(() =>
      assertPathInsideReposDir(REPOS_DIR, { description: 'worktree path', allowRoot: false }),
    ).toThrow('[Sidecar] Refusing worktree path: repository storage root is not a valid target');
  });

  it('resolves a path that does not exist yet against the nearest existing ancestor', () => {
    const target = join(REPOS_DIR, 'brand-new-project', 'not-created-yet');
    expect(assertPathInsideReposDir(target)).toBe(resolve(target));
  });

  it('rejects a symlink that escapes repository storage', () => {
    const outsideDir = mkdtempSync(join(realpathSync(tmpdir()), 'openlinear-repo-storage-outside-'));
    cleanupDirs.push(outsideDir);
    const linkPath = join(REPOS_DIR, 'escape-link');
    symlinkSync(outsideDir, linkPath);
    cleanupDirs.push(linkPath);

    expect(() => assertPathInsideReposDir(join(linkPath, 'evil'), 'escaping path')).toThrow(
      '[Sidecar] Refusing escaping path outside repository storage',
    );
    // Even a path through the symlink that doesn't exist yet must still be
    // caught — the symlink itself is what's resolved, not just the final
    // (missing) segment.
    expect(() =>
      assertPathInsideReposDir(join(linkPath, 'not-created-yet', 'nested'), 'escaping path'),
    ).toThrow('[Sidecar] Refusing escaping path outside repository storage');
  });

  it('rejects a symlink pointing directly at the repos dir itself when used as a destructive target', () => {
    // A symlink *inside* REPOS_DIR that resolves back to something outside
    // (e.g. an attacker-controlled ".." escape hidden behind a nested link)
    // must not be trusted just because assertPathInsideReposDir was called
    // on it once — every call re-resolves from scratch.
    const outsideDir = mkdtempSync(join(realpathSync(tmpdir()), 'openlinear-repo-storage-outside-'));
    cleanupDirs.push(outsideDir);
    const nestedDir = join(REPOS_DIR, 'nested-project');
    symlinkSync(outsideDir, nestedDir);
    cleanupDirs.push(nestedDir);

    expect(() => assertPathInsideReposDir(nestedDir, { allowRoot: false })).toThrow(
      '[Sidecar] Refusing repository path outside repository storage',
    );
  });
});
