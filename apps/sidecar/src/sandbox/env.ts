/**
 * Environment allowlists for every child process the sidecar starts on behalf
 * of an agent or for Git. The rule is the same everywhere: start from nothing,
 * copy only named, non-secret variables, then add explicit values. The
 * sidecar's own environment (DATABASE_URL, JWT_SECRET, TOKEN_ENCRYPTION_KEY,
 * GITHUB_TOKEN, provider keys, …) is never spread into a child.
 */

/** Locale/terminal/identity variables that are safe to pass to any child. */
const BASE_EXACT = new Set([
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'USER',
  'LOGNAME',
  'NO_COLOR',
]);
const BASE_PREFIXES = ['LC_'];

/** Windows process essentials (never populated with secrets). */
const WINDOWS_EXACT = new Set([
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'SystemDrive',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
]);

/** Outbound proxy configuration chosen by the user for the sidecar. */
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

/** Custom CA bundles (paths, not secrets) for corporate TLS interception. */
export const CA_ENV_KEYS = [
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
] as const;

/**
 * Names that look like credentials. Used as a second line of defence: even an
 * allowlisted prefix (e.g. `LC_`) never carries one of these into a child
 * unless the caller injects it explicitly.
 */
const SECRET_NAME_RE = /(SECRET|TOKEN|PASSW(OR)?D|PASSPHRASE|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|SESSION|COOKIE|DATABASE_URL|DSN|AUTH)/i;

export function isSecretLikeEnvName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

function copyAllowed(
  source: NodeJS.ProcessEnv,
  target: Record<string, string>,
  exact: ReadonlySet<string>,
  prefixes: readonly string[] = [],
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!exact.has(key) && !prefixes.some((prefix) => key.startsWith(prefix))) continue;
    if (isSecretLikeEnvName(key)) continue;
    target[key] = value;
  }
}

/** Locale/terminal basics (+ Windows essentials) from `source`. */
export function pickBaseEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  copyAllowed(source, env, BASE_EXACT, BASE_PREFIXES);
  copyAllowed(source, env, WINDOWS_EXACT);
  return env;
}

function pickNamed(source: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Environment for a host-side runner CLI that manages its own sandbox (Codex):
 * locale, PATH/HOME/SHELL/TMPDIR, the user's proxy/CA settings and the
 * runner's own home override. Credentials are added by the caller explicitly.
 */
export function buildRunnerProcessEnv(
  source: NodeJS.ProcessEnv,
  explicit: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    ...pickBaseEnv(source),
    ...pickNamed(source, ['PATH', 'HOME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']),
    ...pickNamed(source, PROXY_ENV_KEYS),
    ...pickNamed(source, CA_ENV_KEYS),
    ...pickNamed(source, ['CODEX_HOME', 'OPENAI_BASE_URL']),
  };
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface SandboxAgentEnvInput {
  source: NodeJS.ProcessEnv;
  /** Already filtered to directories readable inside the sandbox. */
  path: string;
  home: string;
  tmp: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgStateHome: string;
  xdgCacheHome: string;
  /** `http://127.0.0.1:<port>` when egress goes through the per-attempt proxy. */
  proxyUrl: string | null;
  /**
   * Hosts that bypass the proxy. Linux sets loopback (the private netns has
   * its own loopback for agent test servers); macOS sets none, because direct
   * loopback is denied there and must go through the proxy.
   */
  noProxy?: string | null;
  shell: string;
  /** Explicit, reviewed additions (OpenCode config, server password, …). */
  explicit?: Readonly<Record<string, string | undefined>>;
}

/**
 * Environment of the sandboxed agent process. HOME/TMPDIR/XDG point at the
 * attempt's private directories, proxy variables point at the attempt's
 * egress proxy, and nothing else from the sidecar leaks through.
 */
export function buildSandboxAgentEnv(input: SandboxAgentEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    ...pickBaseEnv(input.source),
    PATH: input.path,
    HOME: input.home,
    TMPDIR: input.tmp,
    TMP: input.tmp,
    TEMP: input.tmp,
    XDG_CONFIG_HOME: input.xdgConfigHome,
    XDG_DATA_HOME: input.xdgDataHome,
    XDG_STATE_HOME: input.xdgStateHome,
    XDG_CACHE_HOME: input.xdgCacheHome,
    SHELL: input.shell,
    // Informational only; a child can overwrite it, so it proves nothing.
    OPENLINEAR_SANDBOX: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  if (input.proxyUrl) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      env[key] = input.proxyUrl;
    }
    if (input.noProxy) {
      env.NO_PROXY = input.noProxy;
      env.no_proxy = input.noProxy;
    }
  }
  for (const [key, value] of Object.entries(input.explicit ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Git identity variables a caller may pass for commits/merges. */
const GIT_IDENTITY_KEYS = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

/**
 * Environment for the sidecar's own `git` invocations. `source` supplies
 * PATH/locale/proxy/CA settings; `requested` (the call site's `env` option)
 * may only contribute identity variables. Everything else a call site passes
 * — including a spread of `process.env` — is dropped here, centrally.
 */
export function buildGitProcessEnv(
  source: NodeJS.ProcessEnv,
  requested: NodeJS.ProcessEnv | undefined,
  hardened: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {
    ...pickBaseEnv(source),
    ...pickNamed(source, ['PATH', 'TMPDIR', 'TMP', 'TEMP']),
    ...pickNamed(source, PROXY_ENV_KEYS),
    ...pickNamed(source, CA_ENV_KEYS),
    ...pickNamed(source, ['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH']),
  };
  for (const [key, value] of Object.entries(requested ?? {})) {
    if (value !== undefined && GIT_IDENTITY_KEYS.has(key)) env[key] = value;
  }
  return { ...env, ...hardened };
}
