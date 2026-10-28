import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EgressProxy } from './egress-proxy';
import { buildSandboxAgentEnv, isSecretLikeEnvName } from './env';
import { resolveToolchainRoots } from './paths';
import { buildAttemptPolicy, systemReadRoots } from './policy';
import type {
  CapabilityReport,
  NetworkPolicy,
  ProbeDimension,
  SandboxPolicy,
  SandboxProvider,
} from './types';

/** Output captured from one wrapped probe process. */
export interface ProbeRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_OUTPUT = 64 * 1024;

/** Spawns `argv` under `policy` through `provider.wrap()` and waits for it. */
export async function runWrapped(
  provider: SandboxProvider,
  policy: SandboxPolicy,
  argv: readonly string[],
  timeoutMs = 10_000,
): Promise<ProbeRun> {
  const started = Date.now();
  const wrapped = await provider.wrap({ command: argv[0], args: argv.slice(1), cwd: policy.cwd }, policy);
  return await new Promise<ProbeRun>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(wrapped.command, wrapped.args, {
        cwd: wrapped.cwd,
        env: wrapped.env,
        stdio: ['ignore', 'pipe', 'pipe', ...wrapped.extraFds],
        detached: true,
      });
    } catch (err) {
      wrapped.release();
      resolve({ code: null, signal: null, stdout: '', stderr: String(err), timedOut: false, durationMs: Date.now() - started });
      return;
    }
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wrapped.release();
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      stderr += String(err);
      finish(null, null);
    });
    child.once('close', (code, signal) => finish(code, signal));
  });
}

interface Fixture {
  root: string;
  home: string;
  repos: string;
  worktree: string;
  otherWorktree: string;
  commonDir: string;
  gitDir: string;
  otherGitDir: string;
  attemptRoot: string;
  outside: string;
  canary: {
    ssh: string;
    toolchainCredential: string;
    otherWorktree: string;
    otherGitDir: string;
    envSecret: string;
    hostProcessEnv: string;
  };
}

function token(label: string): string {
  return `OPENLINEAR-FAKE-${label}-${randomBytes(12).toString('hex')}`;
}

/**
 * Fabricated HOME + repos tree with planted FAKE secrets. Nothing here is
 * derived from the real home directory.
 */
export function createProbeFixture(base = tmpdir()): Fixture {
  const root = realpathSync.native(mkdtempSync(join(base, 'openlinear-sbx-probe-')));
  const home = join(root, 'home');
  const repos = join(root, 'repos');
  const commonDir = join(repos, 'acme', 'demo.git');
  const worktree = join(repos, 'worktrees', 'attempt-a');
  const otherWorktree = join(repos, 'worktrees', 'attempt-b');
  const gitDir = join(commonDir, 'worktrees', 'attempt-a');
  const otherGitDir = join(commonDir, 'worktrees', 'attempt-b');
  const attemptRoot = join(root, 'sandbox', 'attempt-a');
  const outside = join(root, 'outside');
  const canary = {
    ssh: token('SSH'),
    toolchainCredential: token('CARGO'),
    otherWorktree: token('OTHER-WORKTREE'),
    otherGitDir: token('OTHER-GITDIR'),
    envSecret: token('ENV'),
    hostProcessEnv: token('HOST-ENV'),
  };
  for (const dir of [
    join(home, '.ssh'),
    join(home, '.cargo', 'bin'),
    join(home, '.aws'),
    worktree,
    otherWorktree,
    gitDir,
    otherGitDir,
    join(commonDir, 'objects'),
    join(commonDir, 'refs'),
    join(attemptRoot, 'home'),
    join(attemptRoot, 'tmp'),
    join(attemptRoot, 'run'),
    outside,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(home, '.ssh', 'id_ed25519'), `-----BEGIN FAKE KEY-----\n${canary.ssh}\n`, { mode: 0o600 });
  writeFileSync(join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key=${canary.ssh}\n`, { mode: 0o600 });
  writeFileSync(join(home, '.cargo', 'credentials.toml'), `[registry]\ntoken = "${canary.toolchainCredential}"\n`, { mode: 0o600 });
  writeFileSync(join(home, '.cargo', 'bin', 'tool'), '#!/bin/sh\necho tool\n', { mode: 0o700 });
  writeFileSync(join(worktree, 'README.md'), 'attempt-a worktree\n');
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/openlinear/attempt-a\n');
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  writeFileSync(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`);
  writeFileSync(join(otherGitDir, 'HEAD'), `${canary.otherGitDir}\n`);
  writeFileSync(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(commonDir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  writeFileSync(join(otherWorktree, 'secret.txt'), `${canary.otherWorktree}\n`);
  return { root, home, repos, worktree, otherWorktree, commonDir, gitDir, otherGitDir, attemptRoot, outside, canary };
}

interface HostCanaries {
  direct: NetServer;
  directPort: number;
  directHits: number;
  allowedTarget: NetServer;
  allowedPort: number;
  allowedHits: number;
  deniedTarget: NetServer;
  deniedPort: number;
  deniedHits: number;
  unixPath: string;
  unix: NetServer;
  unixHits: number;
}

async function listenTcp(onConnection: () => void): Promise<{ server: NetServer; port: number }> {
  const server = createNetServer((socket) => {
    onConnection();
    socket.end('canary\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('canary server has no port');
  return { server, port: address.port };
}

async function startHostCanaries(fixture: Fixture): Promise<HostCanaries> {
  const state = { directHits: 0, allowedHits: 0, deniedHits: 0, unixHits: 0 };
  const direct = await listenTcp(() => { state.directHits += 1; });
  const allowed = await listenTcp(() => { state.allowedHits += 1; });
  const denied = await listenTcp(() => { state.deniedHits += 1; });
  const unixPath = join(fixture.outside, 'host.sock');
  const unix = createNetServer((socket) => {
    state.unixHits += 1;
    socket.end('canary\n');
  });
  await new Promise<void>((resolve, reject) => {
    unix.once('error', reject);
    unix.listen(unixPath, () => resolve());
  });
  return {
    direct: direct.server,
    directPort: direct.port,
    get directHits() { return state.directHits; },
    allowedTarget: allowed.server,
    allowedPort: allowed.port,
    get allowedHits() { return state.allowedHits; },
    deniedTarget: denied.server,
    deniedPort: denied.port,
    get deniedHits() { return state.deniedHits; },
    unixPath,
    unix,
    get unixHits() { return state.unixHits; },
  };
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * A host process whose argv carries the canary token (macOS redacts the env
 * of platform binaries, but argv and env come from the same KERN_PROCARGS2
 * buffer, so argv visibility is the probe) and whose env carries it too.
 */
function spawnHostCanaryProcess(secret: string): ChildProcess {
  return spawn('/bin/sh', ['-c', 'sleep 30; : "$0"', secret], {
    env: { PATH: '/usr/bin:/bin', OPENLINEAR_HOST_CANARY: secret },
    stdio: 'ignore',
    detached: true,
  });
}

/** Sidecar-env values with secret-like names; compared in memory only. */
function sidecarSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && value.length >= 8 && isSecretLikeEnvName(key))
    .map(([, value]) => value as string);
}

function leaks(output: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && output.includes(secret));
}

const SH = '/bin/sh';
const BASH = '/bin/bash';

interface ProbeSpec {
  name: string;
  dimension: ProbeDimension;
  expect: 'allow' | 'deny';
  argv: string[];
  check: (run: ProbeRun) => { passed: boolean; detail: string };
  /**
   * Unsandboxed control: the same probe run outside the sandbox must succeed
   * at the forbidden action, otherwise the deny result proves nothing and the
   * probe fails closed.
   */
  control?: { argv: string[]; succeeded: (stdout: string, code: number | null) => boolean };
}

function describeRun(run: ProbeRun): string {
  if (run.timedOut) return 'timed out';
  return `exit=${run.code ?? run.signal}`;
}

/** Address of the egress proxy as seen from inside the sandbox. */
export function proxyAddressInside(network: NetworkPolicy): { host: string; port: number } | null {
  if (network.mode !== 'proxy' || !network.proxy) return null;
  return network.proxy.kind === 'tcp'
    ? { host: '127.0.0.1', port: network.proxy.port }
    : { host: '127.0.0.1', port: network.proxy.innerPort };
}

function buildProbes(fixture: Fixture, canaries: HostCanaries, hostProc: ChildProcess, policy: SandboxPolicy, platform: NodeJS.Platform): ProbeSpec[] {
  const proxy = proxyAddressInside(policy.network);
  const denyRead = (name: string, path: string, secret: string): ProbeSpec => ({
    name,
    dimension: 'filesystem',
    expect: 'deny',
    argv: [SH, '-c', 'cat -- "$1"', 'probe', path],
    check: (run) => ({ passed: run.code !== 0 && !run.stdout.includes(secret), detail: describeRun(run) }),
  });
  const hostPid = hostProc.pid ?? 0;
  const probes: ProbeSpec[] = [
    {
      name: 'fs.read.worktree',
      dimension: 'filesystem',
      expect: 'allow',
      argv: [SH, '-c', 'cat -- "$1"', 'probe', join(fixture.worktree, 'README.md')],
      check: (run) => ({ passed: run.code === 0 && run.stdout.includes('attempt-a worktree'), detail: describeRun(run) }),
    },
    {
      name: 'fs.read.own-gitdir',
      dimension: 'filesystem',
      expect: 'allow',
      argv: [SH, '-c', 'cat -- "$1"', 'probe', join(fixture.gitDir, 'HEAD')],
      check: (run) => ({ passed: run.code === 0 && run.stdout.includes('openlinear/attempt-a'), detail: describeRun(run) }),
    },
    denyRead('fs.read.home-ssh-key', join(fixture.home, '.ssh', 'id_ed25519'), fixture.canary.ssh),
    denyRead('fs.read.home-aws-credentials', join(fixture.home, '.aws', 'credentials'), fixture.canary.ssh),
    denyRead('fs.read.toolchain-credential', join(fixture.home, '.cargo', 'credentials.toml'), fixture.canary.toolchainCredential),
    denyRead('fs.read.other-worktree', join(fixture.otherWorktree, 'secret.txt'), fixture.canary.otherWorktree),
    denyRead('fs.read.other-attempt-gitdir', join(fixture.otherGitDir, 'HEAD'), fixture.canary.otherGitDir),
    {
      name: 'fs.list.home',
      dimension: 'filesystem',
      expect: 'deny',
      argv: [SH, '-c', 'ls -a -- "$1"', 'probe', fixture.home],
      check: (run) => ({ passed: run.code !== 0 && !run.stdout.includes('.ssh'), detail: describeRun(run) }),
    },
    {
      name: 'fs.read.symlink-escape',
      dimension: 'filesystem',
      expect: 'deny',
      argv: [SH, '-c', 'ln -s -- "$1" "$2/escape-link" 2>/dev/null; cat -- "$2/escape-link"', 'probe', join(fixture.home, '.ssh', 'id_ed25519'), fixture.worktree],
      check: (run) => ({ passed: !run.stdout.includes(fixture.canary.ssh), detail: describeRun(run) }),
    },
    {
      name: 'fs.read.hardlink-escape',
      dimension: 'filesystem',
      expect: 'deny',
      argv: [SH, '-c', 'ln -- "$1" "$2/escape-hardlink" 2>/dev/null; cat -- "$2/escape-hardlink"', 'probe', join(fixture.home, '.ssh', 'id_ed25519'), fixture.worktree],
      check: (run) => ({ passed: !run.stdout.includes(fixture.canary.ssh), detail: describeRun(run) }),
    },
    {
      name: 'fs.write.worktree',
      dimension: 'filesystem',
      expect: 'allow',
      argv: [SH, '-c', 'printf ok > "$1"', 'probe', join(fixture.worktree, 'written.txt')],
      check: (run) => {
        const path = join(fixture.worktree, 'written.txt');
        const ok = run.code === 0 && existsSync(path) && readFileSync(path, 'utf8') === 'ok';
        return { passed: ok, detail: describeRun(run) };
      },
    },
    {
      name: 'fs.write.private-tmp',
      dimension: 'filesystem',
      expect: 'allow',
      argv: [SH, '-c', 'printf ok > "$TMPDIR/probe.txt" && cat "$TMPDIR/probe.txt"', 'probe'],
      check: (run) => ({ passed: run.code === 0 && run.stdout === 'ok', detail: describeRun(run) }),
    },
    {
      name: 'fs.write.outside',
      dimension: 'filesystem',
      expect: 'deny',
      argv: [SH, '-c', 'printf pwned > "$1"', 'probe', join(fixture.outside, 'pwned.txt')],
      check: (run) => ({ passed: run.code !== 0 && !existsSync(join(fixture.outside, 'pwned.txt')), detail: describeRun(run) }),
    },
    {
      name: 'fs.write.home',
      dimension: 'filesystem',
      expect: 'deny',
      argv: [SH, '-c', 'printf pwned >> "$1"', 'probe', join(fixture.home, '.zshrc')],
      check: (run) => ({ passed: run.code !== 0 && !existsSync(join(fixture.home, '.zshrc')), detail: describeRun(run) }),
    },
    {
      name: 'fs.write.git-pointer',
      dimension: 'filesystem',
      expect: 'deny',
      argv: [SH, '-c', 'printf "gitdir: /tmp/evil\\n" > "$1"', 'probe', join(fixture.worktree, '.git')],
      check: (run) => ({
        passed: run.code !== 0 && readFileSync(join(fixture.worktree, '.git'), 'utf8') === `gitdir: ${fixture.gitDir}\n`,
        detail: describeRun(run),
      }),
    },
    {
      name: 'fs.rename.git-pointer',
      dimension: 'filesystem',
      expect: 'deny',
      argv: [SH, '-c', 'mv -- "$1" "$1.moved"', 'probe', join(fixture.worktree, '.git')],
      check: (run) => ({ passed: run.code !== 0 && existsSync(join(fixture.worktree, '.git')), detail: describeRun(run) }),
    },
    {
      name: 'fs.write.gitdir',
      dimension: 'filesystem',
      expect: 'deny',
      argv: [SH, '-c', 'printf evil > "$1"', 'probe', join(fixture.gitDir, 'HEAD')],
      check: (run) => ({
        passed: run.code !== 0 && readFileSync(join(fixture.gitDir, 'HEAD'), 'utf8').startsWith('ref: refs/heads/openlinear/attempt-a'),
        detail: describeRun(run),
      }),
    },
    {
      name: 'fs.write.common-dir-hooks',
      dimension: 'filesystem',
      expect: 'deny',
      argv: [SH, '-c', 'mkdir -p "$1/hooks" && printf "#!/bin/sh\\n" > "$1/hooks/post-checkout"', 'probe', fixture.commonDir],
      check: (run) => ({ passed: run.code !== 0 && !existsSync(join(fixture.commonDir, 'hooks', 'post-checkout')), detail: describeRun(run) }),
    },
    {
      name: 'env.no-inherited-secrets',
      dimension: 'env',
      expect: 'deny',
      argv: [SH, '-c', 'env', 'probe'],
      check: (run) => ({
        passed: run.code === 0 && !run.stdout.includes(fixture.canary.envSecret) && !leaks(run.stdout, sidecarSecretValues()),
        detail: describeRun(run),
      }),
    },
    {
      name: 'net.direct-loopback',
      dimension: 'network',
      expect: 'deny',
      argv: [BASH, '-c', 'exec 3<>"/dev/tcp/127.0.0.1/$1" && cat <&3', 'probe', String(canaries.directPort)],
      check: (run) => ({ passed: canaries.directHits === 0 && !run.stdout.includes('canary'), detail: describeRun(run) }),
    },
    {
      name: 'net.host-unix-socket',
      dimension: 'network',
      expect: 'deny',
      argv: platform === 'darwin'
        ? ['/usr/bin/nc', '-U', canaries.unixPath]
        : [SH, '-c', 'test -e "$1" && cat -- "$1"', 'probe', canaries.unixPath],
      check: (run) => ({ passed: canaries.unixHits === 0 && !run.stdout.includes('canary'), detail: describeRun(run) }),
    },
    {
      name: 'proc.signal-host-process',
      dimension: 'process',
      expect: 'deny',
      argv: [SH, '-c', 'kill -0 "$1"', 'probe', String(hostPid)],
      check: (run) => ({ passed: hostPid > 0 && run.code !== 0 && hostProc.exitCode === null, detail: describeRun(run) }),
    },
    {
      // KERN_PROCARGS2 (macOS) / /proc (Linux) carry argv *and* environment of
      // other processes — the path to the sidecar's own secrets. pgrep -f is
      // a non-setuid client of exactly that interface: it must not find the
      // host canary by its argv token from inside, and must from outside.
      name: 'proc.read-host-process-args',
      dimension: 'process',
      expect: 'deny',
      argv: ['/usr/bin/pgrep', '-f', fixture.canary.hostProcessEnv],
      check: (run) => ({ passed: run.code !== 0 && !run.stdout.includes(String(hostPid)), detail: describeRun(run) }),
      control: {
        argv: ['/usr/bin/pgrep', '-f', fixture.canary.hostProcessEnv],
        succeeded: (stdout, code) => code === 0 && stdout.includes(String(hostPid)),
      },
    },
  ];
  if (platform !== 'darwin') {
    probes.push({
      name: 'proc.read-host-process-environ',
      dimension: 'process',
      expect: 'deny',
      argv: [SH, '-c', 'cat "/proc/$1/environ"', 'probe', String(hostPid)],
      check: (run) => ({ passed: !run.stdout.includes(fixture.canary.hostProcessEnv), detail: describeRun(run) }),
    });
  }
  if (proxy) {
    const connectScript = 'exec 3<>"/dev/tcp/$1/$2" || exit 9; printf "CONNECT 127.0.0.1:%s HTTP/1.1\\r\\nHost: 127.0.0.1:%s\\r\\n\\r\\n" "$3" "$3" >&3; IFS= read -r line <&3; printf "%s\\n" "$line"';
    probes.push(
      {
        name: 'net.proxy-allowlisted-target',
        dimension: 'network',
        expect: 'allow',
        argv: [BASH, '-c', connectScript, 'probe', proxy.host, String(proxy.port), String(canaries.allowedPort)],
        check: (run) => ({ passed: run.stdout.includes(' 200 ') && canaries.allowedHits > 0, detail: describeRun(run) }),
      },
      {
        name: 'net.proxy-non-allowlisted-target',
        dimension: 'network',
        expect: 'deny',
        argv: [BASH, '-c', connectScript, 'probe', proxy.host, String(proxy.port), String(canaries.deniedPort)],
        check: (run) => ({ passed: run.stdout.includes(' 403 ') && canaries.deniedHits === 0, detail: describeRun(run) }),
      },
    );
  }
  return probes;
}

export interface PreflightOptions {
  /** Keep the fixture for debugging (tests). */
  keepFixture?: boolean;
  /** Override the fixture parent dir (defaults to os.tmpdir()). */
  fixtureBase?: string;
  /** Extra readable roots (e.g. the node prefix used by the Linux launcher). */
  extraToolchainRoots?: readonly string[];
}

/**
 * Runs the deterministic canary corpus through `provider.wrap()` on this
 * machine. `available` is true only if every filesystem, env, network and
 * process probe behaved as the policy requires.
 */
export async function runCanaryPreflight(provider: SandboxProvider, options: PreflightOptions = {}): Promise<CapabilityReport> {
  const started = Date.now();
  const report: CapabilityReport = {
    provider: provider.id,
    providerVersion: null,
    platform: process.platform,
    available: false,
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    enforced: { filesystem: false, env: false, network: false, process: false },
    probes: [],
    blockers: [],
    warnings: [],
    unsupported: [...provider.unsupportedLimits],
  };
  const detection = await provider.detect();
  report.providerVersion = detection.version;
  report.warnings.push(...detection.warnings);
  if (!detection.ok) {
    report.blockers.push(...detection.blockers);
    report.durationMs = Date.now() - started;
    return report;
  }

  const fixture = createProbeFixture(options.fixtureBase);
  let canaries: HostCanaries | null = null;
  let proxy: EgressProxy | null = null;
  let hostProc: ChildProcess | null = null;
  try {
    canaries = await startHostCanaries(fixture);
    proxy = new EgressProxy({
      allow: [`127.0.0.1:${canaries.allowedPort}`],
      // The canary listens on loopback; nothing else can reach this proxy's allow list.
      allowLocalTargets: true,
      listen: provider.proxyTransport === 'unix' ? { kind: 'unix', path: join(fixture.attemptRoot, 'run', 'proxy.sock') } : { kind: 'tcp' },
    });
    const endpoint = await proxy.start();
    const network: NetworkPolicy = {
      mode: 'proxy',
      proxy: endpoint.kind === 'tcp'
        ? { kind: 'tcp', host: '127.0.0.1', port: endpoint.port }
        : { kind: 'unix', path: endpoint.path, innerPort: 3128 },
      listenPort: null,
      controlSocketPath: null,
      allowedHosts: proxy.allowedHosts,
    };
    hostProc = spawnHostCanaryProcess(fixture.canary.hostProcessEnv);
    const toolchain = resolveToolchainRoots({
      pathEnv: '/usr/bin:/bin:/usr/sbin:/sbin',
      home: fixture.home,
      volatileRoots: [fixture.root],
      systemRoots: systemReadRoots(process.platform),
    });
    const proxyInside = proxyAddressInside(network);
    const env = buildSandboxAgentEnv({
      source: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        // Planted in the *source* env: the allowlist must drop it.
        OPENLINEAR_PROBE_API_KEY: fixture.canary.envSecret,
        GITHUB_TOKEN: fixture.canary.envSecret,
        DATABASE_URL: `postgres://user:${fixture.canary.envSecret}@localhost/db`,
      },
      path: '/usr/bin:/bin:/usr/sbin:/sbin',
      home: join(fixture.attemptRoot, 'home'),
      tmp: join(fixture.attemptRoot, 'tmp'),
      xdgConfigHome: join(fixture.attemptRoot, 'home', '.config'),
      xdgDataHome: join(fixture.attemptRoot, 'home', '.local', 'share'),
      xdgStateHome: join(fixture.attemptRoot, 'home', '.local', 'state'),
      xdgCacheHome: join(fixture.attemptRoot, 'home', '.cache'),
      proxyUrl: proxyInside ? `http://${proxyInside.host}:${proxyInside.port}` : null,
      shell: '/bin/sh',
    });
    const { policy } = buildAttemptPolicy({
      attemptKey: 'preflight',
      platform: process.platform,
      worktree: fixture.worktree,
      attemptRoot: fixture.attemptRoot,
      home: fixture.home,
      // A deliberately over-broad toolchain root: the mandatory denies must
      // still hide ~/.cargo/credentials.toml inside it.
      toolchainRoots: [...toolchain.roots, join(fixture.home, '.cargo'), ...(options.extraToolchainRoots ?? [])],
      trustedGitRoots: [fixture.repos],
      denyRoots: [fixture.repos],
      network,
      env,
    });
    // Give the host canary a moment to exec so its argv is observable.
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const probe of buildProbes(fixture, canaries, hostProc, policy, process.platform)) {
      let controlDetail = '';
      if (probe.control) {
        const control = spawnSync(probe.control.argv[0], probe.control.argv.slice(1), { encoding: 'utf8', timeout: 10_000 });
        if (!probe.control.succeeded(control.stdout ?? '', control.status)) {
          report.probes.push({
            name: probe.name,
            dimension: probe.dimension,
            expect: probe.expect,
            passed: false,
            detail: 'control run outside the sandbox did not reproduce the action; probe cannot prove denial',
            durationMs: 0,
          });
          continue;
        }
        controlDetail = ', control reproduced outside';
      }
      const run = await runWrapped(provider, policy, probe.argv, 10_000);
      const verdict = probe.check(run);
      report.probes.push({
        name: probe.name,
        dimension: probe.dimension,
        expect: probe.expect,
        passed: verdict.passed,
        detail: `${verdict.detail}${controlDetail}`,
        durationMs: run.durationMs,
      });
    }
  } catch (err) {
    report.blockers.push(`preflight could not run: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (hostProc?.pid) {
      try { process.kill(-hostProc.pid, 'SIGKILL'); } catch { hostProc.kill('SIGKILL'); }
    }
    await proxy?.close();
    if (canaries) {
      await Promise.all([closeServer(canaries.direct), closeServer(canaries.allowedTarget), closeServer(canaries.deniedTarget), closeServer(canaries.unix)]);
    }
    if (!options.keepFixture) rmSync(fixture.root, { recursive: true, force: true });
  }

  for (const dimension of ['filesystem', 'env', 'network', 'process'] as const) {
    const probes = report.probes.filter((probe) => probe.dimension === dimension);
    report.enforced[dimension] = probes.length > 0 && probes.every((probe) => probe.passed);
    if (!report.enforced[dimension]) {
      const failed = probes.filter((probe) => !probe.passed).map((probe) => probe.name);
      report.blockers.push(failed.length > 0 ? `${dimension} probes failed: ${failed.join(', ')}` : `${dimension} was not verified`);
    }
  }
  report.available = report.blockers.length === 0;
  report.durationMs = Date.now() - started;
  return report;
}
