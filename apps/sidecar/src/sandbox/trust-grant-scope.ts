import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '../lib/logger';
import { isWithin, realpathOrResolve } from './paths';
import type { RunScope, RunScopeResolver } from './trust-grants';

/**
 * FE-03: which run (user, project) a checkout belongs to, so a project trust
 * grant applies to that project's runs only.
 *
 * The engine lays checkouts out by run id, not by project:
 *   <repos>/worktrees/<runId>   agent worktree (a follow-up adopts its parent's)
 *   <repos>/verify/<runId>      pristine verification checkout
 * so the project comes from the durable run journal (`run_attempts`: user_id
 * and snapshot_json.projectId), read through a READ-ONLY connection — the
 * run service owns the journal; this never creates or migrates it. A
 * directory outside those roots, an unknown run, or an unreadable journal
 * resolves to null and no grant applies (runs of the legacy engine, which
 * does not journal a project, are never covered).
 */

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RunRoots {
  agent: string;
  verification: string;
}

/**
 * realpath of `path`, or — when it does not exist yet (no run so far) — the
 * realpath of its nearest existing ancestor plus the rest, so a grant made
 * before the first run still matches the checkouts' realpaths later.
 */
export function realpathOfNearest(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** The checkout roots a grant covers, as realpaths. */
export function runRootsFor(reposRoot: string): RunRoots {
  return {
    agent: realpathOfNearest(join(reposRoot, 'worktrees')),
    verification: realpathOfNearest(join(reposRoot, 'verify')),
  };
}

function rowString(row: unknown, key: string): string | null {
  if (!row || typeof row !== 'object') return null;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function snapshotProject(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const projectId = (parsed as Record<string, unknown>).projectId;
    return typeof projectId === 'string' && projectId !== '' ? projectId : null;
  } catch {
    return null;
  }
}

/** The newest journaled run for `runId` (or, for a worktree, any run that adopted it). */
export function readRunScope(journalPath: string, runId: string, kind: RunScope['kind'], worktreePaths: readonly string[]): RunScope | null {
  if (!existsSync(journalPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(journalPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const byWorkspace = worktreePaths.length > 0
      ? ` OR (workspace_json IS NOT NULL AND json_extract(workspace_json, '$.worktreePath') IN (${worktreePaths.map(() => '?').join(', ')}))`
      : '';
    const row = db
      .prepare(`SELECT run_id, user_id, snapshot_json FROM run_attempts WHERE run_id = ?${byWorkspace} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(runId, ...worktreePaths);
    const userId = rowString(row, 'user_id');
    const matchedRun = rowString(row, 'run_id');
    if (!userId || !matchedRun) return null;
    return { runId: matchedRun, userId, projectId: snapshotProject(rowString(row, 'snapshot_json')), kind };
  } catch (error) {
    logger.warn({ err: error }, '[Sandbox] run journal not readable; no trust grant applies');
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

export function createJournalRunScope(deps: { journalPath: () => string; reposRoot: () => string }): RunScopeResolver {
  return (directory) => {
    const real = realpathOrResolve(directory);
    const reposRoot = deps.reposRoot();
    const roots = runRootsFor(reposRoot);
    const kind: RunScope['kind'] | null = isWithin(real, roots.agent) ? 'agent' : isWithin(real, roots.verification) ? 'verification' : null;
    if (!kind) return null;
    const base = kind === 'agent' ? roots.agent : roots.verification;
    const runId = relative(base, real).split(sep)[0] ?? '';
    if (!RUN_ID.test(runId)) return null;
    // A follow-up run records its parent's worktree path (as stored: lexical or real).
    const worktreePaths = kind === 'agent' ? [...new Set([join(reposRoot, 'worktrees', runId), join(base, runId)])] : [];
    return readRunScope(deps.journalPath(), runId, kind, worktreePaths);
  };
}
