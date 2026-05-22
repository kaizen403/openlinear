import { existsSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
}));

vi.mock('./execution/exec', () => ({
  execFileAsync: mocks.execFileAsync,
}));

const {
  createGitCredentialConfig,
  execGitWithCredentials,
} = await import('./git-credentials');

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

  it('executes git with temporary credentials and always cleans up', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: 'ok', stderr: '' });

    await expect(execGitWithCredentials(['status'], 'token', 'https://github.com/acme/repo.git', {
      cwd: '/repo',
    })).resolves.toEqual({ stdout: 'ok', stderr: '' });

    const args = mocks.execFileAsync.mock.calls[0][1];
    expect(mocks.execFileAsync).toHaveBeenCalledWith('git', [
      '-c',
      expect.stringContaining('credential.helper=store --file='),
      'status',
    ], { cwd: '/repo' });
    const credentialsFile = args[1].slice('credential.helper=store --file='.length);
    expect(existsSync(dirname(credentialsFile))).toBe(false);
  });
});
