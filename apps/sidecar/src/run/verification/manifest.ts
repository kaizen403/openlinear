import { createHash } from 'node:crypto';
import {
  REPOSITORY_CHECKS_PATH,
  VERIFICATION_LIMITS,
  autoDetectChecks,
  canonicalJson,
  resolveVerificationManifest,
  type VerificationManifest,
} from '@openlinear/execution-core';
import { execGit } from '../../services/git-credentials';
import type { RunSnapshot, RunWorkspace } from '../types';

/**
 * W11a: resolve the run's verification manifest BEFORE the agent runs, from
 * inputs the agent cannot touch:
 *
 * - the project's settings, issued by the control plane with the attempt
 *   snapshot;
 * - `.openlinear/checks.json` read from the workspace's BASE COMMIT object
 *   (`git cat-file`), never the working tree — a follow-up whose worktree
 *   holds the agent's edits still grades with the base copy;
 * - opt-in auto-detection over the base commit's package.json/lockfiles.
 *
 * Every git call goes through the hardened helper (W09a: config scan, no
 * hooks, no external programs).
 */

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const SHA = /^[0-9a-f]{40,64}$/;

type TreeEntry = { kind: 'blob'; size: number } | { kind: 'other'; mode: string } | null;

/** The tree entry at `<commit>:<path>` (null when absent). */
async function treeEntry(worktree: string, commit: string, path: string): Promise<TreeEntry> {
  const { stdout } = await execGit(['-C', worktree, 'ls-tree', '-l', '-z', '--full-tree', commit, '--', path], { maxBuffer: 64 * 1024 });
  const line = stdout.split('\0').find((candidate) => candidate.endsWith(`\t${path}`));
  if (!line) return null;
  const [meta] = line.split('\t');
  const [mode, type, , size] = (meta ?? '').trim().split(/\s+/);
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return { kind: 'other', mode: mode ?? 'unknown' };
  return { kind: 'blob', size: Number.parseInt(size ?? '0', 10) || 0 };
}

/**
 * A regular file's content at a commit, bounded. `{ text: null }` when the
 * path does not exist there; `{ error }` when it exists but is not a regular
 * file, is too large, or cannot be read.
 */
export async function readFileAtCommit(worktree: string, commit: string, path: string, maxBytes: number): Promise<{ text: string | null; error?: string }> {
  if (!SHA.test(commit)) return { text: null, error: 'invalid base commit' };
  let entry: TreeEntry;
  try {
    entry = await treeEntry(worktree, commit, path);
  } catch {
    return { text: null, error: `the base commit ${commit.slice(0, 12)} is not readable in this workspace` };
  }
  if (!entry) return { text: null };
  if (entry.kind === 'other') return { text: null, error: `${path} is not a regular file at the base commit (mode ${entry.mode})` };
  if (entry.size > maxBytes) return { text: null, error: `${path} is larger than ${maxBytes} bytes` };
  try {
    const { stdout } = await execGit(['-C', worktree, 'cat-file', 'blob', `${commit}:${path}`], { maxBuffer: maxBytes + 1024 });
    return { text: stdout };
  } catch {
    return { text: null, error: `${path} could not be read at the base commit` };
  }
}

async function existsAtCommit(worktree: string, commit: string, path: string): Promise<boolean> {
  try {
    return (await treeEntry(worktree, commit, path))?.kind === 'blob';
  } catch {
    return false;
  }
}

export interface ResolveRunManifestInput {
  snapshot: RunSnapshot;
  workspace: RunWorkspace;
  now?: () => Date;
}

export async function resolveRunManifest(input: ResolveRunManifestInput): Promise<VerificationManifest> {
  const { snapshot, workspace } = input;
  const baseCommit = workspace.baseCommit && SHA.test(workspace.baseCommit) ? workspace.baseCommit : null;
  const settings = snapshot.verificationSettings ?? null;
  const repositoryFile = baseCommit
    ? await readFileAtCommit(workspace.worktreePath, baseCommit, REPOSITORY_CHECKS_PATH, VERIFICATION_LIMITS.maxConfigBytes)
    : null;
  // Auto-detection reads are only needed when the project enables it; gather lazily-but-eagerly
  // (resolveVerificationManifest is synchronous) only in that case.
  let detected: { checks: ReturnType<typeof autoDetectChecks>; sha256: string | null } | null = null;
  const wantsAutoDetect = typeof settings === 'object' && settings !== null && 'autoDetect' in settings && settings.autoDetect === true;
  if (wantsAutoDetect && baseCommit) {
    const pkg = await readFileAtCommit(workspace.worktreePath, baseCommit, 'package.json', VERIFICATION_LIMITS.maxConfigBytes * 4);
    const [pnpm, yarn, npm, bun] = await Promise.all([
      existsAtCommit(workspace.worktreePath, baseCommit, 'pnpm-lock.yaml'),
      existsAtCommit(workspace.worktreePath, baseCommit, 'yarn.lock'),
      existsAtCommit(workspace.worktreePath, baseCommit, 'package-lock.json'),
      existsAtCommit(workspace.worktreePath, baseCommit, 'bun.lockb'),
    ]);
    detected = {
      checks: autoDetectChecks({ packageJson: pkg.text, lockfiles: { pnpm, yarn, npm, bun } }),
      sha256: pkg.text === null ? null : sha256(pkg.text),
    };
  }
  const now = input.now ?? (() => new Date());
  return resolveVerificationManifest({
    projectSettings: settings,
    projectSettingsSha256: settings === null ? null : sha256(canonicalJson(settings)),
    baseCommit,
    repositoryFile: repositoryFile
      ? { text: repositoryFile.text, sha256: repositoryFile.text === null ? null : sha256(repositoryFile.text), ...(repositoryFile.error ? { error: repositoryFile.error } : {}) }
      : null,
    autoDetect: () => detected,
    hash: sha256,
    now: () => now().toISOString(),
  });
}

/** Paths the agent's commit changed among the grading inputs (integrity note for the evidence). */
export async function changedGradingInputs(worktree: string, baseCommit: string | null, commit: string): Promise<string[]> {
  if (!baseCommit || !SHA.test(baseCommit) || !SHA.test(commit)) return [];
  try {
    const { stdout } = await execGit(['-C', worktree, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', baseCommit, commit, '--', '.openlinear'], { maxBuffer: 256 * 1024 });
    return stdout.split('\0').filter(Boolean).slice(0, 20);
  } catch {
    return [];
  }
}
