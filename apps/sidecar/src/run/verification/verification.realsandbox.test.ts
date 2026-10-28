import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformProvider } from '../../sandbox/provider';
import { fakeSnapshot } from '../test-support';
import type { RunWorkspace } from '../types';
import { createSandboxedCheckExecutor } from './executor';
import { createLocalVerification } from './index';
import { resolveRunManifest } from './manifest';

/**
 * W11a on the real OS boundary (the manual check the verify ledger asked
 * for): verification checks run in ENFORCE mode under the live-verified
 * provider — macOS Seatbelt locally, bubblewrap on Linux CI — against a
 * pristine clone. A check may write inside its checkout but not next to it,
 * has no network unless it declares egress, and the evidence names the
 * enforcing sandbox. Skipped without a usable provider, unless
 * OPENLINEAR_SANDBOX_CORPUS_REQUIRED=1 (CI), where that is a failure.
 */

const provider = platformProvider();
const required = process.env.OPENLINEAR_SANDBOX_CORPUS_REQUIRED === '1';
const detected = provider ? (await provider.detect()).ok : false;
const describeSandboxed = provider !== null && (detected || required) ? describe : describe.skip;

let root = '';
let reposRoot = '';

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-verify-sbx-')));
  reposRoot = join(root, 'repos');
  mkdirSync(reposRoot, { recursive: true });
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

describe('enforced-sandbox prerequisites', () => {
  it('has a usable provider when the suite is required', () => {
    if (required) expect(detected).toBe(true);
    else expect(true).toBe(true);
  });
});

describeSandboxed('W11a checks under the enforced OS sandbox', () => {
  it('runs checks in the pristine checkout: writes inside work, writes beside it and network are refused, evidence says enforce', async () => {
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    git(source, 'init', '-q', '-b', 'main');
    writeFileSync(join(source, 'README.md'), '# sandboxed\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'base');
    const base = git(source, 'rev-parse', 'HEAD');
    const outside = join(root, 'escaped.txt');

    const settings = {
      policy: 'require-pass',
      checks: [
        { id: 'reads', name: 'reads the checkout', run: 'test -f README.md' },
        { id: 'writes-inside', name: 'writes inside the checkout', run: 'echo built > out.txt && test -f out.txt' },
        { id: 'writes-beside', name: 'writes beside the checkout', run: `echo leak > '${outside}'`, required: false },
        { id: 'network', name: 'reaches the internet', run: 'curl -sS --max-time 5 https://example.com -o /dev/null', required: false },
      ],
    };
    const workspace: RunWorkspace = { worktreePath: source, branch: 'main', baseRef: 'main', owned: true, handle: null, baseCommit: base };
    const manifest = await resolveRunManifest({ snapshot: fakeSnapshot('t', { verificationSettings: settings }), workspace });
    // Enforce mode: no trusted-host grant in this environment.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root };
    const verification = createLocalVerification({
      reposRoot: () => reposRoot,
      artifactsRoot: () => join(root, 'artifacts'),
      privateRoot: () => join(root, 'private'),
      executor: createSandboxedCheckExecutor({ env, killGraceMs: 200 }),
    });
    const result = await verification.run({ runId: 'run-sbx', manifest, workspace, commitSha: base, runner: 'opencode', signal: new AbortController().signal });

    const byId = Object.fromEntries(result.checks.map((check) => [check.id, check]));
    expect(byId.reads).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(byId['writes-inside']).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(byId['writes-beside']?.status).toBe('failed');
    expect(existsSync(outside)).toBe(false);
    expect(byId.network?.status).toBe('failed');
    // Only optional checks failed: verification passes, and the evidence names the enforcing sandbox.
    expect(result.status).toBe('passed');
    expect(result.environment).toMatchObject({ sandboxMode: 'enforce', checkout: 'pristine-clone' });
    expect(result.environment.provider ?? '').toMatch(/seatbelt|bwrap|bubblewrap/i);
    // One sealed policy per check that ran enforced.
    expect(result.environment.policyHashes.length).toBeGreaterThan(0);
    // The candidate source was not touched by the check's write.
    expect(existsSync(join(source, 'out.txt'))).toBe(false);
  }, 60_000);

  it('a check cannot tunnel to the host through the egress proxy, even with a loopback address in its allow list', async () => {
    const hits: string[] = [];
    const hostService = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('ok');
    });
    await new Promise<void>((resolve) => hostService.listen(0, '127.0.0.1', () => resolve()));
    const port = (hostService.address() as { port: number }).port;
    try {
      const source = join(root, 'src-local');
      mkdirSync(source, { recursive: true });
      git(source, 'init', '-q', '-b', 'main');
      writeFileSync(join(source, 'README.md'), '# local\n');
      git(source, 'add', '-A');
      git(source, 'commit', '-q', '-m', 'base');
      const base = git(source, 'rev-parse', 'HEAD');
      // Through the proxy explicitly (NO_PROXY would send loopback direct, which the sandbox refuses anyway).
      const run = `curl -sS -p -x "$HTTPS_PROXY" --noproxy '' --max-time 5 -o /dev/null http://127.0.0.1:${port}/session`;
      const settings = { policy: 'require-pass', checks: [{ id: 'host', name: 'reaches a host service', run, network: { allow: ['placeholder.example.com'] }, required: false }] };
      const workspace: RunWorkspace = { worktreePath: source, branch: 'main', baseRef: 'main', owned: true, handle: null, baseCommit: base };
      const resolved = await resolveRunManifest({ snapshot: fakeSnapshot('t', { verificationSettings: settings }), workspace });
      // Settings refuse IP addresses when parsed; a sealed allow list naming one is still refused by the proxy.
      const manifest = { ...resolved, checks: resolved.checks.map((check) => (check.id === 'host' ? { ...check, network: { mode: 'egress' as const, hosts: [`127.0.0.1:${port}`], registries: false } } : check)) };
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root };
      const verification = createLocalVerification({
        reposRoot: () => reposRoot,
        artifactsRoot: () => join(root, 'artifacts-local'),
        privateRoot: () => join(root, 'private-local'),
        executor: createSandboxedCheckExecutor({ env, killGraceMs: 200 }),
      });
      const result = await verification.run({ runId: 'run-sbx-local', manifest, workspace, commitSha: base, runner: 'opencode', signal: new AbortController().signal });
      expect(result.checks.find((check) => check.id === 'host')?.status).toBe('failed');
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => hostService.close(() => resolve()));
    }
  }, 60_000);
});

// Opt-in (reaches the public npm registry): OPENLINEAR_SANDBOX_NETWORK_TESTS=1.
const networkTests = process.env.OPENLINEAR_SANDBOX_NETWORK_TESTS === '1';
const describeEgress = provider !== null && detected && networkTests ? describe : describe.skip;

describeEgress('W11a checks with declared egress (real network, opt-in)', () => {
  it('a check that declares registries reaches the npm registry through the egress proxy, and nothing else', async () => {
    const source = join(root, 'src-egress');
    mkdirSync(source, { recursive: true });
    git(source, 'init', '-q', '-b', 'main');
    writeFileSync(join(source, 'README.md'), '# egress\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'base');
    const base = git(source, 'rev-parse', 'HEAD');
    // curl honours the proxy variables the sandbox sets for egress checks.
    const settings = {
      policy: 'warn',
      checks: [
        { id: 'registry', name: 'npm registry', run: 'curl -sS --max-time 15 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/-/ping', network: 'registries' },
        { id: 'elsewhere', name: 'other host', run: 'curl -sS --max-time 10 -o /dev/null https://example.com', network: 'registries', required: false },
      ],
    };
    const workspace: RunWorkspace = { worktreePath: source, branch: 'main', baseRef: 'main', owned: true, handle: null, baseCommit: base };
    const manifest = await resolveRunManifest({ snapshot: fakeSnapshot('t', { verificationSettings: settings }), workspace });
    const verification = createLocalVerification({
      reposRoot: () => reposRoot,
      artifactsRoot: () => join(root, 'artifacts'),
      privateRoot: () => join(root, 'private'),
      executor: createSandboxedCheckExecutor({ env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root }, killGraceMs: 200 }),
    });
    const result = await verification.run({ runId: 'run-egress', manifest, workspace, commitSha: base, runner: 'opencode', signal: new AbortController().signal });
    const byId = Object.fromEntries(result.checks.map((check) => [check.id, check]));
    expect(byId.registry).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(byId.elsewhere?.status).toBe('failed');
    expect(result.environment.sandboxMode).toBe('enforce');
  }, 90_000);
});

