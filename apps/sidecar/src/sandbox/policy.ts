import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SandboxPolicyError } from './errors';
import {
  assertSafeSandboxPath,
  collapseNested,
  isWithin,
  realpathOrResolve,
  resolveGitMetadata,
  type GitMetadata,
} from './paths';
import type { FsRule, NetworkPolicy, SandboxPolicy } from './types';

/**
 * System locations that are readable inside the sandbox on each platform.
 * Everything else — HOME, other users, /Volumes, temp dirs, the sidecar's own
 * state — is denied by default. Listed explicitly so the profile is a
 * positive allowlist rather than "read everything except".
 */
export function systemReadRoots(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/usr',
      '/bin',
      '/sbin',
      '/System',
      '/Library/Apple',
      '/Library/Developer',
      '/Library/Frameworks',
      '/private/etc',
      '/private/var/select',
      '/private/var/db/timezone',
      '/Applications/Xcode.app',
      '/opt/homebrew',
    ].filter((path) => existsSync(path));
  }
  return ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'].filter((path) => existsSync(path));
}

/** Individual system files (Linux binds selected /etc entries, not all of /etc). */
export function systemReadFiles(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/dtracehelper'];
  }
  return [
    '/etc/passwd',
    '/etc/group',
    '/etc/nsswitch.conf',
    '/etc/hosts',
    '/etc/host.conf',
    '/etc/localtime',
    '/etc/timezone',
    '/etc/ld.so.cache',
    '/etc/ld.so.conf',
    '/etc/ld.so.conf.d',
    '/etc/ssl',
    '/etc/ca-certificates',
    '/etc/pki',
    '/etc/alternatives',
    '/etc/os-release',
    '/etc/protocols',
    '/etc/services',
    '/etc/gai.conf',
    '/etc/shells',
    '/etc/mime.types',
  ].filter((path) => existsSync(path));
}

/** Readable system areas that hold other programs' data, hidden again. */
function systemHiddenPaths(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return ['/opt/homebrew/var', '/usr/local/var', '/Library/Keychains', '/private/var/db/sudo'];
  }
  return [];
}

/**
 * Credential stores, shell history, browser profiles and sidecar/OpenCode
 * state under HOME. Applied as the final rules, so they stay denied even when
 * an allowed root (a toolchain prefix, a local project placed in HOME)
 * overlaps them.
 */
export function mandatoryDeniedPaths(home: string, platform: NodeJS.Platform): string[] {
  const rel = [
    '.ssh',
    '.aws',
    '.azure',
    '.gnupg',
    '.netrc',
    '.git-credentials',
    '.gitconfig',
    '.config/git',
    '.config/gh',
    '.config/gcloud',
    '.config/op',
    '.config/hub',
    '.config/opencode',
    '.config/openlinear',
    '.kube',
    '.docker',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.pypirc',
    '.pgpass',
    '.my.cnf',
    '.gem/credentials',
    '.cargo/credentials',
    '.cargo/credentials.toml',
    '.terraform.d/credentials.tfrc.json',
    '.local/share/opencode',
    '.local/state/opencode',
    '.codex',
    '.claude',
    '.zsh_history',
    '.bash_history',
  ];
  if (platform === 'darwin') {
    rel.push(
      'Library/Keychains',
      'Library/Cookies',
      'Library/Safari',
      'Library/Mail',
      'Library/Messages',
      'Library/Application Support/Google/Chrome',
      'Library/Application Support/Firefox',
      'Library/Application Support/BraveSoftware',
      'Library/Application Support/Microsoft Edge',
      'Library/Application Support/Arc',
      'Library/Application Support/com.apple.TCC',
      'Library/Application Support/opencode',
    );
  } else {
    rel.push('.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.pki', '.password-store');
  }
  return rel.map((entry) => join(home, entry));
}

/**
 * Default locations of the sidecar's own state (repos, journal, app data,
 * desktop install). These are denied early — before the attempt's own
 * worktree, Git metadata and private root (which usually live inside them)
 * are re-opened — so a sibling attempt's checkout or the journal is never
 * readable. Callers add REPOS_DIR / OPENLINEAR_APP_DATA overrides.
 */
export function sidecarStateRoots(home: string, platform: NodeJS.Platform): string[] {
  const roots = [join(home, '.openlinear'), join(home, '.local', 'share', 'openlinear')];
  if (platform === 'darwin') roots.push(join(home, 'Library', 'Application Support', 'OpenLinear'));
  return roots;
}

export interface AttemptPolicyInput {
  attemptKey: string;
  platform: NodeJS.Platform;
  /** The attempt's worktree (the only writable project directory). */
  worktree: string;
  /** Private per-attempt HOME/TMP/XDG root. */
  attemptRoot: string;
  /** The real user home (anchor for the mandatory denies). */
  home: string;
  /** Toolchain roots resolved from PATH plus explicit extras. */
  toolchainRoots: readonly string[];
  /** Extra individual readable files (e.g. a models catalogue). */
  readOnlyFiles?: readonly string[];
  /**
   * Roots Git metadata may live in (the repos dir and the worktree itself). A
   * gitdir/common dir resolved outside them is not made readable.
   */
  trustedGitRoots: readonly string[];
  /** Sidecar-owned roots that stay hidden except for this attempt's paths. */
  denyRoots: readonly string[];
  network: NetworkPolicy;
  env: Record<string, string>;
}

export interface AttemptPolicyResult {
  policy: SandboxPolicy;
  git: GitMetadata;
  warnings: string[];
}

const pathSchema = z.string().min(1).refine((value) => value.startsWith('/'), 'absolute path required');

const policySchema = z.object({
  schemaVersion: z.literal(1),
  attemptKey: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  cwd: pathSchema,
  filesystem: z.object({
    rules: z.array(z.object({
      action: z.enum(['read', 'write', 'deny', 'protect']),
      path: pathSchema,
      scope: z.enum(['subtree', 'file']),
    })).min(1),
  }),
  network: z.object({
    mode: z.enum(['none', 'proxy']),
    proxy: z.union([
      z.object({ kind: z.literal('tcp'), host: z.literal('127.0.0.1'), port: z.number().int().min(1).max(65535) }),
      z.object({ kind: z.literal('unix'), path: pathSchema, innerPort: z.number().int().min(1).max(65535) }),
    ]).nullable(),
    listenPort: z.number().int().min(1).max(65535).nullable(),
    controlSocketPath: pathSchema.nullable(),
    allowedHosts: z.array(z.string()),
  }),
  env: z.record(z.string(), z.string()),
});

/** Writable roots may never be `/`, HOME, or an ancestor of HOME. */
function assertWritableRoot(root: string, home: string): void {
  if (root === '/' || isWithin(home, root)) {
    throw new SandboxPolicyError(`[sandbox] refusing to make ${root} writable: it contains the user's home directory`);
  }
}

export function validatePolicy(policy: SandboxPolicy): SandboxPolicy {
  const parsed = policySchema.safeParse(policy);
  if (!parsed.success) {
    throw new SandboxPolicyError(`[sandbox] invalid policy: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  for (const rule of policy.filesystem.rules) assertSafeSandboxPath(rule.path, `filesystem rule ${rule.action}`);
  const writable = policy.filesystem.rules.filter((rule) => rule.action === 'write');
  if (writable.length === 0) throw new SandboxPolicyError('[sandbox] policy has no writable root');
  if (policy.network.mode === 'proxy' && !policy.network.proxy) {
    throw new SandboxPolicyError('[sandbox] proxy network mode requires a proxy endpoint');
  }
  if (policy.network.mode === 'none' && policy.network.proxy) {
    throw new SandboxPolicyError('[sandbox] network mode none must not carry a proxy endpoint');
  }
  return policy;
}

/**
 * Builds the immutable policy for one attempt as an ordered rule list:
 *
 *  1. read: system + toolchain roots, selected files
 *  2. deny: other programs' data in those roots, and the sidecar roots
 *     (repos dir, app data) that would otherwise be reachable
 *  3. read: this attempt's Git common dir; deny: the shared worktrees admin
 *     dir; read: this attempt's own gitdir
 *  4. write: the worktree and the attempt's private HOME/TMP/XDG root
 *  5. protect: `<worktree>/.git` and the resolved Git metadata
 *  6. deny: credential stores / shell history / browser profiles (last)
 */
export function buildAttemptPolicy(input: AttemptPolicyInput): AttemptPolicyResult {
  const warnings: string[] = [];
  const home = realpathOrResolve(input.home);
  const worktree = realpathOrResolve(input.worktree);
  const attemptRoot = realpathOrResolve(input.attemptRoot);
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) {
    throw new SandboxPolicyError('[sandbox] worktree does not exist');
  }
  if (!existsSync(attemptRoot) || !statSync(attemptRoot).isDirectory()) {
    throw new SandboxPolicyError('[sandbox] attempt root does not exist');
  }
  assertWritableRoot(worktree, home);
  assertWritableRoot(attemptRoot, home);
  if (isWithin(attemptRoot, worktree) || isWithin(worktree, attemptRoot)) {
    throw new SandboxPolicyError('[sandbox] attempt root and worktree must be disjoint');
  }

  const rules: FsRule[] = [];
  const read = (path: string, scope: FsRule['scope'] = 'subtree') => rules.push({ action: 'read', path, scope });
  const deny = (path: string) => rules.push({ action: 'deny', path, scope: 'subtree' });

  for (const root of collapseNested([...systemReadRoots(input.platform), ...input.toolchainRoots.map(realpathOrResolve)])) read(root);
  for (const file of systemReadFiles(input.platform)) read(file, 'file');
  for (const file of input.readOnlyFiles ?? []) read(realpathOrResolve(file), 'file');
  for (const hidden of systemHiddenPaths(input.platform)) deny(hidden);
  for (const root of input.denyRoots) deny(realpathOrResolve(root));

  const git = resolveGitMetadata(worktree);
  const trustedRoots = input.trustedGitRoots.map(realpathOrResolve);
  const isTrusted = (path: string | null): path is string => path !== null && trustedRoots.some((root) => isWithin(path, root));
  if (git.dotGitKind === 'file') {
    if (isTrusted(git.gitDir) && isTrusted(git.commonDir)) {
      read(git.commonDir);
      const adminDir = join(git.commonDir, 'worktrees');
      if (isWithin(git.gitDir, adminDir) && git.gitDir !== adminDir) deny(adminDir);
      read(git.gitDir);
    } else {
      warnings.push('git metadata resolves outside trusted roots; it is not readable inside the sandbox');
    }
  } else if (git.dotGitKind === 'symlink') {
    warnings.push('worktree .git is a symlink; it is protected but not followed');
  }

  rules.push({ action: 'write', path: worktree, scope: 'subtree' });
  rules.push({ action: 'write', path: attemptRoot, scope: 'subtree' });

  const protectedPaths = new Set<string>();
  if (git.dotGit) protectedPaths.add(git.dotGit);
  if (git.dotGitKind !== 'symlink') {
    if (git.gitDir) protectedPaths.add(git.gitDir);
    if (git.commonDir) protectedPaths.add(git.commonDir);
  }
  for (const path of protectedPaths) {
    rules.push({ action: 'protect', path, scope: git.dotGit === path && git.dotGitKind !== 'dir' ? 'file' : 'subtree' });
  }

  for (const path of mandatoryDeniedPaths(home, input.platform)) {
    if (isWithin(worktree, path) || isWithin(attemptRoot, path)) {
      throw new SandboxPolicyError('[sandbox] a writable root lies inside a credential store');
    }
    deny(path);
  }

  const policy: SandboxPolicy = {
    schemaVersion: 1,
    attemptKey: input.attemptKey,
    cwd: worktree,
    filesystem: { rules },
    network: input.network,
    env: input.env,
  };
  return { policy: validatePolicy(policy), git, warnings };
}

/** Paths the policy lets the process write (for reports and tests). */
export function writableRootsOf(policy: SandboxPolicy): string[] {
  return policy.filesystem.rules.filter((rule) => rule.action === 'write').map((rule) => rule.path);
}

/**
 * Stable digest of the enforcement-relevant policy. Env *names* are included,
 * env values are not (they carry the attempt's provider credential). Ports
 * and socket paths are per-launch and excluded.
 */
export function policyHash(policy: SandboxPolicy): string {
  const canonical = JSON.stringify({
    schemaVersion: policy.schemaVersion,
    cwd: policy.cwd,
    rules: policy.filesystem.rules,
    network: {
      mode: policy.network.mode,
      proxy: policy.network.proxy?.kind ?? null,
      listen: policy.network.listenPort !== null,
      allowedHosts: [...policy.network.allowedHosts].sort(),
    },
    envKeys: Object.keys(policy.env).sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
