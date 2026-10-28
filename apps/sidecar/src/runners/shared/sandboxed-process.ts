import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { logger } from '../../lib/logger';
import { buildEgressAllowlist } from '../../sandbox/egress-allowlist';
import { EgressProxy, parseHostRule } from '../../sandbox/egress-proxy';
import { buildSandboxAgentEnv } from '../../sandbox/env';
import { SandboxStartError, SandboxUnavailableError } from '../../sandbox/errors';
import { LINUX_INNER_PROXY_PORT } from '../../sandbox/linux-bwrap';
import { grantCovers, resolveSandboxMode, type TrustedHostGrant } from '../../sandbox/mode';
import { darwinDeveloperBin, sandboxStateRoot } from '../../sandbox/opencode-attempts';
import { isWithin, realpathOrResolve, resolveToolchainRoots } from '../../sandbox/paths';
import { buildAttemptPolicy, policyHash, sidecarStateRoots, systemReadRoots, validatePolicy } from '../../sandbox/policy';
import { getVerifiedProvider } from '../../sandbox/provider';
import type { CapabilityReport, FsRule, NetworkPolicy, SandboxPolicy, SandboxProvider } from '../../sandbox/types';
import type { ExitInfo, GroupHandle } from './process-group';

/**
 * W07: launches a runner CLI (Claude Code, Codex) for one attempt under the
 * verified SandboxProvider, exactly like W09a's per-attempt OpenCode servers:
 *
 * - enforce mode (default): live-verified provider or SANDBOX_UNAVAILABLE with
 *   zero spawn; one egress proxy per attempt; an immutable policy granting the
 *   worktree, its Git metadata (read-only), a private HOME/TMP/XDG root and a
 *   private runtime state dir; an exact env (no inheritance).
 * - trusted-host mode: only under an explicit, covering grant; the unmodified
 *   binary runs on the host with an env allowlist. Logged at warn level.
 *
 * The only addition to the W09a policy is the login-file allowance: a
 * runtime's own login-state file (e.g. `~/.claude/.credentials.json`) is made
 * readable as a single file, read-only, AFTER the mandatory credential denies,
 * and linked into the private runtime dir. The sidecar never opens, copies or
 * forwards the file's contents.
 */

export type RunnerProcessId = 'claude-code' | 'codex';

export interface AttemptDirs {
  root: string;
  home: string;
  tmp: string;
  run: string;
  config: string;
  data: string;
  state: string;
  cache: string;
  /** Private runtime state (CLAUDE_CONFIG_DIR / CODEX_HOME): sessions live here. */
  runtime: string;
}

export interface LoginFileAllowance {
  /** Host path of the runtime's own login-state file. Existence is checked; contents are never read. */
  source: string;
  /** Name of the link created inside `dirs.runtime`. */
  linkName: string;
}

export interface RunnerProcessSpec {
  runner: RunnerProcessId;
  worktree: string;
  /** Absolute path of the runtime binary (resolved by the runner, never from the worktree). */
  binary: string;
  /** Argument vector; the sandbox mode decides e.g. whether a runtime's own sandbox is used. */
  argv(mode: 'enforce' | 'trusted-host'): string[];
  /**
   * Explicit, reviewed env additions for the sandboxed process (enforce
   * mode). `context.path` is the PATH already filtered to readable dirs.
   */
  enforceEnv(dirs: AttemptDirs, context: { path: string }): Record<string, string | undefined>;
  /** Complete env for trusted-host mode (built from an allowlist by the runner). */
  hostEnv(): Record<string, string>;
  readFiles?: string[];
  readRoots?: string[];
  loginFiles?: LoginFileAllowance[];
  /** Provider ids from PROVIDER_HOSTS whose hosts the proxy allows. */
  egressProviders: string[];
  /** Additional `host[:port]` rules (validated; invalid ones are dropped with a warning). */
  egressHosts?: string[];
}

export interface RunnerSandboxMetadata {
  mode: 'enforce' | 'trusted-host';
  runner: RunnerProcessId;
  attemptKey: string;
  worktree: string;
  provider: string | null;
  providerVersion: string | null;
  policyHash: string | null;
  preflight: { checkedAt: string; enforced: CapabilityReport['enforced']; unsupported: string[] } | null;
  egressAllowedHosts: string[];
  /** Host login-state files readable (read-only) inside the sandbox. Paths only. */
  loginFileAllowances: string[];
  startedAt: string;
  startupMs: number | null;
  grant: (Omit<TrustedHostGrant, 'paths'> & { paths: string[] | null }) | null;
  warnings: string[];
}

export interface RunnerProcess extends GroupHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly mode: 'enforce' | 'trusted-host';
  readonly metadata: RunnerSandboxMetadata;
  readonly dirs: AttemptDirs | null;
  /** The policy the process runs under (enforce mode). */
  readonly policy: SandboxPolicy | null;
  /** Spawn failure (e.g. ENOENT) if any. */
  spawnError(): Error | null;
  /** Releases the proxy and wrap resources. Idempotent; also runs on exit. */
  dispose(): Promise<void>;
}

export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface RunnerLaunchDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  verifiedProvider?: () => Promise<{ provider: SandboxProvider; report: CapabilityReport }>;
  spawnProcess?: SpawnProcess;
  now?: () => number;
}

export function runnerAttemptKey(runner: RunnerProcessId, worktree: string): string {
  return createHash('sha256').update(`${runner}\0${worktree}`).digest('hex').slice(0, 20);
}

/**
 * W07a: the private runtime-state dir (CLAUDE_CONFIG_DIR / CODEX_HOME) an
 * enforce-mode launch for `worktree` uses — the same path
 * `launchRunnerProcess` derives, so a follow-up turn in the same worktree
 * finds the sessions an earlier run saved. Null when the worktree no longer
 * resolves.
 */
export function runnerRuntimeDir(
  runner: RunnerProcessId,
  worktree: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  let real: string;
  try {
    real = realpathSync.native(worktree);
  } catch {
    return null;
  }
  const root = realpathOrResolve(sandboxStateRoot(env, platform));
  return join(root, 'runners', runner, runnerAttemptKey(runner, real), 'runtime');
}

/**
 * W07a: whether a saved session file exists under `root` within `depth`
 * directory levels (bounded walk; symlinks are not followed).
 */
export function findSessionFile(root: string, matches: (name: string) => boolean, depth: number, budget = 5_000): boolean {
  let remaining = budget;
  const walk = (dir: string, level: number): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      remaining -= 1;
      if (remaining < 0) return false;
      if (entry.isFile() && matches(entry.name)) return true;
      if (entry.isDirectory() && level < depth && walk(join(dir, entry.name), level + 1)) return true;
    }
    return false;
  };
  return walk(root, 0);
}

function appDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.OPENLINEAR_APP_DATA) return env.OPENLINEAR_APP_DATA;
  const home = env.HOME ?? homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'OpenLinear');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'openlinear');
}

/** OPENLINEAR_SANDBOX_EXTRA_READ: colon-separated absolute dirs (toolchains). */
function extraReadRoots(env: NodeJS.ProcessEnv): string[] {
  return (env.OPENLINEAR_SANDBOX_EXTRA_READ ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('/') && existsSync(entry));
}

/** Host-only records (attempt → worktree, session usage baselines). Not readable by agents. */
export function runnerRecordsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(sandboxStateRoot(env, platform), 'runners', 'records');
}

const collected = new Set<string>();

/** Removes private runner roots whose worktree no longer exists (once per state root per process). */
function garbageCollect(root: string): void {
  if (collected.has(root)) return;
  collected.add(root);
  const records = join(root, 'runners', 'records');
  if (!existsSync(records)) return;
  for (const entry of readdirSync(records).slice(0, 1000)) {
    const match = /^(claude-code|codex)-([0-9a-f]{20})\.json$/.exec(entry);
    if (!match) continue;
    try {
      const meta = JSON.parse(readFileSync(join(records, entry), 'utf8')) as { worktree?: unknown };
      if (typeof meta.worktree === 'string' && !existsSync(meta.worktree)) {
        rmSync(join(root, 'runners', match[1], match[2]), { recursive: true, force: true });
        rmSync(join(records, entry), { force: true });
      }
    } catch {
      // Unknown layout: leave it for manual inspection.
    }
  }
}

/** Test seam: forget which state roots were already collected. */
export function resetRunnerGcForTests(): void {
  collected.clear();
}

/**
 * Links the runtime's own login-state file into the private runtime dir.
 * Returns the real host path that must become readable, or null when the
 * file does not exist. Never reads or copies the file.
 */
function linkLoginFile(allowance: LoginFileAllowance, runtimeDir: string, worktree: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(allowance.linkName) || allowance.linkName === '.' || allowance.linkName === '..') {
    throw new SandboxStartError('Invalid login-file link name');
  }
  let real: string;
  try {
    real = realpathSync.native(allowance.source);
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  // A "login file" inside agent-writable space is not the user's login.
  if (isWithin(real, runtimeDir) || isWithin(real, worktree)) return null;
  const link = join(runtimeDir, allowance.linkName);
  try {
    // Whatever is there (a stale link, or a file a runtime wrote by renaming
    // over the link) is replaced: the user's own login stays authoritative.
    lstatSync(link);
    unlinkSync(link);
  } catch {
    // nothing to replace
  }
  symlinkSync(real, link);
  return real;
}

class LaunchedRunnerProcess implements RunnerProcess {
  readonly exited: Promise<ExitInfo>;
  private exitInfo: ExitInfo | null = null;
  private error: Error | null = null;
  private disposed: Promise<void> | null = null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  constructor(
    private readonly child: ChildProcess,
    readonly mode: 'enforce' | 'trusted-host',
    readonly metadata: RunnerSandboxMetadata,
    readonly dirs: AttemptDirs | null,
    readonly policy: SandboxPolicy | null,
    private readonly cleanup: () => Promise<void>,
  ) {
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new SandboxStartError('Runner process was spawned without stdio pipes');
    }
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    // A runner that exits while we write to stdin must not crash the sidecar.
    this.stdin.on('error', () => undefined);
    this.exited = new Promise<ExitInfo>((resolve) => {
      child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
      child.once('error', (err) => {
        this.error = err;
        if (child.pid === undefined) {
          this.exitInfo = { code: null, signal: null };
          resolve(this.exitInfo);
        }
      });
    });
    void this.exited.then(() => this.dispose());
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  killProcess(signal: NodeJS.Signals): boolean {
    return this.child.kill(signal);
  }

  isExited(): boolean {
    return this.exitInfo !== null;
  }

  spawnError(): Error | null {
    return this.error;
  }

  dispose(): Promise<void> {
    if (!this.disposed) this.disposed = this.cleanup().catch(() => undefined);
    return this.disposed;
  }
}

const defaultSpawn: SpawnProcess = (command, args, options) => spawn(command, [...args], options);

/**
 * Starts `spec` for one attempt. Throws SandboxUnavailableError (nothing
 * spawned) when enforce mode has no verified provider or trusted-host mode
 * has no covering grant; SandboxStartError for other start failures.
 */
export async function launchRunnerProcess(spec: RunnerProcessSpec, deps: RunnerLaunchDeps = {}): Promise<RunnerProcess> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const spawnProcess = deps.spawnProcess ?? defaultSpawn;
  const started = now();

  let worktree: string;
  try {
    worktree = realpathSync.native(spec.worktree);
    if (!statSync(worktree).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new SandboxStartError('Attempt workspace does not exist', { directory: spec.worktree });
  }
  if (!spec.binary.startsWith('/')) {
    throw new SandboxStartError(`${spec.runner} binary must resolve to an absolute path`);
  }
  if (isWithin(realpathOrResolve(spec.binary), worktree)) {
    throw new SandboxStartError(`${spec.runner} binary must not live inside the agent worktree`);
  }

  const decision = resolveSandboxMode(env, now());
  const key = runnerAttemptKey(spec.runner, worktree);

  if (decision.mode === 'trusted-host') {
    if (!grantCovers(decision.grant, worktree)) {
      throw new SandboxUnavailableError('The trusted-host grant does not cover this workspace', ['grant paths do not include the attempt worktree']);
    }
    const metadata: RunnerSandboxMetadata = {
      mode: 'trusted-host',
      runner: spec.runner,
      attemptKey: key,
      worktree,
      provider: null,
      providerVersion: null,
      policyHash: null,
      preflight: null,
      egressAllowedHosts: [],
      loginFileAllowances: [],
      startedAt: new Date(started).toISOString(),
      startupMs: null,
      grant: { ...decision.grant },
      warnings: [`${spec.runner} runs on the host without OS isolation under an explicit trusted-host grant`],
    };
    logger.warn({ sandbox: metadata }, '[Sandbox] trusted-host grant used: runner process runs WITHOUT OS isolation');
    const child = spawnProcess(spec.binary, spec.argv('trusted-host'), {
      cwd: worktree,
      env: spec.hostEnv(),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new LaunchedRunnerProcess(child, 'trusted-host', metadata, null, null, async () => undefined);
  }

  // Enforce: nothing below runs without a live-verified provider.
  const { provider, report } = await (deps.verifiedProvider ?? getVerifiedProvider)();
  const root = realpathOrResolve(sandboxStateRoot(env, platform));
  garbageCollect(root);
  const attemptRoot = join(root, 'runners', spec.runner, key);
  const home = join(attemptRoot, 'home');
  const dirs: AttemptDirs = {
    root: attemptRoot,
    home,
    tmp: join(attemptRoot, 'tmp'),
    run: join(attemptRoot, 'run'),
    config: join(home, '.config'),
    data: join(home, '.local', 'share'),
    state: join(home, '.local', 'state'),
    cache: join(home, '.cache'),
    runtime: join(attemptRoot, 'runtime'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const recordsDir = join(root, 'runners', 'records');
  mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
  const recordPath = join(recordsDir, `${spec.runner}-${key}.json`);
  writeFileSync(recordPath, JSON.stringify({ runner: spec.runner, worktree, createdAt: new Date(started).toISOString() }), { mode: 0o600 });

  const allowlist = buildEgressAllowlist({
    authProviders: spec.egressProviders,
    configProviders: null,
    extraHosts: env.OPENLINEAR_SANDBOX_ALLOW_HOSTS,
    includeRegistries: env.OPENLINEAR_SANDBOX_REGISTRIES !== '0',
  });
  const warnings = allowlist.rejected.map((host) => `ignored invalid OPENLINEAR_SANDBOX_ALLOW_HOSTS entry ${host}`);
  const hosts = new Set(allowlist.hosts);
  for (const raw of spec.egressHosts ?? []) {
    try {
      parseHostRule(raw);
      hosts.add(raw.toLowerCase());
    } catch {
      warnings.push(`ignored invalid runner egress host ${raw}`);
    }
  }
  const allowedHosts = [...hosts].sort();

  const linux = provider.proxyTransport === 'unix';
  const proxy = new EgressProxy({
    allow: allowedHosts,
    listen: linux ? { kind: 'unix', path: join(dirs.run, 'proxy.sock') } : { kind: 'tcp' },
    onDecision: (decision) => {
      if (!decision.allowed) logger.info({ runner: spec.runner, attemptKey: key, host: decision.host, port: decision.port, reason: decision.reason }, '[Sandbox] runner egress denied');
    },
  });
  let release: (() => void) | null = null;
  try {
    const endpoint = await proxy.start();
    const network: NetworkPolicy = {
      mode: 'proxy',
      proxy: endpoint.kind === 'tcp'
        ? { kind: 'tcp', host: '127.0.0.1', port: endpoint.port }
        : { kind: 'unix', path: endpoint.path, innerPort: LINUX_INNER_PROXY_PORT },
      listenPort: null,
      controlSocketPath: null,
      allowedHosts,
    };
    const proxyPort = endpoint.kind === 'tcp' ? endpoint.port : LINUX_INNER_PROXY_PORT;
    const realHome = env.HOME ?? homedir();
    const developerBin = platform === 'darwin' ? darwinDeveloperBin() : null;
    const toolchain = resolveToolchainRoots({
      pathEnv: [developerBin, env.PATH].filter(Boolean).join(':'),
      home: realHome,
      volatileRoots: ['/tmp', '/private/tmp', '/private/var/folders', root],
      systemRoots: systemReadRoots(platform),
    });

    const loginReadable: string[] = [];
    for (const allowance of spec.loginFiles ?? []) {
      const real = linkLoginFile(allowance, dirs.runtime, worktree);
      if (real) loginReadable.push(real);
    }

    const sandboxPath = toolchain.pathEntries.join(':');
    const sandboxEnv = buildSandboxAgentEnv({
      source: env,
      path: sandboxPath,
      home: dirs.home,
      tmp: dirs.tmp,
      xdgConfigHome: dirs.config,
      xdgDataHome: dirs.data,
      xdgStateHome: dirs.state,
      xdgCacheHome: dirs.cache,
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      noProxy: linux ? 'localhost,127.0.0.1,::1' : null,
      shell: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh',
      explicit: spec.enforceEnv(dirs, { path: sandboxPath }),
    });
    const sidecarRoots = [
      ...sidecarStateRoots(realHome, platform),
      appDataRoot(env, platform),
      ...(env.REPOS_DIR ? [env.REPOS_DIR] : []),
      root,
    ];
    const built = buildAttemptPolicy({
      attemptKey: key,
      platform,
      worktree,
      attemptRoot,
      home: realHome,
      toolchainRoots: [...toolchain.roots, ...extraReadRoots(env), ...(spec.readRoots ?? []).filter((path) => existsSync(path))],
      readOnlyFiles: [spec.binary, ...(spec.readFiles ?? []).filter((path) => existsSync(path))],
      trustedGitRoots: [...sidecarRoots, worktree],
      denyRoots: sidecarRoots,
      network,
      env: sandboxEnv,
    });
    warnings.push(...built.warnings);
    // Login-file allowances come last so they override the mandatory
    // credential-store denies for exactly these files (read-only).
    const loginRules: FsRule[] = loginReadable.map((path) => ({ action: 'read', path, scope: 'file' }));
    const policy = loginRules.length > 0
      ? validatePolicy({ ...built.policy, filesystem: { rules: [...built.policy.filesystem.rules, ...loginRules] } })
      : built.policy;

    const wrapped = await provider.wrap({ command: spec.binary, args: spec.argv('enforce'), cwd: worktree }, policy);
    release = () => wrapped.release();
    const child = spawnProcess(wrapped.command, wrapped.args, {
      cwd: wrapped.cwd,
      env: wrapped.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', ...wrapped.extraFds],
    });
    // Extra fds are duplicated into the child by spawn(); ours can go now.
    wrapped.release();
    release = null;

    const metadata: RunnerSandboxMetadata = {
      mode: 'enforce',
      runner: spec.runner,
      attemptKey: key,
      worktree,
      provider: provider.id,
      providerVersion: report.providerVersion,
      policyHash: policyHash(policy),
      preflight: { checkedAt: report.checkedAt, enforced: report.enforced, unsupported: report.unsupported },
      egressAllowedHosts: allowedHosts,
      loginFileAllowances: loginReadable,
      startedAt: new Date(started).toISOString(),
      startupMs: now() - started,
      grant: null,
      warnings,
    };
    writeFileSync(recordPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    logger.info({ sandbox: metadata }, '[Sandbox] runner process started under enforced sandbox');
    return new LaunchedRunnerProcess(child, 'enforce', metadata, dirs, policy, () => proxy.close());
  } catch (err) {
    release?.();
    await proxy.close().catch(() => undefined);
    if (err instanceof SandboxUnavailableError || err instanceof SandboxStartError) throw err;
    throw new SandboxStartError(`Sandboxed ${spec.runner} failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
}
