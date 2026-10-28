import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSeccompFilter, seccompArchFor } from './linux-seccomp';
import { isWithin } from './paths';
import { validatePolicy } from './policy';
import { runCanaryPreflight } from './preflight';
import type {
  CapabilityReport,
  FsRule,
  ProviderDetection,
  SandboxPolicy,
  SandboxProvider,
  SpawnSpec,
  WrappedSpawn,
} from './types';

/**
 * Linux provider: bubblewrap with every namespace unshared (user, pid, ipc,
 * uts, cgroup, net), all capabilities dropped, `--die-with-parent`,
 * `--new-session`, a fresh /proc for the private pid namespace, a minimal
 * /dev, and the seccomp filter from linux-seccomp.ts.
 *
 * The new root contains only what the policy binds: system and toolchain
 * directories read-only, the worktree and the attempt's private root
 * read-write, `.git` re-bound read-only on top. HOME, other worktrees and the
 * sidecar's state simply do not exist inside.
 *
 * Network: `--unshare-net` leaves only a private loopback. A small Node
 * launcher inside the sandbox bridges 127.0.0.1:<innerPort> to the egress
 * proxy's Unix socket (bind-mounted from the attempt root) and exposes the
 * agent server's port as a Unix socket for the sidecar's control channel.
 *
 * NOTE: this provider is exercised only on Linux (the sandbox.yml CI corpus);
 * on macOS only its argument rendering is unit-tested.
 */

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];

/** In-sandbox launcher (CommonJS, run as `node -e`). Config arrives as argv[1]. */
export const LINUX_LAUNCHER_SOURCE = String.raw`
'use strict';
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const cfg = JSON.parse(process.argv[1]);
const servers = [];
function pipeBoth(a, b) {
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
  a.pipe(b);
  b.pipe(a);
}
function listen(server, target) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    if (typeof target === 'string') server.listen(target, resolve);
    else server.listen(target, '127.0.0.1', resolve);
  });
}
async function main() {
  if (cfg.proxy) {
    const s = net.createServer((client) => pipeBoth(client, net.connect(cfg.proxy.path)));
    servers.push(s);
    await listen(s, cfg.proxy.innerPort);
  }
  if (cfg.control) {
    try { fs.unlinkSync(cfg.control.path); } catch (_) {}
    const s = net.createServer((client) => pipeBoth(client, net.connect(cfg.control.port, '127.0.0.1')));
    servers.push(s);
    await listen(s, cfg.control.path);
  }
  const child = spawn(cfg.argv[0], cfg.argv.slice(1), { stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (err) => { process.stderr.write('launcher: ' + err.message + '\n'); process.exit(127); });
  child.on('exit', (code, signal) => {
    for (const s of servers) s.close();
    process.exit(code === null ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code);
  });
}
main().catch((err) => { process.stderr.write('launcher: ' + err.message + '\n'); process.exit(126); });
`;

/** Inner port the agent server listens on inside the private netns. */
export const LINUX_INNER_CONTROL_PORT = 4096;
export const LINUX_INNER_PROXY_PORT = 3128;

function findBwrap(env: NodeJS.ProcessEnv): string | null {
  const override = env.OPENLINEAR_BWRAP_PATH;
  if (override) return override.startsWith('/') && existsSync(override) ? override : null;
  return BWRAP_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

export function parseBwrapVersion(output: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast(version: [number, number, number] | null, wanted: [number, number, number]): boolean {
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== wanted[index]) return version[index] > wanted[index];
  }
  return true;
}

/** True when `process.execPath` is a plain Node runtime usable for the launcher. */
function launcherRuntime(): string | null {
  if (process.release?.name !== 'node') return null;
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined) return null;
  try {
    return realpathSync.native(process.execPath);
  } catch {
    return null;
  }
}

export interface BwrapRenderOptions {
  /** Directories bound read-only before the policy rules (launcher runtime). */
  runtimeRoots: readonly string[];
  disableUserns: boolean;
  seccompFd: number | null;
  /** argv executed inside the sandbox (launcher or the command itself). */
  argv: readonly string[];
}

/**
 * Pure rendering of the bwrap argument vector for `policy`. Rules are bound in
 * order, so later rules stack over earlier ones (bubblewrap mount order),
 * matching the policy's last-rule-wins semantics. Paths that do not exist on
 * the host are skipped: what is not bound does not exist inside.
 */
export function renderBwrapArgs(policy: SandboxPolicy, options: BwrapRenderOptions, exists: (path: string) => boolean = existsSync): string[] {
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--unshare-net',
  ];
  if (options.disableUserns) args.push('--disable-userns');
  args.push('--cap-drop', 'ALL', '--hostname', 'openlinear-sandbox');
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/dev/shm', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp');
  for (const root of options.runtimeRoots) args.push('--ro-bind', root, root);

  const bound: FsRule[] = [];
  const remountReadOnly: string[] = [];
  const covered = (path: string) => bound.some((rule) => rule.action !== 'deny' && (rule.scope === 'subtree' ? isWithin(path, rule.path) : rule.path === path));
  const writableCover = (path: string) => [...bound].reverse().find((rule) => rule.action !== 'deny' && rule.action !== 'protect' && (rule.scope === 'subtree' ? isWithin(path, rule.path) : rule.path === path));
  for (const rule of policy.filesystem.rules) {
    if (!exists(rule.path)) continue;
    switch (rule.action) {
      case 'read': {
        let symlinkTarget: string | null = null;
        try {
          if (lstatSync(rule.path).isSymbolicLink() && dirname(rule.path) === '/') symlinkTarget = readlinkSync(rule.path);
        } catch {
          symlinkTarget = null;
        }
        if (symlinkTarget) args.push('--symlink', symlinkTarget, rule.path);
        else args.push('--ro-bind', rule.path, rule.path);
        bound.push(rule);
        break;
      }
      case 'write':
        args.push('--bind', rule.path, rule.path);
        bound.push(rule);
        break;
      case 'deny': {
        if (!covered(rule.path)) break;
        let isDir = true;
        try {
          isDir = statSync(rule.path).isDirectory();
        } catch {
          isDir = true;
        }
        if (isDir) {
          args.push('--tmpfs', rule.path);
          remountReadOnly.push(rule.path);
        } else {
          args.push('--ro-bind', '/dev/null', rule.path);
        }
        bound.push(rule);
        break;
      }
      case 'protect': {
        const cover = writableCover(rule.path);
        if (cover?.action === 'write') {
          args.push('--ro-bind', rule.path, rule.path);
          bound.push(rule);
        }
        break;
      }
    }
  }
  for (const path of remountReadOnly) args.push('--remount-ro', path);
  args.push('--chdir', policy.cwd);
  if (options.seccompFd !== null) args.push('--seccomp', String(options.seccompFd));
  args.push('--', ...options.argv);
  return args;
}

export class LinuxBubblewrapProvider implements SandboxProvider {
  readonly id = 'linux-bubblewrap' as const;
  readonly proxyTransport = 'unix' as const;
  readonly unsupportedLimits = ['limits.cpu', 'limits.memory', 'limits.disk', 'limits.processes'] as const;
  private detection: ProviderDetection | null = null;
  private bwrapPath: string | null = null;
  private version: [number, number, number] | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async detect(): Promise<ProviderDetection> {
    if (this.detection) return this.detection;
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (process.platform !== 'linux') {
      this.detection = { ok: false, version: null, blockers: ['bubblewrap is only used on linux'], warnings };
      return this.detection;
    }
    this.bwrapPath = findBwrap(this.env);
    if (!this.bwrapPath) {
      blockers.push('bubblewrap (bwrap) not found; install it (apt-get install bubblewrap / dnf install bubblewrap)');
    } else {
      try {
        this.version = parseBwrapVersion(execFileSync(this.bwrapPath, ['--version'], { encoding: 'utf8', timeout: 5000 }));
      } catch (err) {
        blockers.push(`bwrap --version failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!atLeast(this.version, [0, 4, 0])) blockers.push('bubblewrap >= 0.4.0 is required');
      if (!atLeast(this.version, [0, 8, 0])) warnings.push('bubblewrap < 0.8: --disable-userns unavailable; nested user namespaces are blocked by seccomp only');
    }
    if (!seccompArchFor(process.arch)) blockers.push(`no seccomp filter for architecture ${process.arch}`);
    if (!launcherRuntime()) blockers.push('the Linux launcher needs a plain Node.js runtime (process.execPath)');
    this.detection = {
      ok: blockers.length === 0,
      version: this.version ? `bubblewrap ${this.version.join('.')}` : null,
      blockers,
      warnings,
    };
    return this.detection;
  }

  async preflight(): Promise<CapabilityReport> {
    const runtime = launcherRuntime();
    return runCanaryPreflight(this, { extraToolchainRoots: runtime ? [dirname(dirname(runtime))] : [] });
  }

  async wrap(spec: SpawnSpec, policy: SandboxPolicy): Promise<WrappedSpawn> {
    validatePolicy(policy);
    const detection = await this.detect();
    if (!detection.ok || !this.bwrapPath) throw new Error(`[sandbox] bubblewrap unavailable: ${detection.blockers.join('; ')}`);
    const arch = seccompArchFor(process.arch);
    const runtime = launcherRuntime();
    if (!arch || !runtime) throw new Error('[sandbox] bubblewrap launcher prerequisites missing');
    if (policy.network.mode === 'proxy' && policy.network.proxy?.kind !== 'unix') {
      throw new Error('[sandbox] Linux egress proxy must be a Unix socket endpoint');
    }

    const needsLauncher = policy.network.mode === 'proxy' || policy.network.controlSocketPath !== null;
    const argv = needsLauncher
      ? [runtime, '-e', LINUX_LAUNCHER_SOURCE, JSON.stringify({
        proxy: policy.network.proxy?.kind === 'unix' ? { path: policy.network.proxy.path, innerPort: policy.network.proxy.innerPort } : null,
        control: policy.network.controlSocketPath && policy.network.listenPort !== null
          ? { path: policy.network.controlSocketPath, port: policy.network.listenPort }
          : null,
        argv: [spec.command, ...spec.args],
      })]
      : [spec.command, ...spec.args];

    const scratch = mkdtempSync(join(tmpdir(), 'openlinear-seccomp-'));
    const filterPath = join(scratch, 'filter.bpf');
    writeFileSync(filterPath, buildSeccompFilter(arch), { mode: 0o600 });
    const fd = openSync(filterPath, 'r');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { closeSync(fd); } catch { /* already closed */ }
      rmSync(scratch, { recursive: true, force: true });
    };
    const args = renderBwrapArgs(policy, {
      runtimeRoots: [dirname(dirname(runtime))],
      disableUserns: atLeast(this.version, [0, 8, 0]),
      // stdio[3] in the spawned bwrap process.
      seccompFd: 3,
      argv,
    });
    return { command: this.bwrapPath, args, cwd: spec.cwd, env: { ...policy.env }, extraFds: [fd], release };
  }
}
