import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableRunJournal } from '../../journal/durable';
import type { RunSnapshot, RunWorkspace } from '../../run/types';
import { branchFromLogs, defaultReposRoot, readJournalWorkspace, resolveTaskWorkspace, scanLegacyWorktrees, scanLegacyWorktreesFor, type LiveExecutionView } from './workspace-resolver';

const TASK = 'abcd1234-0000-4000-8000-000000000001';
const LEGACY_HEAD = 'ref: refs/heads/openlinear/abcd1234';

let root = '';
let appData = '';
let repos = '';

const noLive = { liveExecution: (): LiveExecutionView | undefined => undefined };

function dir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function snapshot(defaultBranch: string | null): RunSnapshot {
  return {
    title: 'Task', description: null, model: null, agent: null, labels: [], projectId: null, teamId: null, creatorId: null, localPath: null,
    repository: defaultBranch ? { id: 'r1', name: 'repo', fullName: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', defaultBranch } : null,
  };
}

function workspace(worktreePath: string, baseRef: string | null, runId = 'run-1'): RunWorkspace {
  return { worktreePath, branch: `openlinear/${runId}`, baseRef, owned: true, handle: { runId, mirrorPath: join(repos, 'acme', 'repo.git'), dissociated: false } };
}

interface Row {
  runId: string;
  userId?: string;
  taskId?: string;
  workspace: string | null;
  snapshot?: string;
  createdAt: number;
}

/** A journal file with just the run_attempts columns the resolver reads. */
function writeJournal(rows: Row[]): string {
  const path = DurableRunJournal.defaultPath();
  dir(dirname(path));
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS run_attempts (run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT NOT NULL, workspace_json TEXT, snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const insert = db.prepare('INSERT INTO run_attempts (run_id, task_id, user_id, workspace_json, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.runId, row.taskId ?? TASK, row.userId ?? 'user-9', row.workspace, row.snapshot ?? JSON.stringify(snapshot('main')), row.createdAt);
  }
  db.close();
  return path;
}

function legacyLinked(name: string, head: string, mirror = join(repos, 'acme', 'repo.git')): string {
  const worktree = dir(join(repos, 'worktrees', name));
  const gitdir = dir(join(mirror, 'worktrees', name));
  writeFileSync(join(gitdir, 'HEAD'), `${head}\n`);
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
  return worktree;
}

function legacyClone(name: string, head: string): string {
  const worktree = dir(join(repos, 'worktrees', name));
  dir(join(worktree, '.git'));
  writeFileSync(join(worktree, '.git', 'HEAD'), `${head}\n`);
  return worktree;
}

function age(path: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, when, when);
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-resolver-')));
  appData = join(root, 'appdata');
  repos = join(appData, 'repos');
  dir(join(repos, 'worktrees'));
  vi.stubEnv('OPENLINEAR_APP_DATA', appData);
  vi.stubEnv('REPOS_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('resolveTaskWorkspace', () => {
  it('prefers the live legacy execution', async () => {
    const live = dir(join(root, 'live-checkout'));
    const v2 = dir(join(repos, 'worktrees', 'run-1'));
    writeJournal([{ runId: 'run-1', workspace: JSON.stringify(workspace(v2, 'main')), createdAt: 1 }]);
    legacyClone('old', LEGACY_HEAD);
    const resolved = await resolveTaskWorkspace(TASK, {
      liveExecution: () => ({ repoPath: live, branchName: 'openlinear/abcd1234', userId: 'user-1', publishRepository: { defaultBranch: 'develop' } }),
    });
    expect(resolved).toEqual({ worktreePath: live, branch: 'openlinear/abcd1234', baseRef: 'develop', ownerUserId: 'user-1', source: 'legacy-live' });
  });

  it('falls through when the live execution has no checkout yet', async () => {
    const v2 = dir(join(repos, 'worktrees', 'run-1'));
    writeJournal([{ runId: 'run-1', workspace: JSON.stringify(workspace(v2, 'main')), createdAt: 1 }]);
    const resolved = await resolveTaskWorkspace(TASK, {
      liveExecution: () => ({ repoPath: join(root, 'not-cloned-yet'), branchName: 'x', userId: null }),
    });
    expect(resolved?.source).toBe('v2');
  });

  it('reads the newest v2 journal row (owner, workspace baseRef, snapshot default branch fallback)', async () => {
    const older = dir(join(repos, 'worktrees', 'run-old'));
    const newer = dir(join(repos, 'worktrees', 'run-new'));
    writeJournal([
      { runId: 'run-old', workspace: JSON.stringify(workspace(older, 'main', 'run-old')), createdAt: 1 },
      { runId: 'run-new', userId: 'user-2', workspace: JSON.stringify(workspace(newer, 'develop', 'run-new')), createdAt: 2 },
      { runId: 'run-other-task', taskId: 'another-task', workspace: JSON.stringify(workspace(older, 'x')), createdAt: 3 },
    ]);
    expect(await resolveTaskWorkspace(TASK, noLive)).toEqual({ worktreePath: newer, branch: 'openlinear/run-new', baseRef: 'develop', ownerUserId: 'user-2', source: 'v2' });

    rmSync(DurableRunJournal.defaultPath());
    writeJournal([{ runId: 'run-a', workspace: JSON.stringify({ ...workspace(newer, null), owned: false, handle: null }), snapshot: JSON.stringify(snapshot('trunk')), createdAt: 5 }]);
    expect(await resolveTaskWorkspace(TASK, noLive)).toMatchObject({ baseRef: 'trunk', source: 'v2' });
  });

  it('falls through to the disk scan when the newest attempt worktree is gone', async () => {
    const gone = join(repos, 'worktrees', 'run-gone');
    const older = dir(join(repos, 'worktrees', 'run-older'));
    writeJournal([
      { runId: 'run-older', workspace: JSON.stringify(workspace(older, 'main', 'run-older')), createdAt: 1 },
      { runId: 'run-gone', workspace: JSON.stringify(workspace(gone, 'main', 'run-gone')), createdAt: 2 },
    ]);
    expect(await resolveTaskWorkspace(TASK, noLive)).toBeNull();
    const legacy = legacyClone('legacy', LEGACY_HEAD);
    expect(await resolveTaskWorkspace(TASK, noLive)).toEqual({ worktreePath: legacy, branch: 'openlinear/abcd1234', baseRef: null, ownerUserId: null, source: 'legacy-disk' });
  });

  it('skips corrupt journal rows', async () => {
    const valid = dir(join(repos, 'worktrees', 'run-valid'));
    writeJournal([
      { runId: 'run-valid', workspace: JSON.stringify(workspace(valid, 'main', 'run-valid')), createdAt: 1 },
      { runId: 'bad-json', workspace: '{not json', createdAt: 4 },
      { runId: 'bad-shape', workspace: JSON.stringify({ worktreePath: 7 }), createdAt: 3 },
      { runId: 'bad-snapshot', workspace: JSON.stringify(workspace(valid, 'main')), snapshot: '{"title":1}', createdAt: 2 },
      { runId: 'no-workspace', workspace: null, createdAt: 5 },
    ]);
    expect(await resolveTaskWorkspace(TASK, noLive)).toMatchObject({ worktreePath: valid, branch: 'openlinear/run-valid', source: 'v2' });
  });

  it('reads a real DurableRunJournal through a read-only connection while the writer is open', async () => {
    const worktree = dir(join(repos, 'worktrees', 'run-real'));
    const journal = new DurableRunJournal(DurableRunJournal.defaultPath());
    try {
      journal.createRun({
        runId: 'run-real', taskId: TASK, userId: 'user-7', attemptId: null, capability: null, capabilityExpiresAt: null,
        runner: 'opencode', model: null, state: 'queued', snapshot: snapshot('main'), bootId: 'boot',
      }, {});
      journal.update('run-real', { workspace: workspace(worktree, 'main', 'run-real') });
      expect(await resolveTaskWorkspace(TASK, noLive)).toEqual({ worktreePath: worktree, branch: 'openlinear/run-real', baseRef: 'main', ownerUserId: 'user-7', source: 'v2' });
      expect(journal.get('run-real')?.workspace?.worktreePath).toBe(worktree);
    } finally {
      journal.close();
    }
  });

  it('treats an unreadable journal as absent', async () => {
    const path = DurableRunJournal.defaultPath();
    dir(dirname(path));
    writeFileSync(path, 'this is not a sqlite database');
    expect(readJournalWorkspace(path, TASK)).toBeNull();
    expect(readJournalWorkspace(join(root, 'missing.sqlite'), TASK)).toBeNull();
    expect(await resolveTaskWorkspace(TASK, noLive)).toBeNull();
  });
});

describe('legacy disk scan', () => {
  it('finds openlinear/<task8> via a .git file (gitdir inside the repos root) and via a .git directory; newest HEAD wins', async () => {
    const linked = legacyLinked('11111111-aaaa', LEGACY_HEAD);
    const cloned = legacyClone('22222222-bbbb', LEGACY_HEAD);
    age(join(repos, 'acme', 'repo.git', 'worktrees', '11111111-aaaa', 'HEAD'), 10);
    age(join(cloned, '.git', 'HEAD'), 100);
    expect(await scanLegacyWorktrees(repos, TASK)).toBe(linked);
    age(join(cloned, '.git', 'HEAD'), 1);
    expect(await scanLegacyWorktrees(repos, TASK)).toBe(cloned);
  });

  it('accepts a relative gitdir pointer and a CRLF HEAD', async () => {
    const worktree = dir(join(repos, 'worktrees', 'relative'));
    const gitdir = dir(join(repos, 'acme', 'repo.git', 'worktrees', 'relative'));
    writeFileSync(join(gitdir, 'HEAD'), `${LEGACY_HEAD}\r\n`);
    writeFileSync(join(worktree, '.git'), 'gitdir: ../../acme/repo.git/worktrees/relative\r\n');
    expect(await scanLegacyWorktrees(repos, TASK)).toBe(worktree);
  });

  it('does not match a v2 branch, a different task, a detached HEAD or an unrelated .git file', async () => {
    legacyClone('v2', `ref: refs/heads/openlinear/${TASK}`);
    legacyClone('prefix', 'ref: refs/heads/openlinear/abcd12345');
    legacyClone('other', 'ref: refs/heads/openlinear/ffff0000');
    legacyClone('detached', 'a'.repeat(40));
    const odd = dir(join(repos, 'worktrees', 'odd'));
    writeFileSync(join(odd, '.git'), 'not a gitdir pointer\n');
    const empty = dir(join(repos, 'worktrees', 'empty-pointer'));
    writeFileSync(join(empty, '.git'), 'gitdir: \n');
    writeFileSync(join(repos, 'worktrees', 'stray-file'), 'x');
    expect(await scanLegacyWorktrees(repos, TASK)).toBeNull();
  });

  it('ignores a symlinked .git, a symlinked worktree, a symlinked HEAD and a gitdir outside the repos root', async () => {
    const outside = dir(join(root, 'outside'));
    // symlinked .git
    const target = dir(join(outside, 'gitdir-a'));
    writeFileSync(join(target, 'HEAD'), `${LEGACY_HEAD}\n`);
    const wtA = dir(join(repos, 'worktrees', 'symlinked-dotgit'));
    symlinkSync(target, join(wtA, '.git'));
    // symlinked worktree directory
    const realElsewhere = dir(join(outside, 'checkout'));
    dir(join(realElsewhere, '.git'));
    writeFileSync(join(realElsewhere, '.git', 'HEAD'), `${LEGACY_HEAD}\n`);
    symlinkSync(realElsewhere, join(repos, 'worktrees', 'symlinked-worktree'));
    // gitdir pointer outside the repos root
    legacyLinked('outside-gitdir', LEGACY_HEAD, join(outside, 'mirror.git'));
    // gitdir reached through a symlink that leaves the repos root
    symlinkSync(join(outside, 'mirror.git'), join(repos, 'escape.git'));
    const wtB = dir(join(repos, 'worktrees', 'via-symlink'));
    dir(join(outside, 'mirror.git', 'worktrees', 'via-symlink'));
    writeFileSync(join(outside, 'mirror.git', 'worktrees', 'via-symlink', 'HEAD'), `${LEGACY_HEAD}\n`);
    writeFileSync(join(wtB, '.git'), `gitdir: ${join(repos, 'escape.git', 'worktrees', 'via-symlink')}\n`);
    // symlinked HEAD inside a .git directory
    const wtC = dir(join(repos, 'worktrees', 'symlinked-head'));
    dir(join(wtC, '.git'));
    writeFileSync(join(outside, 'HEAD'), `${LEGACY_HEAD}\n`);
    symlinkSync(join(outside, 'HEAD'), join(wtC, '.git', 'HEAD'));
    expect(await scanLegacyWorktrees(repos, TASK)).toBeNull();
  });

  it('refuses unusable task ids and missing roots', async () => {
    legacyClone('dots', 'ref: refs/heads/openlinear/../x');
    expect(await scanLegacyWorktrees(repos, '../x')).toBeNull();
    expect(await scanLegacyWorktrees(join(root, 'missing'), TASK)).toBeNull();
  });
});

describe('defaultReposRoot', () => {
  it('mirrors appReposDir() in workspace/local-worktree.ts', () => {
    expect(defaultReposRoot({ REPOS_DIR: '/custom/repos' }, 'linux')).toBe(resolve('/custom/repos'));
    expect(defaultReposRoot({ OPENLINEAR_APP_DATA: '/app' }, 'darwin')).toBe(resolve('/app/repos'));
    expect(defaultReposRoot({}, 'darwin')).toBe(join(homedir(), 'Library', 'Application Support', 'OpenLinear', 'repos'));
    expect(defaultReposRoot({ XDG_DATA_HOME: '/xdg' }, 'linux')).toBe(resolve('/xdg/openlinear/repos'));
    expect(defaultReposRoot({}, 'linux')).toBe(join(homedir(), '.local', 'share', 'openlinear', 'repos'));
    expect(defaultReposRoot({ LOCALAPPDATA: '/local' }, 'win32')).toBe(resolve('/local/OpenLinear/repos'));
    expect(defaultReposRoot()).toBe(join(appData, 'repos'));
  });
});

describe('finished legacy runs (branch from the persisted log)', () => {
  const RUN_BRANCH = 'openlinear/5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab';

  it('branchFromLogs takes the newest sidecar-written "Branch created" line and nothing else', () => {
    expect(branchFromLogs([
      { type: 'info', message: 'Branch created: openlinear/old-run' },
      { type: 'agent', message: 'Branch created: openlinear/agent-said-so' },
      { type: 'info', message: `Branch created: ${RUN_BRANCH}` },
      { type: 'info', message: 'OpenCode agent started' },
    ])).toBe(RUN_BRANCH);
    expect(branchFromLogs([{ type: 'agent', message: 'Branch created: openlinear/x' }])).toBeNull();
    expect(branchFromLogs([{ type: 'info', message: 'Branch created: main' }])).toBeNull();
    expect(branchFromLogs([{ type: 'info', message: 'Branch created: openlinear/../../etc' }])).toBeNull();
    expect(branchFromLogs([{ type: 'info', message: 'Branch created: openlinear/a b' }])).toBeNull();
    expect(branchFromLogs([null, 'x', { type: 'info' }])).toBeNull();
  });

  it("finds the clone on the logged branch (today's openlinear/<uuid> legacy checkouts)", async () => {
    const worktree = legacyLinked('7d0c-clone', `ref: refs/heads/${RUN_BRANCH}`);
    legacyLinked('other-clone', 'ref: refs/heads/openlinear/99999999-aaaa-4bbb-8ccc-0123456789ab');
    expect(await resolveTaskWorkspace(TASK, noLive)).toBeNull();
    const persistedBranch = vi.fn(async () => RUN_BRANCH);
    expect(await resolveTaskWorkspace(TASK, { ...noLive, persistedBranch })).toEqual({ worktreePath: worktree, branch: RUN_BRANCH, baseRef: null, ownerUserId: null, source: 'legacy-disk' });
    expect(persistedBranch).toHaveBeenCalledWith(TASK);
  });

  it('a persisted log that cannot be read still allows the older-checkout scan; hostile branches are ignored', async () => {
    const legacy = legacyClone('old', LEGACY_HEAD);
    const failing = async (): Promise<string | null> => {
      throw new Error('503');
    };
    expect(await resolveTaskWorkspace(TASK, { ...noLive, persistedBranch: failing })).toMatchObject({ worktreePath: legacy, source: 'legacy-disk' });
    expect(await scanLegacyWorktreesFor(repos, '../x', ['refs/heads/main', 'openlinear/../x'])).toBeNull();
  });

  it('is not consulted when a live workspace exists', async () => {
    const live = dir(join(root, 'live'));
    const persistedBranch = vi.fn(async () => RUN_BRANCH);
    await resolveTaskWorkspace(TASK, { liveExecution: () => ({ repoPath: live, branchName: 'b', userId: 'u' }), persistedBranch });
    expect(persistedBranch).not.toHaveBeenCalled();
  });
});
