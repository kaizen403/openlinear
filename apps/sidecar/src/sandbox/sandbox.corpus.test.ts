import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { buildSandboxAgentEnv } from './env';
import { AttemptServerManager } from './opencode-attempts';
import { resolveToolchainRoots } from './paths';
import { buildAttemptPolicy, systemReadRoots } from './policy';
import { runCanaryPreflight, runWrapped } from './preflight';
import { platformProvider } from './provider';
import type { CapabilityReport, SandboxProvider } from './types';

/**
 * Acceptance corpus on the real OS boundary (macOS Seatbelt locally, Linux
 * bubblewrap in .github/workflows/sandbox.yml). Probes run actual commands
 * inside the sandbox against a fabricated HOME with planted FAKE secrets; the
 * real home directory is never read.
 *
 * Without a usable provider the suite is skipped, unless
 * OPENLINEAR_SANDBOX_CORPUS_REQUIRED=1 (CI), where that is a failure.
 */

const provider: SandboxProvider | null = platformProvider();
const required = process.env.OPENLINEAR_SANDBOX_CORPUS_REQUIRED === '1';
let detectedOk = false;
if (provider) {
  // detect() is static (binary presence/version); probes come later.
  detectedOk = (await provider.detect()).ok;
}
const runCorpus = provider !== null && (detectedOk || required);
const describeCorpus = runCorpus ? describe : describe.skip;

const gitAvailable = spawnSync('git', ['--version']).status === 0;

describe('sandbox corpus prerequisites', () => {
  it('has a provider when the corpus is required', () => {
    if (required) {
      expect(provider).not.toBeNull();
      expect(detectedOk).toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });
});

describeCorpus(`sandbox acceptance corpus (${provider?.id ?? 'none'}, real OS enforcement)`, () => {
  let report: CapabilityReport;

  beforeAll(async () => {
    report = await runCanaryPreflight(provider as SandboxProvider, {});
    console.info(`[sandbox corpus] ${report.provider} ${report.providerVersion ?? ''}\n${report.probes.map((probe) => `${probe.passed ? 'PASS' : 'FAIL'} ${probe.dimension}/${probe.expect} ${probe.name} (${probe.detail}, ${probe.durationMs}ms)`).join('\n')}\nunsupported: ${report.unsupported.join(', ')}`);
  }, 120_000);

  it('verifies every enforced dimension with live canary probes', () => {
    expect(report.blockers).toEqual([]);
    expect(report.enforced).toEqual({ filesystem: true, env: true, network: true, process: true });
    expect(report.available).toBe(true);
    // Both directions are exercised: allow probes must succeed, deny probes must fail.
    expect(report.probes.filter((probe) => probe.expect === 'allow').length).toBeGreaterThanOrEqual(4);
    expect(report.probes.filter((probe) => probe.expect === 'deny').length).toBeGreaterThanOrEqual(15);
  });

  describe('real git worktree inside the sandbox', () => {
    let root = '';
    let worktree = '';
    let otherWorktree = '';
    let attemptRoot = '';
    let repos = '';
    let fakeHome = '';

    beforeAll(() => {
      if (!gitAvailable) return;
      root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-sbx-git-')));
      fakeHome = join(root, 'home');
      mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
      writeFileSync(join(fakeHome, '.ssh', 'id_ed25519'), 'OPENLINEAR-FAKE-SSH-KEY-WORKTREE-CORPUS\n');
      repos = join(root, 'repos');
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: fakeHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
      const src = join(root, 'src');
      execFileSync('git', ['init', '-q', '-b', 'main', src], { env });
      writeFileSync(join(src, 'index.js'), 'console.log("hi")\n');
      execFileSync('git', ['-C', src, 'add', '.'], { env });
      execFileSync('git', ['-C', src, 'commit', '-q', '-m', 'init'], { env });
      const mirror = join(repos, 'acme', 'demo.git');
      mkdirSync(dirname(mirror), { recursive: true });
      execFileSync('git', ['clone', '-q', '--bare', src, mirror], { env });
      worktree = join(repos, 'worktrees', 'run-a');
      otherWorktree = join(repos, 'worktrees', 'run-b');
      execFileSync('git', ['-C', mirror, 'worktree', 'add', '-q', '-b', 'openlinear/run-a', worktree, 'main'], { env });
      execFileSync('git', ['-C', mirror, 'worktree', 'add', '-q', '-b', 'openlinear/run-b', otherWorktree, 'main'], { env });
      writeFileSync(join(otherWorktree, 'uncommitted-secret.txt'), 'OPENLINEAR-FAKE-OTHER-RUN-WORK\n');
      attemptRoot = join(root, 'sandbox', 'run-a');
      for (const sub of ['home', 'tmp']) mkdirSync(join(attemptRoot, sub), { recursive: true });
    });

    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    function policyFor() {
      const toolchain = resolveToolchainRoots({
        pathEnv: process.env.PATH,
        home: homedir(),
        volatileRoots: [root, tmpdir(), '/tmp', '/private/tmp'],
        systemRoots: systemReadRoots(process.platform),
      });
      const runtimeRoot = dirname(dirname(realpathSync.native(process.execPath)));
      const env = buildSandboxAgentEnv({
        source: { ...process.env, JWT_SECRET: 'OPENLINEAR-FAKE-JWT', DATABASE_URL: 'postgres://u:OPENLINEAR-FAKE-DB@x/y' },
        path: [dirname(realpathSync.native(process.execPath)), ...toolchain.pathEntries].join(':'),
        home: join(attemptRoot, 'home'),
        tmp: join(attemptRoot, 'tmp'),
        xdgConfigHome: join(attemptRoot, 'home', '.config'),
        xdgDataHome: join(attemptRoot, 'home', '.local', 'share'),
        xdgStateHome: join(attemptRoot, 'home', '.local', 'state'),
        xdgCacheHome: join(attemptRoot, 'home', '.cache'),
        proxyUrl: null,
        shell: '/bin/sh',
      });
      return buildAttemptPolicy({
        attemptKey: 'corpus-git',
        platform: process.platform,
        worktree,
        attemptRoot,
        home: fakeHome,
        toolchainRoots: [...toolchain.roots, runtimeRoot],
        trustedGitRoots: [repos],
        denyRoots: [repos],
        network: { mode: 'none', proxy: null, listenPort: null, controlSocketPath: null, allowedHosts: [] },
        env,
      }).policy;
    }

    it.skipIf(!gitAvailable)('runs git status/log and node inside the worktree, but not git commit or sibling reads', async () => {
      const policy = policyFor();
      const sandboxed = provider as SandboxProvider;
      const status = await runWrapped(sandboxed, policy, ['git', 'status', '--porcelain', '--branch']);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain('openlinear/run-a');
      const log = await runWrapped(sandboxed, policy, ['git', 'log', '--oneline', '-1']);
      expect(log.code, log.stderr).toBe(0);
      const node = await runWrapped(sandboxed, policy, [process.execPath, '-e', 'require("fs").writeFileSync("from-node.txt", "ok"); console.log(require("fs").readdirSync(".").sort().join(","))']);
      expect(node.code, node.stderr).toBe(0);
      expect(readFileSync(join(worktree, 'from-node.txt'), 'utf8')).toBe('ok');
      const envDump = await runWrapped(sandboxed, policy, ['/bin/sh', '-c', 'env']);
      expect(envDump.stdout).not.toContain('OPENLINEAR-FAKE-JWT');
      expect(envDump.stdout).not.toContain('OPENLINEAR-FAKE-DB');
      // The agent cannot write the shared Git metadata (index/refs live there).
      const commit = await runWrapped(sandboxed, policy, ['git', '-c', 'user.name=a', '-c', 'user.email=a@example.invalid', 'commit', '-am', 'agent']);
      expect(commit.code).not.toBe(0);
      const sibling = await runWrapped(sandboxed, policy, ['/bin/sh', '-c', 'cat -- "$1"', 'probe', join(otherWorktree, 'uncommitted-secret.txt')]);
      expect(sibling.code).not.toBe(0);
      expect(sibling.stdout).not.toContain('OPENLINEAR-FAKE-OTHER-RUN-WORK');
      const key = await runWrapped(sandboxed, policy, ['/bin/sh', '-c', 'cat -- "$1"', 'probe', join(fakeHome, '.ssh', 'id_ed25519')]);
      expect(key.stdout).not.toContain('OPENLINEAR-FAKE-SSH-KEY');
    }, 60_000);
  });

  const ccAvailable = process.platform === 'darwin' && spawnSync('cc', ['--version']).status === 0;
  it.skipIf(!ccAvailable)('macOS: a non-setuid KERN_PROCARGS2 reader cannot read the environment of a host process', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-sbx-procargs-')));
    try {
      const worktree = join(root, 'wt');
      const attemptRoot = join(root, 'attempt');
      mkdirSync(worktree, { recursive: true });
      mkdirSync(attemptRoot, { recursive: true });
      const source = join(root, 'procargs.c');
      writeFileSync(source, [
        '#include <stdio.h>', '#include <stdlib.h>', '#include <sys/sysctl.h>',
        'int main(int argc, char **argv) {',
        '  int mib[3] = { CTL_KERN, KERN_PROCARGS2, atoi(argv[1]) };',
        '  size_t size = 0;',
        '  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0) { perror("sysctl"); return 2; }',
        '  char *buf = malloc(size);',
        '  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0) { perror("sysctl"); return 3; }',
        '  for (size_t i = sizeof(int); i < size; i++) putchar(buf[i] ? buf[i] : 10);',
        '  return 0;',
        '}',
      ].join('\n'));
      const binary = join(worktree, 'procargs');
      execFileSync('cc', ['-o', binary, source]);
      // macOS redacts the environment of Apple platform binaries (/bin/sleep)
      // even outside a sandbox, so the host canary is a compiled sleeper.
      const sleeperSource = join(root, 'sleeper.c');
      writeFileSync(sleeperSource, '#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n');
      const sleeper = join(root, 'sleeper');
      execFileSync('cc', ['-o', sleeper, sleeperSource]);
      const secret = `OPENLINEAR-FAKE-HOST-ENV-${process.pid}`;
      const host = spawn(sleeper, [], { env: { PATH: '/usr/bin:/bin', OPENLINEAR_HOST_CANARY: secret }, stdio: 'ignore', detached: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        // Control: outside the sandbox the same binary does read it.
        const control = spawnSync(binary, [String(host.pid)], { encoding: 'utf8' });
        expect(control.stdout).toContain(secret);
        const { policy } = buildAttemptPolicy({
          attemptKey: 'corpus-procargs',
          platform: process.platform,
          worktree,
          attemptRoot,
          home: join(root, 'home'),
          toolchainRoots: [],
          trustedGitRoots: [],
          denyRoots: [],
          network: { mode: 'none', proxy: null, listenPort: null, controlSocketPath: null, allowedHosts: [] },
          env: { PATH: '/usr/bin:/bin' },
        });
        const run = await runWrapped(provider as SandboxProvider, policy, [binary, String(host.pid)]);
        expect(run.stdout).not.toContain(secret);
        expect(run.code).not.toBe(0);
      } finally {
        if (host.pid) process.kill(-host.pid, 'SIGKILL');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Optional smoke: a real `opencode serve` started through the per-attempt
 * manager under the sandbox, driven with the SDK-level `session.shell` call
 * (a bash tool execution that needs no model). Runs when an OpenCode binary
 * is available (OPENLINEAR_SANDBOX_OPENCODE_BIN or ~/.opencode/bin/opencode).
 * With OPENLINEAR_SANDBOX_BENCH=1 it also measures startup latency over 12
 * sandboxed and 12 unsandboxed starts.
 */
const opencodeBin = process.env.OPENLINEAR_SANDBOX_OPENCODE_BIN ?? join(homedir(), '.opencode', 'bin', 'opencode');
const smokeEnabled = runCorpus && existsSync(opencodeBin) && process.env.OPENLINEAR_SANDBOX_SKIP_OPENCODE !== '1';
const describeSmoke = smokeEnabled ? describe : describe.skip;

describeSmoke('OpenCode under the sandbox (model-free smoke)', () => {
  let root = '';
  let worktree = '';
  let fakeHome = '';

  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-sbx-opencode-')));
    fakeHome = join(root, 'home');
    worktree = join(root, 'projects', 'demo');
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(fakeHome, '.ssh', 'id_ed25519'), 'OPENLINEAR-FAKE-SSH-KEY-OPENCODE\n');
    writeFileSync(join(worktree, 'README.md'), 'demo\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function manager(extraEnv: Record<string, string> = {}) {
    // HOME is fabricated: the manager reads OpenCode auth from it (none) and
    // derives the mandatory denies from it.
    const env: NodeJS.ProcessEnv = {
      // System dirs + the OpenCode binary only: with a fabricated HOME, PATH
      // entries under the real home would otherwise count as outside HOME.
      PATH: [dirname(opencodeBin), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      LANG: 'en_US.UTF-8',
      HOME: fakeHome,
      OPENLINEAR_SANDBOX_DIR: join(root, 'sandbox-state'),
      OPENLINEAR_SANDBOX_REGISTRIES: '0',
      JWT_SECRET: 'OPENLINEAR-FAKE-JWT-OPENCODE',
      ...extraEnv,
    };
    return import('../services/opencode').then(({ launchSandboxedServer, buildAgentConfig }) => new AttemptServerManager({
      launch: launchSandboxedServer,
      resolveBinary: () => opencodeBin,
      createClient: (config) => createOpencodeClient(config),
      agentConfig: () => ({ ...buildAgentConfig() }),
      // A fake provider on an unresolvable .invalid host: provider traffic
      // must go through the attempt's proxy, and can never reach a real model.
      managementConfig: async () => ({
        model: 'olfake/none',
        provider: { olfake: { npm: '@ai-sdk/openai-compatible', name: 'fake', options: { baseURL: 'https://model.openlinear-test.invalid/v1', apiKey: 'none' }, models: { none: { name: 'none' } } } },
      }),
      env,
    }));
  }

  it('confines a bash tool call started through the SDK', async () => {
    const attempts = await manager();
    try {
      const route = await attempts.route('user-1', worktree);
      expect(route.kind).toBe('attempt');
      if (route.kind !== 'attempt') return;
      expect(route.metadata).toMatchObject({ mode: 'enforce', provider: provider?.id });
      const client = route.client;
      const created = await client.session.create({ body: { title: 'smoke' } });
      const sessionId = created.data?.id as string;
      expect(sessionId).toBeTruthy();
      const command = [
        'printf sandboxed > proof.txt',
        `cat ${join(fakeHome, '.ssh', 'id_ed25519')} 2>&1`,
        'env | grep -c OPENLINEAR-FAKE-JWT-OPENCODE',
        'curl -sS -m 5 https://example.com 2>&1 | head -c 120',
      ].join('; ');
      const shell = await client.session.shell({ path: { id: sessionId }, body: { agent: 'build', model: { providerID: 'olfake', modelID: 'none' }, command } });
      const text = JSON.stringify(shell.data ?? shell.error);
      expect(readFileSync(join(worktree, 'proof.txt'), 'utf8')).toBe('sandboxed');
      expect(text).not.toContain('OPENLINEAR-FAKE-SSH-KEY-OPENCODE');
      expect(text).toMatch(/Operation not permitted|No such file or directory/);
      // Unauthenticated requests to the attempt server are refused.
      const [server] = attempts.status();
      const anonymous = await fetch(`${server.url}/config`);
      expect(anonymous.status).toBe(401);
      // The tool's direct curl to a non-allowlisted host was refused by the proxy.
      expect(attempts.status()[0].egress.recent).toContainEqual(expect.objectContaining({ host: 'example.com', allowed: false, reason: 'not-allowlisted' }));
      // OpenCode's own provider request (a prompt) is routed through the
      // proxy too: the allowlisted-but-unresolvable host shows up there.
      await client.session.promptAsync({ path: { id: sessionId }, body: { model: { providerID: 'olfake', modelID: 'none' }, parts: [{ type: 'text', text: 'ping' }] } });
      const deadline = Date.now() + 20_000;
      let providerDecision: { host: string; allowed: boolean; reason: string } | undefined;
      while (!providerDecision && Date.now() < deadline) {
        providerDecision = attempts.status()[0].egress.recent.find((decision) => decision.host === 'model.openlinear-test.invalid');
        if (!providerDecision) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(providerDecision).toMatchObject({ host: 'model.openlinear-test.invalid', allowed: false, reason: 'dns-failure' });
      await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
    } finally {
      await attempts.shutdownAll();
    }
  }, 120_000);

  it.skipIf(process.env.OPENLINEAR_SANDBOX_BENCH !== '1')('measures added startup latency (p50/p95 over 12 starts)', async () => {
    const sandboxed: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const attempts = await manager();
      const started = performance.now();
      const route = await attempts.route('user-1', worktree);
      sandboxed.push(performance.now() - started);
      expect(route.kind).toBe('attempt');
      await attempts.shutdownAll();
    }
    const plain: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const home = mkdtempSync(join(root, 'plain-home-'));
      const started = performance.now();
      const proc = spawn(opencodeBin, ['serve', '--hostname=127.0.0.1', '--port=0'], {
        env: { PATH: process.env.PATH ?? '', HOME: home, XDG_DATA_HOME: join(home, 'd'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k'), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' },
        cwd: worktree,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('plain opencode did not start')), 30_000);
        proc.stdout?.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('opencode server listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      plain.push(performance.now() - started);
      if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
    }
    const pct = (values: number[], p: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
    };
    console.info(`[sandbox bench] sandboxed attempt start (includes proxy, policy, cached preflight): p50=${pct(sandboxed, 50)}ms p95=${pct(sandboxed, 95)}ms n=${sandboxed.length}; plain opencode serve: p50=${pct(plain, 50)}ms p95=${pct(plain, 95)}ms n=${plain.length}; samples sandboxed=${sandboxed.map(Math.round).join(',')} plain=${plain.map(Math.round).join(',')}`);
  }, 600_000);
});
