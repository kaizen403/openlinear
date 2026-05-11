import { join, relative, resolve, isAbsolute } from 'path';

export const REPOS_DIR = process.env.REPOS_DIR || '/tmp/openlinear-repos';

const resolvedReposDir = resolve(REPOS_DIR);

export function assertPathInsideReposDir(targetPath: string, description = 'repository path'): string {
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedReposDir, resolvedTarget);

  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return resolvedTarget;
  }

  throw new Error(`[Sidecar] Refusing ${description} outside repository storage`);
}

export function buildReposPath(...segments: string[]): string {
  return assertPathInsideReposDir(join(REPOS_DIR, ...segments));
}
