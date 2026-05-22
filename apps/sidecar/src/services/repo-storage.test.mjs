import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { REPOS_DIR, assertPathInsideReposDir, buildReposPath } from './repo-storage';

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
});
