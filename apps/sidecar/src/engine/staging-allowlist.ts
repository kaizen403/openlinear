import { readFileSync, lstatSync } from 'node:fs';
import { join, posix } from 'node:path';
import { execGit } from '../services/git-credentials';

export interface StagingPolicy {
  allowGithubDir?: boolean;
  allowHooks?: boolean;
  allowPackageScripts?: boolean;
}
export class StagingBlockedError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`Refusing to stage ${path}: ${reason}`);
    this.name = 'StagingBlockedError';
  }
}

export interface GitStatusEntry { code: string; path: string; originalPath?: string }

/** -z paths are literal; do not trim, unquote, or split on arrows/newlines. */
export function parseGitStatusPorcelainZ(stdout: string): GitStatusEntry[] {
  if (!stdout) return [];
  const records = stdout.split('\0');
  if (records.pop() !== '') throw new Error('Git status did not return NUL-terminated paths');
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ' || !record.slice(3) || record.includes('\ufffd')) throw new Error('Invalid Git status path record');
    const entry: GitStatusEntry = { code: record.slice(0, 2), path: record.slice(3) };
    if (entry.code.includes('R') || entry.code.includes('C')) {
      const original = records[++index];
      if (!original || original.includes('\ufffd')) throw new Error('Invalid Git rename/copy source');
      entry.originalPath = original;
    }
    entries.push(entry);
  }
  return entries;
}

export function isBlockedPath(path: string, policy: StagingPolicy = {}): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (!policy.allowGithubDir && (normalized === '.github' || normalized.startsWith('.github/'))) {
    return 'modifying .github/ requires explicit opt-in';
  }
  if (!policy.allowHooks && (normalized === 'hooks' || normalized.startsWith('.git/hooks/') || normalized.startsWith('hooks/'))) {
    return 'git hooks require explicit opt-in';
  }
  return null;
}

function scriptsChanged(before: string | null, after: string | null): boolean {
  try {
    const previous = before ? (JSON.parse(before) as { scripts?: unknown }).scripts ?? {} : {};
    const next = after ? (JSON.parse(after) as { scripts?: unknown }).scripts ?? {} : {};
    return JSON.stringify(previous) !== JSON.stringify(next);
  } catch { return true; }
}

async function checkPaths(repoPath: string, paths: string[], policy: StagingPolicy, index: boolean): Promise<void> {
  for (const path of paths) {
    const reason = isBlockedPath(path, policy);
    if (reason) throw new StagingBlockedError(path, reason);
    if (policy.allowPackageScripts || posix.basename(path).toLowerCase() !== 'package.json') continue;
    let before: string | null = null;
    try { before = (await execGit(['-C', repoPath, 'show', `HEAD:${path}`])).stdout; }
    catch { /* A newly added manifest has no HEAD version. */ }
    let after: string | null = null;
    if (index) {
      try { after = (await execGit(['-C', repoPath, 'show', `:${path}`])).stdout; }
      catch { /* A staged deletion has no index version. */ }
    } else {
      try {
        if (lstatSync(join(repoPath, path)).isSymbolicLink()) throw new StagingBlockedError(path, 'package manifest symlinks require explicit opt-in');
        after = readFileSync(join(repoPath, path), 'utf8');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    if (scriptsChanged(before, after)) throw new StagingBlockedError(path, 'package.json#scripts changes require opt-in + approval');
  }
}

export async function assertStagingAllowlist(repoPath: string, policy: StagingPolicy = {}): Promise<void> {
  const { stdout } = await execGit(['-C', repoPath, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = parseGitStatusPorcelainZ(stdout);
  await checkPaths(repoPath, entries.flatMap((entry) => entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]), policy, false);
}

export async function assertStagedAllowlist(repoPath: string, policy: StagingPolicy = {}): Promise<string[]> {
  // Disable rename detection so both deleted source and added destination are checked.
  const { stdout } = await execGit(['-C', repoPath, 'diff', '--cached', '--no-renames', '--name-only', '-z']);
  if (!stdout) return [];
  const paths = stdout.split('\0');
  if (paths.pop() !== '' || paths.some((path) => !path || path.includes('\ufffd'))) throw new Error('Invalid staged Git path list');
  await checkPaths(repoPath, paths, policy, true);
  return paths;
}
