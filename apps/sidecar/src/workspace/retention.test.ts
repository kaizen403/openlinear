import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunState } from '@openlinear/execution-core';
import { DurableRunJournal, type RunRecord } from '../journal/durable';
import { fakeSnapshot } from '../run/test-support';
import type { RunWorkspace } from '../run/types';
import { sweepRetainedWorktrees, type RetentionDeps, type RetentionJournal } from './retention';

/**
 * W11a retention: worktrees are kept while a follow-up or review can still
 * use them and removed with a receipt otherwise — never while a run is in
 * flight, never the user's own repository.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const roots: string[] = [];
const journals: DurableRunJournal[] = [];

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ol-retention-'));
  roots.push(root);
  const reposRoot = join(root, 'repos');
  mkdirSync(join(reposRoot, 'worktrees'), { recursive: true });
  const journal = new DurableRunJournal(':memory:');
  journals.push(journal);
  const removed: string[] = [];
  let counter = 0;

  const runs: RunRecord[] = [];
  /** Synthetic run records (any state/time) over the real journal's receipts and hints. */
  const retentionJournal: RetentionJournal = {
    listWorkspaceRuns: () => runs,
    recordWorkspaceCleanup: (input, now) => journal.recordWorkspaceCleanup(input, now),
    settleWorkspaceCleanup: (path, status, detail, now) => journal.settleWorkspaceCleanup(path, status, detail, now),
    workspaceCleanups: (status) => journal.workspaceCleanups(status),
    closedTasks: () => journal.closedTasks(),
    pruneRetention: (olderThanMs, now) => journal.pruneRetention(olderThanMs, now),
  };

  /** A run with an owned worktree on disk, finished `ageMs` before NOW. */
  function run(input: { taskId: string; state?: RunState; ageMs?: number; createdAt?: number; owned?: boolean; worktree?: string; continuedFrom?: string }) {
    counter += 1;
    const runId = `run-${counter}`;
    const worktreePath = input.worktree ?? join(reposRoot, 'worktrees', runId);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'file.txt'), 'x'.repeat(10));
    const base = journal.createRun({
      runId, taskId: input.taskId, userId: 'user-1', attemptId: null, capability: null, capabilityExpiresAt: null,
      runner: 'opencode', model: null, state: 'preparing', snapshot: fakeSnapshot(input.taskId), bootId: 'boot',
    }, {});
    const workspace: RunWorkspace = {
      worktreePath, branch: `openlinear/${runId}`, baseRef: 'main', owned: input.owned ?? true,
      handle: input.owned === false ? null : { runId, mirrorPath: join(reposRoot, 'mirror.git'), dissociated: false },
      ...(input.continuedFrom ? { continuedFrom: input.continuedFrom } : {}),
    };
    const state = input.state ?? 'succeeded';
    const at = NOW - (input.ageMs ?? 0);
    runs.push({
      ...base, state, workspace, updatedAt: at, createdAt: input.createdAt ?? at,
      finishedAt: state === 'running' || state === 'verifying' ? null : at,
    });
    return { runId, worktreePath };
  }

  function deps(overrides: Partial<RetentionDeps> = {}): RetentionDeps {
    return {
      journal: retentionJournal,
      reposRoot,
      now: NOW,
      removeWorkspace: async (workspace) => {
        removed.push(workspace.worktreePath);
        rmSync(workspace.worktreePath, { recursive: true, force: true });
      },
      sizeOf: async () => 1_000,
      ...overrides,
    };
  }

  return { root, reposRoot, journal, removed, run, deps };
}

describe('W11a worktree retention', () => {
  it('keeps recent and in-flight worktrees; removes expired ones with a settled receipt', async () => {
    const s = setup();
    const fresh = s.run({ taskId: 'a', ageMs: 2 * DAY });
    const old = s.run({ taskId: 'b', ageMs: 8 * DAY });
    const running = s.run({ taskId: 'c', state: 'running', ageMs: 30 * DAY });
    const report = await sweepRetainedWorktrees(s.deps());

    expect(report.removed.map((entry) => [entry.worktreePath, entry.reason])).toEqual([[old.worktreePath, 'retention_expired']]);
    expect(existsSync(fresh.worktreePath)).toBe(true);
    expect(existsSync(running.worktreePath)).toBe(true);
    expect(existsSync(old.worktreePath)).toBe(false);
    expect(s.journal.workspaceCleanup(old.worktreePath)).toMatchObject({ status: 'removed', reason: 'retention_expired', taskId: 'b', runId: old.runId });
  });

  it('never touches a run active in this process, the user’s own repository, or a worktree shared with a newer follow-up', async () => {
    const s = setup();
    const active = s.run({ taskId: 'a', ageMs: 30 * DAY });
    const local = s.run({ taskId: 'b', ageMs: 30 * DAY, owned: false, worktree: join(s.root, 'user-repo') });
    const parent = s.run({ taskId: 'c', ageMs: 9 * DAY });
    s.run({ taskId: 'c', ageMs: 1 * DAY, worktree: parent.worktreePath, continuedFrom: parent.runId });
    const report = await sweepRetainedWorktrees(s.deps({ isActive: (runId) => runId === active.runId }));
    expect(report.removed).toEqual([]);
    expect(existsSync(active.worktreePath) && existsSync(local.worktreePath) && existsSync(parent.worktreePath)).toBe(true);
  });

  it('removes superseded worktrees of a task and those of closed tasks', async () => {
    const s = setup();
    const older = s.run({ taskId: 'a', ageMs: 3 * DAY, createdAt: NOW - 3 * DAY });
    const newer = s.run({ taskId: 'a', ageMs: 1 * DAY, createdAt: NOW - 1 * DAY });
    const archived = s.run({ taskId: 'z', ageMs: 1 * DAY });
    s.journal.noteTaskClosed('z', 'task_archived', NOW);
    const report = await sweepRetainedWorktrees(s.deps());
    expect(Object.fromEntries(report.removed.map((entry) => [entry.worktreePath, entry.reason]))).toEqual({
      [older.worktreePath]: 'superseded',
      [archived.worktreePath]: 'task_closed',
    });
    expect(existsSync(newer.worktreePath)).toBe(true);
  });

  it('a newer run without a surviving worktree supersedes nothing', async () => {
    const s = setup();
    const older = s.run({ taskId: 'a', ageMs: 3 * DAY, createdAt: NOW - 3 * DAY });
    const failedSetup = s.run({ taskId: 'a', state: 'failed', ageMs: 1 * DAY, createdAt: NOW - 1 * DAY });
    rmSync(failedSetup.worktreePath, { recursive: true, force: true });
    const report = await sweepRetainedWorktrees(s.deps());
    expect(report.removed).toEqual([]);
    expect(existsSync(older.worktreePath)).toBe(true);
  });

  it('enforces the disk budget least recently used first', async () => {
    const s = setup();
    const lru = s.run({ taskId: 'a', ageMs: 5 * DAY });
    const mid = s.run({ taskId: 'b', ageMs: 3 * DAY });
    const mru = s.run({ taskId: 'c', ageMs: 1 * DAY });
    const report = await sweepRetainedWorktrees(s.deps({ policy: { maxBytes: 2_500 } }));
    expect(report.removed.map((entry) => [entry.worktreePath, entry.reason])).toEqual([[lru.worktreePath, 'disk_budget']]);
    expect(existsSync(mid.worktreePath) && existsSync(mru.worktreePath)).toBe(true);
  });

  it('a failed removal is receipted as failed and retried by the next sweep', async () => {
    const s = setup();
    const old = s.run({ taskId: 'a', ageMs: 10 * DAY });
    let fail = true;
    const flaky = s.deps({
      removeWorkspace: async (workspace) => {
        if (fail) throw new Error('worktree is locked');
        rmSync(workspace.worktreePath, { recursive: true, force: true });
      },
    });
    const first = await sweepRetainedWorktrees(flaky);
    expect(first.failed).toEqual([{ worktreePath: old.worktreePath, reason: 'retention_expired', detail: 'worktree is locked' }]);
    expect(s.journal.workspaceCleanup(old.worktreePath)).toMatchObject({ status: 'failed', detail: 'worktree is locked' });
    fail = false;
    const second = await sweepRetainedWorktrees(flaky);
    expect(second.removed.map((entry) => entry.worktreePath)).toEqual([old.worktreePath]);
    expect(s.journal.workspaceCleanup(old.worktreePath)?.status).toBe('removed');
  });

  it('settles a receipt whose deletion finished before a crash; a worktree deleted by hand gets no invented receipt', async () => {
    const s = setup();
    const interrupted = s.run({ taskId: 'a', ageMs: 10 * DAY });
    s.journal.recordWorkspaceCleanup({ worktreePath: interrupted.worktreePath, runId: interrupted.runId, taskId: 'a', branch: null, reason: 'retention_expired', bytes: null }, NOW - 1_000);
    rmSync(interrupted.worktreePath, { recursive: true, force: true });
    const byHand = s.run({ taskId: 'b', ageMs: 1 * DAY });
    rmSync(byHand.worktreePath, { recursive: true, force: true });
    await sweepRetainedWorktrees(s.deps());
    expect(s.journal.workspaceCleanup(interrupted.worktreePath)?.status).toBe('removed');
    expect(s.journal.workspaceCleanup(byHand.worktreePath)).toBeNull();
  });

  it('legacy (unjournaled) worktree directories keep the 24 h rule; stale verification checkouts are removed', async () => {
    const s = setup();
    const legacyOld = join(s.reposRoot, 'worktrees', 'legacy-old');
    const legacyNew = join(s.reposRoot, 'worktrees', 'legacy-new');
    for (const dir of [legacyOld, legacyNew]) mkdirSync(dir, { recursive: true });
    const past = new Date(NOW - 2 * DAY);
    utimesSync(legacyOld, past, past);
    const recent = new Date(NOW - 60_000);
    utimesSync(legacyNew, recent, recent);
    const verifying = s.run({ taskId: 'v', state: 'verifying' });
    const staleCheckout = join(s.reposRoot, 'verify', 'run-crashed');
    const liveCheckout = join(s.reposRoot, 'verify', verifying.runId);
    for (const dir of [staleCheckout, liveCheckout]) mkdirSync(dir, { recursive: true });

    const report = await sweepRetainedWorktrees(s.deps());
    expect(Object.fromEntries(report.removed.map((entry) => [entry.worktreePath, entry.reason]))).toEqual({
      [legacyOld]: 'legacy_age',
      [staleCheckout]: 'orphan_checkout',
    });
    expect(existsSync(legacyNew) && existsSync(liveCheckout) && existsSync(verifying.worktreePath)).toBe(true);
  });
});

describe('W08 mirrors in the retention sweep', () => {
  function mirror(reposRoot: string, name: string, linkedWorktree: string | null, ageMs: number) {
    const path = join(reposRoot, 'acme', `${name}.git`);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'HEAD'), 'ref: refs/heads/main\n');
    if (linkedWorktree) {
      mkdirSync(join(path, 'worktrees', 'run-x'), { recursive: true });
      writeFileSync(join(path, 'worktrees', 'run-x', 'gitdir'), `${join(linkedWorktree, '.git')}\n`);
    }
    const when = new Date(NOW - ageMs);
    for (const target of [join(path, 'HEAD'), path]) utimesSync(target, when, when);
    return path;
  }

  it('removes a mirror no worktree uses after the retention period; keeps one a worktree still uses', async () => {
    const s = setup();
    const live = s.run({ taskId: 'a', ageMs: 1 * DAY });
    mkdirSync(join(live.worktreePath, '.git'), { recursive: true });
    const used = mirror(s.reposRoot, 'used', live.worktreePath, 30 * DAY);
    const unused = mirror(s.reposRoot, 'unused', join(s.root, 'gone-worktree'), 30 * DAY);
    const fresh = mirror(s.reposRoot, 'fresh', null, 1 * DAY);

    const report = await sweepRetainedWorktrees(s.deps());
    expect(report.removed).toEqual([{ worktreePath: unused, reason: 'unused_cache', bytes: 1_000 }]);
    expect(existsSync(used) && existsSync(fresh)).toBe(true);
    expect(s.journal.workspaceCleanup(unused)).toMatchObject({ status: 'removed', reason: 'unused_cache' });
  });

  it('mirrors count toward the disk budget; unused mirrors go before any worktree', async () => {
    const s = setup();
    const worktree = s.run({ taskId: 'a', ageMs: 5 * DAY });
    const unused = mirror(s.reposRoot, 'cache', null, 2 * DAY);
    // Worktree 1000 + mirror 1000 > 1500: the unused mirror is removed, the worktree kept.
    const report = await sweepRetainedWorktrees(s.deps({ policy: { maxBytes: 1_500 } }));
    expect(report.removed.map((entry) => [entry.worktreePath, entry.reason])).toEqual([[unused, 'disk_budget']]);
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  it('an admin entry without a readable gitdir keeps the mirror (never remove on doubt)', async () => {
    const s = setup();
    const path = mirror(s.reposRoot, 'doubt', null, 30 * DAY);
    mkdirSync(join(path, 'worktrees', 'broken'), { recursive: true });
    const report = await sweepRetainedWorktrees(s.deps());
    expect(report.removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });
});
