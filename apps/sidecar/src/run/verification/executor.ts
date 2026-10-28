import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { VERIFICATION_LIMITS, type VerificationCheckSpec } from '@openlinear/execution-core';
import { logger } from '../../lib/logger';
import { buildEgressAllowlist } from '../../sandbox/egress-allowlist';
import { EgressProxy, parseHostRule } from '../../sandbox/egress-proxy';
import { buildSandboxAgentEnv, pickBaseEnv } from '../../sandbox/env';
import { SandboxUnavailableError } from '../../sandbox/errors';
import { LINUX_INNER_PROXY_PORT } from '../../sandbox/linux-bwrap';
import { grantCovers, resolveSandboxMode } from '../../sandbox/mode';
import { darwinDeveloperBin } from '../../sandbox/opencode-attempts';
import { isWithin, realpathOrResolve, resolveToolchainRoots } from '../../sandbox/paths';
import { buildAttemptPolicy, policyHash, sidecarStateRoots, systemReadRoots, validatePolicy } from '../../sandbox/policy';
import { getVerifiedProvider } from '../../sandbox/provider';
import type { CapabilityReport, FsRule, NetworkPolicy, SandboxProvider } from '../../sandbox/types';
import { redactSecrets } from '../../services/execution/state';

/**
 * W11a: runs ONE verification check (argv form, never re-parsed) inside the
 * verified sandbox, against the pristine checkout:
 *
 * - enforce mode (default): the live-verified SandboxProvider (W09a) with an
 *   immutable policy — the checkout is the only writable project directory
 *   (its `.git` read-only), a private HOME/TMP/XDG root, the sidecar's state
 *   and every credential store denied, an exact environment (no
 *   inheritance, no provider credentials), and network `none` unless the
 *   check declares egress (then only the per-check egress proxy allowlist);
 * - trusted-host mode only under an explicit grant covering the checkout
 *   (logged; the evidence says `trusted-host`);
 * - no verified sandbox and no grant: the check is not run (`error`).
 *
 * Bounded: a wall-clock timeout (SIGTERM to the process group, SIGKILL after
 * a grace), ≤ 1 MiB of combined output stored as the log artifact, a
 * redacted ≤ 4 KiB tail for the evidence record. The result is the exit
 * code; descendants left behind are killed with the group.
 */

export interface CheckExecutionInput {
  check: VerificationCheckSpec;
  /** Realpath of the pristine checkout. */
  checkoutPath: string;
  /** Private HOME/TMP root for this check (created; disjoint from the checkout). */
  privateRoot: string;
  /** Directories the checkout borrows objects from (read-only). */
  readRoots: readonly string[];
  /** Root the sidecar keeps checkouts in (denied except for this checkout). */
  denyRoots: readonly string[];
  logPath: string;
  signal: AbortSignal;
}

export interface CheckSandboxInfo {
  mode: 'enforce' | 'trusted-host' | 'none';
  provider: string | null;
  providerVersion: string | null;
  policyHash: string | null;
}

export interface CheckExecution {
  status: 'passed' | 'failed' | 'timed_out' | 'error';
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  log: { sha256: string | null; bytes: number; truncated: boolean; tail: string; artifact: string | null };
  detail: string | null;
  sandbox: CheckSandboxInfo;
}

export interface CheckExecutor {
  run(input: CheckExecutionInput): Promise<CheckExecution>;
}

export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SandboxedCheckExecutorDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  verifiedProvider?: () => Promise<{ provider: SandboxProvider; report: CapabilityReport }>;
  spawnProcess?: SpawnProcess;
  now?: () => number;
  /** SIGTERM → SIGKILL grace on timeout/cancel. */
  killGraceMs?: number;
}

/** Bounded, hashed log artifact plus a redacted tail. */
class BoundedLog {
  private readonly fd: number | null;
  private stored = 0;
  private total = 0;
  private readonly hash = createHash('sha256');
  private tail = Buffer.alloc(0);

  constructor(readonly path: string) {
    let fd: number | null = null;
    try {
      fd = openSync(path, 'w', 0o600);
    } catch (error) {
      logger.warn({ err: error, path }, '[Verify] log artifact could not be opened; keeping the tail only');
    }
    this.fd = fd;
  }

  write(chunk: Buffer): void {
    this.total += chunk.length;
    const room = VERIFICATION_LIMITS.maxLogBytes - this.stored;
    if (room > 0 && this.fd !== null) {
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      writeSync(this.fd, part);
      this.hash.update(part);
      this.stored += part.length;
    }
    const keep = VERIFICATION_LIMITS.logTailBytes * 2;
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > keep) this.tail = this.tail.subarray(this.tail.length - keep);
  }

  close(): CheckExecution['log'] {
    if (this.fd !== null) closeSync(this.fd);
    const text = redactSecrets(this.tail.toString('utf8'));
    const tail = text.length > VERIFICATION_LIMITS.logTailBytes ? text.slice(text.length - VERIFICATION_LIMITS.logTailBytes) : text;
    return {
      sha256: this.fd !== null ? this.hash.digest('hex') : null,
      bytes: this.total,
      truncated: this.total > this.stored || this.fd === null,
      tail,
      artifact: this.fd !== null ? this.path : null,
    };
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** argv[0] as an absolute path: given absolute, or found on `path` (never in the checkout). */
export function resolveCommand(command: string, path: string, checkout: string): string | null {
  if (isAbsolute(command)) return executable(command) && !isWithin(realpathOrResolve(command), checkout) ? command : null;
  if (command.includes('/')) return null;
  for (const dir of path.split(':')) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    if (executable(candidate) && !isWithin(realpathOrResolve(candidate), checkout)) return candidate;
  }
  return null;
}

function failure(detail: string, sandbox: CheckSandboxInfo, log: BoundedLog, startedAt: number, now: () => number): CheckExecution {
  log.write(Buffer.from(`[openlinear] ${detail}\n`));
  return { status: 'error', exitCode: null, signal: null, durationMs: now() - startedAt, timedOut: false, log: log.close(), detail, sandbox };
}

function appDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.OPENLINEAR_APP_DATA) return env.OPENLINEAR_APP_DATA;
  const home = env.HOME ?? homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'OpenLinear');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'openlinear');
}

export function createSandboxedCheckExecutor(deps: SandboxedCheckExecutorDeps = {}): CheckExecutor {
  const now = deps.now ?? Date.now;
  const spawnProcess: SpawnProcess = deps.spawnProcess ?? ((command, args, options) => spawn(command, [...args], options));
  const killGraceMs = deps.killGraceMs ?? 2_000;

  return {
    async run(input) {
      const env = deps.env ?? process.env;
      const platform = deps.platform ?? process.platform;
      const startedAt = now();
      const log = new BoundedLog(input.logPath);
      const none: CheckSandboxInfo = { mode: 'none', provider: null, providerVersion: null, policyHash: null };
      if (input.signal.aborted) return failure('verification was cancelled before the check started', none, log, startedAt, now);

      const cwd = input.check.cwd ? join(input.checkoutPath, input.check.cwd) : input.checkoutPath;
      try {
        const real = realpathSync(cwd);
        if (!statSync(real).isDirectory() || !isWithin(real, input.checkoutPath)) throw new Error('outside');
      } catch {
        return failure(`working directory "${input.check.cwd}" does not exist in the verified commit`, none, log, startedAt, now);
      }
      const home = join(input.privateRoot, 'home');
      const tmp = join(input.privateRoot, 'tmp');
      for (const dir of [home, tmp, join(home, '.config'), join(home, '.local', 'share'), join(home, '.local', 'state'), join(home, '.cache')]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      let decision: ReturnType<typeof resolveSandboxMode>;
      try {
        decision = resolveSandboxMode(env, now());
      } catch (error) {
        // An invalid or expired trusted-host grant never downgrades to "run unsandboxed".
        const reason = error instanceof SandboxUnavailableError ? error.message : 'the sandbox configuration is invalid';
        return failure(`${reason}; the check was not run`, none, log, startedAt, now);
      }
      let command: string;
      let spawnCwd = cwd;
      let args: string[];
      let spawnEnv: Record<string, string>;
      let extraFds: number[] = [];
      let sandbox: CheckSandboxInfo;
      let proxy: EgressProxy | null = null;
      let release: (() => void) | null = null;

      try {
        if (decision.mode === 'trusted-host') {
          if (!grantCovers(decision.grant, input.checkoutPath)) {
            return failure('no verified sandbox, and the trusted-host grant does not cover the verification checkout', none, log, startedAt, now);
          }
          sandbox = { mode: 'trusted-host', provider: null, providerVersion: null, policyHash: null };
          const path = env.PATH ?? '/usr/bin:/bin';
          const resolved = resolveCommand(input.check.argv[0] ?? '', path, input.checkoutPath);
          if (!resolved) return failure(`command not found: ${input.check.argv[0] ?? ''}`, sandbox, log, startedAt, now);
          command = resolved;
          args = input.check.argv.slice(1);
          spawnEnv = { ...pickBaseEnv(env), PATH: path, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CI: '1', OPENLINEAR_VERIFY: '1' };
          logger.warn({ check: input.check.id, grant: decision.grant.grantId }, '[Verify] trusted-host grant used: check runs WITHOUT OS isolation');
        } else {
          let verified: { provider: SandboxProvider; report: CapabilityReport };
          try {
            verified = await (deps.verifiedProvider ?? getVerifiedProvider)();
          } catch (error) {
            const reason = error instanceof SandboxUnavailableError ? error.message : 'no verified sandbox is available';
            return failure(`${reason}; the check was not run`, none, log, startedAt, now);
          }
          const { provider, report } = verified;
          let network: NetworkPolicy = { mode: 'none', proxy: null, listenPort: null, controlSocketPath: null, allowedHosts: [] };
          let proxyPort: number | null = null;
          const linux = provider.proxyTransport === 'unix';
          if (input.check.network.mode === 'egress') {
            const allowlist = buildEgressAllowlist({ authProviders: [], configProviders: null, extraHosts: undefined, includeRegistries: input.check.network.registries });
            const hosts = new Set(allowlist.hosts);
            for (const host of input.check.network.hosts) {
              try {
                parseHostRule(host);
                hosts.add(host);
              } catch {
                log.write(Buffer.from(`[openlinear] ignored invalid egress host ${host}\n`));
              }
            }
            const allowedHosts = [...hosts].sort();
            proxy = new EgressProxy({ allow: allowedHosts, listen: linux ? { kind: 'unix', path: join(tmp, 'proxy.sock') } : { kind: 'tcp' } });
            const endpoint = await proxy.start();
            network = {
              mode: 'proxy',
              proxy: endpoint.kind === 'tcp' ? { kind: 'tcp', host: '127.0.0.1', port: endpoint.port } : { kind: 'unix', path: endpoint.path, innerPort: LINUX_INNER_PROXY_PORT },
              listenPort: null,
              controlSocketPath: null,
              allowedHosts,
            };
            proxyPort = endpoint.kind === 'tcp' ? endpoint.port : LINUX_INNER_PROXY_PORT;
          }
          const realHome = env.HOME ?? homedir();
          const developerBin = platform === 'darwin' ? darwinDeveloperBin() : null;
          const toolchain = resolveToolchainRoots({
            pathEnv: [developerBin, env.PATH].filter(Boolean).join(':'),
            home: realHome,
            volatileRoots: ['/tmp', '/private/tmp', '/private/var/folders', ...input.denyRoots],
            systemRoots: systemReadRoots(platform),
          });
          const sandboxPath = toolchain.pathEntries.join(':');
          const resolved = resolveCommand(input.check.argv[0] ?? '', sandboxPath || '/usr/bin:/bin', input.checkoutPath);
          sandbox = { mode: 'enforce', provider: provider.id, providerVersion: report.providerVersion, policyHash: null };
          if (!resolved) return failure(`command not found inside the sandbox: ${input.check.argv[0] ?? ''}`, sandbox, log, startedAt, now);
          const sandboxEnv = {
            ...buildSandboxAgentEnv({
              source: env,
              path: sandboxPath,
              home,
              tmp,
              xdgConfigHome: join(home, '.config'),
              xdgDataHome: join(home, '.local', 'share'),
              xdgStateHome: join(home, '.local', 'state'),
              xdgCacheHome: join(home, '.cache'),
              proxyUrl: proxyPort !== null ? `http://127.0.0.1:${proxyPort}` : null,
              noProxy: linux ? 'localhost,127.0.0.1,::1' : null,
              shell: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh',
            }),
            CI: '1',
            OPENLINEAR_VERIFY: '1',
          };
          const sidecarRoots = [...sidecarStateRoots(realHome, platform), appDataRoot(env, platform), ...input.denyRoots];
          const built = buildAttemptPolicy({
            attemptKey: `verify-${createHash('sha256').update(`${input.checkoutPath}\0${input.check.id}`).digest('hex').slice(0, 16)}`,
            platform,
            worktree: input.checkoutPath,
            attemptRoot: input.privateRoot,
            home: realHome,
            toolchainRoots: toolchain.roots,
            readOnlyFiles: [],
            trustedGitRoots: [input.checkoutPath],
            denyRoots: sidecarRoots,
            network,
            env: sandboxEnv,
          });
          // Borrowed objects (alternates) are readable, never writable; last rule wins.
          const readRules: FsRule[] = input.readRoots.filter((path) => existsSync(path)).map((path) => ({ action: 'read', path: realpathOrResolve(path), scope: 'subtree' }));
          const policy = readRules.length > 0
            ? validatePolicy({ ...built.policy, filesystem: { rules: [...built.policy.filesystem.rules, ...readRules] } })
            : built.policy;
          sandbox = { ...sandbox, policyHash: policyHash(policy) };
          const wrapped = await provider.wrap({ command: resolved, args: input.check.argv.slice(1), cwd }, policy);
          release = () => wrapped.release();
          command = wrapped.command;
          spawnCwd = wrapped.cwd;
          args = wrapped.args;
          spawnEnv = wrapped.env;
          extraFds = wrapped.extraFds;
        }
      } catch (error) {
        release?.();
        await proxy?.close().catch(() => undefined);
        return failure(`the sandbox could not start the check: ${error instanceof Error ? error.message : String(error)}`, none, log, startedAt, now);
      }

      let child: ChildProcess;
      try {
        child = spawnProcess(command, args, { cwd: spawnCwd, env: spawnEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...extraFds] });
      } catch (error) {
        release?.();
        await proxy?.close().catch(() => undefined);
        return failure(`the check could not be started: ${error instanceof Error ? error.message : String(error)}`, sandbox, log, startedAt, now);
      }
      // Extra fds were duplicated into the child by spawn(); ours can go.
      release?.();
      release = null;

      child.stdout?.on('data', (chunk: Buffer) => log.write(chunk));
      child.stderr?.on('data', (chunk: Buffer) => log.write(chunk));

      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // already gone
          }
        }
      };
      let timedOut = false;
      let cancelled = false;
      let graceTimer: NodeJS.Timeout | null = null;
      const stop = () => {
        killGroup('SIGTERM');
        graceTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
        graceTimer.unref?.();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        log.write(Buffer.from(`\n[openlinear] timed out after ${Math.round(input.check.timeoutMs / 1000)} s; stopping the check\n`));
        stop();
      }, input.check.timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        cancelled = true;
        log.write(Buffer.from('\n[openlinear] verification cancelled; stopping the check\n'));
        stop();
      };
      input.signal.addEventListener('abort', onAbort, { once: true });

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>((resolve) => {
        let spawnError: Error | null = null;
        child.once('error', (error) => {
          spawnError = error;
          if (child.pid === undefined) resolve({ code: null, signal: null, error });
        });
        child.once('exit', (code, signal) => {
          // Let buffered output drain (bounded): a daemon holding the pipe does not hold the result.
          const drained = new Promise<void>((done) => {
            if (child.stdout?.readableEnded !== false && child.stderr?.readableEnded !== false) done();
            else child.once('close', () => done());
          });
          const deadline = new Promise<void>((done) => setTimeout(done, 1_000).unref?.());
          void Promise.race([drained, deadline]).then(() => resolve({ code, signal, error: spawnError }));
        });
      });
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      input.signal.removeEventListener('abort', onAbort);
      // No descendant outlives its check.
      killGroup('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      await proxy?.close().catch(() => undefined);

      const durationMs = now() - startedAt;
      if (exit.error && exit.code === null && exit.signal === null) {
        return { status: 'error', exitCode: null, signal: null, durationMs, timedOut: false, log: log.close(), detail: `the check could not be started: ${exit.error.message}`, sandbox };
      }
      const status: CheckExecution['status'] = timedOut ? 'timed_out' : cancelled ? 'error' : exit.code === 0 ? 'passed' : 'failed';
      const detail = timedOut
        ? `timed out after ${Math.round(input.check.timeoutMs / 1000)} s`
        : cancelled ? 'cancelled while running' : exit.code === null ? `terminated by ${exit.signal ?? 'a signal'}` : null;
      return { status, exitCode: exit.code, signal: exit.signal, durationMs, timedOut, log: log.close(), detail, sandbox };
    },
  };
}
