import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isTerminalRunState } from '@openlinear/execution-core';
import type { RunRecord, WorkspaceCleanupReason, WorkspaceCleanupRecord } from '../journal/durable';
import { logger } from '../lib/logger';
import type { RunWorkspace } from '../run/types';
import { releaseLocalWorktree, withRepoLock } from './local-worktree';

/**
 * W11a journal-aware worktree retention (replaces the boot-time "delete every
 * worktree older than 24 h" sweep for the v2 run engine).
 *
 * A run's worktree is what a follow-up turn and the review diff work on, so
 * it is kept while it is useful and removed — with a receipt — when it is not:
 *
 * - never while any run using it is in flight (follow-ups share their
 *   parent's worktree; all runs on one path are one group);
 * - never the user's own repository (`owned: false`);
 * - `task_closed`: the control plane reported the task archived/deleted;
 * - `superseded`: a newer run of the same task has its own worktree
 *   (follow-ups always continue from the task's latest run, so an older
 *   worktree can no longer be continued);
 * - `retention_expired`: no activity for `retainMs` (default 7 days);
 * - `disk_budget`: past `maxBytes`, the least recently used terminal
 *   worktrees go first;
 * - `legacy_age`: directories under `<repos>/worktrees` that no journaled
 *   run references (legacy engine) keep the old 24 h rule;
 * - `unused_cache`: repository mirrors (`<repos>/<owner>/<name>.git`) no
 *   existing worktree uses, untouched for `retainMs`; mirrors count toward
 *   `maxBytes` too, and unused ones go before any worktree (they are
 *   re-fetchable caches). Removal takes the mirror's clone lock and
 *   re-checks its use inside it;
 * - `orphan_checkout`: verification checkouts (`<repos>/verify/<runId>`) of
 *   runs that are not verifying any more (left by a crash).
 *
 * A receipt (`pending`) is journaled BEFORE anything is deleted and settled
 * afterwards (`removed` / `failed`), so "the workspace expired" is reported
 * honestly and an interrupted deletion is retried by the next sweep.
 */

export interface RetentionPolicy {
  /** Keep a finished worktree this long after its last run ended. */
  retainMs: number;
  /** Total size of retained worktrees above which the least recently used go first. */
  maxBytes: number;
  /** Age limit for worktree directories no journaled run references. */
  legacyMaxAgeMs: number;
  /** Settled receipts and task hints are pruned after this long. */
  receiptTtlMs: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  retainMs: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 20 * 1024 * 1024 * 1024,
  legacyMaxAgeMs: 24 * 60 * 60 * 1000,
  receiptTtlMs: 30 * 24 * 60 * 60 * 1000,
};

export interface RetentionSweepReport {
  scanned: number;
  kept: number;
  removed: Array<{ worktreePath: string; reason: WorkspaceCleanupReason; bytes: number | null }>;
  failed: Array<{ worktreePath: string; reason: WorkspaceCleanupReason; detail: string }>;
  pruned: number;
}

/** The slice of the durable journal the sweep needs. */
export interface RetentionJournal {
  listWorkspaceRuns(): RunRecord[];
  recordWorkspaceCleanup(
    input: { worktreePath: string; runId: string | null; taskId: string | null; branch: string | null; reason: WorkspaceCleanupReason; bytes: number | null; detail?: string | null },
    now?: number,
  ): WorkspaceCleanupRecord;
  settleWorkspaceCleanup(worktreePath: string, status: 'removed' | 'failed', detail?: string | null, now?: number): WorkspaceCleanupRecord | null;
  workspaceCleanups(status?: WorkspaceCleanupRecord['status']): WorkspaceCleanupRecord[];
  closedTasks(): Map<string, { closedAt: number; reason: string }>;
  pruneRetention(olderThanMs: number, now?: number): number;
}

export interface RetentionDeps {
  journal: RetentionJournal;
  reposRoot: string;
  policy?: Partial<RetentionPolicy>;
  now?: number;
  /** Runs in flight in this process (their worktrees and verification checkouts are never touched). */
  isActive?: (runId: string) => boolean;
  /** Remove a journaled, owned worktree (default: `releaseLocalWorktree`). */
  removeWorkspace?: (workspace: RunWorkspace) => Promise<void>;
  /** Remove an unjournaled directory under `<repos>` (default: guarded `rm -rf`). */
  removeDirectory?: (path: string) => Promise<void>;
  /** Bytes used by a directory; null when unknown (default: `du -sk`). */
  sizeOf?: (path: string) => Promise<number | null>;
}

interface Group {
  worktreePath: string;
  workspace: RunWorkspace;
  runs: RunRecord[];
  taskId: string;
  lastActivity: number;
  newestCreatedAt: number;
}

function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, resolve(target));
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

async function defaultRemoveWorkspace(workspace: RunWorkspace): Promise<void> {
  if (!workspace.owned || !workspace.handle) throw new Error('not an owned checkout');
  await releaseLocalWorktree({
    kind: 'local-worktree',
    runId: workspace.handle.runId,
    worktreePath: workspace.worktreePath,
    mirrorPath: workspace.handle.mirrorPath,
    branch: workspace.branch,
    ...(workspace.handle.dissociated ? { dissociated: true } : {}),
  });
}

function guardedRemove(root: string): (path: string) => Promise<void> {
  return async (path) => {
    if (!insideRoot(root, path)) throw new Error('path is outside the repository root');
    if (lstatSync(path).isSymbolicLink()) throw new Error('refusing to follow a symlink');
    rmSync(path, { recursive: true, force: true });
  };
}

function duBytes(path: string): Promise<number | null> {
  return new Promise((done) => {
    execFile('du', ['-sk', path], { timeout: 30_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) return done(null);
      const kib = Number.parseInt(String(stdout).trim().split(/\s+/)[0] ?? '', 10);
      done(Number.isFinite(kib) ? kib * 1024 : null);
    });
  });
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function groupRuns(runs: readonly RunRecord[]): Group[] {
  const groups = new Map<string, Group>();
  for (const run of runs) {
    const workspace = run.workspace;
    if (!workspace) continue;
    const at = run.finishedAt ?? run.updatedAt;
    const group = groups.get(workspace.worktreePath);
    if (!group) {
      groups.set(workspace.worktreePath, {
        worktreePath: workspace.worktreePath,
        // The first (creating) run's record names the owner and handle; adopters carry `continuedFrom`.
        workspace,
        runs: [run],
        taskId: run.taskId,
        lastActivity: at,
        newestCreatedAt: run.createdAt,
      });
      continue;
    }
    group.runs.push(run);
    if (!workspace.continuedFrom && group.workspace.continuedFrom) group.workspace = workspace;
    group.lastActivity = Math.max(group.lastActivity, at);
    group.newestCreatedAt = Math.max(group.newestCreatedAt, run.createdAt);
  }
  return [...groups.values()];
}

/** `<root>/<owner>/<name>.git` bare mirrors (not `worktrees/`, `verify/`). */
function listMirrors(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const owner of readdirSync(root)) {
    if (owner === 'worktrees' || owner === 'verify') continue;
    const ownerDir = join(root, owner);
    try {
      if (!lstatSync(ownerDir).isDirectory()) continue;
      for (const name of readdirSync(ownerDir)) {
        const path = join(ownerDir, name);
        if (name.endsWith('.git') && lstatSync(path).isDirectory() && existsSync(join(path, 'HEAD'))) found.push(path);
      }
    } catch {
      // unreadable entries are skipped, never removed
    }
  }
  return found;
}

/** Any linked worktree of the mirror still exists (git's own `worktrees/<id>/gitdir` pointers). */
function mirrorInUse(mirror: string): boolean {
  const admin = join(mirror, 'worktrees');
  if (!existsSync(admin)) return false;
  for (const entry of readdirSync(admin)) {
    try {
      const gitdir = readFileSync(join(admin, entry, 'gitdir'), 'utf8').trim();
      if (gitdir && existsSync(gitdir)) return true;
    } catch {
      // An admin entry without a readable gitdir is treated as in use (never remove on doubt).
      return true;
    }
  }
  return false;
}

/** Last fetch or checkout through the mirror. */
function mirrorLastUsed(mirror: string): number {
  let latest = 0;
  for (const file of ['FETCH_HEAD', 'HEAD', 'packed-refs', '']) {
    try {
      latest = Math.max(latest, statSync(join(mirror, file)).mtimeMs);
    } catch {
      // absent
    }
  }
  return latest;
}

export async function sweepRetainedWorktrees(deps: RetentionDeps): Promise<RetentionSweepReport> {
  const policy: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY, ...deps.policy };
  const now = deps.now ?? Date.now();
  const root = resolve(deps.reposRoot);
  const isActive = deps.isActive ?? (() => false);
  const removeWorkspace = deps.removeWorkspace ?? defaultRemoveWorkspace;
  const removeDirectory = deps.removeDirectory ?? guardedRemove(root);
  // Under the clone lock, and only if nothing started using it meanwhile.
  const removeMirror = (path: string) => withRepoLock(path, async () => {
    if (mirrorInUse(path)) throw new Error('the mirror is in use again');
    await removeDirectory(path);
  });
  const sizeOf = deps.sizeOf ?? duBytes;
  const { journal } = deps;
  const report: RetentionSweepReport = { scanned: 0, kept: 0, removed: [], failed: [], pruned: 0 };

  const groups = groupRuns(journal.listWorkspaceRuns());
  const known = new Set(groups.map((group) => resolve(group.worktreePath)));
  const closed = journal.closedTasks();
  const receipts = new Map(journal.workspaceCleanups().map((cleanup) => [cleanup.worktreePath, cleanup]));

  const remove = async (
    target: { worktreePath: string; runId: string | null; taskId: string | null; branch: string | null },
    reason: WorkspaceCleanupReason,
    bytes: number | null,
    run: () => Promise<void>,
  ): Promise<void> => {
    journal.recordWorkspaceCleanup({ ...target, reason, bytes }, now);
    try {
      await run();
      journal.settleWorkspaceCleanup(target.worktreePath, 'removed', null, now);
      report.removed.push({ worktreePath: target.worktreePath, reason, bytes });
      logger.info({ worktree: target.worktreePath, reason, taskId: target.taskId }, '[Retention] worktree removed');
    } catch (error) {
      const detail = errorText(error);
      journal.settleWorkspaceCleanup(target.worktreePath, 'failed', detail, now);
      report.failed.push({ worktreePath: target.worktreePath, reason, detail });
      logger.warn({ err: error, worktree: target.worktreePath, reason }, '[Retention] worktree removal failed; retried by the next sweep');
    }
  };

  // Newest worktree per task: anything older of the same task is superseded.
  const newestPerTask = new Map<string, Group>();
  for (const group of groups) {
    const current = newestPerTask.get(group.taskId);
    if (!current || group.newestCreatedAt > current.newestCreatedAt) newestPerTask.set(group.taskId, group);
  }

  const budgetCandidates: Array<{ group: Group; bytes: number | null }> = [];
  for (const group of groups) {
    report.scanned += 1;
    const { workspace } = group;
    const busy = group.runs.some((run) => !isTerminalRunState(run.state) || isActive(run.runId));
    if (busy || !workspace.owned || !workspace.handle || !insideRoot(root, group.worktreePath)) {
      report.kept += 1;
      continue;
    }
    const target = { worktreePath: group.worktreePath, runId: workspace.handle.runId, taskId: group.taskId, branch: workspace.branch };
    if (!existsSync(group.worktreePath)) {
      // A deletion interrupted after the directory went (crash mid-sweep): settle its receipt.
      // A worktree removed by hand gets no invented receipt (follow-ups report worktree_missing).
      const receipt = receipts.get(group.worktreePath);
      if (receipt && receipt.status !== 'removed') journal.settleWorkspaceCleanup(group.worktreePath, 'removed', null, now);
      continue;
    }
    const newest = newestPerTask.get(group.taskId);
    let reason: WorkspaceCleanupReason | null = null;
    if (closed.has(group.taskId)) reason = 'task_closed';
    // Only when the newer worktree still exists: a later run that failed in setup supersedes nothing.
    else if (newest && newest !== group && existsSync(newest.worktreePath)) reason = 'superseded';
    else if (now - group.lastActivity >= policy.retainMs) reason = 'retention_expired';
    if (reason) {
      await remove(target, reason, await sizeOf(group.worktreePath), () => removeWorkspace(workspace));
      continue;
    }
    budgetCandidates.push({ group, bytes: await sizeOf(group.worktreePath) });
  }

  // Mirrors: unused ones expire; every mirror counts toward the budget.
  const mirrors: Array<{ path: string; bytes: number | null; lastUsed: number; used: boolean }> = [];
  for (const path of listMirrors(root)) {
    const used = mirrorInUse(path);
    const lastUsed = mirrorLastUsed(path);
    if (!used && now - lastUsed >= policy.retainMs) {
      const bytes = await sizeOf(path);
      await remove({ worktreePath: path, runId: null, taskId: null, branch: null }, 'unused_cache', bytes, () => removeMirror(path));
      continue;
    }
    mirrors.push({ path, bytes: await sizeOf(path), lastUsed, used });
  }

  // Disk budget over what is left: unused mirrors first, then worktrees, least recently used first.
  let total = budgetCandidates.reduce((sum, candidate) => sum + (candidate.bytes ?? 0), 0)
    + mirrors.reduce((sum, mirror) => sum + (mirror.bytes ?? 0), 0);
  for (const mirror of mirrors.filter((item) => !item.used).sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (total <= policy.maxBytes) break;
    await remove({ worktreePath: mirror.path, runId: null, taskId: null, branch: null }, 'disk_budget', mirror.bytes, () => removeMirror(mirror.path));
    total -= mirror.bytes ?? 0;
  }
  budgetCandidates.sort((a, b) => a.group.lastActivity - b.group.lastActivity);
  for (const candidate of budgetCandidates) {
    if (total <= policy.maxBytes) {
      report.kept += 1;
      continue;
    }
    const { group } = candidate;
    const handle = group.workspace.handle;
    await remove(
      { worktreePath: group.worktreePath, runId: handle?.runId ?? null, taskId: group.taskId, branch: group.workspace.branch },
      'disk_budget',
      candidate.bytes,
      () => removeWorkspace(group.workspace),
    );
    total -= candidate.bytes ?? 0;
  }

  // Unjournaled worktree directories (legacy engine): the pre-W11a 24 h rule.
  const worktreesDir = join(root, 'worktrees');
  if (existsSync(worktreesDir)) {
    for (const entry of readdirSync(worktreesDir)) {
      const path = join(worktreesDir, entry);
      if (known.has(resolve(path)) || isActive(entry)) continue;
      let mtime: number;
      try {
        const stat = lstatSync(path);
        if (!stat.isDirectory()) continue;
        mtime = stat.mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime < policy.legacyMaxAgeMs) continue;
      await remove({ worktreePath: path, runId: entry, taskId: null, branch: null }, 'legacy_age', null, () => removeDirectory(path));
    }
  }

  // Verification checkouts whose run is not verifying any more.
  const verifyDir = join(root, 'verify');
  if (existsSync(verifyDir)) {
    const verifying = new Set(groups.flatMap((group) => group.runs.filter((run) => run.state === 'verifying').map((run) => run.runId)));
    for (const entry of readdirSync(verifyDir)) {
      if (verifying.has(entry) || isActive(entry)) continue;
      const path = join(verifyDir, entry);
      await remove({ worktreePath: path, runId: entry, taskId: null, branch: null }, 'orphan_checkout', null, () => removeDirectory(path));
    }
  }

  report.pruned = journal.pruneRetention(policy.receiptTtlMs, now);
  return report;
}
