import { Script } from 'node:vm';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEgressAllowlist } from './egress-allowlist';
import { deniedAddressClass, EgressProxy, matchRule, parseHostRule } from './egress-proxy';
import { buildGitProcessEnv, buildRunnerProcessEnv, buildSandboxAgentEnv, isSecretLikeEnvName } from './env';
import { SandboxPolicyError, SandboxUnavailableError } from './errors';
import { GIT_HARDENING_CONFIG_ARGS, gitWorkingDirectory, parseScopedConfigList, unsafeRepositoryKeys } from './git-hardening';
import { LINUX_LAUNCHER_SOURCE, parseBwrapVersion, renderBwrapArgs } from './linux-bwrap';
import { AUDIT_ARCHES, buildSeccompFilter, CLONE_NAMESPACE_FLAGS, deniedSyscalls, evaluateSeccompFilter, SECCOMP_RESULTS } from './linux-seccomp';
import { MacSeatbeltProvider, renderSeatbeltProfile, SANDBOX_EXEC_PATH } from './macos-seatbelt';
import { grantCovers, MAX_GRANT_DAYS, parseTrustedHostGrant, resolveSandboxMode } from './mode';
import { attemptKeyFor, AttemptServerManager, type LaunchSpec } from './opencode-attempts';
import { ancestorsOf, collapseNested, resolveGitMetadata, resolveToolchainRoots } from './paths';
import { buildAttemptPolicy, mandatoryDeniedPaths, policyHash, validatePolicy } from './policy';
import { getVerifiedProvider, setProviderFactoryForTests } from './provider';
import type { CapabilityReport, NetworkPolicy, SandboxPolicy, SandboxProvider } from './types';

const NO_NETWORK: NetworkPolicy = { mode: 'none', proxy: null, listenPort: null, controlSocketPath: null, allowedHosts: [] };

let root = '';
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-sbx-unit-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setProviderFactoryForTests(null);
});

/** repos/<owner>/demo.git common dir + linked worktree pointer (no git needed). */
function linkedWorktree() {
  const repos = join(root, 'repos');
  const commonDir = join(repos, 'acme', 'demo.git');
  const gitDir = join(commonDir, 'worktrees', 'run-a');
  const worktree = join(repos, 'worktrees', 'run-a');
  const attemptRoot = join(root, 'sandbox', 'run-a');
  const home = join(root, 'home');
  for (const dir of [gitDir, worktree, attemptRoot, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  return { repos, commonDir, gitDir, worktree, attemptRoot, home };
}

describe('env allowlists', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/Users/u',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    LC_SECRET_TOKEN: 'leak',
    JWT_SECRET: 'jwt',
    DATABASE_URL: 'postgres://u:p@h/db',
    TOKEN_ENCRYPTION_KEY: 'k',
    GITHUB_TOKEN: 'ghp',
    OPENCODE_AUTH_CONTENT: '{"x":1}',
    HTTPS_PROXY: 'http://corp:3128',
    CODEX_HOME: '/Users/u/.codex',
    SSH_AUTH_SOCK: '/tmp/agent',
    GIT_DIR: '/elsewhere',
  };

  it('builds the sandboxed agent env from nothing but explicit values', () => {
    const env = buildSandboxAgentEnv({
      source, path: '/usr/bin:/bin', home: '/a/home', tmp: '/a/tmp', xdgConfigHome: '/a/c', xdgDataHome: '/a/d',
      xdgStateHome: '/a/s', xdgCacheHome: '/a/k', proxyUrl: 'http://127.0.0.1:9', noProxy: null, shell: '/bin/sh',
      explicit: { OPENCODE_SERVER_PASSWORD: 'pw', SKIPPED: undefined },
    });
    for (const key of ['JWT_SECRET', 'DATABASE_URL', 'TOKEN_ENCRYPTION_KEY', 'GITHUB_TOKEN', 'OPENCODE_AUTH_CONTENT', 'SSH_AUTH_SOCK', 'GIT_DIR', 'LC_SECRET_TOKEN', 'SKIPPED']) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env).toMatchObject({ HOME: '/a/home', TMPDIR: '/a/tmp', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', LC_ALL: 'C', OPENCODE_SERVER_PASSWORD: 'pw' });
    expect(env).not.toHaveProperty('NO_PROXY');
    const linux = buildSandboxAgentEnv({ source: {}, path: '/usr/bin', home: '/h', tmp: '/t', xdgConfigHome: '/c', xdgDataHome: '/d', xdgStateHome: '/s', xdgCacheHome: '/k', proxyUrl: 'http://127.0.0.1:3128', noProxy: 'localhost', shell: '/bin/sh' });
    expect(linux).toMatchObject({ NO_PROXY: 'localhost', no_proxy: 'localhost', LANG: 'en_US.UTF-8' });
    const offline = buildSandboxAgentEnv({ source: {}, path: '/usr/bin', home: '/h', tmp: '/t', xdgConfigHome: '/c', xdgDataHome: '/d', xdgStateHome: '/s', xdgCacheHome: '/k', proxyUrl: null, shell: '/bin/sh' });
    expect(offline).not.toHaveProperty('HTTPS_PROXY');
  });

  it('gives runner CLIs (Codex) locale/path/home/proxy but no sidecar secrets', () => {
    const env = buildRunnerProcessEnv(source, { CODEX_API_KEY: 'explicit', DROPPED: undefined });
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/Users/u', HTTPS_PROXY: 'http://corp:3128', CODEX_HOME: '/Users/u/.codex', CODEX_API_KEY: 'explicit' });
    for (const key of ['JWT_SECRET', 'DATABASE_URL', 'TOKEN_ENCRYPTION_KEY', 'GITHUB_TOKEN', 'OPENCODE_AUTH_CONTENT', 'SSH_AUTH_SOCK', 'GIT_DIR', 'DROPPED']) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('lets git call sites contribute identity variables only', () => {
    const env = buildGitProcessEnv(source, { ...source, GIT_AUTHOR_NAME: 'A', GIT_COMMITTER_EMAIL: 'c@x', GIT_SSH_COMMAND: 'evil', GIT_CONFIG_PARAMETERS: "'x'" }, { GIT_CONFIG_GLOBAL: '/dev/null' });
    expect(env).toMatchObject({ PATH: '/usr/bin', GIT_AUTHOR_NAME: 'A', GIT_COMMITTER_EMAIL: 'c@x', HTTPS_PROXY: 'http://corp:3128', GIT_CONFIG_GLOBAL: '/dev/null' });
    for (const key of ['JWT_SECRET', 'DATABASE_URL', 'GITHUB_TOKEN', 'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'HOME', 'SSH_AUTH_SOCK']) {
      expect(env).not.toHaveProperty(key);
    }
    expect(buildGitProcessEnv({}, undefined, {})).toEqual({});
  });

  it('recognises secret-looking names', () => {
    for (const name of ['JWT_SECRET', 'GITHUB_TOKEN', 'DB_PASSWORD', 'OPENAI_API_KEY', 'DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'SESSION_COOKIE']) expect(isSecretLikeEnvName(name)).toBe(true);
    for (const name of ['PATH', 'LANG', 'LC_ALL', 'TERM']) expect(isSecretLikeEnvName(name)).toBe(false);
  });
});

describe('paths', () => {
  it('lists strict ancestors root first and collapses nested roots', () => {
    expect(ancestorsOf('/a/b/c')).toEqual(['/', '/a', '/a/b']);
    expect(collapseNested(['/a/b', '/a', '/c', '/a/b/c'])).toEqual(['/a', '/c']);
  });

  it('resolves .git pointer files, directories, symlinks and absence', () => {
    const layout = linkedWorktree();
    expect(resolveGitMetadata(layout.worktree)).toMatchObject({ dotGitKind: 'file', gitDir: layout.gitDir, commonDir: layout.commonDir });
    const plain = join(root, 'plain');
    mkdirSync(join(plain, '.git'), { recursive: true });
    expect(resolveGitMetadata(plain)).toMatchObject({ dotGitKind: 'dir', gitDir: join(plain, '.git'), commonDir: join(plain, '.git') });
    const linked = join(root, 'linked');
    mkdirSync(linked);
    symlinkSync(join(root, 'home'), join(linked, '.git'));
    expect(resolveGitMetadata(linked)).toMatchObject({ dotGitKind: 'symlink', gitDir: null });
    const none = join(root, 'none');
    mkdirSync(none);
    expect(resolveGitMetadata(none).dotGitKind).toBe('none');
    const garbage = join(root, 'garbage');
    mkdirSync(garbage);
    writeFileSync(join(garbage, '.git'), 'not a pointer');
    expect(resolveGitMetadata(garbage)).toMatchObject({ dotGitKind: 'file', gitDir: null });
  });

  it('only admits known toolchain dirs from HOME and install prefixes from elsewhere', () => {
    const home = join(root, 'home');
    for (const dir of ['.bun/bin', '.local/bin', '.cargo/bin', '.rustup/toolchains', 'opt/tool/bin', 'tmpdir/bin']) mkdirSync(join(home === join(root, 'home') && dir.startsWith('opt') ? root : home, dir), { recursive: true });
    mkdirSync(join(root, 'tmpdir', 'bin'), { recursive: true });
    const result = resolveToolchainRoots({
      pathEnv: [join(home, '.bun/bin'), join(home, '.local/bin'), join(home, '.cargo/bin'), join(root, 'opt/tool/bin'), join(root, 'tmpdir/bin'), '/usr/bin', 'relative/bin', '/does/not/exist'].join(':'),
      home,
      volatileRoots: [join(root, 'tmpdir')],
      systemRoots: ['/usr'],
    });
    expect(result.roots).toEqual(expect.arrayContaining([join(home, '.bun/bin'), join(home, '.cargo/bin'), join(home, '.rustup/toolchains'), join(root, 'opt/tool')]));
    expect(result.roots).not.toContain(join(home, '.local/bin'));
    expect(result.roots).not.toContain(join(home, '.cargo'));
    expect(result.skipped).toEqual(expect.arrayContaining([join(home, '.local/bin'), join(root, 'tmpdir/bin')]));
    expect(result.pathEntries).toContain('/usr/bin');
  });
});

describe('attempt policy', () => {
  function build(overrides: Partial<Parameters<typeof buildAttemptPolicy>[0]> = {}) {
    const layout = linkedWorktree();
    return {
      layout,
      result: buildAttemptPolicy({
        attemptKey: 'k1', platform: 'darwin', worktree: layout.worktree, attemptRoot: layout.attemptRoot, home: layout.home,
        toolchainRoots: [], trustedGitRoots: [layout.repos], denyRoots: [layout.repos], network: NO_NETWORK, env: { PATH: '/usr/bin' },
        ...overrides,
      }),
    };
  }

  it('orders rules so the attempt re-opens only its own paths and credential stores are denied last', () => {
    const { layout, result } = build();
    const rules = result.policy.filesystem.rules;
    const index = (action: string, path: string) => rules.findIndex((rule) => rule.action === action && rule.path === path);
    expect(index('deny', layout.repos)).toBeGreaterThan(-1);
    expect(index('read', layout.commonDir)).toBeGreaterThan(index('deny', layout.repos));
    expect(index('deny', join(layout.commonDir, 'worktrees'))).toBeGreaterThan(index('read', layout.commonDir));
    expect(index('read', layout.gitDir)).toBeGreaterThan(index('deny', join(layout.commonDir, 'worktrees')));
    expect(index('write', layout.worktree)).toBeGreaterThan(index('read', layout.gitDir));
    expect(rules.find((rule) => rule.action === 'protect' && rule.path === join(layout.worktree, '.git'))?.scope).toBe('file');
    expect(index('protect', layout.gitDir)).toBeGreaterThan(index('write', layout.worktree));
    const lastWrite = Math.max(index('write', layout.worktree), index('write', layout.attemptRoot));
    for (const denied of mandatoryDeniedPaths(layout.home, 'darwin')) expect(index('deny', denied)).toBeGreaterThan(lastWrite);
    expect(result.policy.cwd).toBe(layout.worktree);
    expect(result.warnings).toEqual([]);
  });

  it('refuses writable roots that contain HOME or sit inside a credential store', () => {
    const layout = linkedWorktree();
    const base = { attemptKey: 'k', platform: 'darwin' as const, attemptRoot: layout.attemptRoot, toolchainRoots: [], trustedGitRoots: [], denyRoots: [], network: NO_NETWORK, env: {} };
    expect(() => buildAttemptPolicy({ ...base, worktree: layout.home, home: layout.home })).toThrow(SandboxPolicyError);
    expect(() => buildAttemptPolicy({ ...base, worktree: root, home: layout.home })).toThrow(/home directory/);
    const inSsh = join(layout.home, '.ssh', 'project');
    mkdirSync(inSsh, { recursive: true });
    expect(() => buildAttemptPolicy({ ...base, worktree: inSsh, home: layout.home })).toThrow(/credential store/);
    expect(() => buildAttemptPolicy({ ...base, worktree: join(root, 'missing'), home: layout.home })).toThrow(/does not exist/);
    expect(() => buildAttemptPolicy({ ...base, worktree: layout.worktree, attemptRoot: join(layout.worktree, 'nested'), home: layout.home })).toThrow();
  });

  it('does not open git metadata outside the trusted roots', () => {
    const { result } = build({ trustedGitRoots: [join(root, 'elsewhere')] });
    expect(result.warnings[0]).toMatch(/outside trusted roots/);
    expect(result.policy.filesystem.rules.some((rule) => rule.action === 'read' && rule.path.endsWith('demo.git'))).toBe(false);
  });

  it('hashes the policy without env values', () => {
    const { result } = build();
    const same = { ...result.policy, env: { PATH: '/other' } };
    expect(policyHash(same)).toBe(policyHash(result.policy));
    expect(policyHash({ ...result.policy, env: { PATH: '/x', EXTRA: '1' } })).not.toBe(policyHash(result.policy));
  });

  it('validates network/rule shape', () => {
    const { result } = build();
    expect(() => validatePolicy({ ...result.policy, network: { ...NO_NETWORK, mode: 'proxy' } })).toThrow(/proxy endpoint/);
    expect(() => validatePolicy({ ...result.policy, network: { ...NO_NETWORK, proxy: { kind: 'tcp', host: '127.0.0.1', port: 1 } } })).toThrow(/must not carry/);
    expect(() => validatePolicy({ ...result.policy, filesystem: { rules: [{ action: 'read', path: '/usr', scope: 'subtree' }] } })).toThrow(/writable/);
    expect(() => validatePolicy({ ...result.policy, filesystem: { rules: [{ action: 'write', path: 'relative', scope: 'subtree' }] } })).toThrow();
    expect(() => validatePolicy({ ...result.policy, filesystem: { rules: [{ action: 'write', path: '/a\nb', scope: 'subtree' }] } })).toThrow(/control characters/);
  });
});

describe('macOS Seatbelt rendering', () => {
  function policy(network: NetworkPolicy = NO_NETWORK): SandboxPolicy {
    const layout = linkedWorktree();
    return buildAttemptPolicy({ attemptKey: 'k', platform: 'darwin', worktree: layout.worktree, attemptRoot: layout.attemptRoot, home: layout.home, toolchainRoots: [], trustedGitRoots: [layout.repos], denyRoots: [layout.repos], network, env: { PATH: '/usr/bin', HOME: '/h' } }).policy;
  }

  it('passes every policy path as a parameter, never as profile text', () => {
    const p = policy();
    const { profile, params } = renderSeatbeltProfile(p);
    for (const rule of p.filesystem.rules) {
      expect(profile).not.toContain(rule.path.startsWith(root) ? rule.path : '\u0000');
      expect(params).toContain(`${params[params.indexOf('-D') + 1]?.split('=')[0]}=${params[params.indexOf('-D') + 1]?.split('=').slice(1).join('=')}`);
    }
    expect(params.filter((value) => value === '-D').length).toBeGreaterThan(p.filesystem.rules.length);
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny process-info*)\n(allow process-info* (target same-sandbox))');
    expect(profile).toMatch(/\(deny file-write\* \(literal \(param "P\d+"\)\)\)/);
    expect(profile).not.toContain('network-outbound');
  });

  it('allows only the proxy port outbound and the control port inbound', () => {
    const { profile } = renderSeatbeltProfile(policy({ mode: 'proxy', proxy: { kind: 'tcp', host: '127.0.0.1', port: 4100 }, listenPort: 4200, controlSocketPath: null, allowedHosts: [] }));
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:4100"))');
    expect(profile).toContain('(allow network-bind (local ip "localhost:4200"))');
    expect(profile).toContain('(allow network-inbound (local ip "localhost:4200"))');
    expect(profile.match(/allow network-outbound/g)).toHaveLength(1);
  });

  it('wraps argv with the absolute sandbox-exec and the policy env only', async () => {
    const p = policy();
    const wrapped = await new MacSeatbeltProvider().wrap({ command: '/usr/bin/true', args: ['a b'], cwd: p.cwd }, p);
    expect(wrapped.command).toBe(SANDBOX_EXEC_PATH);
    expect(wrapped.args.slice(-3)).toEqual(['--', '/usr/bin/true', 'a b']);
    expect(wrapped.env).toEqual(p.env);
    wrapped.release();
    await expect(new MacSeatbeltProvider().wrap({ command: '/bin/x', args: [], cwd: p.cwd }, { ...p, network: { mode: 'proxy', proxy: { kind: 'unix', path: '/s', innerPort: 1 }, listenPort: null, controlSocketPath: null, allowedHosts: [] } })).rejects.toThrow(/loopback TCP/);
  });
});

describe('Linux bubblewrap rendering (unit only: bwrap is exercised in sandbox.yml CI)', () => {
  it('unshares every namespace, drops caps and binds rules in order', () => {
    const layout = linkedWorktree();
    const { policy } = buildAttemptPolicy({ attemptKey: 'k', platform: 'linux', worktree: layout.worktree, attemptRoot: layout.attemptRoot, home: layout.home, toolchainRoots: [], trustedGitRoots: [layout.repos], denyRoots: [layout.repos], network: NO_NETWORK, env: {} });
    const args = renderBwrapArgs(policy, { runtimeRoots: ['/opt/node'], disableUserns: true, seccompFd: 3, argv: ['/bin/sh', '-c', 'true'] });
    for (const flag of ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-net', '--disable-userns']) expect(args).toContain(flag);
    expect(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL']);
    const at = (...needle: string[]) => args.findIndex((_, index) => needle.every((value, offset) => args[index + offset] === value));
    expect(at('--bind', layout.worktree, layout.worktree)).toBeGreaterThan(at('--ro-bind', layout.gitDir, layout.gitDir));
    expect(at('--tmpfs', join(layout.commonDir, 'worktrees'))).toBeGreaterThan(at('--ro-bind', layout.commonDir, layout.commonDir));
    expect(at('--ro-bind', join(layout.worktree, '.git'), join(layout.worktree, '.git'))).toBeGreaterThan(at('--bind', layout.worktree, layout.worktree));
    expect(at('--remount-ro', join(layout.commonDir, 'worktrees'))).toBeGreaterThan(at('--tmpfs', join(layout.commonDir, 'worktrees')));
    expect(args.slice(-6)).toEqual(['--seccomp', '3', '--', '/bin/sh', '-c', 'true']);
    // HOME and the credential stores are simply never bound.
    expect(args).not.toContain(layout.home);
    expect(args.indexOf('--chdir')).toBeGreaterThan(-1);
    const noSeccomp = renderBwrapArgs(policy, { runtimeRoots: [], disableUserns: false, seccompFd: null, argv: ['/x'] }, () => false);
    expect(noSeccomp).not.toContain('--seccomp');
    expect(noSeccomp).not.toContain('--disable-userns');
    expect(noSeccomp).not.toContain('--bind');
  });

  it('parses bwrap versions and ships a syntactically valid launcher', () => {
    expect(parseBwrapVersion('bubblewrap 0.9.0\n')).toEqual([0, 9, 0]);
    expect(parseBwrapVersion('nonsense')).toBeNull();
    expect(() => new Script(LINUX_LAUNCHER_SOURCE)).not.toThrow();
  });
});

describe('seccomp filter', () => {
  for (const arch of ['x64', 'arm64'] as const) {
    it(`${arch}: denies the listed syscalls and namespace clones, allows the rest`, () => {
      const filter = buildSeccompFilter(arch);
      const auditArch = AUDIT_ARCHES[arch];
      const denied = deniedSyscalls(arch);
      for (const nr of Object.values(denied)) expect(evaluateSeccompFilter(filter, { arch: auditArch, nr })).toBe(SECCOMP_RESULTS.eperm);
      const clone = arch === 'x64' ? 56 : 220;
      expect(evaluateSeccompFilter(filter, { arch: auditArch, nr: clone, arg0: 0x11 })).toBe(SECCOMP_RESULTS.allow);
      expect(evaluateSeccompFilter(filter, { arch: auditArch, nr: clone, arg0: 0x10000000 })).toBe(SECCOMP_RESULTS.eperm);
      expect(evaluateSeccompFilter(filter, { arch: auditArch, nr: clone, arg0: CLONE_NAMESPACE_FLAGS })).toBe(SECCOMP_RESULTS.eperm);
      expect(evaluateSeccompFilter(filter, { arch: auditArch, nr: 435 })).toBe(SECCOMP_RESULTS.enosys);
      expect(evaluateSeccompFilter(filter, { arch: auditArch, nr: arch === 'x64' ? 0 : 63 })).toBe(SECCOMP_RESULTS.allow);
      expect(evaluateSeccompFilter(filter, { arch: 0x40000003, nr: 0 })).toBe(SECCOMP_RESULTS.kill);
      expect(denied.ptrace).toBeDefined();
      expect(denied.io_uring_setup).toBe(425);
    });
  }

  it('x64: refuses the x32 ABI', () => {
    expect(evaluateSeccompFilter(buildSeccompFilter('x64'), { arch: AUDIT_ARCHES.x64, nr: 0x40000000 + 1 })).toBe(SECCOMP_RESULTS.eperm);
  });
});

describe('egress proxy', () => {
  it('parses host rules and matches 443 by default', () => {
    expect(parseHostRule('API.Example.com')).toMatchObject({ host: 'api.example.com', port: null });
    expect(parseHostRule('*.npmjs.org:8443')).toMatchObject({ wildcard: true, port: 8443 });
    expect(parseHostRule('[::1]:80')).toMatchObject({ host: '::1', ipLiteral: true, port: 80 });
    expect(() => parseHostRule('::1')).toThrow(/bracketed/);
    expect(() => parseHostRule('bad host')).toThrow();
    expect(() => parseHostRule('a.com:99999')).toThrow();
    const rules = ['api.example.com', '*.npmjs.org', '127.0.0.1:4000'].map(parseHostRule);
    expect(matchRule(rules, 'api.example.com', 443)).not.toBeNull();
    expect(matchRule(rules, 'api.example.com', 22)).toBeNull();
    expect(matchRule(rules, 'registry.npmjs.org', 443)).not.toBeNull();
    expect(matchRule(rules, 'npmjs.org', 443)).toBeNull();
    expect(matchRule(rules, 'evil-npmjs.org', 443)).toBeNull();
    expect(matchRule(rules, '127.0.0.1', 4000)).not.toBeNull();
    expect(matchRule(rules, '127.0.0.1', 4001)).toBeNull();
  });

  it('classifies addresses an allowed hostname must not resolve to', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '169.254.169.254', '224.0.0.1', '::1', '::', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', 'fd00:ec2::254', '100.100.100.200']) {
      expect(deniedAddressClass(address), address).not.toBeNull();
    }
    for (const address of ['93.184.216.34', '10.0.0.5', '2606:4700::1']) expect(deniedAddressClass(address), address).toBeNull();
  });

  async function connectThrough(port: number, target: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let data = '';
      let pinged = false;
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (!data.includes('\r\n\r\n')) return;
        if (!data.startsWith('HTTP/1.1 200')) {
          socket.end();
        } else if (!pinged) {
          pinged = true;
          socket.write('ping\n');
        } else if (data.includes('pong')) {
          socket.end();
        }
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
  }

  it('tunnels allowlisted targets and refuses everything else (real loopback sockets)', async () => {
    const target = createNetServer((socket) => socket.on('data', () => socket.end('pong\n')));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (target.address() as { port: number }).port;
    const decisions: string[] = [];
    const proxy = new EgressProxy({
      allow: [`127.0.0.1:${targetPort}`, 'rebind.example.com'],
      listen: { kind: 'tcp' },
      allowLocalTargets: true,
      resolve: async () => ['127.0.0.1'],
      onDecision: (decision) => decisions.push(`${decision.allowed}:${decision.reason}`),
    });
    const endpoint = await proxy.start();
    if (endpoint.kind !== 'tcp') throw new Error('expected tcp');
    try {
      expect(await connectThrough(endpoint.port, `127.0.0.1:${targetPort}`)).toContain('pong');
      expect(await connectThrough(endpoint.port, `127.0.0.1:${targetPort + 1}`)).toContain('403');
      expect(await connectThrough(endpoint.port, 'example.com:443')).toContain('403');
      // DNS for an allowed name pointing at loopback is refused.
      expect(await connectThrough(endpoint.port, 'rebind.example.com:443')).toContain('resolved-to-loopback');
      const plain = await fetch(`http://127.0.0.1:${endpoint.port}/`, { headers: { host: 'example.com' } });
      expect(plain.status).toBe(403);
      expect(decisions).toEqual(expect.arrayContaining(['true:allowlisted-ip', 'false:not-allowlisted', 'false:resolved-to-loopback', 'false:plain-http-refused']));
      expect(proxy.deniedCount).toBeGreaterThanOrEqual(3);
      expect(proxy.decisions.length).toBe(decisions.length);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it('refuses an allowlisted loopback, link-local or metadata literal unless the proxy allows local targets', async () => {
    const target = createNetServer((socket) => socket.on('data', () => socket.end('pong\n')));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (target.address() as { port: number }).port;
    const decisions: string[] = [];
    const proxy = new EgressProxy({
      allow: [`127.0.0.1:${targetPort}`, '169.254.169.254:80', '[::1]:4096', '0.0.0.0:5432'],
      listen: { kind: 'tcp' },
      onDecision: (decision) => decisions.push(`${decision.allowed}:${decision.reason}`),
    });
    const endpoint = await proxy.start();
    if (endpoint.kind !== 'tcp') throw new Error('expected tcp');
    try {
      expect(await connectThrough(endpoint.port, `127.0.0.1:${targetPort}`)).toContain('403');
      expect(await connectThrough(endpoint.port, '169.254.169.254:80')).toContain('403');
      expect(await connectThrough(endpoint.port, '[::1]:4096')).toContain('403');
      expect(await connectThrough(endpoint.port, '0.0.0.0:5432')).toContain('403');
      expect(decisions).toEqual(['false:denied-address-loopback', 'false:denied-address-link-local', 'false:denied-address-loopback', 'false:denied-address-unspecified']);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it('listens on a 0600 unix socket for the Linux bridge', async () => {
    const path = join(root, 'proxy.sock');
    const proxy = new EgressProxy({ allow: [], listen: { kind: 'unix', path } });
    await expect(proxy.start()).resolves.toEqual({ kind: 'unix', path });
    await expect(proxy.start()).rejects.toThrow(/already started/);
    await proxy.close();
    expect(existsSync(path)).toBe(false);
  });
});

describe('egress allowlist', () => {
  it('derives provider hosts, custom https baseURLs, registries and validated extras', () => {
    const result = buildEgressAllowlist({
      authProviders: ['anthropic', 'unknown-provider'],
      configProviders: { custom: { options: { baseURL: 'https://llm.internal.example:8443/v1' } }, insecure: { options: { baseURL: 'http://plain.example' } }, broken: null },
      extraHosts: 'Extra.example.com, bad host, 127.0.0.1:11434',
      includeRegistries: true,
    });
    expect(result.hosts).toEqual(expect.arrayContaining(['api.anthropic.com', 'llm.internal.example:8443', 'registry.npmjs.org', 'extra.example.com', '127.0.0.1:11434']));
    expect(result.hosts).not.toContain('plain.example');
    expect(result.rejected).toEqual(['bad host']);
    expect(buildEgressAllowlist({ authProviders: [], configProviders: null, extraHosts: undefined, includeRegistries: false }).hosts).toEqual([]);
  });
});

describe('git hardening helpers', () => {
  it('parses scoped config listings and flags non-allowlisted repository keys', () => {
    const listing = 'local\0core.bare\nfalse\0local\0filter.evil.clean\ntouch x\0worktree\0include.path\n/x\0local\0remote.origin.url\nhttps://github.com/a/b\0local\0remote.origin.pushurl\nhttps://evil\0command\0core.pager\ncat\0global\0alias.x\n!y\0local\0http.https://github.com/.extraheader\nX: y\0local\0branch.main.merge\nrefs/heads/main\0';
    const entries = parseScopedConfigList(listing);
    expect(entries).toContainEqual({ scope: 'local', key: 'core.bare' });
    expect(unsafeRepositoryKeys(entries)).toEqual(['filter.evil.clean', 'http.https://github.com/.extraheader', 'include.path', 'remote.origin.pushurl']);
    expect(gitWorkingDirectory(['-C', '/r', 'status'])).toBe('/r');
    expect(gitWorkingDirectory(['clone', 'x'])).toBeNull();
    expect(GIT_HARDENING_CONFIG_ARGS.join(' ')).toContain('credential.helper=');
  });
});

describe('sandbox mode and trusted-host grants', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  const grant = (extra: Record<string, unknown> = {}) => JSON.stringify({ actor: 'owner@example.com', reason: 'reviewed fixture repositories only', expiresAt: '2026-11-01T00:00:00Z', ...extra });

  it('defaults to enforce and validates explicit modes', () => {
    expect(resolveSandboxMode({}, now)).toEqual({ mode: 'enforce' });
    expect(resolveSandboxMode({ OPENLINEAR_SANDBOX_MODE: 'ENFORCE' }, now)).toEqual({ mode: 'enforce' });
    expect(() => resolveSandboxMode({ OPENLINEAR_SANDBOX_MODE: 'off' }, now)).toThrow(SandboxUnavailableError);
    expect(() => resolveSandboxMode({ OPENLINEAR_SANDBOX_MODE: 'trusted-host' }, now)).toThrow(/without a valid grant/);
  });

  it('accepts a bounded, explicit grant and records its id', () => {
    const decision = resolveSandboxMode({ OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: grant({ paths: [root] }) }, now);
    expect(decision.mode).toBe('trusted-host');
    if (decision.mode !== 'trusted-host') return;
    expect(decision.grant).toMatchObject({ actor: 'owner@example.com', source: 'env', paths: [root] });
    expect(decision.grant.grantId).toMatch(/^[0-9a-f]{12}$/);
    expect(grantCovers(decision.grant, join(root, 'project'))).toBe(true);
    expect(grantCovers(decision.grant, tmpdir() === root ? '/' : '/usr')).toBe(false);
    const file = join(root, 'grant.json');
    writeFileSync(file, grant());
    const fromFile = resolveSandboxMode({ OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT_FILE: file }, now);
    expect(fromFile.mode === 'trusted-host' && fromFile.grant.source).toBe('file');
    expect(fromFile.mode === 'trusted-host' && grantCovers(fromFile.grant, '/anything')).toBe(true);
  });

  it('rejects expired, over-long, malformed and unscoped grants', () => {
    const blockersOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(SandboxUnavailableError);
        return (err as SandboxUnavailableError).blockers.join(' ');
      }
      throw new Error('expected a SandboxUnavailableError');
    };
    expect(blockersOf(() => parseTrustedHostGrant(grant({ expiresAt: '2026-10-01T00:00:00Z' }), 'env', now))).toMatch(/expired/);
    expect(blockersOf(() => parseTrustedHostGrant(grant({ expiresAt: new Date(now + (MAX_GRANT_DAYS + 1) * 86_400_000).toISOString() }), 'env', now))).toMatch(/exceed/);
    expect(blockersOf(() => parseTrustedHostGrant('{', 'env', now))).toMatch(/JSON/);
    expect(blockersOf(() => parseTrustedHostGrant(grant({ reason: 'short' }), 'env', now))).toMatch(/invalid/);
    expect(blockersOf(() => parseTrustedHostGrant(grant({ unexpected: true }), 'env', now))).toMatch(/invalid/);
    expect(blockersOf(() => parseTrustedHostGrant(grant({ paths: ['relative'] }), 'env', now))).toMatch(/absolute/);
    expect(blockersOf(() => resolveSandboxMode({ OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT_FILE: 'relative.json' }, now))).toMatch(/absolute/);
    expect(blockersOf(() => resolveSandboxMode({ OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT_FILE: join(root, 'missing.json') }, now))).toMatch(/could not be read/);
  });
});

function fakeReport(available: boolean): CapabilityReport {
  return {
    provider: 'macos-seatbelt', providerVersion: 'fake', platform: process.platform, available, checkedAt: new Date().toISOString(), durationMs: 1,
    enforced: { filesystem: available, env: available, network: available, process: available }, probes: [], blockers: available ? [] : ['fake blocker'], warnings: [], unsupported: ['limits.cpu'],
  };
}

function fakeProvider(available: boolean, wraps: Array<{ policy: SandboxPolicy }> = []): SandboxProvider & { preflights: number } {
  const provider = {
    id: 'macos-seatbelt' as const,
    proxyTransport: 'tcp' as const,
    unsupportedLimits: ['limits.cpu'],
    preflights: 0,
    detect: async () => ({ ok: true, version: 'fake', blockers: [], warnings: [] }),
    preflight: async () => {
      provider.preflights += 1;
      return fakeReport(available);
    },
    wrap: async (spec: { command: string; args: readonly string[]; cwd: string }, policy: SandboxPolicy) => {
      wraps.push({ policy });
      return { command: '/fake/sandbox', args: ['--', spec.command, ...spec.args], cwd: spec.cwd, env: { ...policy.env }, extraFds: [], release: () => undefined };
    },
  };
  return provider;
}

describe('verified provider cache', () => {
  it('fails closed with blockers, caches success and shares one preflight', async () => {
    setProviderFactoryForTests(() => null);
    await expect(getVerifiedProvider()).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    const failing = fakeProvider(false);
    setProviderFactoryForTests(() => failing);
    await expect(getVerifiedProvider()).rejects.toMatchObject({ blockers: ['fake blocker'] });
    const ok = fakeProvider(true);
    setProviderFactoryForTests(() => ok);
    const [a, b] = await Promise.all([getVerifiedProvider(), getVerifiedProvider()]);
    expect(a.provider).toBe(ok);
    expect(b.report.available).toBe(true);
    await getVerifiedProvider();
    expect(ok.preflights).toBe(1);
  });
});

describe('per-attempt server manager (fake provider and launcher)', () => {
  let statusServer: HttpServer;
  let statusPort = 0;
  let busy = false;

  beforeEach(async () => {
    statusServer = createHttpServer((req, res) => {
      if (req.headers.authorization?.startsWith('Basic ') !== true) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url?.startsWith('/session/status') ? (busy ? { s1: { type: 'busy' } } : { s1: { type: 'idle' } }) : { ok: true }));
    });
    await new Promise<void>((resolve) => statusServer.listen(0, '127.0.0.1', () => resolve()));
    statusPort = (statusServer.address() as { port: number }).port;
    busy = false;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => statusServer.close(() => resolve()));
  });

  function setup(env: NodeJS.ProcessEnv = {}, available = true) {
    const layout = linkedWorktree();
    const wraps: Array<{ policy: SandboxPolicy }> = [];
    const provider = fakeProvider(available, wraps);
    const launches: LaunchSpec[] = [];
    const closed: string[] = [];
    const clients: Array<{ baseUrl: string; headers: Record<string, string>; fetch: (request: Request) => Promise<Response> }> = [];
    let clock = Date.now();
    const manager = new AttemptServerManager({
      launch: async (spec) => {
        launches.push(spec);
        const proc = Object.assign(new EventEmitter(), { exitCode: null as number | null, pid: 31_337 }) as unknown as ChildProcess;
        return { url: `http://127.0.0.1:${statusPort}`, proc, close: async () => { closed.push(spec.cwd); } };
      },
      resolveBinary: () => '/usr/bin/true',
      createClient: (config) => {
        clients.push(config);
        return { config };
      },
      managementConfig: async () => ({ model: 'anthropic/claude', provider: { custom: { options: { baseURL: 'https://llm.example/v1' } } } }),
      agentConfig: () => ({ autoupdate: false }),
      env: { PATH: '/usr/bin:/bin', HOME: layout.home, OPENLINEAR_SANDBOX_DIR: join(root, 'state'), JWT_SECRET: 'fake-jwt', DATABASE_URL: 'postgres://fake', ...env },
      platform: 'darwin',
      verifiedProvider: async () => {
        if (!available) throw new SandboxUnavailableError('none', ['fake blocker']);
        return { provider, report: fakeReport(true) };
      },
      now: () => clock,
    });
    return { layout, manager, wraps, launches, closed, clients, advance: (ms: number) => { clock += ms; } };
  }

  it('starts one sandboxed server per worktree with a complete, secret-free env and auth', async () => {
    const { layout, manager, wraps, launches, clients } = setup();
    const [first, second] = await Promise.all([manager.route('u1', layout.worktree), manager.route('u1', layout.worktree)]);
    expect(launches).toHaveLength(1);
    expect(first.kind).toBe('attempt');
    expect(second.metadata.attemptKey).toBe(attemptKeyFor(layout.worktree));
    const env = launches[0].env;
    expect(env).not.toHaveProperty('JWT_SECRET');
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env.OPENCODE_SERVER_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(env.HOME.startsWith(join(root, 'state', 'attempts'))).toBe(true);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toMatchObject({ autoupdate: false, model: 'anthropic/claude' });
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(launches[0].args.slice(-3)).toEqual(['serve', '--hostname=127.0.0.1', expect.stringMatching(/^--port=\d+$/)]);
    const policy = wraps[0].policy;
    expect(policy.network.mode).toBe('proxy');
    expect(policy.network.allowedHosts).toEqual(expect.arrayContaining(['llm.example', 'registry.npmjs.org']));
    expect(policy.filesystem.rules.filter((rule) => rule.action === 'write').map((rule) => rule.path)).toEqual([layout.worktree, join(root, 'state', 'attempts', attemptKeyFor(layout.worktree))]);
    expect(clients[0].headers.authorization).toBe(`Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`);
    expect(manager.metadataFor(layout.worktree)).toMatchObject({ mode: 'enforce', provider: 'macos-seatbelt', egressAllowedHosts: expect.any(Array) });
    // The record lives outside the agent-writable attempt root.
    expect(JSON.parse(readFileSync(join(root, 'state', 'records', `${attemptKeyFor(layout.worktree)}.json`), 'utf8')).policyHash).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(join(root, 'state', 'attempts', attemptKeyFor(layout.worktree), 'metadata.json'))).toBe(false);
    expect(wraps[0].policy.filesystem.rules).toContainEqual({ action: 'read', path: '/usr/bin/true', scope: 'file' });
    await manager.shutdownAll();
    await expect(manager.route('u1', layout.worktree)).rejects.toMatchObject({ code: 'SANDBOX_START_FAILED' });
  });

  it('FE-04: an "ask" worktree gets a server that asks before edits, commands and fetches; an idle server of the other mode is replaced', async () => {
    const { layout, manager, launches, closed } = setup();
    await manager.route('u1', layout.worktree);
    expect(JSON.parse(launches[0].env.OPENCODE_CONFIG_CONTENT).permission).toBeUndefined();
    // Same mode: the running server is reused.
    manager.setApprovalMode(layout.worktree, 'policy');
    await manager.route('u1', layout.worktree);
    expect(launches).toHaveLength(1);
    // Another mode while idle: replaced by a server started with that mode.
    manager.setApprovalMode(layout.worktree, 'ask');
    await manager.route('u1', layout.worktree);
    expect(closed).toEqual([layout.worktree]);
    expect(launches).toHaveLength(2);
    expect(JSON.parse(launches[1].env.OPENCODE_CONFIG_CONTENT)).toMatchObject({ autoupdate: false, permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } });
    await manager.route('u1', layout.worktree);
    expect(launches).toHaveLength(2);
    expect(manager.approvalModeOf(layout.worktree)).toBe('ask');
    // A server with a live session is never stopped for a mode change; it keeps its mode.
    busy = true;
    manager.setApprovalMode(layout.worktree, 'policy');
    await manager.route('u1', layout.worktree);
    expect(launches).toHaveLength(2);
    expect(manager.approvalModeOf(layout.worktree)).toBe('ask');
    busy = false;
    await manager.shutdownAll();
  });

  it('W12a: exposes the server process identity for the journal; release reports whether it owned a server', async () => {
    const { layout, manager } = setup();
    expect(manager.processFor(layout.worktree)).toBeNull();
    await manager.route('u1', layout.worktree);
    const identity = manager.processFor(layout.worktree);
    expect(identity).toMatchObject({ pid: 31_337, launchedAt: expect.any(Number), spawnedBy: expect.any(Number) });
    expect(identity && identity.spawnedBy >= identity.launchedAt).toBe(true);
    expect(await manager.release(layout.worktree)).toBe(true);
    expect(await manager.release(layout.worktree)).toBe(false);
    expect(manager.processFor(layout.worktree)).toBeNull();
  });

  it('fails closed without a verified provider and spawns nothing', async () => {
    const { layout, manager, launches } = setup({}, false);
    await expect(manager.route('u1', layout.worktree)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(launches).toHaveLength(0);
    await expect(manager.route('u1', join(root, 'missing'))).rejects.toMatchObject({ code: 'SANDBOX_START_FAILED' });
  });

  it('routes trusted-host grants to the legacy path, scoped by grant paths', async () => {
    const grant = JSON.stringify({ actor: 'owner@example.com', reason: 'reviewed fixture repositories only', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const { layout, manager, launches } = setup({ OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: grant });
    const route = await manager.route('u1', layout.worktree);
    expect(route.kind).toBe('trusted-host');
    expect(route.metadata.grant?.actor).toBe('owner@example.com');
    expect(launches).toHaveLength(0);
    const scoped = setup({ OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: JSON.stringify({ ...JSON.parse(grant), paths: ['/nonexistent-root'] }) });
    await expect(scoped.manager.route('u1', scoped.layout.worktree)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });

  it('reaps idle servers (not busy or streaming ones) and those whose worktree vanished', async () => {
    const { layout, manager, closed, clients, advance } = setup();
    await manager.route('u1', layout.worktree);
    // An open response body counts as activity until it ends.
    const response = await clients[0].fetch(new Request(`http://127.0.0.1:${statusPort}/config`, { headers: clients[0].headers }));
    advance(manager.idleMs + 1);
    expect(await manager.reapIdle()).toEqual([]);
    await response.text();
    advance(manager.idleMs + 1);
    busy = true;
    expect(await manager.reapIdle()).toEqual([]);
    busy = false;
    advance(manager.idleMs + 1);
    expect(await manager.reapIdle()).toEqual([attemptKeyFor(layout.worktree)]);
    expect(closed).toEqual([layout.worktree]);
    // Restart, then remove the worktree: reaped and the private root deleted.
    await manager.route('u1', layout.worktree);
    const attemptRoot = join(root, 'state', 'attempts', attemptKeyFor(layout.worktree));
    rmSync(layout.worktree, { recursive: true, force: true });
    expect(await manager.reapIdle()).toEqual([attemptKeyFor(layout.worktree)]);
    expect(existsSync(attemptRoot)).toBe(false);
    await manager.release(layout.worktree);
  });
});
