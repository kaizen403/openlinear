import { lstatSync, mkdirSync, realpathSync, type Stats } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { homedir } from 'os';

function defaultReposDir(): string {
  const home = homedir();

  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'OpenLinear', 'repos');
  }

  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, 'OpenLinear', 'repos');
  }

  const xdgDataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(xdgDataHome, 'openlinear', 'repos');
}

export const REPOS_DIR = process.env.REPOS_DIR || defaultReposDir();

/**
 * Resolves symlinks with the OS-native realpath, walking up to the nearest
 * existing ancestor when the full path (or an internal segment) doesn't
 * exist yet — e.g. a clone destination that hasn't been created. The
 * not-yet-existing tail is joined back on lexically once a real ancestor is
 * found, so containment checks still work against a target `git clone` is
 * about to create. See C6a F10.
 */
function realpathOrNearestAncestor(targetPath: string): string {
  const resolved = resolve(targetPath);
  const missingSegments: string[] = [];
  let current = resolved;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = realpathSync.native(current);
      return missingSegments.length === 0 ? real : join(real, ...missingSegments.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }

      const parent = dirname(current);
      if (parent === current) {
        // Hit the filesystem root without resolving anything real — fall
        // back to the lexical resolution rather than looping forever.
        return resolved;
      }

      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

function ensureReposDirIsSafe(dir: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return;
    }
    throw err;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`[Sidecar] Refusing to use ${dir} as REPOS_DIR: it is a symlink`);
  }

  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`[Sidecar] Refusing to use ${dir} as REPOS_DIR: not owned by the current user`);
  }
}

let resolvedReposDirReal: string | null = null;

/**
 * Refuses a symlinked or other-owned repo storage directory, creating it
 * privately (0700) if it doesn't exist yet (C6a F9), and returns its real
 * path. Runs on first use rather than at import, so importing this module
 * (tests, evals, tooling) never creates the per-user app-data directory; the
 * sidecar calls it at boot so a bad directory still fails fast.
 */
export function assertReposDirSafe(): string {
  if (resolvedReposDirReal === null) {
    ensureReposDirIsSafe(REPOS_DIR);
    resolvedReposDirReal = realpathOrNearestAncestor(REPOS_DIR);
  }
  return resolvedReposDirReal;
}

export interface AssertPathInsideReposDirOptions {
  description?: string;
  /**
   * When false, the bare repository storage root itself is rejected even
   * though it is (trivially) "inside" itself. Destructive callers — anything
   * that eventually `rmSync`s the result — should set this to false so a bug
   * that resolves an empty/undefined path can never wipe out all of
   * REPOS_DIR. See C6a F21.
   */
  allowRoot?: boolean;
}

export function assertPathInsideReposDir(
  targetPath: string,
  options: AssertPathInsideReposDirOptions | string = {},
): string {
  const { description = 'repository path', allowRoot = true } =
    typeof options === 'string' ? { description: options } : options;

  const resolvedTarget = realpathOrNearestAncestor(targetPath);
  const rel = relative(assertReposDirSafe(), resolvedTarget);
  const isRoot = rel === '';
  const isInside = !isRoot && !rel.startsWith('..') && !isAbsolute(rel);

  if (isRoot && !allowRoot) {
    throw new Error(`[Sidecar] Refusing ${description}: repository storage root is not a valid target`);
  }

  if (isRoot || isInside) {
    return resolvedTarget;
  }

  throw new Error(`[Sidecar] Refusing ${description} outside repository storage`);
}

export function buildReposPath(...segments: string[]): string {
  return assertPathInsideReposDir(join(REPOS_DIR, ...segments));
}
