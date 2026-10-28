import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VerificationManifest } from '@openlinear/execution-core';
import { SandboxUnavailableError } from '../../sandbox/errors';
import { fakeSnapshot } from '../test-support';
import type { RunWorkspace } from '../types';
import { createSandboxedCheckExecutor } from './executor';
import { createLocalVerification } from './index';
import { resolveRunManifest } from './manifest';

/**
 * W11a with real git and real processes: the manifest comes from the BASE
 * commit (the agent's edit of the check file is ignored and flagged), the
 * checks run against the exact candidate commit in a pristine clone that
 * holds nothing uncommitted, results are exit codes with timeouts and
 * bounded, redacted logs, and without a verified sandbox (or a covering
 * trusted-host grant) nothing runs.
 *
 * The executor runs under an explicit trusted-host grant scoped to this
 * test's directory, so the suite is deterministic on hosts without a
 * verified OS sandbox (the enforced path is covered by the W09a sandbox
 * suites; here the sandbox decision is exercised through its failure modes).
 */

let root = '';
let reposRoot = '';

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-verify-git-')));
  reposRoot = join(root, 'repos');
  mkdirSync(reposRoot, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=OpenLinear Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim();
}

function grantEnv(paths: string[]): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    OPENLINEAR_SANDBOX_MODE: 'trusted-host',
    OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: JSON.stringify({
      actor: 'verification-test',
      reason: 'W11a real-process verification test',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      paths,
    }),
  };
}

function port(env: NodeJS.ProcessEnv, executor = createSandboxedCheckExecutor({ env, killGraceMs: 200 })) {
  return createLocalVerification({
    reposRoot: () => reposRoot,
    artifactsRoot: () => join(root, 'artifacts'),
    privateRoot: () => join(root, 'private'),
    executor,
  });
}

let repoCounter = 0;

/** A repository whose base commit holds `files`; returns its path and base commit. */
function repository(files: Record<string, string>): { path: string; base: string } {
  repoCounter += 1;
  const path = join(root, `src-${repoCounter}`);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(path, name, '..'), { recursive: true });
    writeFileSync(join(path, name), content);
  }
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'base');
  return { path, base: git(path, 'rev-parse', 'HEAD') };
}

function workspaceOf(path: string, base: string): RunWorkspace {
  return { worktreePath: path, branch: 'main', baseRef: 'main', owned: true, handle: null, baseCommit: base };
}

function runInput(runId: string, manifest: VerificationManifest, workspace: RunWorkspace, commitSha: string) {
  return { runId, manifest, workspace, commitSha, runner: 'opencode', signal: new AbortController().signal };
}

describe('W11a manifest and pristine checkout (real git)', () => {
  it("grades with the base commit's check file, against the exact candidate commit, in a clone without uncommitted files", async () => {
    const baseChecks = JSON.stringify({
      checks: [
        { id: 'feature', name: 'feature present', run: 'test -f feature.txt' },
        { id: 'clean', name: 'no uncommitted leak', run: 'test ! -e secret.txt' },
      ],
    });
    const { path, base } = repository({ '.openlinear/checks.json': baseChecks, 'README.md': '# repo\n' });
    // The agent: adds the feature, rewrites the check file to something trivial, leaves an untracked file.
    writeFileSync(join(path, 'feature.txt'), 'done\n');
    writeFileSync(join(path, '.openlinear', 'checks.json'), JSON.stringify({ checks: [{ name: 'noop', run: 'true' }] }));
    writeFileSync(join(path, 'secret.txt'), 'uncommitted\n');
    git(path, 'add', 'feature.txt', '.openlinear/checks.json');
    git(path, 'commit', '-q', '-m', 'agent work');
    const candidate = git(path, 'rev-parse', 'HEAD');

    const workspace = workspaceOf(path, base);
    const manifest = await resolveRunManifest({ snapshot: fakeSnapshot('task-1'), workspace });
    expect(manifest).toMatchObject({ source: 'repository', policy: 'warn', baseCommit: base, problems: [] });
    expect(manifest.checks.map((check) => check.id)).toEqual(['feature', 'clean']);
    expect(manifest.inputs.find((input) => input.kind === 'repository')).toMatchObject({ status: 'used', ref: base });

    const result = await port(grantEnv([root])).run(runInput('run-pristine', manifest, workspace, candidate));
    expect(result).toMatchObject({ status: 'passed', commitSha: candidate, baseCommit: base, checksHash: manifest.checksHash, source: 'repository' });
    expect(result.checks.map((check) => [check.id, check.status, check.exitCode])).toEqual([['feature', 'passed', 0], ['clean', 'passed', 0]]);
    expect(result.environment).toMatchObject({ sandboxMode: 'trusted-host', checkout: 'pristine-clone' });
    expect(result.warnings.join('\n')).toContain(`changes .openlinear/checks.json; the copy from the base commit ${base.slice(0, 12)} was graded`);
    // The pristine checkout is gone; the bounded log artifacts stay.
    expect(existsSync(join(reposRoot, 'verify', 'run-pristine'))).toBe(false);
    expect(readdirSync(join(root, 'artifacts', 'run-pristine', candidate.slice(0, 12))).sort()).toEqual(['01-feature.log', '02-clean.log']);
    expect(result.checks.every((check) => check.log.sha256?.length === 64)).toBe(true);
    // The source repository was not modified (no worktree metadata, same HEAD).
    expect(git(path, 'rev-parse', 'HEAD')).toBe(candidate);
    expect(git(path, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('an invalid repository check file makes verification unevaluable instead of silently skipping it', async () => {
    const { path, base } = repository({ '.openlinear/checks.json': '{ "checks": [ { "name": "x" } ] }' });
    writeFileSync(join(path, 'a.txt'), 'a\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'agent');
    const workspace = workspaceOf(path, base);
    const manifest = await resolveRunManifest({ snapshot: fakeSnapshot('task-1'), workspace });
    expect(manifest.source).toBe('repository');
    expect(manifest.checks).toEqual([]);
    expect(manifest.problems.join('\n')).toMatch(/needs "run"/);
    const result = await port(grantEnv([root])).run(runInput('run-invalid', manifest, workspace, git(path, 'rev-parse', 'HEAD')));
    expect(result.status).toBe('error');
  });

  it('project settings take precedence over the repository file; auto-detection only when enabled', async () => {
    const { path, base } = repository({
      '.openlinear/checks.json': JSON.stringify({ checks: [{ name: 'repo check', run: 'true' }] }),
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'echo "Error: no test specified" && exit 1' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    });
    const workspace = workspaceOf(path, base);
    const project = await resolveRunManifest({ snapshot: fakeSnapshot('t', { verificationSettings: { checks: [{ name: 'project check', run: 'true' }] } }), workspace });
    expect(project.source).toBe('project');
    expect(project.inputs.find((input) => input.kind === 'repository')?.status).toBe('ignored');

    const noRepo = await resolveRunManifest({ snapshot: fakeSnapshot('t', { verificationSettings: { repositoryChecks: false, autoDetect: true } }), workspace });
    expect(noRepo.source).toBe('auto-detect');
    expect(noRepo.checks.map((check) => [check.id, check.argv.join(' ')])).toEqual([
      ['install', 'pnpm install --frozen-lockfile --ignore-scripts'],
      ['typecheck', 'pnpm run typecheck'],
    ]);
    expect(noRepo.checks[0]?.network).toEqual({ mode: 'egress', hosts: [], registries: true });
    expect(noRepo.checks[1]?.network).toEqual({ mode: 'none' });
  });
});

describe('W11a check execution (real processes)', () => {
  it('records exit codes, enforces timeouts, bounds logs and redacts secrets from the evidence tail', async () => {
    const { path, base } = repository({ 'README.md': '# r\n' });
    const workspace = workspaceOf(path, base);
    const settings = {
      policy: 'require-pass',
      checks: [
        { id: 'fails', name: 'fails', run: 'echo "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"; exit 3' },
        { id: 'slow', name: 'slow', run: 'sleep 20', timeoutSeconds: 1 },
        { id: 'noisy', name: 'noisy', run: "head -c 2000000 /dev/zero | tr '\\0' a" },
        { id: 'optional', name: 'optional', run: 'exit 1', required: false },
      ],
    };
    const manifest = await resolveRunManifest({ snapshot: fakeSnapshot('t', { verificationSettings: settings }), workspace });
    const started = Date.now();
    const result = await port(grantEnv([root])).run(runInput('run-exec', manifest, workspace, base));
    expect(Date.now() - started).toBeLessThan(15_000);
    const byId = Object.fromEntries(result.checks.map((check) => [check.id, check]));
    expect(byId.fails).toMatchObject({ status: 'failed', exitCode: 3, timedOut: false });
    expect(byId.fails?.log.tail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(byId.slow).toMatchObject({ status: 'timed_out', timedOut: true, detail: 'timed out after 1 s' });
    expect(byId.noisy).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(byId.noisy?.log.bytes).toBeGreaterThanOrEqual(2_000_000);
    expect(byId.noisy?.log.truncated).toBe(true);
    expect(byId.noisy?.log.tail.length).toBeLessThanOrEqual(4 * 1024);
    expect(byId.optional).toMatchObject({ status: 'failed', required: false });
    expect(result.status).toBe('failed');
  });

  it('a non-required failure alone does not fail verification', async () => {
    const { path, base } = repository({ 'README.md': '# r\n' });
    const workspace = workspaceOf(path, base);
    const manifest = await resolveRunManifest({
      snapshot: fakeSnapshot('t', { verificationSettings: { checks: [{ name: 'ok', run: 'true' }, { name: 'lint', run: 'exit 1', required: false }] } }),
      workspace,
    });
    const result = await port(grantEnv([root])).run(runInput('run-optional', manifest, workspace, base));
    expect(result.status).toBe('passed');
  });

  it('fails closed: no verified sandbox, an uncovering grant, an invalid mode or a missing working directory never run the check', async () => {
    const { path, base } = repository({ 'README.md': '# r\n' });
    const workspace = workspaceOf(path, base);
    const manifest = await resolveRunManifest({
      snapshot: fakeSnapshot('t', { verificationSettings: { checks: [{ name: 'marker', run: 'touch "$HOME/ran"' }] } }),
      workspace,
    });

    const noSandbox = createSandboxedCheckExecutor({
      env: { PATH: process.env.PATH, HOME: root, OPENLINEAR_SANDBOX_MODE: 'enforce' },
      verifiedProvider: async () => {
        throw new SandboxUnavailableError('Seatbelt is not available on this host', []);
      },
    });
    const unsandboxed = await port({}, noSandbox).run(runInput('run-nosandbox', manifest, workspace, base));
    expect(unsandboxed.status).toBe('error');
    expect(unsandboxed.checks[0]?.detail).toMatch(/Seatbelt is not available on this host; the check was not run/);

    const elsewhere = await port(grantEnv(['/nonexistent-openlinear-grant-root'])).run(runInput('run-uncovered', manifest, workspace, base));
    expect(elsewhere.status).toBe('error');
    expect(elsewhere.checks[0]?.detail).toMatch(/trusted-host grant does not cover/);

    const invalid = await port({ PATH: process.env.PATH, OPENLINEAR_SANDBOX_MODE: 'yolo' }).run(runInput('run-invalid-mode', manifest, workspace, base));
    expect(invalid.status).toBe('error');
    expect(invalid.checks[0]?.detail).toMatch(/the check was not run/);

    const missingCwd = await resolveRunManifest({
      snapshot: fakeSnapshot('t', { verificationSettings: { checks: [{ name: 'sub', run: 'true', cwd: 'packages/missing' }] } }),
      workspace,
    });
    const cwd = await port(grantEnv([root])).run(runInput('run-cwd', missingCwd, workspace, base));
    expect(cwd.checks[0]).toMatchObject({ status: 'error' });
    expect(cwd.checks[0]?.detail).toMatch(/does not exist in the verified commit/);
    expect(existsSync(join(root, 'private'))).toBe(true);
  });

  it('a cancelled verification returns what finished and skips the rest (evidence retained)', async () => {
    const { path, base } = repository({ 'README.md': '# r\n' });
    const workspace = workspaceOf(path, base);
    const manifest = await resolveRunManifest({
      snapshot: fakeSnapshot('t', { verificationSettings: { checks: [{ name: 'first', run: 'true' }, { name: 'long', run: 'sleep 20' }, { name: 'never', run: 'true' }] } }),
      workspace,
    });
    const controller = new AbortController();
    const result = await port(grantEnv([root])).run({
      ...runInput('run-cancel', manifest, workspace, base),
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === 'start' && progress.check.name === 'long') setTimeout(() => controller.abort(), 100);
      },
    });
    expect(result.status).toBe('error');
    expect(result.checks.map((check) => check.status)).toEqual(['passed', 'error', 'skipped']);
    expect(existsSync(join(reposRoot, 'verify', 'run-cancel'))).toBe(false);
  });
});
