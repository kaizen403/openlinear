import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DIFF_LIMITS } from './diff-parser';
import { type ComputeTaskDiffInput, type ComputeTaskDiffOptions, EMPTY_TREE_SHA1, computeTaskDiff, readUntrackedPath } from './git-diff';
import type { DiffFile, TaskDiffResponse } from './types';

/**
 * Real-git coverage of the review diff, including planted payloads: every
 * payload script writes a marker file when it executes, and the fixture is
 * shown to be a live trigger with plain git before the hardened path runs.
 * Fixtures live under a fresh temp root with a fabricated HOME.
 */

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const describeGit = gitAvailable ? describe : describe.skip;
const mkfifoAvailable = spawnSync('mkfifo', ['--help']).error === undefined;

const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_NOSYSTEM'] as const;

let root = '';
let fakeHome = '';
let counter = 0;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: fakeHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', cwd, ...args], { env: { ...baseEnv(), ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fresh(name: string): string {
  counter += 1;
  return join(root, `${name}-${counter}`);
}

function write(repo: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function commitAll(repo: string, message: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** main with one commit, `origin/main` pointing at it, checked out on the task branch. */
function taskRepo(files: Record<string, string | Buffer> = { 'a.txt': 'one\ntwo\nthree\n' }): { repo: string; baseSha: string } {
  const repo = fresh('repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: baseEnv() });
  write(repo, files);
  const baseSha = commitAll(repo, 'base');
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'openlinear/abcd1234']);
  return { repo, baseSha };
}

function diff(repo: string, input: Partial<ComputeTaskDiffInput> = {}, options: ComputeTaskDiffOptions = {}): Promise<TaskDiffResponse> {
  return computeTaskDiff({ worktreePath: repo, baseRef: 'main', source: 'v2', ...input }, options);
}

function fileOf(response: TaskDiffResponse, path: string): DiffFile {
  const file = response.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`no ${path} in ${response.files.map((f) => f.path).join(', ')}`);
  return file;
}

function textOf(file: DiffFile): string[] {
  return file.hunks.flatMap((hunk) => hunk.lines).map((line) => `${line.kind}:${line.text}`);
}

function lineCount(file: DiffFile): number {
  return file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}

function lines(count: number, label = 'line'): string {
  return `${Array.from({ length: count }, (_, i) => `${label} ${i}`).join('\n')}\n`;
}

function payloadScript(name: string, body = ''): { script: string; marker: string } {
  const id = fresh(name).slice(root.length + 1);
  const marker = join(root, 'markers', `${id}.ran`);
  const script = join(root, 'payloads', `${id}.sh`);
  writeFileSync(script, `#!/bin/sh\necho executed >> '${marker}'\n${body}\n`);
  chmodSync(script, 0o755);
  return { script, marker };
}

function markersPresent(): string[] {
  return readdirSync(join(root, 'markers'));
}

function clearMarkers(): void {
  for (const marker of markersPresent()) rmSync(join(root, 'markers', marker), { force: true });
}

/** A global config / HOME full of program-running keys, planted in the sidecar's own environment. */
function plantEvilGlobalConfig(): { globalFile: string; scripts: string[] } {
  const textconv = payloadScript('global-textconv', 'cat "$1"');
  const command = payloadScript('global-diff-command');
  const clean = payloadScript('global-filter-clean', 'cat');
  const external = payloadScript('global-diff-external');
  const fsmonitor = payloadScript('global-fsmonitor');
  const config = [
    '[diff "evil"]', `\ttextconv = ${textconv.script}`, `\tcommand = ${command.script}`,
    '[filter "evil"]', `\tclean = ${clean.script}`, `\tsmudge = ${clean.script}`,
    '[diff]', `\texternal = ${external.script}`,
    '[core]', `\tfsmonitor = ${fsmonitor.script}`, `\tpager = ${external.script}`,
    '',
  ].join('\n');
  const evilHome = fresh('evil-home');
  mkdirSync(join(evilHome, '.config', 'git'), { recursive: true });
  writeFileSync(join(evilHome, '.gitconfig'), config);
  writeFileSync(join(evilHome, '.config', 'git', 'config'), config);
  writeFileSync(join(evilHome, '.config', 'git', 'attributes'), '* diff=evil\n* filter=evil\n');
  const globalFile = fresh('evil-global.cfg');
  writeFileSync(globalFile, config);
  process.env.HOME = evilHome;
  process.env.XDG_CONFIG_HOME = join(evilHome, '.config');
  process.env.GIT_CONFIG_GLOBAL = globalFile;
  process.env.GIT_CONFIG_PARAMETERS = `'diff.external'='${external.script}'`;
  process.env.GIT_EXTERNAL_DIFF = external.script;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  return { globalFile, scripts: [textconv.script, command.script, clean.script, external.script, fsmonitor.script] };
}

describeGit('computeTaskDiff (real git)', () => {
  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-task-diff-')));
    fakeHome = join(root, 'home');
    for (const dir of ['home', 'markers', 'payloads']) mkdirSync(join(root, dir), { recursive: true });
  });

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearMarkers();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('includes committed, staged, unstaged and untracked changes against the merge-base with origin/main', async () => {
    const { repo, baseSha } = taskRepo({ 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' });
    write(repo, { 'a.txt': 'one\nTWO\nthree\n' });
    commitAll(repo, 'agent commit');
    // origin/main advances after the attempt started.
    git(repo, ['checkout', '-q', 'main']);
    write(repo, { 'c.txt': 'c2 upstream\n' });
    commitAll(repo, 'upstream');
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(repo, ['checkout', '-q', 'openlinear/abcd1234']);
    write(repo, { 'b.txt': 'b1\nb2 unstaged\n', 'staged.txt': 'staged\n', 'u.txt': 'untracked 1\nuntracked 2\n' });
    git(repo, ['add', 'staged.txt']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    const res = await diff(repo);
    expect(res.base).toEqual({ ref: 'origin/main', sha: baseSha });
    expect(res.head).toEqual({ ref: 'openlinear/abcd1234', sha: head, dirty: true });
    expect(res.source).toBe('v2');
    expect(res.files.map((f) => [f.path, f.status, f.untracked ?? false])).toEqual([
      ['a.txt', 'modified', false],
      ['b.txt', 'modified', false],
      ['staged.txt', 'added', false],
      ['u.txt', 'added', true],
    ]);
    expect(textOf(fileOf(res, 'a.txt'))).toEqual(['context:one', 'del:two', 'add:TWO', 'context:three']);
    expect(fileOf(res, 'a.txt').hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(fileOf(res, 'b.txt').hunks[0].lines).toEqual([
      { kind: 'context', oldNo: 1, newNo: 1, text: 'b1' },
      { kind: 'add', newNo: 2, text: 'b2 unstaged' },
    ]);
    expect(fileOf(res, 'u.txt').hunks).toEqual([{
      header: '@@ -0,0 +1,2 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2,
      lines: [{ kind: 'add', newNo: 1, text: 'untracked 1' }, { kind: 'add', newNo: 2, text: 'untracked 2' }],
    }]);
    expect(JSON.stringify(res)).not.toContain('c2 upstream');
    expect(res.stats).toEqual({ files: 4, additions: 5, deletions: 1, shownFiles: 4, binaryFiles: 0, untrackedFiles: 1 });
    expect(res.truncated).toBe(false);
    expect(res.limits).toEqual(DEFAULT_DIFF_LIMITS);
    expect(res.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a clean HEAD (dirty=false) when only committed changes exist', async () => {
    const { repo } = taskRepo();
    write(repo, { 'a.txt': 'rewritten\n' });
    commitAll(repo, 'agent');
    const res = await diff(repo);
    expect(res.head.dirty).toBe(false);
    expect(res.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('detects a rename with edits', async () => {
    const original = lines(20);
    const { repo } = taskRepo({ 'old-name.txt': original });
    git(repo, ['mv', 'old-name.txt', 'new-name.txt']);
    write(repo, { 'new-name.txt': original.replace('line 5\n', 'line five\n') });
    const res = await diff(repo);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({ path: 'new-name.txt', oldPath: 'old-name.txt', status: 'renamed', additions: 1, deletions: 1 });
    expect(res.files[0].similarity).toBeGreaterThanOrEqual(80);
    expect(textOf(res.files[0])).toEqual(expect.arrayContaining(['del:line 5', 'add:line five']));
  });

  it('reports binary files (added, modified, untracked) without hunks and keeps later files aligned', async () => {
    const { repo } = taskRepo({ 'mod.bin': Buffer.from([0, 1, 2, 3, 0, 5]), 'z.txt': 'z1\n' });
    write(repo, { 'mod.bin': Buffer.from([0, 9, 9, 9, 0]), 'new.bin': Buffer.from([0x89, 0x50, 0, 0, 1]), 'z.txt': 'z2\n' });
    git(repo, ['add', 'new.bin']);
    write(repo, { 'untracked.bin': Buffer.from([1, 0, 2]) });
    const res = await diff(repo);
    expect(fileOf(res, 'mod.bin')).toEqual({ path: 'mod.bin', status: 'binary', additions: 0, deletions: 0, hunks: [] });
    expect(fileOf(res, 'new.bin')).toMatchObject({ status: 'binary', hunks: [] });
    expect(fileOf(res, 'untracked.bin')).toMatchObject({ status: 'binary', untracked: true, hunks: [] });
    expect(textOf(fileOf(res, 'z.txt'))).toEqual(['del:z1', 'add:z2']);
    expect(res.stats.binaryFiles).toBe(3);
  });

  it('caps a huge file at maxLinesPerFile while numstat totals stay exact', async () => {
    const { repo } = taskRepo();
    write(repo, { 'big.txt': lines(30_000, 'row') });
    commitAll(repo, 'big');
    const res = await diff(repo);
    const big = fileOf(res, 'big.txt');
    expect(big.truncated).toBe(true);
    expect(lineCount(big)).toBe(DEFAULT_DIFF_LIMITS.maxLinesPerFile);
    expect(big.additions).toBe(30_000);
    expect(res.stats.additions).toBe(30_000);
    expect(res.truncated).toBe(true);
  });

  it('shows at most maxFiles files while stats count all of them', async () => {
    const { repo } = taskRepo();
    for (let i = 0; i < 8; i += 1) write(repo, { [`f${i}.txt`]: `file ${i}\n` });
    commitAll(repo, 'many');
    write(repo, { 'u1.txt': 'untracked\n' });
    const res = await diff(repo, {}, { limits: { maxFiles: 5 } });
    expect(res.files).toHaveLength(5);
    expect(res.stats).toMatchObject({ files: 9, shownFiles: 5, untrackedFiles: 1, additions: 8 });
    expect(res.truncated).toBe(true);
    expect(res.limits.maxFiles).toBe(5);
  });

  it('parses a patch cut at maxPatchBytes and marks the rest truncated', async () => {
    const { repo } = taskRepo();
    write(repo, { 'f0.txt': lines(50), 'f1.txt': lines(50), 'f2.txt': lines(50) });
    commitAll(repo, 'three files');
    const res = await diff(repo, {}, { limits: { maxPatchBytes: 300 } });
    expect(res.truncated).toBe(true);
    expect(res.files).toHaveLength(3);
    expect(res.stats.additions).toBe(150);
    expect(res.files[0].truncated).toBe(true);
    expect(lineCount(res.files[0])).toBeGreaterThan(0);
    expect(lineCount(res.files[0])).toBeLessThan(50);
    expect(res.files[2]).toMatchObject({ truncated: true, hunks: [] });
  });

  it('shows an untracked symlink as its target string and never reads outside the worktree', async () => {
    const outside = fresh('outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-CONTENT\n');
    const { repo } = taskRepo({ 'a.txt': 'a\n', 'tracked.txt': 'tracked\n' });
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'leak.txt'));
    symlinkSync(outside, join(repo, 'leakdir'));
    // A tracked file replaced by a symlink (typechange: two patch sections).
    rmSync(join(repo, 'tracked.txt'));
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'tracked.txt'));
    const res = await diff(repo);
    expect(fileOf(res, 'leak.txt')).toMatchObject({ status: 'added', untracked: true, additions: 1 });
    expect(fileOf(res, 'leak.txt').hunks[0].lines).toEqual([{ kind: 'add', newNo: 1, text: join(outside, 'secret.txt'), noEol: true }]);
    expect(textOf(fileOf(res, 'leakdir'))).toEqual([`add:${outside}`]);
    expect(textOf(fileOf(res, 'tracked.txt'))).toEqual(['del:tracked', `add:${join(outside, 'secret.txt')}`]);
    expect(JSON.stringify(res)).not.toContain('TOP-SECRET-CONTENT');
  });

  it.skipIf(!mkfifoAvailable)('skips an untracked FIFO without blocking', async () => {
    const { repo } = taskRepo();
    execFileSync('mkfifo', [join(repo, 'pipe')]);
    write(repo, { 'after.txt': 'x\n' });
    const res = await diff(repo);
    expect(res.files.map((f) => f.path)).toEqual(['after.txt']);
  });

  it('honours an explicit base and validates it', async () => {
    const { repo, baseSha } = taskRepo();
    write(repo, { 'a.txt': 'changed\n' });
    const c1 = commitAll(repo, 'c1');
    write(repo, { 'b.txt': 'b\n' });
    commitAll(repo, 'c2');
    const bySha = await diff(repo, { base: c1 });
    expect(bySha.base).toEqual({ ref: c1, sha: c1 });
    expect(bySha.files.map((f) => f.path)).toEqual(['b.txt']);
    expect((await diff(repo, { base: 'main' })).base).toEqual({ ref: 'main', sha: baseSha });
    await expect(diff(repo, { base: '--output=x' })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_BASE_REF' });
    expect(existsSync(join(repo, 'x'))).toBe(false);
    await expect(diff(repo, { base: 'no-such-branch' })).rejects.toMatchObject({ statusCode: 404, code: 'BASE_REF_NOT_FOUND' });
    await expect(diff(repo, { base: 'f'.repeat(40) })).rejects.toMatchObject({ statusCode: 404, code: 'BASE_REF_NOT_FOUND' });
  });

  it('excludes .sisyphus runtime artifacts', async () => {
    const { repo } = taskRepo({ 'a.txt': 'a\n', '.sisyphus/tracked.md': 'v1\n' });
    write(repo, { '.sisyphus/tracked.md': 'v2\n', '.sisyphus/plans/new.md': 'plan\n', 'real.txt': 'r\n' });
    const res = await diff(repo);
    expect(res.files.map((f) => f.path)).toEqual(['real.txt']);
  });

  it('keeps the revision stable until something changes, and never rewrites the index', async () => {
    const { repo } = taskRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    write(repo, { 'a.txt': 'x\n', 'u.txt': 'u\n' });
    const first = await diff(repo);
    expect((await diff(repo)).revision).toBe(first.revision);
    write(repo, { 'u.txt': 'u2\n' });
    const untrackedEdit = await diff(repo);
    expect(untrackedEdit.revision).not.toBe(first.revision);
    write(repo, { 'a.txt': 'y\n' });
    const trackedEdit = await diff(repo);
    expect(trackedEdit.revision).not.toBe(untrackedEdit.revision);
    // Touch an unchanged tracked file: stat-dirty, same content.
    const index = join(repo, '.git', 'index');
    const indexBefore = statSync(index).mtimeMs;
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(repo, 'b.txt'), future, future);
    const touched = await diff(repo);
    expect(touched.files.map((f) => f.path)).toEqual(['a.txt', 'u.txt']);
    expect(touched.revision).toBe(trackedEdit.revision);
    expect(statSync(index).mtimeMs).toBe(indexBefore);
    expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
  });

  it('falls back to the empty tree in a repository without commits', async () => {
    const repo = fresh('empty');
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: baseEnv() });
    write(repo, { 'first.txt': 'hello\n' });
    const untracked = await diff(repo, { baseRef: null, source: 'legacy-disk' });
    expect(untracked.base).toEqual({ ref: 'empty', sha: EMPTY_TREE_SHA1 });
    expect(untracked.head).toEqual({ ref: 'main', sha: null, dirty: true });
    expect(untracked.files).toEqual([expect.objectContaining({ path: 'first.txt', status: 'added', untracked: true })]);
    git(repo, ['add', 'first.txt']);
    const staged = await diff(repo, { baseRef: null });
    expect(staged.files).toEqual([expect.objectContaining({ path: 'first.txt', status: 'added', additions: 1 })]);
    expect(staged.files[0].untracked).toBeUndefined();
    expect(staged.head.dirty).toBe(true);
  });

  it('falls back to a local branch, then HEAD when there are no remotes', async () => {
    const repo = fresh('no-remote');
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: baseEnv() });
    write(repo, { 'a.txt': 'a\n' });
    const baseSha = commitAll(repo, 'base');
    git(repo, ['checkout', '-q', '-b', 'openlinear/abcd1234']);
    write(repo, { 'b.txt': 'committed\n' });
    const head = commitAll(repo, 'agent');
    write(repo, { 'c.txt': 'uncommitted\n' });
    expect((await diff(repo, { baseRef: 'main' })).base).toEqual({ ref: 'main', sha: baseSha });
    const noBase = await diff(repo, { baseRef: null });
    expect(noBase.base).toEqual({ ref: 'HEAD', sha: head });
    expect(noBase.files.map((f) => f.path)).toEqual(['c.txt']);
    expect(noBase.head.dirty).toBe(true);
  });

  it('uses origin/HEAD, then the fork point from remotes (ignoring pushed task branches)', async () => {
    const { repo, baseSha } = taskRepo();
    write(repo, { 'a.txt': 'agent\n' });
    const head = commitAll(repo, 'agent');
    git(repo, ['update-ref', 'refs/remotes/origin/openlinear/abcd1234', head]);
    const fork = await diff(repo, { baseRef: null });
    expect(fork.base).toEqual({ ref: 'fork-point', sha: baseSha });
    expect(fork.files.map((f) => f.path)).toEqual(['a.txt']);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    expect((await diff(repo, { baseRef: null })).base).toEqual({ ref: 'origin/HEAD', sha: baseSha });
    // An unsafe recorded default branch is ignored rather than passed to git.
    expect((await diff(repo, { baseRef: '--upload-pack=x' })).base.ref).toBe('origin/HEAD');
  });

  it('works in a linked worktree of a blobless mirror and never lazy-fetches a missing blob', async () => {
    const origin = `${fresh('origin')}.git`;
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: baseEnv() });
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    const seed = fresh('seed');
    execFileSync('git', ['init', '-q', '-b', 'main', seed], { env: baseEnv() });
    write(seed, { 'big.txt': 'version one\n', 'other.txt': 'other\n' });
    const c1 = commitAll(seed, 'c1');
    write(seed, { 'big.txt': 'version two\n' });
    const c2 = commitAll(seed, 'c2');
    git(seed, ['push', '-q', origin, 'main']);
    const mirror = `${fresh('mirror')}.git`;
    execFileSync('git', ['clone', '-q', '--bare', '--filter=blob:none', `file://${origin}`, mirror], { env: baseEnv(), stdio: 'ignore' });
    git(mirror, ['update-ref', 'refs/remotes/origin/main', c2]);
    const worktree = fresh('wt');
    git(mirror, ['worktree', 'add', '-q', '-b', 'openlinear/run-1', worktree, c2]);
    write(worktree, { 'other.txt': 'other edited\n' });

    const ok = await computeTaskDiff({ worktreePath: worktree, baseRef: 'main', source: 'v2' });
    expect(ok.base).toEqual({ ref: 'origin/main', sha: c2 });
    expect(ok.files.map((f) => f.path)).toEqual(['other.txt']);

    const missing = () => git(mirror, ['rev-list', '--objects', '--missing=print', c1]).split('\n').filter((l) => l.startsWith('?'));
    const before = missing();
    expect(before.length).toBeGreaterThan(0);
    await expect(computeTaskDiff({ worktreePath: worktree, baseRef: 'main', source: 'v2', base: c1 })).rejects.toMatchObject({ statusCode: 500, code: 'DIFF_FAILED' });
    expect(missing()).toEqual(before);
  });

  it('answers 404 when the worktree vanished and DIFF_FAILED outside a repository', async () => {
    await expect(diff(join(root, 'does-not-exist'))).rejects.toMatchObject({ statusCode: 404, code: 'DIFF_WORKSPACE_NOT_FOUND' });
    const plainDir = fresh('not-a-repo');
    mkdirSync(plainDir);
    const error = await diff(plainDir).catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 500, code: 'DIFF_FAILED', message: 'Failed to compute the task diff' });
    // A linked worktree whose gitdir was pruned: the config cannot be verified.
    const pruned = fresh('pruned');
    mkdirSync(pruned);
    writeFileSync(join(pruned, '.git'), `gitdir: ${join(root, 'gone.git', 'worktrees', 'x')}\n`);
    const refused = await diff(pruned).catch((e: unknown) => e);
    expect(refused).toMatchObject({ statusCode: 409, code: 'GIT_CONFIG_UNSAFE', details: { keys: [] } });
    expect(refused).toHaveProperty('message', expect.stringMatching(/could not be verified/));
  });

  describe('planted payloads', () => {
    it('(a) refuses repository-local drivers/filters with GIT_CONFIG_UNSAFE and runs nothing', async () => {
      const { repo } = taskRepo({ 'a.txt': 'a\n', '.gitattributes': '* diff=evil\n* filter=evil\n' });
      const textconv = payloadScript('textconv', 'cat "$1"');
      const command = payloadScript('diff-command');
      const clean = payloadScript('filter-clean', 'cat');
      git(repo, ['config', 'diff.evil.textconv', textconv.script]);
      git(repo, ['config', 'diff.evil.command', command.script]);
      git(repo, ['config', 'filter.evil.clean', clean.script]);
      write(repo, { 'a.txt': 'changed\n' });
      // Live trigger with plain git:
      spawnSync('git', ['-C', repo, 'diff', 'HEAD'], { env: baseEnv(), encoding: 'utf8' });
      expect(markersPresent().length).toBeGreaterThan(0);
      clearMarkers();

      const error = await diff(repo).catch((e: unknown) => e);
      expect(error).toMatchObject({ statusCode: 409, code: 'GIT_CONFIG_UNSAFE', details: { keys: ['diff.evil.command', 'diff.evil.textconv', 'filter.evil.clean'] } });
      expect(JSON.stringify(error)).not.toContain(join(root, 'payloads'));
      expect(markersPresent()).toEqual([]);
    });

    it('(b) ignores drivers, filters and diff.external planted in the global config / HOME / env', async () => {
      const { repo } = taskRepo({ 'a.txt': 'original\n', '.gitattributes': '* diff=evil\n* filter=evil\n' });
      const { globalFile } = plantEvilGlobalConfig();
      write(repo, { 'a.txt': 'changed for review\n' });
      // Live trigger with plain git using that global config:
      spawnSync('git', ['-C', repo, 'diff', 'HEAD'], { env: { ...baseEnv(), GIT_CONFIG_GLOBAL: globalFile }, encoding: 'utf8' });
      expect(markersPresent().length).toBeGreaterThan(0);
      clearMarkers();

      const res = await diff(repo);
      expect(textOf(fileOf(res, 'a.txt'))).toEqual(['del:original', 'add:changed for review']);
      expect(markersPresent()).toEqual([]);
    });

    it('(c) ignores .git/info/attributes pointing at a globally configured driver', async () => {
      const { repo } = taskRepo({ 'a.txt': 'original\n' });
      writeFileSync(join(repo, '.git', 'info', 'attributes'), '* diff=evil\n* filter=evil\n');
      const { globalFile } = plantEvilGlobalConfig();
      write(repo, { 'a.txt': 'changed\n' });
      spawnSync('git', ['-C', repo, 'diff', 'HEAD'], { env: { ...baseEnv(), GIT_CONFIG_GLOBAL: globalFile }, encoding: 'utf8' });
      expect(markersPresent().length).toBeGreaterThan(0);
      clearMarkers();

      const res = await diff(repo);
      expect(textOf(fileOf(res, 'a.txt'))).toEqual(['del:original', 'add:changed']);
      expect(markersPresent()).toEqual([]);
    });
  });
});

describe('readUntrackedPath', () => {
  let dir = '';

  beforeAll(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-untracked-')));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads regular files (binary sniff, byte cap without splitting UTF-8)', async () => {
    const wt = join(dir, 'wt-files');
    mkdirSync(join(wt, 'sub'), { recursive: true });
    writeFileSync(join(wt, 'sub', 'text.txt'), 'hello\n');
    writeFileSync(join(wt, 'bin'), Buffer.from([65, 0, 66]));
    writeFileSync(join(wt, 'utf8.txt'), 'aé€');
    expect((await readUntrackedPath(wt, 'sub/text.txt', 100))?.content).toEqual({ kind: 'text', text: 'hello\n', cut: false });
    expect((await readUntrackedPath(wt, 'bin', 100))?.content).toEqual({ kind: 'binary' });
    // 'a' (1) + 'é' (2) + '€' (3) = 6 bytes; a 4-byte cap must not emit half of '€'.
    expect((await readUntrackedPath(wt, 'utf8.txt', 4))?.content).toEqual({ kind: 'text', text: 'aé', cut: true });
    expect((await readUntrackedPath(wt, 'utf8.txt', 6))?.content).toEqual({ kind: 'text', text: 'aé€', cut: false });
  });

  it('refuses traversal, absolute paths, symlinked parents and special files', async () => {
    const wt = join(dir, 'wt-unsafe');
    const outside = join(dir, 'outside');
    mkdirSync(wt, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(outside, join(wt, 'linked'));
    mkdirSync(join(wt, 'realdir'));
    expect(await readUntrackedPath(wt, '../outside/secret.txt', 100)).toBeNull();
    expect(await readUntrackedPath(wt, join(outside, 'secret.txt'), 100)).toBeNull();
    expect(await readUntrackedPath(wt, 'linked/secret.txt', 100)).toBeNull();
    expect(await readUntrackedPath(wt, '', 100)).toBeNull();
    expect(await readUntrackedPath(wt, 'realdir', 100)).toBeNull();
    expect(await readUntrackedPath(wt, 'missing.txt', 100)).toBeNull();
    expect((await readUntrackedPath(wt, 'linked', 100))?.content).toEqual({ kind: 'symlink', target: outside });
    if (mkfifoAvailable) {
      execFileSync('mkfifo', [join(wt, 'fifo')]);
      expect(await readUntrackedPath(wt, 'fifo', 100)).toBeNull();
    }
  });
});
