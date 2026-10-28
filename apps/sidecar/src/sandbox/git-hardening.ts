import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitProcessEnv } from './env';

/**
 * Hardening for the git processes the sidecar itself runs (status, add,
 * commit, merge, fetch, push) inside worktrees an agent controlled.
 *
 * Git has no switch that ignores repository-local configuration, and many
 * local keys name commands git will run (fsmonitor, filters, diff/merge
 * drivers, credential helpers, ssh/askpass/gpg programs, …). Three layers:
 *
 * 1. Environment: system and global config disabled, HOME/XDG_CONFIG_HOME a
 *    private empty directory, no inherited GIT_* redirection variables, no
 *    sidecar secrets (explicit allowlist, see env.ts), harmless editor,
 *    pager and askpass programs, replace refs ignored.
 * 2. Command-line `-c` overrides (highest precedence) for every
 *    fixed-name key that executes a program or recurses with credentials,
 *    plus a reset of inherited credential helpers.
 * 3. A pre-flight scan of the effective local/worktree config that refuses
 *    to run git when any key outside a small allowlist is present. This is
 *    what covers driver-style keys whose names the agent chooses
 *    (`filter.<x>.*`, `diff.<x>.textconv`, `merge.<x>.driver`,
 *    `credential.<url>.helper`, `http.<url>.*`, `include*`, `url.*`, …),
 *    since no `-c` value can out-rank a more specific URL match or an
 *    arbitrary driver name.
 */

const TRUE_BINARY = existsSync('/usr/bin/true') ? '/usr/bin/true' : 'true';
const FALSE_BINARY = existsSync('/usr/bin/false') ? '/usr/bin/false' : 'false';

/** Environment overrides applied last to every sidecar git process. */
export const GIT_HARDENING_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: TRUE_BINARY,
  SSH_ASKPASS: TRUE_BINARY,
  GIT_EDITOR: TRUE_BINARY,
  GIT_SEQUENCE_EDITOR: TRUE_BINARY,
  EDITOR: TRUE_BINARY,
  VISUAL: TRUE_BINARY,
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_PROTOCOL_FROM_USER: '0',
};

/**
 * `-c` overrides that neutralise fixed-name keys which run programs or
 * recurse into submodules with credentials. Ordered so that the credential
 * helper reset precedes any helper the caller appends.
 */
export const GIT_HARDENING_CONFIG_ARGS: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.pager=cat',
  '-c', `core.editor=${TRUE_BINARY}`,
  '-c', `sequence.editor=${TRUE_BINARY}`,
  '-c', `core.sshCommand=${FALSE_BINARY}`,
  '-c', 'core.alternateRefsCommand=',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.protectHFS=true',
  '-c', 'core.protectNTFS=true',
  '-c', 'credential.helper=',
  '-c', 'diff.external=',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
  '-c', 'push.gpgSign=false',
  '-c', 'log.showSignature=false',
  '-c', 'merge.verifySignatures=false',
  '-c', `gpg.program=${FALSE_BINARY}`,
  '-c', `gpg.ssh.program=${FALSE_BINARY}`,
  '-c', `gpg.x509.program=${FALSE_BINARY}`,
  '-c', 'gpg.ssh.defaultKeyCommand=',
  '-c', 'submodule.recurse=false',
  '-c', 'fetch.recurseSubmodules=false',
  '-c', 'push.recurseSubmodules=no',
];

let privateHome: string | null = null;

/** Empty, private HOME for git: no user attributes/ignores/credential stores. */
export function gitPrivateHome(): string {
  if (privateHome && existsSync(privateHome)) return privateHome;
  const created = stableGitHome() ?? mkdtempSync(join(tmpdir(), 'openlinear-git-home-'));
  privateHome = created;
  return created;
}

/**
 * One per-user directory reused across processes (nothing to leak). It is
 * trusted only if it is a real directory owned by this uid, mode 0700 and
 * empty; otherwise the caller falls back to a fresh mkdtemp directory.
 */
function stableGitHome(): string | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const path = join(tmpdir(), `openlinear-git-home-${uid ?? 'user'}`);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) return null;
  }
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if (uid !== null && st.uid !== uid) return null;
    if ((st.mode & 0o077) !== 0) return null;
    if (readdirSync(path).length > 0) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * Complete environment for a sidecar git process: allowlisted basics from the
 * sidecar env, identity variables from the call site (nothing else from it),
 * then the hardening overrides.
 */
export function buildHardenedGitEnv(
  requested: NodeJS.ProcessEnv | undefined,
  source: NodeJS.ProcessEnv = process.env,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const home = gitPrivateHome();
  return buildGitProcessEnv(source, requested, {
    ...GIT_HARDENING_ENV,
    HOME: home,
    XDG_CONFIG_HOME: home,
    ...extra,
  });
}

/** Repository-local keys the sidecar's own repositories legitimately carry. */
const ALLOWED_LOCAL_KEYS: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|sparsecheckout|sparsecheckoutcone|longpaths|quotepath|checkstat|trustctime|commitgraph|multipackindex|splitindex|preloadindex|fscache|protecthfs|protectntfs|abbrev|compression|loosecompression|bigfilethreshold|deltabasecachelimit|packedgitlimit|packedgitwindowsize)$/,
  /^extensions\.(worktreeconfig|objectformat|partialclone|refstorage|preciousobjects|noop)$/,
  /^remote\..+\.(url|fetch|tagopt|mirror|promisor|partialclonefilter|prune|prunetags|skipdefaultupdate|skipfetchall)$/,
  /^branch\..+\.(remote|merge|rebase|description)$/,
  /^user\.(name|email)$/,
  /^gc\.(auto|autodetach|autopacklimit|pruneexpire|worktreepruneexpire|reflogexpire|reflogexpireunreachable)$/,
  /^maintenance\.(auto|strategy)$/,
  /^fetch\.(prune|prunetags|writecommitgraph|showforcedupdates)$/,
  /^pull\.(rebase|ff)$/,
  /^push\.(default|autosetupremote|followtags)$/,
  /^init\.defaultbranch$/,
  /^index\.(version|threads|sparse|skiphash)$/,
  /^pack\.(threads|windowmemory|packsizelimit)$/,
  /^lfs\.repositoryformatversion$/,
  /^safe\.directory$/,
];

export class GitConfigPolicyError extends Error {
  readonly code = 'GIT_CONFIG_UNSAFE' as const;
  readonly keys: readonly string[];

  constructor(message: string, keys: readonly string[]) {
    super(message);
    this.name = 'GitConfigPolicyError';
    this.keys = keys;
  }
}

/** Parses `git config --list --show-scope -z` output into scope/key pairs. */
export function parseScopedConfigList(output: string): Array<{ scope: string; key: string }> {
  const fields = output.split('\0');
  const entries: Array<{ scope: string; key: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index];
    const keyAndValue = fields[index + 1];
    const newline = keyAndValue.indexOf('\n');
    entries.push({ scope, key: newline === -1 ? keyAndValue : keyAndValue.slice(0, newline) });
  }
  return entries;
}

/** Keys in repository scopes that are not on the allowlist (names only, no values). */
export function unsafeRepositoryKeys(entries: ReadonlyArray<{ scope: string; key: string }>): string[] {
  const offending = new Set<string>();
  for (const { scope, key } of entries) {
    if (scope !== 'local' && scope !== 'worktree') continue;
    const normalized = key.toLowerCase();
    if (!ALLOWED_LOCAL_KEYS.some((pattern) => pattern.test(normalized))) offending.add(key);
  }
  return [...offending].sort();
}

/** The `-C <dir>` a git argv operates in, if it starts with one. */
export function gitWorkingDirectory(args: readonly string[]): string | null {
  return args[0] === '-C' && typeof args[1] === 'string' ? args[1] : null;
}

export type GitRunner = (args: readonly string[], env: Record<string, string>) => Promise<{ stdout: string }>;

/**
 * Refuses to run git in `dir` when its effective local/worktree config holds
 * any non-allowlisted key. Reading config executes nothing. A directory that
 * does not exist is left to the real command to report.
 */
export async function assertSafeRepositoryConfig(dir: string, run: GitRunner, env: Record<string, string>): Promise<void> {
  try {
    if (!statSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  let stdout: string;
  try {
    ({ stdout } = await run([...GIT_HARDENING_CONFIG_ARGS, '-C', dir, 'config', '--list', '--show-scope', '-z'], env));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Outside a repository git lists only (disabled) global/system scopes and
    // still exits 0; any failure here means the config could not be read.
    throw new GitConfigPolicyError(`[git] refusing to run: repository config in ${dir} could not be verified (${message.split('\n')[0]})`, []);
  }
  const unsafe = unsafeRepositoryKeys(parseScopedConfigList(stdout));
  if (unsafe.length > 0) {
    throw new GitConfigPolicyError(
      `[git] refusing to run in ${dir}: repository config contains keys the sidecar does not allow (${unsafe.join(', ')})`,
      unsafe,
    );
  }
}
