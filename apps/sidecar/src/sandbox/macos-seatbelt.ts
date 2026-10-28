import { accessSync, constants, existsSync } from 'node:fs';
import { release } from 'node:os';
import { ancestorsOf } from './paths';
import { validatePolicy } from './policy';
import { runCanaryPreflight } from './preflight';
import type {
  CapabilityReport,
  ProviderDetection,
  SandboxPolicy,
  SandboxProvider,
  SpawnSpec,
  WrappedSpawn,
} from './types';

/**
 * Never resolve sandbox-exec through PATH: a writable PATH entry would let
 * anything replace the enforcement binary.
 */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/**
 * Deny-by-default base profile. Process, sysctl and IPC allowances follow the
 * Chrome-derived profiles used by Anthropic's sandbox-runtime and Codex, but
 * narrower: no user-preference reads (CFPreferences of every app), no
 * keychain/securityd, launch-services, Apple Events or trustd services, no
 * pseudo-terminals.
 */
const BASE_PROFILE = [
  '(version 1)',
  '(deny default)',
  // Explicit denies for the sensitive operation classes, ahead of every
  // allow (last match wins). `(deny default)` was observed not to cover
  // process-info on macOS 27, so nothing security-relevant relies on it alone.
  '(deny file-read* file-write*)',
  '(deny network*)',
  '(deny mach-lookup mach-register)',
  '(deny appleevent-send lsopen)',
  '(deny iokit-open)',
  '(deny sysctl-write)',
  '(allow process-exec)',
  '(allow process-fork)',
  // `(deny default)` alone did NOT stop sysctl(KERN_PROCARGS2) on another
  // same-user process (argv + environment, i.e. the sidecar's secrets) on
  // macOS 27; an explicit deny before the same-sandbox re-allow does. Verified
  // by the corpus (control run outside the sandbox reads the canary).
  '(deny process-info*)',
  '(allow process-info* (target same-sandbox))',
  '(deny signal)',
  '(allow signal (target same-sandbox))',
  '(deny mach-priv-task-port)',
  '(allow mach-priv-task-port (target same-sandbox))',
  '(allow mach-lookup',
  '  (global-name "com.apple.system.opendirectoryd.libinfo")',
  '  (global-name "com.apple.system.opendirectoryd.membership")',
  '  (global-name "com.apple.system.notification_center")',
  '  (global-name "com.apple.system.logger")',
  '  (global-name "com.apple.logd")',
  '  (global-name "com.apple.bsd.dirhelper"))',
  '(allow ipc-posix-shm)',
  '(allow ipc-posix-sem)',
  '(allow sysctl-read',
  '  (sysctl-name "hw.activecpu")',
  '  (sysctl-name "hw.byteorder")',
  '  (sysctl-name "hw.cacheconfig")',
  '  (sysctl-name "hw.cachelinesize")',
  '  (sysctl-name "hw.cachelinesize_compat")',
  '  (sysctl-name "hw.cpufamily")',
  '  (sysctl-name "hw.cpufrequency")',
  '  (sysctl-name "hw.cpufrequency_compat")',
  '  (sysctl-name "hw.cputype")',
  '  (sysctl-name "hw.cpusubtype")',
  '  (sysctl-name "hw.l1dcachesize")',
  '  (sysctl-name "hw.l1icachesize")',
  '  (sysctl-name "hw.l2cachesize")',
  '  (sysctl-name "hw.l3cachesize")',
  '  (sysctl-name "hw.logicalcpu")',
  '  (sysctl-name "hw.logicalcpu_max")',
  '  (sysctl-name "hw.machine")',
  '  (sysctl-name "hw.memsize")',
  '  (sysctl-name "hw.model")',
  '  (sysctl-name "hw.ncpu")',
  '  (sysctl-name "hw.nperflevels")',
  '  (sysctl-name "hw.packages")',
  '  (sysctl-name "hw.pagesize")',
  '  (sysctl-name "hw.pagesize_compat")',
  '  (sysctl-name "hw.physicalcpu")',
  '  (sysctl-name "hw.physicalcpu_max")',
  '  (sysctl-name "hw.tbfrequency")',
  '  (sysctl-name "hw.tbfrequency_compat")',
  '  (sysctl-name "hw.vectorunit")',
  '  (sysctl-name "kern.argmax")',
  '  (sysctl-name "kern.bootargs")',
  '  (sysctl-name "kern.hostname")',
  '  (sysctl-name "kern.maxfiles")',
  '  (sysctl-name "kern.maxfilesperproc")',
  '  (sysctl-name "kern.maxproc")',
  '  (sysctl-name "kern.ngroups")',
  '  (sysctl-name "kern.osproductversion")',
  '  (sysctl-name "kern.osrelease")',
  '  (sysctl-name "kern.ostype")',
  '  (sysctl-name "kern.osvariant_status")',
  '  (sysctl-name "kern.osversion")',
  '  (sysctl-name "kern.secure_kernel")',
  '  (sysctl-name "kern.tcsm_available")',
  '  (sysctl-name "kern.tcsm_enable")',
  '  (sysctl-name "kern.usrstack64")',
  '  (sysctl-name "kern.version")',
  '  (sysctl-name "kern.willshutdown")',
  '  (sysctl-name "machdep.cpu.brand_string")',
  '  (sysctl-name "machdep.ptrauth_enabled")',
  '  (sysctl-name "security.mac.lockdown_mode_state")',
  '  (sysctl-name "sysctl.proc_cputype")',
  '  (sysctl-name "vm.loadavg")',
  '  (sysctl-name-prefix "hw.optional.")',
  '  (sysctl-name-prefix "hw.perflevel")',
  '  (sysctl-name-prefix "machdep.cpu."))',
  '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
  '(allow file-ioctl',
  '  (literal "/dev/null")',
  '  (literal "/dev/zero")',
  '  (literal "/dev/random")',
  '  (literal "/dev/urandom")',
  '  (literal "/dev/dtracehelper"))',
  '(allow file-read* file-write-data (literal "/dev/null") (literal "/dev/zero"))',
  '(allow file-read* file-write* (subpath "/dev/fd"))',
  // `/`, and the root-level compatibility symlinks, are traversed by every
  // path lookup; listing `/` exposes only top-level names.
  '(allow file-read* (literal "/"))',
  '(allow file-read-metadata (literal "/etc") (literal "/tmp") (literal "/var") (literal "/private") (literal "/private/var"))',
];

interface RenderedProfile {
  profile: string;
  params: string[];
}

/**
 * Renders the policy as SBPL. Every path is passed out of band as a `-D`
 * parameter and referenced with `(param "…")`, so no path text is ever
 * spliced into the profile source.
 */
export function renderSeatbeltProfile(policy: SandboxPolicy): RenderedProfile {
  const params: string[] = [];
  const lines = [...BASE_PROFILE];
  let counter = 0;
  const param = (value: string): string => {
    const key = `P${counter}`;
    counter += 1;
    params.push('-D', `${key}=${value}`);
    return `(param "${key}")`;
  };
  const filter = (path: string, scope: 'subtree' | 'file') => `(${scope === 'file' ? 'literal' : 'subpath'} ${param(path)})`;

  // Directory metadata for every ancestor of an allowed path, so realpath()
  // and module resolution can traverse into the allowed islands. Metadata
  // only: no listing, no file contents.
  const ancestors = new Set<string>();
  for (const rule of policy.filesystem.rules) {
    if (rule.action === 'read' || rule.action === 'write') {
      for (const ancestor of ancestorsOf(rule.path)) ancestors.add(ancestor);
    }
  }
  ancestors.delete('/');
  if (ancestors.size > 0) {
    lines.push(`(allow file-read-metadata ${[...ancestors].sort().map((path) => `(literal ${param(path)})`).join(' ')})`);
  }

  for (const rule of policy.filesystem.rules) {
    const target = filter(rule.path, rule.scope);
    switch (rule.action) {
      case 'read':
        lines.push(`(allow file-read* ${target})`);
        break;
      case 'write':
        lines.push(`(allow file-read* file-write* ${target})`);
        break;
      case 'deny':
        lines.push(`(deny file-read* file-write* ${target})`);
        break;
      case 'protect':
        // `file-write*` covers create, unlink (so rename-away), mode and
        // xattr changes of the protected path itself and its subtree.
        lines.push(`(deny file-write* ${target})`);
        break;
    }
  }

  const network = policy.network;
  if (network.mode === 'proxy' && network.proxy?.kind === 'tcp') {
    lines.push(`(allow network-outbound (remote ip "localhost:${network.proxy.port}"))`);
  }
  if (network.listenPort !== null) {
    lines.push(`(allow network-bind (local ip "localhost:${network.listenPort}"))`);
    lines.push(`(allow network-inbound (local ip "localhost:${network.listenPort}"))`);
  }
  return { profile: `${lines.join('\n')}\n`, params };
}

export class MacSeatbeltProvider implements SandboxProvider {
  readonly id = 'macos-seatbelt' as const;
  readonly proxyTransport = 'tcp' as const;
  readonly unsupportedLimits = [
    'limits.cpu',
    'limits.memory',
    'limits.disk',
    'limits.processes',
    'process.reapDescendantsOnParentDeath',
    'network.loopbackForAgentTests',
  ] as const;

  async detect(): Promise<ProviderDetection> {
    if (process.platform !== 'darwin') {
      return { ok: false, version: null, blockers: ['macOS Seatbelt is only available on darwin'], warnings: [] };
    }
    if (!existsSync(SANDBOX_EXEC_PATH)) {
      return { ok: false, version: null, blockers: [`${SANDBOX_EXEC_PATH} is missing`], warnings: [] };
    }
    try {
      accessSync(SANDBOX_EXEC_PATH, constants.X_OK);
    } catch {
      return { ok: false, version: null, blockers: [`${SANDBOX_EXEC_PATH} is not executable`], warnings: [] };
    }
    return { ok: true, version: `seatbelt darwin-${release()}`, blockers: [], warnings: [] };
  }

  async preflight(): Promise<CapabilityReport> {
    return runCanaryPreflight(this);
  }

  async wrap(spec: SpawnSpec, policy: SandboxPolicy): Promise<WrappedSpawn> {
    validatePolicy(policy);
    if (policy.network.mode === 'proxy' && policy.network.proxy?.kind !== 'tcp') {
      throw new Error('[sandbox] macOS egress proxy must be a loopback TCP endpoint');
    }
    const { profile, params } = renderSeatbeltProfile(policy);
    return {
      command: SANDBOX_EXEC_PATH,
      args: ['-p', profile, ...params, '--', spec.command, ...spec.args],
      cwd: spec.cwd,
      env: { ...policy.env },
      extraFds: [],
      release: () => undefined,
    };
  }
}
