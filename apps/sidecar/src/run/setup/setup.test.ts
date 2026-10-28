import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseSetupSteps, type VerificationCheckSpec } from '@openlinear/execution-core';
import { platformProvider } from '../../sandbox/provider';
import type { RunWorkspace } from '../types';
import { createSandboxedCheckExecutor, type CheckExecution, type CheckExecutionInput, type CheckExecutor } from '../verification/executor';
import { changedPaths, createLocalSetup, worktreeFingerprint } from './index';

/**
 * W16a setup port: one step through the verification check executor in the
 * run's worktree (realpath), a private HOME/TMP root per run removed by
 * `cleanup`, a log artifact per step, the repos root denied. The second
 * suite runs real steps under the enforced OS sandbox (macOS Seatbelt
 * locally, bubblewrap on Linux CI) in a real `git worktree`; skipped
 * without a usable provider unless OPENLINEAR_SANDBOX_CORPUS_REQUIRED=1.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function steps(raw: unknown[]): VerificationCheckSpec[] {
  const parsed = parseSetupSteps(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.value;
}

function workspaceAt(path: string): RunWorkspace {
  return { worktreePath: path, branch: 'openlinear/run-1', baseRef: 'main', owned: true, handle: null };
}

class RecordingExecutor implements CheckExecutor {
  readonly inputs: CheckExecutionInput[] = [];
  next: Partial<CheckExecution> = {};

  async run(input: CheckExecutionInput): Promise<CheckExecution> {
    this.inputs.push(input);
    return {
      status: 'passed', exitCode: 0, signal: null, durationMs: 12.6, timedOut: false,
      log: { sha256: 'a'.repeat(64), bytes: 3, truncated: false, tail: 'ok\n', artifact: input.logPath }, detail: null,
      sandbox: { mode: 'enforce', provider: 'seatbelt', providerVersion: '1', policyHash: 'b'.repeat(64) },
      ...this.next,
    };
  }
}

describe('W16a local setup port', () => {
  it('runs a step in the worktree (realpath) with a private root under the run, a log artifact and the repos root denied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ol-setup-port-'));
    roots.push(root);
    const worktree = join(root, 'repos', 'worktrees', 'run-1');
    mkdirSync(worktree, { recursive: true });
    const executor = new RecordingExecutor();
    const setup = createLocalSetup({
      reposRoot: () => join(root, 'repos'),
      artifactsRoot: () => join(root, 'artifacts'),
      privateRoot: () => join(root, 'private'),
      executor,
    });
    const [install] = steps([{ name: 'install', run: 'pnpm install --frozen-lockfile', network: 'registries' }]);
    if (!install) throw new Error('no step');
    const controller = new AbortController();
    const outcome = await setup.runStep({ runId: 'run-1', step: install, index: 0, workspace: workspaceAt(worktree), signal: controller.signal });

    const input = executor.inputs[0];
    expect(input).toMatchObject({
      check: install,
      checkoutPath: realpathSync(worktree),
      privateRoot: join(root, 'private', 'run-1'),
      readRoots: [],
      denyRoots: [join(root, 'repos')],
      logPath: join(root, 'artifacts', 'run-1', '01-install.log'),
    });
    expect(input?.signal).toBe(controller.signal);
    expect(existsSync(join(root, 'private', 'run-1'))).toBe(true);
    expect(outcome.result).toEqual({
      id: 'install', name: 'install', required: true, status: 'passed', exitCode: 0, signal: null, durationMs: 13, timedOut: false,
      network: 'egress', command: 'pnpm install --frozen-lockfile',
      log: { sha256: 'a'.repeat(64), bytes: 3, truncated: false, tail: 'ok\n', artifact: join(root, 'artifacts', 'run-1', '01-install.log') }, detail: null,
    });
    expect(outcome.sandbox).toMatchObject({ mode: 'enforce', provider: 'seatbelt' });

    executor.next = { status: 'timed_out', exitCode: null, signal: 'SIGTERM', timedOut: true, detail: 'timed out after 600 s' };
    const [codegen] = steps([{ id: 'codegen', name: 'Generate', command: ['pnpm', 'run', 'gen', '--out', 'a b'] }]);
    if (!codegen) throw new Error('no step');
    const timedOut = await setup.runStep({ runId: 'run-1', step: codegen, index: 1, workspace: workspaceAt(worktree), signal: controller.signal });
    expect(timedOut.result).toMatchObject({ status: 'timed_out', timedOut: true, network: 'none', command: 'pnpm run gen --out "a b"', detail: 'timed out after 600 s' });
    expect(executor.inputs[1]?.logPath).toBe(join(root, 'artifacts', 'run-1', '02-codegen.log'));

    setup.cleanup('run-1');
    expect(existsSync(join(root, 'private', 'run-1'))).toBe(false);
    expect(existsSync(worktree)).toBe(true);
  });

  it('a missing worktree is an error result; the executor is not called', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ol-setup-port-'));
    roots.push(root);
    const executor = new RecordingExecutor();
    const setup = createLocalSetup({ reposRoot: () => root, artifactsRoot: () => join(root, 'a'), privateRoot: () => join(root, 'p'), executor });
    const [install] = steps([{ name: 'install', run: 'true' }]);
    if (!install) throw new Error('no step');
    const outcome = await setup.runStep({ runId: 'run-2', step: install, index: 0, workspace: workspaceAt(join(root, 'gone')), signal: new AbortController().signal });
    expect(outcome).toMatchObject({ result: { status: 'error', exitCode: null, detail: 'the run\'s worktree does not exist' }, sandbox: null });
    expect(executor.inputs).toEqual([]);
  });
});

const provider = platformProvider();
const required = process.env.OPENLINEAR_SANDBOX_CORPUS_REQUIRED === '1';
const detected = provider ? (await provider.detect()).ok : false;
const describeSandboxed = provider !== null && (detected || required) ? describe : describe.skip;

describeSandboxed('W16a setup steps under the enforced OS sandbox', () => {
  let root = '';
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-setup-sbx-')));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=OpenLinear Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    }).trim();
  }

  it('writes into the run\'s git worktree with a private HOME; beside it, git metadata and the network are refused', async () => {
    const reposRoot = join(root, 'repos');
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    git(source, 'init', '-q', '-b', 'main');
    writeFileSync(join(source, 'package.json'), '{"name":"fixture"}\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'base');
    const mirror = join(reposRoot, 'mirrors', 'fixture.git');
    mkdirSync(join(reposRoot, 'mirrors'), { recursive: true });
    git(root, 'clone', '-q', '--bare', source, mirror);
    const worktree = join(reposRoot, 'worktrees', 'run-sbx');
    git(mirror, 'worktree', 'add', '-q', '-b', 'openlinear/run-sbx', worktree, 'main');
    const outside = join(reposRoot, 'leak.txt');

    const plan = steps([
      { id: 'install', name: 'install', run: `mkdir -p node_modules/.bin && echo installed > node_modules/.marker && test "$HOME" != "${root}" && mkdir -p "$HOME/.cache/pnpm" && touch "$HOME/.cache/pnpm/store"` },
      { id: 'beside', name: 'writes beside the worktree', run: `echo leak > '${outside}'`, required: false },
      { id: 'git', name: 'rewrites git metadata', run: 'echo tampered >> .git', required: false },
      { id: 'network', name: 'reaches the internet', run: 'curl -sS --max-time 5 https://example.com -o /dev/null', required: false },
    ]);
    const setup = createLocalSetup({
      reposRoot: () => reposRoot,
      artifactsRoot: () => join(root, 'artifacts'),
      privateRoot: () => join(root, 'private'),
      executor: createSandboxedCheckExecutor({ env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root }, killGraceMs: 200 }),
    });
    const results = [];
    for (const [index, step] of plan.entries()) {
      results.push((await setup.runStep({ runId: 'run-sbx', step, index, workspace: workspaceAt(worktree), signal: new AbortController().signal })).result);
    }
    const byId = Object.fromEntries(results.map((result) => [result.id, result]));
    expect(byId.install).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(readFileSync(join(worktree, 'node_modules', '.marker'), 'utf8')).toBe('installed\n');
    expect(byId.beside?.status).toBe('failed');
    expect(existsSync(outside)).toBe(false);
    expect(byId.git?.status).toBe('failed');
    expect(readFileSync(join(worktree, '.git'), 'utf8')).not.toContain('tampered');
    expect(byId.network?.status).toBe('failed');
    expect(byId.install?.log.artifact).toBe(join(root, 'artifacts', 'run-sbx', '01-install.log'));
    setup.cleanup('run-sbx');
    expect(existsSync(join(root, 'private', 'run-sbx'))).toBe(false);
    // The worktree's own state is intact for the agent.
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('openlinear/run-sbx');
  }, 60_000);
});

describe('W16a worktree fingerprint (what setup may not leave behind)', () => {
  it('covers committable changes only and notices a second change to an already-dirty file', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ol-setup-fp-')));
    roots.push(repo);
    const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: repo, GIT_CONFIG_NOSYSTEM: '1' } });
    run('init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.env\n');
    writeFileSync(join(repo, 'package.json'), '{}\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'base');

    expect(await worktreeFingerprint(repo)).toEqual(new Map());
    // The agent's earlier work (a follow-up's worktree) is part of the baseline.
    writeFileSync(join(repo, 'package.json'), '{"name":"a"}\n');
    const before = await worktreeFingerprint(repo);
    expect([...(before?.keys() ?? [])]).toEqual(['package.json']);

    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'x.js'), 'ignored');
    writeFileSync(join(repo, '.env'), 'ignored');
    writeFileSync(join(repo, 'package.json'), '{"name":"a","lock":1}\n');
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const after = await worktreeFingerprint(repo);
    if (!before || !after) throw new Error('fingerprint unreadable');
    expect(changedPaths(before, after)).toEqual(['package.json', 'pnpm-lock.yaml']);
    expect(await worktreeFingerprint(join(repo, 'missing'))).toBeNull();
  });
});
