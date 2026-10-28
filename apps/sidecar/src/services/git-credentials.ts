import type { ExecFileOptions } from 'node:child_process';
import type { ExecutionGitCredential, ExecutionGitCredentialEffect } from '@openlinear/api-client';
import { logger } from '../lib/logger';
import { execFileAsync, type ExecFileResult } from './execution/exec';
import {
  assertSafeRepositoryConfig,
  buildHardenedGitEnv,
  GIT_HARDENING_CONFIG_ARGS,
  GIT_HARDENING_ENV,
  gitWorkingDirectory,
} from '../sandbox/git-hardening';

// ---------------------------------------------------------------------------
// W10a: effect-specific credential acquisition
//
// The sidecar asks the control plane for a credential right before each git
// network operation — `fetch` before clone/fetch, `push` before ls-remote +
// push, `pull_request` before the PR API — and keeps it in memory for that
// operation only. It is never journaled, logged, written to disk or passed to
// an agent process; only its kind/effect/expiry are logged.
// ---------------------------------------------------------------------------

export type GitCredentialEffect = ExecutionGitCredentialEffect;

/** The part of the attempt client the acquisition needs (lets tests stub it). */
export interface GitCredentialSource {
  gitCredential(effect: GitCredentialEffect): Promise<ExecutionGitCredential>;
}

/**
 * Fetch the credential for one effect and return the token (memory only).
 * Logs which kind was issued — `installation` (repo-scoped GitHub App token),
 * `user_oauth` (policy-allowed fallback) or `none` — never the value.
 */
export async function acquireGitCredential(
  source: GitCredentialSource,
  effect: GitCredentialEffect,
  context: { attemptId: string | null },
): Promise<string | null> {
  const issued = await source.gitCredential(effect);
  // Pre-W10a control planes answered `{ provider, token, purpose, notAfter }`.
  const kind = typeof issued.kind === 'string' ? issued.kind : issued.token ? 'user_oauth' : 'none';
  const notAfter = typeof issued.notAfter === 'string' ? Date.parse(issued.notAfter) : Number.NaN;
  if (issued.token && Number.isFinite(notAfter) && notAfter <= Date.now()) {
    throw new GitCredentialError(`[Sidecar] The ${effect} credential issued by the control plane is already expired`);
  }
  logger.info({
    attemptId: context.attemptId,
    effect,
    credentialKind: kind,
    expiresAt: issued.expiresAt ?? null,
    grantId: issued.grantId ?? null,
    fallbackReason: issued.fallbackReason ?? null,
  }, `[git-credential] ${effect} credential acquired (${kind})`);
  return issued.token ?? null;
}

// ---------------------------------------------------------------------------
// W10a: credential-helper-free HTTPS authentication
//
// The token obtained from the control plane for one git effect is handed to
// the ONE git process that needs it as an ephemeral, URL-scoped HTTP header,
// through git's documented environment config interface:
//
//   GIT_CONFIG_COUNT=1
//   GIT_CONFIG_KEY_0=http.<remote URL>.extraHeader
//   GIT_CONFIG_VALUE_0=Authorization: Basic base64(x-access-token:<token>)
//
// - No disk: no credential store/helper file, nothing under TMPDIR, nothing
//   written to the repository's or the mirror's git config.
// - No argv: `ps` shows only the hardened `-c` flags and the git command.
// - Scoped: git matches `http.<url>.*` against the remote URL, so the header
//   goes only to the attempt's repository URL on the allowlisted host (curl
//   drops a custom Authorization header on a cross-host redirect).
// - Not readable by agents: this git runs in the sidecar, outside the
//   sandbox; the macOS profile denies process-info on host processes and the
//   Linux sandbox has its own PID namespace (sandbox/macos-seatbelt.ts,
//   linux-bwrap.ts), so a sandboxed agent cannot read this process's
//   environment. Agent processes get an allowlisted env that never contains
//   it (sandbox/env.ts).
// - Short-lived: the env object exists for the duration of one git call; the
//   token itself is an installation token that expires within an hour and is
//   revoked when the attempt closes (or the policy-allowed OAuth fallback).
//
// Requires git >= 2.31 (GIT_CONFIG_COUNT); older git is refused with a clear
// error instead of failing authentication obscurely.
// ---------------------------------------------------------------------------

/** git first supporting GIT_CONFIG_COUNT/KEY/VALUE. */
export const MIN_GIT_VERSION_FOR_HEADER_AUTH: readonly [number, number] = [2, 31];

/** Characters a token may contain before it is placed in an HTTP header (no CR/LF/colon/space injection). */
const HEADER_SAFE_TOKEN = /^[A-Za-z0-9_.~+/=-]{1,4096}$/;

export class GitCredentialError extends Error {
  readonly code = 'GIT_CREDENTIAL_UNUSABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'GitCredentialError';
  }
}

/**
 * The URL prefix the header is scoped to: scheme, host[:port] and repository
 * path of an http(s) remote, without userinfo, query or fragment. Null for
 * anything else (file:// test remotes need no credential; other schemes are
 * refused by assertSafeCloneUrl before they get here).
 */
export function credentialScopeUrl(remoteUrl: string | undefined): string | null {
  if (!remoteUrl) return null;
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/' || /[\r\n\s]/.test(path)) return null;
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Environment entries that authenticate exactly one git process against
 * `remoteUrl`. Empty when there is no token or no http(s) remote.
 */
export function createGitCredentialEnv(accessToken: string | null, remoteUrl?: string): Record<string, string> {
  if (!accessToken) return {};
  if (!HEADER_SAFE_TOKEN.test(accessToken)) {
    throw new GitCredentialError('[Sidecar] Refusing a git credential with characters that are unsafe in an HTTP header');
  }
  const scope = credentialScopeUrl(remoteUrl);
  if (!scope) return {};
  const basic = Buffer.from(`x-access-token:${accessToken}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${scope}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

let gitVersionCheck: Promise<void> | null = null;

export function parseGitVersion(output: string): [number, number] | null {
  const match = /git version (\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** Refuses (once per process, cached) a git too old for header authentication. */
async function assertGitSupportsHeaderAuth(): Promise<void> {
  gitVersionCheck ??= (async () => {
    const { stdout } = await execFileAsync('git', ['--version'], { env: buildHardenedGitEnv(undefined) });
    const version = parseGitVersion(stdout);
    const [major, minor] = MIN_GIT_VERSION_FOR_HEADER_AUTH;
    if (!version || version[0] < major || (version[0] === major && version[1] < minor)) {
      throw new GitCredentialError(
        `[Sidecar] git ${major}.${minor} or newer is required for isolated repository credentials (found ${stdout.trim() || 'unknown'})`,
      );
    }
  })();
  try {
    await gitVersionCheck;
  } catch (error) {
    gitVersionCheck = null;
    throw error;
  }
}

/** Tests only: forget the cached git version check. */
export function resetGitVersionCheckForTests(): void {
  gitVersionCheck = null;
}

// ---------------------------------------------------------------------------
// Git argument & environment hardening (C6a F6/F7)
//
// Everything below is shared by every `git` invocation in `execution/git.ts`
// and `worktree.ts` so the hardening can't be forgotten at a new call site.
// ---------------------------------------------------------------------------

/**
 * Environment applied last to every git subprocess (W09a; see
 * sandbox/git-hardening.ts for the rationale of each entry): system and
 * global config off, a private empty HOME, no prompts, harmless
 * askpass/editor/pager programs, replace refs ignored. The rest of the child
 * environment is an explicit allowlist — a call site's `env` may only
 * contribute GIT_AUTHOR_* / GIT_COMMITTER_* identity variables.
 */
export const HARDENED_GIT_ENV: NodeJS.ProcessEnv = { ...GIT_HARDENING_ENV };

/**
 * `-c` overrides applied ahead of every git subcommand: hooks off
 * (core.hooksPath=/dev/null, C6a F3), fsmonitor/pager/editor/ssh/gpg/
 * alternate-refs programs neutralised, inherited credential helpers reset,
 * external diff off, submodule recursion off, and only the https transport
 * allowed (C6a F6).
 */
function hardenedConfigArgs(): string[] {
  const args = [
    ...GIT_HARDENING_CONFIG_ARGS,
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
  ];
  if (process.env.NODE_ENV === 'test' && process.env.OPENLINEAR_ALLOW_FILE_GIT === '1') {
    args.push('-c', 'protocol.file.allow=always');
  }
  return args;
}

export function buildHardenedGitArgs(args: ReadonlyArray<string>): string[] {
  return [...hardenedConfigArgs(), ...args];
}

function mergeHardenedEnv(options: ExecFileOptions): ExecFileOptions {
  return {
    ...options,
    env: buildHardenedGitEnv(options.env),
  };
}

/**
 * Refuses to run when the repository named by a leading `-C <dir>` carries
 * repository-local config outside the allowlist (planted filters, drivers,
 * helpers, includes, URL rewrites, …). See assertSafeRepositoryConfig.
 */
async function assertRepositoryConfig(args: ReadonlyArray<string>, options: ExecFileOptions): Promise<void> {
  const dir = gitWorkingDirectory(args);
  if (!dir) return;
  await assertSafeRepositoryConfig(
    dir,
    (scanArgs, scanEnv) => execFileAsync('git', scanArgs, { env: scanEnv }),
    buildHardenedGitEnv(options.env),
  );
}

/** Hardened `execFileAsync('git', ...)` for call sites with no credentials to inject. */
export async function execGit(
  args: ReadonlyArray<string>,
  options: ExecFileOptions = {},
): Promise<ExecFileResult> {
  await assertRepositoryConfig(args, options);
  return execFileAsync('git', buildHardenedGitArgs(args), mergeHardenedEnv(options));
}

/**
 * Hardened git with the attempt's credential for one network operation
 * (W10a): the token travels only in this child's environment as a header
 * scoped to `remoteUrl` (see createGitCredentialEnv) — never argv, disk or
 * repository config.
 */
export async function execGitWithCredentials(
  args: ReadonlyArray<string>,
  accessToken: string | null,
  remoteUrl?: string,
  options: ExecFileOptions = {},
): Promise<ExecFileResult> {
  await assertRepositoryConfig(args, options);
  const credentialEnv = createGitCredentialEnv(accessToken, remoteUrl);
  if (Object.keys(credentialEnv).length > 0) await assertGitSupportsHeaderAuth();
  return execFileAsync('git', buildHardenedGitArgs(args), {
    ...options,
    env: buildHardenedGitEnv(options.env, process.env, credentialEnv),
  });
}

// ---------------------------------------------------------------------------
// Ref name / clone URL validation (C6a F6/F7)
// ---------------------------------------------------------------------------

const SAFE_REF_NAME_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Rejects anything that isn't unambiguously a git ref name: no leading `-`
 * (which git would parse as an option in a positional slot), no leading or
 * trailing `/`/`.`, no `..` traversal segment, and nothing outside
 * `[A-Za-z0-9._/-]` (which also excludes whitespace and control characters).
 */
export function assertSafeRefName(ref: unknown, description = 'ref name'): string {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error(`[Sidecar] Refusing unsafe ${description}: empty`);
  }

  if (
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.startsWith('.') ||
    ref.endsWith('.') ||
    ref.includes('..') ||
    !SAFE_REF_NAME_RE.test(ref)
  ) {
    throw new Error(`[Sidecar] Refusing unsafe ${description}: ${JSON.stringify(ref)}`);
  }

  return ref;
}

/**
 * Requires an `https:` URL on an allowlisted host (GitHub.com by default, or
 * `GITHUB_HOST` for GitHub Enterprise). Blocks `ext::`, `file://`, `ssh://`,
 * and arbitrary hosts from ever reaching `git clone`/`git push` — see C6a F6.
 */
export function assertSafeCloneUrl(url: unknown, description = 'clone URL'): string {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`[Sidecar] Refusing unsafe ${description}: empty`);
  }

  if (process.env.NODE_ENV === 'test' && process.env.OPENLINEAR_ALLOW_FILE_GIT === '1') {
    if (url.startsWith('file://') || url.startsWith('/')) return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[Sidecar] Refusing unsafe ${description}: not a valid URL`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`[Sidecar] Refusing unsafe ${description}: only https: URLs are allowed`);
  }

  const allowedHost = process.env.GITHUB_HOST || 'github.com';
  if (parsed.hostname.toLowerCase() !== allowedHost.toLowerCase()) {
    throw new Error(`[Sidecar] Refusing unsafe ${description}: host must be ${allowedHost}`);
  }

  return url;
}
