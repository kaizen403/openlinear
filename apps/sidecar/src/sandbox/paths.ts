import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** realpath when the path exists, otherwise the lexical absolute path. */
export function realpathOrResolve(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return resolve(target);
  }
}

/** True when `child` is `parent` or lies beneath it (lexical, after resolve). */
export function isWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Strict ancestors of `target`, root first: `/a/b/c` → ['/', '/a', '/a/b']. */
export function ancestorsOf(target: string): string[] {
  const out: string[] = [];
  let current = dirname(resolve(target));
  for (;;) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out.reverse();
}

/** Rejects paths that cannot be expressed safely in a sandbox profile. */
export function assertSafeSandboxPath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`[sandbox] ${label} must be absolute`);
  // Control characters have no business in a policy path and would make
  // profile/argv review ambiguous.
  for (let index = 0; index < path.length; index += 1) {
    if (path.charCodeAt(index) < 0x20 || path.charCodeAt(index) === 0x7f) {
      throw new Error(`[sandbox] ${label} contains control characters`);
    }
  }
  return path;
}

export function dedupePaths(paths: Iterable<string>): string[] {
  return [...new Set([...paths].map((path) => resolve(path)))].sort();
}

/** Drops paths that are already covered by another entry in the list. */
export function collapseNested(paths: Iterable<string>): string[] {
  const sorted = dedupePaths(paths);
  const kept: string[] = [];
  for (const path of sorted) {
    if (!kept.some((parent) => isWithin(path, parent))) kept.push(path);
  }
  return kept;
}

export interface GitMetadata {
  /** `<worktree>/.git` when present. */
  dotGit: string | null;
  dotGitKind: 'file' | 'dir' | 'symlink' | 'none';
  /** Resolved gitdir (per-worktree admin dir for linked worktrees). */
  gitDir: string | null;
  /** Resolved common dir (shared objects/refs/config). */
  commonDir: string | null;
}

function readSmallFile(path: string, limit = 4096): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const length = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolves `<worktree>/.git` (directory or `gitdir:` pointer file) and the
 * common dir without running git, so nothing in the agent-controlled tree is
 * executed or trusted beyond these two path reads.
 */
export function resolveGitMetadata(worktree: string): GitMetadata {
  const dotGit = join(worktree, '.git');
  let kind: GitMetadata['dotGitKind'] = 'none';
  try {
    const st = lstatSync(dotGit);
    kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'none';
  } catch {
    return { dotGit: null, dotGitKind: 'none', gitDir: null, commonDir: null };
  }
  if (kind === 'none') return { dotGit, dotGitKind: kind, gitDir: null, commonDir: null };
  // A symlinked .git could point anywhere; protect the link but grant nothing.
  if (kind === 'symlink') return { dotGit, dotGitKind: kind, gitDir: null, commonDir: null };
  if (kind === 'dir') {
    const real = realpathOrResolve(dotGit);
    return { dotGit, dotGitKind: kind, gitDir: real, commonDir: real };
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readSmallFile(dotGit));
  if (!match) return { dotGit, dotGitKind: kind, gitDir: null, commonDir: null };
  const gitDir = realpathOrResolve(resolve(worktree, match[1]));
  let commonDir = gitDir;
  const commonFile = join(gitDir, 'commondir');
  if (existsSync(commonFile)) {
    commonDir = realpathOrResolve(resolve(gitDir, readSmallFile(commonFile).trim()));
  }
  return { dotGit, dotGitKind: kind, gitDir, commonDir };
}

/**
 * Toolchain directories under HOME that may be read inside the sandbox when
 * they are on PATH. Keys are PATH entries relative to HOME (prefix match);
 * values are the directories that become readable. Credential files that
 * live next to toolchains (e.g. `~/.cargo/credentials.toml`) are never
 * covered: only `bin`-style subdirectories or self-contained install trees
 * are listed, and the mandatory deny list is applied after these anyway.
 */
const HOME_TOOLCHAINS: ReadonlyArray<{ match: string; roots: readonly string[] }> = [
  { match: '.opencode/bin', roots: ['.opencode/bin'] },
  { match: '.bun/bin', roots: ['.bun/bin'] },
  { match: '.cargo/bin', roots: ['.cargo/bin', '.rustup/toolchains', '.rustup/settings.toml'] },
  { match: '.nvm/versions/node', roots: [] },
  { match: '.volta/bin', roots: ['.volta/bin', '.volta/tools/image'] },
  { match: '.local/share/fnm', roots: ['.local/share/fnm'] },
  { match: '.fnm', roots: ['.fnm'] },
  { match: '.asdf/shims', roots: ['.asdf/shims', '.asdf/installs', '.asdf/lib', '.asdf/bin'] },
  { match: '.local/share/mise', roots: ['.local/share/mise/installs', '.local/share/mise/shims'] },
  { match: '.pyenv/shims', roots: ['.pyenv/shims', '.pyenv/versions', '.pyenv/libexec'] },
  { match: '.rbenv/shims', roots: ['.rbenv/shims', '.rbenv/versions', '.rbenv/libexec'] },
  { match: 'go/bin', roots: ['go/bin'] },
  { match: '.deno/bin', roots: ['.deno/bin'] },
  { match: 'Library/pnpm', roots: ['Library/pnpm'] },
  { match: '.local/share/pnpm', roots: ['.local/share/pnpm'] },
];

/** Directories outside HOME that must never become readable via PATH. */
function isVolatileDir(path: string, volatileRoots: readonly string[]): boolean {
  return volatileRoots.some((root) => isWithin(path, root));
}

export interface ToolchainResolution {
  /** Directories to add as read-only roots. */
  roots: string[];
  /** PATH entries kept (all of them readable inside the sandbox). */
  pathEntries: string[];
  /** PATH entries dropped because they are not readable inside the sandbox. */
  skipped: string[];
}

/**
 * Derives readable toolchain roots from PATH. Entries outside HOME contribute
 * their install prefix (`/opt/homebrew/bin` → `/opt/homebrew`); entries under
 * HOME only count when they belong to a known toolchain manager. Temp and
 * sidecar-state directories never qualify.
 */
export function resolveToolchainRoots(input: {
  pathEnv: string | undefined;
  home: string;
  volatileRoots: readonly string[];
  systemRoots: readonly string[];
}): ToolchainResolution {
  const roots = new Set<string>();
  const kept: string[] = [];
  const skipped: string[] = [];
  const home = realpathOrResolve(input.home);
  for (const raw of (input.pathEnv ?? '').split(':')) {
    if (!raw || !isAbsolute(raw)) continue;
    let entry: string;
    try {
      entry = realpathSync.native(raw);
      if (!statSync(entry).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isVolatileDir(entry, input.volatileRoots)) {
      skipped.push(raw);
      continue;
    }
    if (isWithin(entry, home)) {
      const rel = relative(home, entry).split(sep).join('/');
      const known = HOME_TOOLCHAINS.find((toolchain) => rel === toolchain.match || rel.startsWith(`${toolchain.match}/`));
      if (!known) {
        skipped.push(raw);
        continue;
      }
      if (known.match === '.nvm/versions/node') {
        // ~/.nvm/versions/node/<version>/bin → the version's install prefix.
        const parts = rel.split('/');
        if (parts.length >= 4) roots.add(join(home, ...parts.slice(0, 4)));
      }
      for (const root of known.roots) {
        const candidate = join(home, root);
        if (existsSync(candidate)) roots.add(realpathOrResolve(candidate));
      }
      roots.add(entry);
      kept.push(entry);
      continue;
    }
    if (input.systemRoots.some((root) => isWithin(entry, root))) {
      kept.push(entry);
      continue;
    }
    const name = basename(entry);
    const prefix = name === 'bin' || name === 'sbin' ? dirname(entry) : entry;
    if (prefix === '/' || isWithin(home, prefix)) {
      // A prefix that would expose `/` or a HOME ancestor is too broad.
      roots.add(entry);
    } else {
      roots.add(prefix);
    }
    kept.push(entry);
  }
  return { roots: [...roots], pathEntries: [...new Set(kept)], skipped };
}
