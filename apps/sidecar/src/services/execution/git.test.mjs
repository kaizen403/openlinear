import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  execGitWithCredentials: vi.fn(),
  getGitIdentityEnv: vi.fn(() => ({ GIT_AUTHOR_NAME: 'OpenLinear' })),
  assertPathInsideReposDir: vi.fn((path) => path),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  accessSync: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  rmSync: mocks.rmSync,
  accessSync: mocks.accessSync,
  constants: { W_OK: 2 },
}));

vi.mock('./exec', () => ({ execFileAsync: mocks.execFileAsync }));
vi.mock('../git-credentials', () => ({ execGitWithCredentials: mocks.execGitWithCredentials }));
vi.mock('../git-identity', () => ({ getGitIdentityEnv: mocks.getGitIdentityEnv }));
vi.mock('../repo-storage', () => ({
  REPOS_DIR: '/tmp/openlinear-repos',
  assertPathInsideReposDir: mocks.assertPathInsideReposDir,
}));

const {
  cloneRepository,
  commitAndPush,
  createBranch,
  createPullRequest,
  hasCommittableChanges,
  stageCommittableChanges,
} = await import('./git');

describe('execution git helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.getGitIdentityEnv.mockReturnValue({ GIT_AUTHOR_NAME: 'OpenLinear' });
    mocks.assertPathInsideReposDir.mockImplementation((path) => path);
    mocks.existsSync.mockReturnValue(false);
    globalThis.fetch = mocks.fetch;
  });

  it('ignores runtime artifacts when detecting committable changes', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '?? .sisyphus/state.json\n', stderr: '' });
    await expect(hasCommittableChanges('/repo')).resolves.toBe(false);

    mocks.execFileAsync.mockResolvedValueOnce({ stdout: 'R  old.ts -> src/new.ts\n', stderr: '' });
    await expect(hasCommittableChanges('/repo')).resolves.toBe(true);
  });

  it('stages only committable files after excluding runtime artifacts', async () => {
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/index.ts\n', stderr: '' });

    await expect(stageCommittableChanges('/repo')).resolves.toBe(true);

    expect(mocks.execFileAsync).toHaveBeenNthCalledWith(1, 'git', [
      '-C',
      '/repo',
      'add',
      '-A',
      '--',
      '.',
      ':(exclude).sisyphus',
      ':(exclude).sisyphus/**',
    ]);
  });

  it('clones into a safe repo path and prepares permissions', async () => {
    mocks.existsSync.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mocks.execGitWithCredentials.mockResolvedValue(undefined);
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await cloneRepository('https://github.com/acme/repo.git', '/tmp/openlinear-repos/repo', 'token', 'main');

    expect(mocks.rmSync).toHaveBeenCalledWith('/tmp/openlinear-repos/repo', { recursive: true, force: true });
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      ['clone', '--depth', '1', '--branch', 'main', 'https://github.com/acme/repo.git', '/tmp/openlinear-repos/repo'],
      'token',
      'https://github.com/acme/repo.git',
    );
    expect(mocks.execFileAsync).toHaveBeenCalledWith('chmod', ['-R', 'a+rwX', '/tmp/openlinear-repos/repo']);
  });

  it('checks out branches without shelling through a command string', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await createBranch('/repo', 'openlinear/task;rm -rf /');

    expect(mocks.execFileAsync).toHaveBeenCalledWith('git', [
      '-C',
      '/repo',
      'checkout',
      '-B',
      'openlinear/task;rm -rf /',
    ]);
  });

  it('commits and pushes when staged changes exist', async () => {
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: ' M src/index.ts\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/index.ts\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://github.com/acme/repo.git\n', stderr: '' });
    mocks.execGitWithCredentials.mockResolvedValue(undefined);

    await expect(commitAndPush('/repo', 'openlinear/task-1', 'Fix Drag + Drop!', 'token')).resolves.toEqual({
      status: 'pushed',
    });

    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'commit', '-m', 'feat: fix drag  drop'],
      expect.objectContaining({ env: expect.objectContaining({ GIT_AUTHOR_NAME: 'OpenLinear' }) }),
    );
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      ['-C', '/repo', 'push', '--force-with-lease', '-u', 'origin', 'openlinear/task-1'],
      'token',
      'https://github.com/acme/repo.git',
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });

  it('returns no_changes before committing when nothing relevant changed', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '?? .sisyphus/tmp\n', stderr: '' });

    await expect(commitAndPush('/repo', 'branch', 'Task')).resolves.toEqual({ status: 'no_changes' });

    expect(mocks.execGitWithCredentials).not.toHaveBeenCalled();
  });

  it('returns failed with stderr when git operations fail', async () => {
    mocks.execFileAsync.mockRejectedValueOnce({ stderr: 'fatal: bad repo\n', message: 'bad' });

    await expect(commitAndPush('/repo', 'branch', 'Task')).resolves.toEqual({
      status: 'failed',
      reason: 'fatal: bad repo',
    });
  });

  it('creates pull requests or falls back to compare links', async () => {
    await expect(createPullRequest('acme/repo', 'feature', 'main', 'Task', null, null)).resolves.toEqual({
      url: 'https://github.com/acme/repo/compare/main...feature',
      type: 'compare',
    });

    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ html_url: 'https://github.com/acme/repo/pull/1' }),
    });
    await expect(createPullRequest('acme/repo', 'feature', 'main', 'Task', 'Body', 'token')).resolves.toEqual({
      url: 'https://github.com/acme/repo/pull/1',
      type: 'pr',
    });

    mocks.fetch.mockResolvedValueOnce({ ok: false, text: async () => 'nope' });
    await expect(createPullRequest('acme/repo', 'feature', 'main', 'Task', null, 'token')).resolves.toEqual({
      url: 'https://github.com/acme/repo/compare/main...feature',
      type: 'compare',
    });
  });
});
