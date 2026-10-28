import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFollowUpPrompt, FOLLOW_UP_LIMITS, type FollowUpComment } from '@openlinear/execution-core';
import { git, gitTry } from '../util/git';
import type { SidecarReviewFinding } from './sidecar';
import type { ReviewSeverity } from './types';

/**
 * W19a ablation plumbing around the sidecar's reviewer contract: what the
 * reviewer sees (a disposable checkout of the agent's work, committed) and
 * how its findings reach the follow-up turn (as the desktop does it: each
 * finding becomes a review comment on its last line, sent with a follow-up).
 */

export interface ReviewSnapshot {
  /** Disposable clone detached at `commit`; shares no writable state with the trial worktree. */
  checkout: string;
  /** The agent's work (tracked, untracked, deleted files) committed on top of the base commit. */
  commit: string;
  changedFiles: string[];
  /** `git diff base commit`, capped like the sidecar's reviewer (`MAX_REVIEW_DIFF_CHARS`). */
  diff: string;
  diffTruncated: boolean;
}

/**
 * Commits the worktree's current state without touching its index, refs or
 * files (a private index + `commit-tree`, deterministic identity and dates),
 * then clones it into `dir` detached at that commit with no remote. Null when
 * the agent changed nothing (the sidecar refuses such a review too).
 */
export async function snapshotForReview(input: { worktree: string; baseSha: string; dir: string; maxDiffChars: number }): Promise<ReviewSnapshot | null> {
  await mkdir(input.dir, { recursive: true });
  const env = { GIT_INDEX_FILE: join(input.dir, 'review.index') };
  await git(input.worktree, ['read-tree', input.baseSha], { env });
  await git(input.worktree, ['add', '-A'], { env });
  const tree = (await git(input.worktree, ['write-tree'], { env })).trim();
  const baseTree = (await git(input.worktree, ['rev-parse', `${input.baseSha}^{tree}`])).trim();
  if (tree === baseTree) return null;
  const commit = (await git(input.worktree, ['commit-tree', tree, '-p', input.baseSha, '-m', 'eval: the agent work under review'])).trim();
  const checkout = join(input.dir, 'checkout');
  // --shared: the commit object lives in the worktree's object store (read through alternates, never written).
  await git(input.dir, ['clone', '--quiet', '--shared', '--no-checkout', input.worktree, checkout]);
  await git(checkout, ['checkout', '--quiet', '--detach', commit]);
  await git(checkout, ['remote', 'remove', 'origin']);
  const names = await git(checkout, ['diff', '--name-only', '-z', '--no-renames', input.baseSha, commit, '--']);
  const changedFiles = names.split('\0').filter(Boolean);
  const full = await git(checkout, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', input.baseSha, commit, '--']);
  // The sidecar's reviewer cuts the diff the same way (run/reviewer/index.ts `diffOf`).
  const diffTruncated = full.length > input.maxDiffChars;
  const diff = diffTruncated ? `${full.slice(0, input.maxDiffChars)}\n… (diff truncated)` : full;
  return { checkout, commit, changedFiles, diff, diffTruncated };
}

/** The file at the reviewed commit, or null (anchoring input for `anchorFindings`). */
export async function readFileAtCommit(checkout: string, commit: string, path: string): Promise<string | null> {
  const result = await gitTry(checkout, ['show', `${commit}:${path}`]);
  return result.code === 0 ? result.stdout : null;
}

export const ACTIONABLE_SEVERITIES: ReadonlySet<ReviewSeverity> = new Set(['blocker', 'major']);

const SEVERITY_LABEL: Record<ReviewSeverity, string> = { blocker: 'Blocker', major: 'Major', minor: 'Minor', nit: 'Nit' };

/**
 * A finding as a review comment on its last line, new side — the same text
 * the desktop's "Comment" button drafts (components/review/model/agent-review.ts
 * `findingComment`).
 */
export function findingComment(finding: Pick<SidecarReviewFinding, 'severity' | 'title' | 'body' | 'file' | 'endLine'>): FollowUpComment {
  const body = [`${SEVERITY_LABEL[finding.severity]}: ${finding.title}`, finding.body.trim()].filter(Boolean).join('\n\n');
  return { path: finding.file, line: finding.endLine, side: 'new', body };
}

export const FOLLOW_UP_MESSAGE = 'An independent agent review of your change found the problems in the comments below. Fix them, verify the result, then stop.';

/**
 * The follow-up turn's prompt (execution-core `buildFollowUpPrompt`, the run
 * engine's builder). Seeded mode: the harness starts a fresh session in the
 * same worktree, with the previous work as a diff — the engine's fallback
 * when a session cannot be resumed.
 */
export function reviewFollowUpPrompt(input: {
  task: { title: string; description: string };
  findings: ReadonlyArray<Pick<SidecarReviewFinding, 'severity' | 'title' | 'body' | 'file' | 'endLine'>>;
  baseSha: string;
  /** The diff the reviewer saw (untruncated is fine; it is cut here at the engine's limit). */
  diff: string;
}): string {
  const truncated = input.diff.length > FOLLOW_UP_LIMITS.diffMaxChars;
  return buildFollowUpPrompt({
    mode: 'seeded',
    request: { message: FOLLOW_UP_MESSAGE, comments: input.findings.map(findingComment) },
    branch: 'HEAD',
    task: { title: input.task.title, description: input.task.description, labels: [] },
    previous: { base: input.baseSha, diff: truncated ? input.diff.slice(0, FOLLOW_UP_LIMITS.diffMaxChars) : input.diff, truncated, untracked: [] },
  });
}
