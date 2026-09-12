import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execGit } from '../services/git-credentials';

const BLOCKED_PREFIXES = ['.github/', '.git/hooks/', 'hooks/'];
const BLOCKED_EXACT = new Set(['.github']);

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

export function isBlockedPath(path: string, policy: StagingPolicy = {}): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!policy.allowGithubDir && (BLOCKED_EXACT.has(normalized) || BLOCKED_PREFIXES.some((p) => normalized === p.slice(0, -1) || normalized.startsWith(p)))) {
    if (normalized === '.github' || normalized.startsWith('.github/')) {
      return 'modifying .github/ requires explicit opt-in';
    }
  }
  if (!policy.allowHooks && (normalized.startsWith('.git/hooks/') || normalized.startsWith('hooks/'))) {
    return 'git hooks require explicit opt-in';
  }
  return null;
}

function scriptsChanged(before: string | null, after: string | null): boolean {
  if (!after) return false;
  try {
    const prev = before ? (JSON.parse(before) as { scripts?: Record<string, string> }).scripts ?? {} : {};
    const next = (JSON.parse(after) as { scripts?: Record<string, string> }).scripts ?? {};
    return JSON.stringify(prev) !== JSON.stringify(next);
  } catch {
    return true;
  }
}

export async function assertStagingAllowlist(repoPath: string, policy: StagingPolicy = {}): Promise<void> {
  const { stdout } = await execGit(['-C', repoPath, 'status', '--porcelain', '--untracked-files=all']);
  const paths = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim().replace(/\\/g, '/').split(' -> ').pop() ?? '');

  for (const path of paths) {
    const reason = isBlockedPath(path, policy);
    if (reason) throw new StagingBlockedError(path, reason);
  }

  if (!policy.allowPackageScripts && paths.includes('package.json')) {
    let before: string | null = null;
    try {
      const { stdout: head } = await execGit(['-C', repoPath, 'show', 'HEAD:package.json']);
      before = head;
    } catch {
      before = null;
    }
    let after: string | null = null;
    try {
      after = readFileSync(join(repoPath, 'package.json'), 'utf8');
    } catch {
      after = null;
    }
    if (scriptsChanged(before, after)) {
      throw new StagingBlockedError('package.json', 'package.json#scripts changes require opt-in + approval');
    }
  }
}
