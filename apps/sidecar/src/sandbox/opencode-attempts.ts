import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '../lib/logger';
import { buildEgressAllowlist } from './egress-allowlist';
import { EgressProxy } from './egress-proxy';
import { buildSandboxAgentEnv } from './env';
import { SandboxStartError, SandboxUnavailableError } from './errors';
import { LINUX_INNER_CONTROL_PORT, LINUX_INNER_PROXY_PORT } from './linux-bwrap';
import { grantCovers, resolveSandboxMode, type TrustedHostGrant } from './mode';
import { realpathOrResolve, resolveToolchainRoots } from './paths';
import { buildAttemptPolicy, policyHash, sidecarStateRoots, systemReadRoots } from './policy';
import { getVerifiedProvider } from './provider';
import type { CapabilityReport, NetworkPolicy, SandboxProvider, WrappedSpawn } from './types';

/**
 * Per-attempt OpenCode servers.
 *
 * `opencode serve` is one multi-project server: any request may name any
 * directory, and every tool call runs inside that one process tree. Wrapping
 * the shared server in a sandbox would therefore have to grant every worktree
 * to every run. Instead each attempt (keyed by its worktree realpath) gets its
 * own server process, started under the verified sandbox provider with a
 * policy that grants exactly that worktree, its Git metadata (read-only), a
 * private HOME/TMP/XDG root, and one egress proxy. The server requires a
 * per-launch random password (OPENCODE_SERVER_PASSWORD), so neither other
 * local processes nor other sandboxes can drive it.
 *
 * A server is reaped when it has been idle (no in-flight request or open
 * event stream, no busy session) for the idle window, when its worktree
 * disappears, or on sidecar shutdown. The private root is kept while the
 * worktree exists (OpenCode's session DB lives there, so a restarted sidecar
 * can resume) and removed once the worktree is gone.
 */

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  extraFds: number[];
}

export interface LaunchedServer {
  url: string;
  proc: ChildProcess;
  close(): Promise<void>;
}

export interface AttemptClientConfig {
  baseUrl: string;
  directory: string;
  headers: Record<string, string>;
  fetch: (request: Request) => Promise<Response>;
}

export interface AttemptManagerDeps<TClient> {
  /** Spawns the (already wrapped) server and resolves once it listens. */
  launch(spec: LaunchSpec, timeoutMs: number): Promise<LaunchedServer>;
  resolveBinary(): string;
  createClient(config: AttemptClientConfig): TClient;
  /** Model/provider selection from the management server, if running. */
  managementConfig(): Promise<Record<string, unknown> | null>;
  /** Agent config every server gets (permissions, compaction, …). */
  agentConfig(): Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  verifiedProvider?: () => Promise<{ provider: SandboxProvider; report: CapabilityReport }>;
  now?: () => number;
  onEvent?: (event: string, payload: Record<string, unknown>) => void;
}

export interface SandboxRunMetadata {
  mode: 'enforce' | 'trusted-host';
  attemptKey: string;
  worktree: string;
  provider: string | null;
  providerVersion: string | null;
  policyHash: string | null;
  preflight: { checkedAt: string; enforced: CapabilityReport['enforced']; unsupported: string[] } | null;
  egressAllowedHosts: string[];
  startedAt: string;
  startupMs: number | null;
  grant: Omit<TrustedHostGrant, 'paths'> & { paths: string[] | null } | null;
  warnings: string[];
}

export type AttemptRoute<TClient> =
  | { kind: 'attempt'; client: TClient; metadata: SandboxRunMetadata }
  | { kind: 'trusted-host'; metadata: SandboxRunMetadata };

interface AttemptServer {
  key: string;
  worktree: string;
  attemptRoot: string;
  url: string;
  authorization: string;
  launched: LaunchedServer;
  proxy: EgressProxy;
  bridge: Server | null;
  wrapped: WrappedSpawn;
  inflight: number;
  lastActivity: number;
  metadata: SandboxRunMetadata;
  closing: Promise<void> | null;
  /** W12a: when the server process was spawned (its identity for orphan stopping after a crash). */
  launchWindow: { launchedAt: number; spawnedBy: number };
  /** FE-04: `ask` = edits, commands and fetches wait for a reply (`permission.updated`). */
  approvals: AttemptApprovalMode;
}

/**
 * FE-04: how an attempt server answers the agent's edits, shell commands
 * and web fetches: `policy` (OpenCode's defaults — the OS sandbox is the
 * boundary) or `ask` (each one emits a permission request the run service
 * holds for the person who started the run).
 */
export type AttemptApprovalMode = 'policy' | 'ask';

const ASK_PERMISSIONS = { edit: 'ask', bash: 'ask', webfetch: 'ask' } as const;

const DEFAULT_IDLE_MS = 15 * 60_000;
const REAP_INTERVAL_MS = 60_000;
const START_TIMEOUT_MS = 30_000;
const MAX_AUTH_BYTES = 1024 * 1024;

export function attemptKeyFor(worktree: string): string {
  return createHash('sha256').update(worktree).digest('hex').slice(0, 20);
}

function appDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.OPENLINEAR_APP_DATA) return env.OPENLINEAR_APP_DATA;
  const home = env.HOME ?? homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'OpenLinear');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'openlinear');
}

/** Where per-attempt private roots live (OPENLINEAR_SANDBOX_DIR overrides). */
export function sandboxStateRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env.OPENLINEAR_SANDBOX_DIR ?? join(appDataRoot(env, platform), 'sandbox');
}

/** The management server's OpenCode credential store (read on the host only). */
function readOpenCodeAuth(env: NodeJS.ProcessEnv): { content: string | null; providers: string[] } {
  const home = env.HOME ?? homedir();
  const path = join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'opencode', 'auth.json');
  try {
    if (statSync(path).size > MAX_AUTH_BYTES) return { content: null, providers: [] };
    const content = readFileSync(path, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { content: null, providers: [] };
    return { content, providers: Object.keys(parsed) };
  } catch {
    return { content: null, providers: [] };
  }
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('[sandbox] could not allocate a loopback port');
  return address.port;
}

/** Host-side TCP listener that forwards to the sandbox's control socket (Linux). */
async function startControlBridge(socketPath: string): Promise<{ server: Server; port: number }> {
  const server = createServer((client) => {
    const upstream = connect(socketPath);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('[sandbox] control bridge has no port');
  return { server, port: address.port };
}

/** Wraps a fetch Response so the end (or cancel) of its body is observed. */
function observeBody(response: Response, done: () => void): Response {
  if (!response.body) {
    done();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      done();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export class AttemptServerManager<TClient> {
  private readonly servers = new Map<string, AttemptServer>();
  private readonly starting = new Map<string, Promise<AttemptServer>>();
  /** FE-04: the approval mode the next session on a worktree needs (by attempt key). */
  private readonly approvalModes = new Map<string, AttemptApprovalMode>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private reaper: NodeJS.Timeout | null = null;
  private gcDone = false;
  private shuttingDown = false;

  constructor(private readonly deps: AttemptManagerDeps<TClient>) {
    this.env = deps.env ?? process.env;
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
  }

  get idleMs(): number {
    const value = Number(this.env.OPENLINEAR_SANDBOX_IDLE_MS);
    return Number.isFinite(value) && value >= 10_000 ? value : DEFAULT_IDLE_MS;
  }

  /**
   * Routes a directory-scoped client. Enforce mode returns a client for the
   * attempt's own sandboxed server; trusted-host returns the decision so the
   * caller uses the legacy shared server. Fails closed otherwise.
   */
  async route(userId: string, directory: string): Promise<AttemptRoute<TClient>> {
    if (this.shuttingDown) throw new SandboxStartError('Sidecar is shutting down');
    let worktree: string;
    try {
      worktree = realpathSync.native(directory);
      if (!statSync(worktree).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new SandboxStartError('Attempt workspace does not exist', { directory });
    }
    const decision = resolveSandboxMode(this.env, this.now());
    if (decision.mode === 'trusted-host') {
      if (!grantCovers(decision.grant, worktree)) {
        throw new SandboxUnavailableError('The trusted-host grant does not cover this workspace', ['grant paths do not include the attempt worktree']);
      }
      const metadata: SandboxRunMetadata = {
        mode: 'trusted-host',
        attemptKey: attemptKeyFor(worktree),
        worktree,
        provider: null,
        providerVersion: null,
        policyHash: null,
        preflight: null,
        egressAllowedHosts: [],
        startedAt: new Date(this.now()).toISOString(),
        startupMs: null,
        grant: { ...decision.grant },
        warnings: ['agent runs on the host without OS isolation under an explicit trusted-host grant'],
      };
      logger.warn({ userId, sandbox: metadata }, '[Sandbox] trusted-host grant used: attempt runs WITHOUT OS isolation');
      this.deps.onEvent?.('sandbox:attempt', { mode: 'trusted-host', attemptKey: metadata.attemptKey, grantId: decision.grant.grantId });
      return { kind: 'trusted-host', metadata };
    }
    const server = await this.ensureServer(worktree);
    server.lastActivity = this.now();
    return { kind: 'attempt', client: this.clientFor(server), metadata: server.metadata };
  }

  /**
   * W12a: the identity of the attempt server's process (a process-group
   * leader), journaled with the run so a restarted sidecar can stop an
   * orphan without signalling a recycled pid.
   */
  processFor(directory: string): { pid: number | null; launchedAt: number; spawnedBy: number } | null {
    const server = this.servers.get(attemptKeyFor(realpathOrResolve(directory)));
    if (!server) return null;
    return { pid: server.launched.proc.pid ?? null, ...server.launchWindow };
  }

  metadataFor(directory: string): SandboxRunMetadata | null {
    const key = attemptKeyFor(realpathOrResolve(directory));
    return this.servers.get(key)?.metadata ?? null;
  }

  status(): Array<{
    attemptKey: string;
    worktree: string;
    url: string;
    inflight: number;
    idleMs: number;
    policyHash: string | null;
    egress: { allowed: number; denied: number; recent: Array<{ host: string; port: number; allowed: boolean; reason: string }> };
  }> {
    return [...this.servers.values()].map((server) => ({
      attemptKey: server.key,
      worktree: server.worktree,
      url: server.url,
      inflight: server.inflight,
      idleMs: this.now() - server.lastActivity,
      policyHash: server.metadata.policyHash,
      egress: {
        allowed: server.proxy.allowedCount,
        denied: server.proxy.deniedCount,
        recent: server.proxy.decisions.slice(-20).map(({ host, port, allowed, reason }) => ({ host, port, allowed, reason })),
      },
    }));
  }

  private clientFor(server: AttemptServer): TClient {
    const tracked = async (request: Request): Promise<Response> => {
      server.inflight += 1;
      server.lastActivity = this.now();
      let released = false;
      const done = () => {
        if (released) return;
        released = true;
        server.inflight = Math.max(0, server.inflight - 1);
        server.lastActivity = this.now();
      };
      try {
        const response = await fetch(request);
        return observeBody(response, done);
      } catch (err) {
        done();
        throw err;
      }
    };
    return this.deps.createClient({
      baseUrl: server.url,
      directory: server.worktree,
      headers: { authorization: server.authorization },
      fetch: tracked,
    });
  }

  /**
   * FE-04: the approval mode for the next session on `directory`. The mode
   * is part of the server's startup config, so an idle server started with
   * another mode is replaced on the next route; a busy one is kept (its
   * sessions keep the mode they started with).
   */
  setApprovalMode(directory: string, mode: AttemptApprovalMode): void {
    this.approvalModes.set(attemptKeyFor(realpathOrResolve(directory)), mode);
  }

  /** FE-04: the approval mode the running attempt server for `directory` was started with (null = none running). */
  approvalModeOf(directory: string): AttemptApprovalMode | null {
    const server = this.servers.get(attemptKeyFor(realpathOrResolve(directory)));
    return server && !server.closing ? server.approvals : null;
  }

  private ensureServer(worktree: string): Promise<AttemptServer> {
    const key = attemptKeyFor(worktree);
    const existing = this.servers.get(key);
    if (existing && !existing.closing && existing.launched.proc.exitCode === null) {
      const wanted = this.approvalModes.get(key) ?? 'policy';
      if (existing.approvals === wanted || existing.inflight > 0) return Promise.resolve(existing);
      const pending = this.starting.get(key);
      if (pending) return pending;
      // Never stop a server with a live session (the reaper's check): a busy
      // server keeps its mode, and callers see it (`approvalModeOf`).
      const restart = (async () => {
        if (await this.hasBusySession(existing)) return existing;
        logger.info({ attemptKey: key, from: existing.approvals, to: wanted }, '[Sandbox] restarting the idle attempt server for another approval mode');
        await this.close(existing, 'approval-mode');
        return this.start(key, worktree);
      })().finally(() => this.starting.delete(key));
      this.starting.set(key, restart);
      return restart;
    }
    const pending = this.starting.get(key);
    if (pending) return pending;
    const start = this.start(key, worktree).finally(() => this.starting.delete(key));
    this.starting.set(key, start);
    return start;
  }

  /**
   * Removes private roots whose worktree no longer exists. Records live in
   * `<root>/records`, which the sandboxed agent cannot write (only its own
   * `<root>/attempts/<key>` is re-opened), so a record cannot be forged to
   * point the cleanup elsewhere; deletion only ever targets
   * `<root>/attempts/<key>`.
   */
  private garbageCollect(root: string): void {
    if (this.gcDone) return;
    this.gcDone = true;
    const records = join(root, 'records');
    if (!existsSync(records)) return;
    for (const entry of readdirSync(records).slice(0, 1000)) {
      const match = /^([0-9a-f]{20})\.json$/.exec(entry);
      if (!match) continue;
      try {
        const meta = JSON.parse(readFileSync(join(records, entry), 'utf8')) as { worktree?: unknown };
        if (typeof meta.worktree === 'string' && !existsSync(meta.worktree)) {
          rmSync(join(root, 'attempts', match[1]), { recursive: true, force: true });
          rmSync(join(records, entry), { force: true });
        }
      } catch {
        // Unknown layout: leave it for manual inspection.
      }
    }
  }

  private async start(key: string, worktree: string): Promise<AttemptServer> {
    const started = this.now();
    const { provider, report } = await (this.deps.verifiedProvider ?? getVerifiedProvider)();
    const root = realpathOrResolve(sandboxStateRoot(this.env, this.platform));
    this.garbageCollect(root);
    const attemptRoot = join(root, 'attempts', key);
    const home = join(attemptRoot, 'home');
    const dirs = {
      home,
      tmp: join(attemptRoot, 'tmp'),
      run: join(attemptRoot, 'run'),
      config: join(home, '.config'),
      data: join(home, '.local', 'share'),
      state: join(home, '.local', 'state'),
      cache: join(home, '.cache'),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const recordsDir = join(root, 'records');
    mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
    const recordPath = join(recordsDir, `${key}.json`);
    writeFileSync(recordPath, JSON.stringify({ worktree, createdAt: new Date(started).toISOString() }), { mode: 0o600 });

    const auth = readOpenCodeAuth(this.env);
    let managementConfig: Record<string, unknown> | null = null;
    try {
      managementConfig = await this.deps.managementConfig();
    } catch (err) {
      logger.warn({ err }, '[Sandbox] could not read model selection from the management server');
    }
    const configProviders = managementConfig && typeof managementConfig.provider === 'object' && managementConfig.provider !== null
      ? managementConfig.provider as Record<string, unknown>
      : null;
    const allowlist = buildEgressAllowlist({
      authProviders: auth.providers,
      configProviders,
      extraHosts: this.env.OPENLINEAR_SANDBOX_ALLOW_HOSTS,
      includeRegistries: this.env.OPENLINEAR_SANDBOX_REGISTRIES !== '0',
    });
    const warnings = allowlist.rejected.map((host) => `ignored invalid OPENLINEAR_SANDBOX_ALLOW_HOSTS entry ${host}`);

    const proxy = new EgressProxy({
      allow: allowlist.hosts,
      listen: provider.proxyTransport === 'unix' ? { kind: 'unix', path: join(dirs.run, 'proxy.sock') } : { kind: 'tcp' },
      onDecision: (decision) => {
        if (!decision.allowed) logger.info({ attemptKey: key, host: decision.host, port: decision.port, reason: decision.reason }, '[Sandbox] egress denied');
      },
    });
    let bridge: Server | null = null;
    let wrapped: WrappedSpawn | null = null;
    try {
      const endpoint = await proxy.start();
      const linux = provider.proxyTransport === 'unix';
      const listenPort = linux ? LINUX_INNER_CONTROL_PORT : await freeLoopbackPort();
      const controlSocketPath = linux ? join(dirs.run, 'ctl.sock') : null;
      const network: NetworkPolicy = {
        mode: 'proxy',
        proxy: endpoint.kind === 'tcp'
          ? { kind: 'tcp', host: '127.0.0.1', port: endpoint.port }
          : { kind: 'unix', path: endpoint.path, innerPort: LINUX_INNER_PROXY_PORT },
        listenPort,
        controlSocketPath,
        allowedHosts: allowlist.hosts,
      };
      const proxyPort = endpoint.kind === 'tcp' ? endpoint.port : LINUX_INNER_PROXY_PORT;

      const binary = realpathOrResolve(this.deps.resolveBinary());
      if (!binary.startsWith('/')) throw new SandboxStartError('OpenCode binary must resolve to an absolute path for sandboxed execution');
      const realHome = this.env.HOME ?? homedir();
      const developerBin = this.platform === 'darwin' ? darwinDeveloperBin() : null;
      const toolchain = resolveToolchainRoots({
        pathEnv: [developerBin, this.env.PATH].filter(Boolean).join(':'),
        home: realHome,
        volatileRoots: ['/tmp', '/private/tmp', '/private/var/folders', root],
        systemRoots: systemReadRoots(this.platform),
      });
      const password = randomBytes(24).toString('base64url');
      const agentConfig: Record<string, unknown> = { ...this.deps.agentConfig() };
      for (const field of ['model', 'small_model', 'provider', 'disabled_providers', 'enabled_providers']) {
        if (managementConfig && managementConfig[field] !== undefined) agentConfig[field] = managementConfig[field];
      }
      const approvals = this.approvalModes.get(key) ?? 'policy';
      if (approvals === 'ask') {
        const base = typeof agentConfig.permission === 'object' && agentConfig.permission !== null ? agentConfig.permission : {};
        agentConfig.permission = { ...base, ...ASK_PERMISSIONS };
      }
      const env = buildSandboxAgentEnv({
        source: this.env,
        path: toolchain.pathEntries.join(':'),
        home: dirs.home,
        tmp: dirs.tmp,
        xdgConfigHome: dirs.config,
        xdgDataHome: dirs.data,
        xdgStateHome: dirs.state,
        xdgCacheHome: dirs.cache,
        proxyUrl: `http://127.0.0.1:${proxyPort}`,
        noProxy: linux ? 'localhost,127.0.0.1,::1' : null,
        shell: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh',
        explicit: {
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(agentConfig),
          // Provider credentials for this attempt's server. The agent can read
          // them (the server's env is inherited by its tools); egress is
          // limited to the allowlist. A credential broker is W10.
          OPENCODE_AUTH_CONTENT: auth.content ?? undefined,
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          OPENCODE_DISABLE_MODELS_FETCH: '1',
          OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          OPENCODE_DISABLE_CLAUDE_CODE: '1',
          OPENCODE_DISABLE_SHARE: '1',
        },
      });
      const sidecarRoots = [
        ...sidecarStateRoots(realHome, this.platform),
        appDataRoot(this.env, this.platform),
        ...(this.env.REPOS_DIR ? [this.env.REPOS_DIR] : []),
        root,
      ];
      const { policy, warnings: policyWarnings } = buildAttemptPolicy({
        attemptKey: key,
        platform: this.platform,
        worktree,
        attemptRoot,
        home: realHome,
        toolchainRoots: [...toolchain.roots, ...extraReadRoots(this.env)],
        // The agent runtime itself (bundled next to the sidecar, in ~/.opencode,
        // …) is readable as a single file, not via its whole directory.
        readOnlyFiles: [binary],
        trustedGitRoots: [...sidecarRoots, worktree],
        // Denied early; this attempt's worktree, Git metadata and private
        // root are re-opened by later rules even when they live inside.
        denyRoots: sidecarRoots,
        network,
        env,
      });
      warnings.push(...policyWarnings);
      wrapped = await provider.wrap({
        command: binary,
        args: ['serve', '--hostname=127.0.0.1', `--port=${listenPort}`],
        cwd: worktree,
      }, policy);
      const launchedAt = this.now();
      const launched = await this.deps.launch({
        command: wrapped.command,
        args: wrapped.args,
        cwd: wrapped.cwd,
        env: wrapped.env,
        extraFds: wrapped.extraFds,
      }, Number(this.env.OPENLINEAR_SANDBOX_START_TIMEOUT_MS) || START_TIMEOUT_MS);
      wrapped.release();
      let url = launched.url;
      if (controlSocketPath) {
        const opened = await startControlBridge(controlSocketPath);
        bridge = opened.server;
        url = `http://127.0.0.1:${opened.port}`;
      }
      const metadata: SandboxRunMetadata = {
        mode: 'enforce',
        attemptKey: key,
        worktree,
        provider: provider.id,
        providerVersion: report.providerVersion,
        policyHash: policyHash(policy),
        preflight: { checkedAt: report.checkedAt, enforced: report.enforced, unsupported: report.unsupported },
        egressAllowedHosts: allowlist.hosts,
        startedAt: new Date(started).toISOString(),
        startupMs: this.now() - started,
        grant: null,
        warnings,
      };
      writeFileSync(recordPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
      const server: AttemptServer = {
        key,
        worktree,
        attemptRoot,
        url,
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
        launched,
        proxy,
        bridge,
        wrapped,
        inflight: 0,
        lastActivity: this.now(),
        metadata,
        closing: null,
        launchWindow: { launchedAt, spawnedBy: this.now() },
        approvals,
      };
      launched.proc.once('exit', (code, signal) => {
        if (this.servers.get(key) !== server || server.closing) return;
        logger.warn({ attemptKey: key, code, signal }, '[Sandbox] attempt server exited unexpectedly');
        void this.close(server, 'exited');
      });
      this.servers.set(key, server);
      this.ensureReaper();
      logger.info({ sandbox: metadata }, '[Sandbox] attempt server started under enforced sandbox');
      this.deps.onEvent?.('sandbox:attempt', { mode: 'enforce', attemptKey: key, provider: provider.id, policyHash: metadata.policyHash, startupMs: metadata.startupMs });
      return server;
    } catch (err) {
      wrapped?.release();
      await proxy.close().catch(() => undefined);
      bridge?.close();
      if (err instanceof SandboxUnavailableError || err instanceof SandboxStartError) throw err;
      throw new SandboxStartError(`Sandboxed OpenCode server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private ensureReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      void this.reapIdle();
    }, REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  /** Closes idle servers and those whose worktree is gone. Exposed for tests. */
  async reapIdle(): Promise<string[]> {
    const reaped: string[] = [];
    for (const server of [...this.servers.values()]) {
      if (server.closing) continue;
      if (!existsSync(server.worktree)) {
        await this.close(server, 'worktree-removed');
        reaped.push(server.key);
        continue;
      }
      if (server.inflight > 0 || this.now() - server.lastActivity < this.idleMs) continue;
      if (await this.hasBusySession(server)) {
        server.lastActivity = this.now();
        continue;
      }
      await this.close(server, 'idle');
      reaped.push(server.key);
    }
    return reaped;
  }

  private async hasBusySession(server: AttemptServer): Promise<boolean> {
    try {
      const response = await fetch(`${server.url}/session/status?directory=${encodeURIComponent(server.worktree)}`, {
        headers: { authorization: server.authorization },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return true;
      const body = await response.json() as Record<string, { type?: string }>;
      return Object.values(body ?? {}).some((status) => status?.type && status.type !== 'idle');
    } catch {
      // Unknown state: keep the server rather than kill a running agent.
      return true;
    }
  }

  /** Stops the server for `directory` (e.g. when its worktree is released). False when this manager has none. */
  async release(directory: string): Promise<boolean> {
    const server = this.servers.get(attemptKeyFor(realpathOrResolve(directory)));
    if (!server) return false;
    await this.close(server, 'released');
    return true;
  }

  private close(server: AttemptServer, reason: string): Promise<void> {
    if (server.closing) return server.closing;
    server.closing = (async () => {
      try {
        await server.launched.close();
      } finally {
        await server.proxy.close().catch(() => undefined);
        server.bridge?.close();
        server.wrapped.release();
        if (this.servers.get(server.key) === server) this.servers.delete(server.key);
        if (!existsSync(server.worktree)) {
          rmSync(server.attemptRoot, { recursive: true, force: true });
          rmSync(join(dirname(dirname(server.attemptRoot)), 'records', `${server.key}.json`), { force: true });
        }
        logger.info({ attemptKey: server.key, reason, egressDenied: server.proxy.deniedCount, egressAllowed: server.proxy.allowedCount }, '[Sandbox] attempt server stopped');
        this.deps.onEvent?.('sandbox:attempt:stopped', { attemptKey: server.key, reason });
      }
    })();
    return server.closing;
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.servers.values()].map((server) => this.close(server, 'shutdown')));
  }
}

/** Active Xcode/CLT developer `usr/bin`, so `git` resolves past the xcrun shim. */
export function darwinDeveloperBin(): string | null {
  try {
    const link = realpathSync.native('/private/var/db/xcode_select_link');
    const bin = join(link, 'usr', 'bin');
    return existsSync(join(bin, 'git')) ? bin : null;
  } catch {
    const clt = '/Library/Developer/CommandLineTools/usr/bin';
    return existsSync(join(clt, 'git')) ? clt : null;
  }
}

/** OPENLINEAR_SANDBOX_EXTRA_READ: colon-separated absolute dirs (toolchains). */
function extraReadRoots(env: NodeJS.ProcessEnv): string[] {
  return (env.OPENLINEAR_SANDBOX_EXTRA_READ ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('/') && existsSync(entry));
}
