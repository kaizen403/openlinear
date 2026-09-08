import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ExecFileOptions } from 'child_process';
import { execFileAsync, type ExecFileResult } from './execution/exec';

interface GitCredentialConfig {
  args: string[];
  cleanup: () => void;
}

function getCredentialUrl(accessToken: string, remoteUrl?: string): string {
  const encodedToken = encodeURIComponent(accessToken);

  if (remoteUrl) {
    try {
      const url = new URL(remoteUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        return `${url.protocol}//oauth2:${encodedToken}@${url.host}`;
      }
    } catch {
      // Fall through to GitHub, which is the only token-backed provider today.
    }
  }

  return `https://oauth2:${encodedToken}@github.com`;
}

export function createGitCredentialConfig(accessToken: string | null, remoteUrl?: string): GitCredentialConfig {
  if (!accessToken) {
    return { args: [], cleanup: () => undefined };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'openlinear-git-'));
  const credentialsFile = join(tempDir, 'credentials');
  writeFileSync(credentialsFile, `${getCredentialUrl(accessToken, remoteUrl)}\n`, { mode: 0o600 });

  return {
    args: ['-c', `credential.helper=store --file=${credentialsFile}`],
    cleanup: () => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Git argument & environment hardening (C6a F6/F7)
//
// Everything below is shared by every `git` invocation in `execution/git.ts`
// and `worktree.ts` so the hardening can't be forgotten at a new call site.
// ---------------------------------------------------------------------------

/**
 * Environment applied to every git subprocess:
 * - GIT_CONFIG_NOSYSTEM: ignore the machine-wide gitconfig, which this
 *   process doesn't control and which could otherwise change git's behavior
 *   (credential helpers, protocol allowlists, aliases) out from under us.
 * - GIT_TERMINAL_PROMPT: never let git block waiting for interactive input
 *   (a credential prompt) — fail fast instead.
 */
export const HARDENED_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * `-c` overrides applied ahead of every git subcommand:
 * - core.hooksPath=/dev/null: disable repo-supplied hooks outright (a cloned
 *   repo's .git/hooks should never execute) — see C6a F3.
 * - core.fsmonitor=: disable any configured fsmonitor hook.
 * - core.pager=cat: never spawn a pager (would hang waiting on a tty).
 * - protocol.allow=never / protocol.https.allow=always: only the https
 *   transport is permitted, closing off `ext::`, `file://`, and friends —
 *   see C6a F6.
 */
function hardenedConfigArgs(): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=',
    '-c', 'core.pager=cat',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
  ];
}

export function buildHardenedGitArgs(args: ReadonlyArray<string>): string[] {
  return [...hardenedConfigArgs(), ...args];
}

function mergeHardenedEnv(options: ExecFileOptions): ExecFileOptions {
  return {
    ...options,
    env: { ...(options.env ?? process.env), ...HARDENED_GIT_ENV },
  };
}

/** Hardened `execFileAsync('git', ...)` for call sites with no credentials to inject. */
export async function execGit(
  args: ReadonlyArray<string>,
  options: ExecFileOptions = {},
): Promise<ExecFileResult> {
  return execFileAsync('git', buildHardenedGitArgs(args), mergeHardenedEnv(options));
}

export async function execGitWithCredentials(
  args: ReadonlyArray<string>,
  accessToken: string | null,
  remoteUrl?: string,
  options: ExecFileOptions = {},
): Promise<ExecFileResult> {
  const credentials = createGitCredentialConfig(accessToken, remoteUrl);
  try {
    return await execFileAsync(
      'git',
      buildHardenedGitArgs([...credentials.args, ...args]),
      mergeHardenedEnv(options),
    );
  } finally {
    credentials.cleanup();
  }
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
