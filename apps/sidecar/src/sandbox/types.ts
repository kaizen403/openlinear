/**
 * Shared types for the agent sandbox (W09a).
 *
 * A SandboxProvider turns a plain spawn spec plus an immutable per-attempt
 * policy into the spawn spec that actually runs under OS enforcement. Which
 * guarantees hold is never inferred from the OS name: `preflight()` runs live
 * canary probes through `wrap()` and reports what was observed.
 */

export type SandboxProviderId = 'macos-seatbelt' | 'linux-bubblewrap';

/**
 * A process to start: argv form only, never a shell string. The environment
 * is not part of the spec — it is a policy dimension (`SandboxPolicy.env`)
 * and is the child's complete environment.
 */
export interface SpawnSpec {
  command: string;
  args: readonly string[];
  cwd: string;
}

/** What to hand to `child_process.spawn` after wrapping. */
export interface WrappedSpawn {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /**
   * Extra file descriptors to place at stdio[3], stdio[4], … (Linux passes the
   * seccomp program this way). The caller must not close them before spawn.
   */
  extraFds: number[];
  /** Releases temp files/fds created for this wrap. Idempotent. */
  release(): void;
}

export interface ProxyEndpointTcp {
  kind: 'tcp';
  host: '127.0.0.1';
  port: number;
}

export interface ProxyEndpointUnix {
  kind: 'unix';
  /** Host path of the proxy socket; bind-mounted into the sandbox. */
  path: string;
  /** Port the in-sandbox bridge listens on (inside the private netns). */
  innerPort: number;
}

export type ProxyEndpoint = ProxyEndpointTcp | ProxyEndpointUnix;

/**
 * One filesystem rule. Rules are applied in order and a later rule wins over
 * an earlier one for the paths it covers — exactly Seatbelt's last-match-wins
 * semantics and bubblewrap's mount stacking. Anything not covered by a rule
 * is denied (deny-by-default reads and writes).
 *
 * - `read`: readable (and executable), not writable
 * - `write`: readable and writable
 * - `deny`: neither readable nor writable
 * - `protect`: not writable (stays readable if an earlier rule allowed it)
 */
export interface FsRule {
  action: 'read' | 'write' | 'deny' | 'protect';
  path: string;
  /** `subtree`: the path and everything below it. `file`: the path only. */
  scope: 'subtree' | 'file';
}

export interface FilesystemPolicy {
  rules: FsRule[];
}

export interface NetworkPolicy {
  /** `none`: no egress at all. `proxy`: only the per-attempt egress proxy. */
  mode: 'none' | 'proxy';
  proxy: ProxyEndpoint | null;
  /** Loopback port the sandboxed process may listen on (control channel). */
  listenPort: number | null;
  /** Unix socket the Linux launcher exposes for the control channel. */
  controlSocketPath: string | null;
  /** Host patterns the proxy allows (informational here; enforced by the proxy). */
  allowedHosts: string[];
}

export interface SandboxPolicy {
  schemaVersion: 1;
  /** Opaque, non-secret identifier used in logs and metadata. */
  attemptKey: string;
  cwd: string;
  filesystem: FilesystemPolicy;
  network: NetworkPolicy;
  /** The complete environment of the sandboxed process. */
  env: Record<string, string>;
}

export type ProbeDimension = 'filesystem' | 'env' | 'network' | 'process';

export interface ProbeResult {
  name: string;
  dimension: ProbeDimension;
  expect: 'allow' | 'deny';
  passed: boolean;
  detail: string;
  durationMs: number;
}

export interface CapabilityReport {
  provider: SandboxProviderId | 'none';
  providerVersion: string | null;
  platform: NodeJS.Platform;
  available: boolean;
  checkedAt: string;
  durationMs: number;
  /** A dimension is `true` only if every probe for it passed on this machine. */
  enforced: Record<ProbeDimension, boolean>;
  probes: ProbeResult[];
  blockers: string[];
  warnings: string[];
  /** Policy dimensions this provider does not enforce (reported, never claimed). */
  unsupported: string[];
}

export interface ProviderDetection {
  ok: boolean;
  version: string | null;
  blockers: string[];
  warnings: string[];
}

export interface SandboxProvider {
  readonly id: SandboxProviderId;
  /** How the sandboxed process reaches the egress proxy. */
  readonly proxyTransport: 'tcp' | 'unix';
  /** Static checks (binary present, kernel features) — no untrusted code runs. */
  detect(): Promise<ProviderDetection>;
  /** Live canary probes through wrap(); the only source of `enforced`. */
  preflight(): Promise<CapabilityReport>;
  /** Pure: returns the spawn spec that runs `spec` under `policy`. */
  wrap(spec: SpawnSpec, policy: SandboxPolicy): Promise<WrappedSpawn>;
  /** Limits this provider cannot enforce; reported in every capability report. */
  readonly unsupportedLimits: readonly string[];
}
