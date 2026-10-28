import { constants as fsConstants, existsSync } from 'node:fs';
import { type FileHandle, lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DurableRunJournal } from '../../journal/durable';
import { logger } from '../../lib/logger';
import { runSnapshotSchema, runWorkspaceSchema } from '../../run/types';
import { getExecutionStatus } from '../execution/state';
import type { ResolvedTaskWorkspace } from './types';

/**
 * Finds the checkout of a task's attempt on this device, in order:
 *
 * 1. legacy live — the in-memory legacy execution (`getExecutionStatus`);
 * 2. v2 — the newest valid `run_attempts` row of the durable run journal,
 *    read through a READ-ONLY sqlite connection (constructing
 *    DurableRunJournal would create/migrate the file), used only while its
 *    worktree directory still exists;
 * 3. legacy disk — a scan of `<repos>/worktrees/*` for a checkout whose HEAD
 *    is the task's branch, read straight from the files (no git, no symlinks
 *    followed). Today's legacy clones sit on `openlinear/<random uuid>`, which
 *    only the run's own log names ("Branch created: …", persisted with the
 *    task and read back under the caller's credential); older checkouts used
 *    `openlinear/<taskId[0..8]>`.
 *
 * Every candidate must be an absolute path to a real directory (lstat, not a
 * symlink). Worktrees are garbage-collected after 24 h (gcLocalWorktrees).
 */

export const MAX_LEGACY_SCAN_ENTRIES = 500;
const MAX_POINTER_FILE_BYTES = 4096;
const JOURNAL_ROWS = 10;

/** The fields of a legacy ExecutionState the resolver reads. */
export interface LiveExecutionView {
  repoPath: string;
  branchName: string;
  userId: string | null;
  publishRepository?: { defaultBranch: string } | null;
}

export interface WorkspaceResolverDeps {
  liveExecution(taskId: string): LiveExecutionView | undefined;
  journalPath(): string;
  reposRoot(): string;
  /** The branch the task's last legacy run created (from its persisted log), if known. */
  persistedBranch(taskId: string): Promise<string | null>;
}

/**
 * Root of the sidecar's repository storage. MUST stay in sync with
 * `appReposDir()` in workspace/local-worktree.ts (not exported there).
 */
export function defaultReposRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.REPOS_DIR) return resolve(env.REPOS_DIR);
  const root = env.OPENLINEAR_APP_DATA ?? (
    platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'OpenLinear')
      : platform === 'win32' ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenLinear')
        : join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'openlinear')
  );
  return resolve(root, 'repos');
}

export const defaultResolverDeps: WorkspaceResolverDeps = {
  liveExecution: (taskId) => getExecutionStatus(taskId),
  journalPath: () => DurableRunJournal.defaultPath(),
  reposRoot: () => defaultReposRoot(),
  persistedBranch: async () => null,
};

const BRANCH_LOG_RE = /^Branch created: (openlinear\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

/**
 * The branch named by the newest sidecar-written "Branch created: …" log line
 * (type `info`; agent output is type `agent` and never matches). Only
 * `openlinear/<segment>` names are accepted.
 */
export function branchFromLogs(logs: readonly unknown[]): string | null {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const entry = logs[index];
    if (!entry || typeof entry !== 'object') continue;
    const { type, message } = entry as { type?: unknown; message?: unknown };
    if (type !== 'info' || typeof message !== 'string') continue;
    const match = BRANCH_LOG_RE.exec(message);
    if (match && !match[1].includes('..') && !match[1].endsWith('.')) return match[1];
  }
  return null;
}

export async function isRealDirectory(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// v2 journal
// ---------------------------------------------------------------------------

interface JournalHit {
  worktreePath: string;
  branch: string;
  baseRef: string | null;
  ownerUserId: string;
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function journalRow(row: unknown): JournalHit | null {
  if (!row || typeof row !== 'object') return null;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(row));
  const userId = record.user_id;
  if (typeof userId !== 'string' || userId === '') return null;
  const workspace = runWorkspaceSchema.safeParse(parseJsonColumn(record.workspace_json));
  const snapshot = runSnapshotSchema.safeParse(parseJsonColumn(record.snapshot_json));
  if (!workspace.success || !snapshot.success) return null;
  return {
    worktreePath: workspace.data.worktreePath,
    branch: workspace.data.branch,
    baseRef: workspace.data.baseRef ?? snapshot.data.repository?.defaultBranch ?? null,
    ownerUserId: userId,
  };
}

/** The newest valid journal row for the task (invalid rows are skipped), or null. */
export function readJournalWorkspace(path: string, taskId: string): JournalHit | null {
  if (!existsSync(path)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const rows = db
      .prepare(`SELECT user_id, workspace_json, snapshot_json FROM run_attempts
        WHERE task_id = ? AND workspace_json IS NOT NULL
        ORDER BY created_at DESC, rowid DESC LIMIT ${JOURNAL_ROWS}`)
      .all(taskId);
    for (const row of rows) {
      const hit = journalRow(row);
      if (hit) return hit;
    }
    return null;
  } catch (error) {
    logger.debug({ err: error }, '[TaskDiff] run journal not readable; skipping the v2 lookup');
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy disk scan
// ---------------------------------------------------------------------------

interface SmallFile {
  text: string;
  mtimeMs: number;
}

/** A regular file (never a symlink), at most MAX_POINTER_FILE_BYTES. */
async function readSmallFile(path: string): Promise<SmallFile | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(MAX_POINTER_FILE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** HEAD of a candidate checkout: `.git` file → `gitdir:` inside the repos root, or `.git` directory. */
async function candidateHead(candidate: string, realRoot: string): Promise<SmallFile | null> {
  const dotGit = join(candidate, '.git');
  let headPath: string;
  try {
    const stat = await lstat(dotGit);
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) {
      headPath = join(dotGit, 'HEAD');
    } else if (stat.isFile()) {
      const pointer = await readSmallFile(dotGit);
      const firstLine = pointer?.text.split('\n')[0]?.replace(/\r$/, '') ?? '';
      if (!firstLine.startsWith('gitdir: ')) return null;
      const target = firstLine.slice('gitdir: '.length);
      if (target === '') return null;
      const gitdir = await realpath(resolve(candidate, target));
      if (!isInside(realRoot, gitdir)) return null;
      headPath = join(gitdir, 'HEAD');
    } else {
      return null;
    }
  } catch {
    return null;
  }
  return readSmallFile(headPath);
}

/**
 * A checkout on one of the task's legacy branches: `openlinear/<first 8 chars
 * of the task id>` (older checkouts) or `branches` (from the run's log).
 * Returns the newest match and the branch it is on.
 */
export async function scanLegacyWorktreesFor(reposRoot: string, taskId: string, branches: readonly string[] = []): Promise<{ path: string; branch: string } | null> {
  const prefix = taskId.slice(0, 8);
  const names = [...(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix) ? [`openlinear/${prefix}`] : []), ...branches.filter((branch) => /^openlinear\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branch))];
  if (names.length === 0) return null;
  const wanted = new Map(names.map((branch) => [`ref: refs/heads/${branch}`, branch]));
  const worktreesDir = join(reposRoot, 'worktrees');
  if (!(await isRealDirectory(worktreesDir))) return null;
  let realRoot: string;
  try {
    realRoot = await realpath(reposRoot);
  } catch {
    return null;
  }
  let best: { path: string; branch: string; mtimeMs: number } | null = null;
  let seen = 0;
  try {
    for await (const entry of await opendir(worktreesDir)) {
      if (seen >= MAX_LEGACY_SCAN_ENTRIES) break;
      seen += 1;
      const candidate = join(worktreesDir, entry.name);
      if (!(await isRealDirectory(candidate))) continue;
      const head = await candidateHead(candidate, realRoot);
      const branch = head ? wanted.get(head.text.replace(/\r?\n$/, '')) : undefined;
      if (!head || !branch) continue;
      if (!best || head.mtimeMs > best.mtimeMs) best = { path: candidate, branch, mtimeMs: head.mtimeMs };
    }
  } catch (error) {
    logger.debug({ err: error }, '[TaskDiff] legacy worktree scan failed');
  }
  return best ? { path: best.path, branch: best.branch } : null;
}

/** Older checkouts: branch `openlinear/<first 8 chars of the task id>`. */
export async function scanLegacyWorktrees(reposRoot: string, taskId: string): Promise<string | null> {
  return (await scanLegacyWorktreesFor(reposRoot, taskId))?.path ?? null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function resolveTaskWorkspace(
  taskId: string,
  overrides: Partial<WorkspaceResolverDeps> = {},
): Promise<ResolvedTaskWorkspace | null> {
  const deps: WorkspaceResolverDeps = { ...defaultResolverDeps, ...overrides };

  const live = deps.liveExecution(taskId);
  if (live && typeof live.repoPath === 'string' && (await isRealDirectory(live.repoPath))) {
    return {
      worktreePath: live.repoPath,
      branch: live.branchName || null,
      baseRef: live.publishRepository?.defaultBranch ?? null,
      ownerUserId: live.userId ?? null,
      source: 'legacy-live',
    };
  }

  const journal = readJournalWorkspace(deps.journalPath(), taskId);
  if (journal) {
    if (await isRealDirectory(journal.worktreePath)) return { ...journal, source: 'v2' };
    logger.debug({ taskId }, '[TaskDiff] the newest v2 attempt worktree is gone');
  }

  let logged: string | null = null;
  try {
    logged = await deps.persistedBranch(taskId);
  } catch (error) {
    // Unreachable/denied: the route's authorization reports it properly.
    logger.debug({ err: error, taskId }, '[TaskDiff] persisted log not readable; scanning for older checkouts only');
  }
  const legacy = await scanLegacyWorktreesFor(deps.reposRoot(), taskId, logged ? [logged] : []);
  if (legacy) {
    return { worktreePath: legacy.path, branch: legacy.branch, baseRef: null, ownerUserId: null, source: 'legacy-disk' };
  }
  return null;
}
