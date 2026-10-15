import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  rmdirSync: vi.fn(),
  execGit: vi.fn(),
  execGitWithCredentials: vi.fn(),
  assertSafeCloneUrl: vi.fn((url) => url),
  assertSafeRefName: vi.fn((ref) => ref),
  getGitIdentityEnv: vi.fn(() => ({ GIT_AUTHOR_NAME: 'OpenLinear' })),
  buildReposPath: vi.fn((...segments) => `/repos/${segments.join('/')}`),
  assertPathInsideReposDir: vi.fn((path) => path),
}));

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  rmSync: mocks.rmSync,
  rmdirSync: mocks.rmdirSync,
}));

vi.mock('./git-credentials', () => ({
  execGit: mocks.execGit,
  execGitWithCredentials: mocks.execGitWithCredentials,
  assertSafeCloneUrl: mocks.assertSafeCloneUrl,
  assertSafeRefName: mocks.assertSafeRefName,
}));
vi.mock('./git-identity', () => ({ getGitIdentityEnv: mocks.getGitIdentityEnv }));
vi.mock('./repo-storage', () => ({
  buildReposPath: mocks.buildReposPath,
  assertPathInsideReposDir: mocks.assertPathInsideReposDir,
}));
vi.mock('../workspace/local-worktree', () => ({
  withRepoLock: async (_key, fn) => fn(),
}));

const {
  cleanupBatch,
  createBatchBranch,
  createBatchWorktree,
  createWorktree,
  ensureMainRepo,
  listWorktrees,
  mergeBranch,
  pushBranch,
  removeWorktree,
} = await import('./worktree');

describe('worktree helpers', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.existsSync.mockReturnValue(false);
    mocks.buildReposPath.mockImplementation((...segments) => `/repos/${segments.join('/')}`);
    mocks.assertPathInsideReposDir.mockImplementation((path) => path);
    mocks.assertSafeCloneUrl.mockImplementation((url) => url);
    mocks.assertSafeRefName.mockImplementation((ref) => ref);
    mocks.getGitIdentityEnv.mockReturnValue({ GIT_AUTHOR_NAME: 'OpenLinear' });
    mocks.execGit.mockResolvedValue({ stdout: '', stderr: '' });
    mocks.execGitWithCredentials.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('fetches an existing bare repo or clones a new one', async () => {
    mocks.existsSync.mockReturnValueOnce(true);
    await expect(ensureMainRepo('project-1', 'https://github.com/acme/repo.git', 'token')).resolves.toBe('/repos/project-1/.main');
    expect(mocks.assertSafeCloneUrl).toHaveBeenCalledWith('https://github.com/acme/repo.git', 'clone URL');
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      ['-C', '/repos/project-1/.main', 'fetch', '--prune', '--no-tags', '--', 'https://github.com/acme/repo.git', '+refs/heads/*:refs/remotes/origin/*'],
      'token',
      'https://github.com/acme/repo.git',
    );

    mocks.execGitWithCredentials.mockClear();
    mocks.existsSync.mockReturnValue(false);
    await expect(ensureMainRepo('project-1', 'https://github.com/acme/repo.git', null)).resolves.toBe('/repos/project-1/.main');
    expect(mocks.mkdirSync).toHaveBeenCalledWith('/repos/project-1', { recursive: true });
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      ['clone', '--bare', '--filter=blob:none', '--', 'https://github.com/acme/repo.git', '/repos/project-1/.main'],
      null,
      'https://github.com/acme/repo.git',
    );

    mocks.mkdirSync.mockClear();
    mocks.execGitWithCredentials.mockClear();
    mocks.existsSync
      .mockReset()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await expect(ensureMainRepo('project-1', 'https://github.com/acme/repo.git', null)).resolves.toBe('/repos/project-1/.main');

    expect(mocks.mkdirSync).not.toHaveBeenCalled();
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      ['clone', '--bare', '--filter=blob:none', '--', 'https://github.com/acme/repo.git', '/repos/project-1/.main'],
      null,
      'https://github.com/acme/repo.git',
    );
  });

  it('rejects an unsafe clone URL before touching the filesystem', async () => {
    mocks.assertSafeCloneUrl.mockImplementationOnce(() => {
      throw new Error('[Sidecar] Refusing unsafe clone URL: only https: URLs are allowed');
    });

    await expect(ensureMainRepo('project-1', 'ext::sh -c evil', null)).rejects.toThrow('Refusing unsafe clone URL');
    expect(mocks.execGitWithCredentials).not.toHaveBeenCalled();
  });

  it('rethrows main repo preparation failures', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.execGitWithCredentials.mockRejectedValue(new Error('fetch failed'));

    await expect(ensureMainRepo('project-1', 'https://github.com/acme/repo.git', 'token'))
      .rejects.toThrow('fetch failed');
  });

  it('creates unique attempt worktrees with credential-scoped blob materialization', async () => {
    await expect(createWorktree('project-1', 'batch-1', 'task-1', 'main', 'token', 'https://github.com/acme/repo.git'))
      .resolves.toBe('/repos/project-1/batch-batch-1/task-task-1');
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith([
      '-C', '/repos/project-1/.main', 'worktree', 'add', '/repos/project-1/batch-batch-1/task-task-1',
      '-b', 'openlinear/batch-1/task-1', '--', 'refs/remotes/origin/main',
    ], 'token', 'https://github.com/acme/repo.git');
    expect(mocks.execGit).not.toHaveBeenCalled();
    await expect(createBatchWorktree('project-1', 'batch-1', 'openlinear/batch-1', 'main'))
      .resolves.toBe('/repos/project-1/batch-batch-1/combined');
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith([
      '-C', '/repos/project-1/.main', 'worktree', 'add', '/repos/project-1/batch-batch-1/combined',
      '-b', 'openlinear/batch-1', '--', 'refs/remotes/origin/main',
    ], null, undefined);
  });

  it('rejects an unsafe default branch before creating a worktree', async () => {
    mocks.assertSafeRefName.mockImplementationOnce(() => {
      throw new Error('[Sidecar] Refusing unsafe default branch: "-x"');
    });

    await expect(createWorktree('project-1', 'batch-1', 'task-1', '-x')).rejects.toThrow(
      'Refusing unsafe default branch',
    );
    expect(mocks.execGit).not.toHaveBeenCalled();
  });

  it('refuses an existing attempt without deleting or unregistering it', async () => {
    mocks.existsSync.mockReturnValue(true);
    await expect(createWorktree('project-1', 'batch-1', 'task-1', 'main')).rejects.toThrow('already exists');
    await expect(createBatchWorktree('project-1', 'batch-1', 'openlinear/batch-1', 'main')).rejects.toThrow('already exists');
    expect(mocks.execGit).not.toHaveBeenCalled();
    expect(mocks.execGitWithCredentials).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('creates a combined worktree without recreating an existing batch directory', async () => {
    mocks.existsSync.mockImplementation((path) => path === '/repos/project-1/batch-batch-1');
    mocks.execGit.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(createBatchWorktree('project-1', 'batch-1', 'openlinear/batch-1', 'main')).resolves.toBe(
      '/repos/project-1/batch-batch-1/combined',
    );

    expect(mocks.mkdirSync).not.toHaveBeenCalled();
  });

  it('retains partial acquisition evidence on Git failure', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execGitWithCredentials.mockRejectedValue(new Error('add failed'));
    await expect(createWorktree('project-1', 'batch-1', 'task-1', 'main')).rejects.toThrow('add failed');
    await expect(createBatchWorktree('project-1', 'batch-1', 'openlinear/batch-1', 'main')).rejects.toThrow('add failed');
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.execGit).not.toHaveBeenCalled();
  });

  it('lists, removes, and cleans up worktrees safely', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.execGit.mockResolvedValueOnce({
      stdout: 'worktree /repos/project-1/.main\n\nworktree /repos/project-1/batch-batch-1/task-task-1\n',
      stderr: '',
    });

    await expect(listWorktrees('project-1')).resolves.toEqual([
      '/repos/project-1/.main',
      '/repos/project-1/batch-batch-1/task-task-1',
    ]);

    await removeWorktree('project-1', '/repos/project-1/batch-batch-1/task-task-1');
    expect(mocks.execGit).toHaveBeenCalledWith([
      '-C',
      '/repos/project-1/.main',
      'worktree',
      'remove',
      '/repos/project-1/batch-batch-1/task-task-1',
    ]);

    mocks.execGit.mockClear();
    mocks.execGit.mockResolvedValueOnce({
      stdout: 'worktree /repos/project-1/batch-batch-1/task-task-1\nworktree /outside\n',
      stderr: '',
    });
    mocks.assertPathInsideReposDir.mockImplementation((path) => {
      if (path === '/outside') throw new Error('outside');
      return path;
    });

    await cleanupBatch('project-1', 'batch-1');
    expect(mocks.rmdirSync).toHaveBeenCalledWith('/repos/project-1/batch-batch-1');
  });

  it('surfaces remove failures without deleting retained paths', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execGit.mockRejectedValueOnce(new Error('remove failed'));

    await expect(removeWorktree('project-1', '/repos/project-1/batch-batch-1/task-task-1')).rejects.toThrow('remove failed');

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('ignores listed worktrees outside the target batch', async () => {
    mocks.existsSync.mockImplementation((path) => path === '/repos/project-1/.main');
    mocks.execGit.mockResolvedValueOnce({
      stdout: 'worktree /repos/project-1/other/task-task-1\n',
      stderr: '',
    });

    await cleanupBatch('project-1', 'batch-1');

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('surfaces list errors and preserves the batch directory', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.execGit.mockRejectedValue(new Error('list failed'));

    await expect(listWorktrees('project-1')).rejects.toThrow('list failed');
    await expect(cleanupBatch('project-1', 'batch-1')).rejects.toThrow('list failed');
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.rmdirSync).not.toHaveBeenCalled();
  });

  it('returns an empty worktree list when the main repo is missing', async () => {
    mocks.existsSync.mockReturnValue(false);

    await expect(listWorktrees('project-1')).resolves.toEqual([]);

    expect(mocks.execGit).not.toHaveBeenCalled();
  });

  it('retains the batch directory when cleanup inspection fails', async () => {
    mocks.execGit.mockResolvedValueOnce({ stdout: '', stderr: '' });
    mocks.existsSync.mockImplementation((path) => {
      if (path === '/repos/project-1/batch-batch-1') {
        throw new Error('stat failed');
      }
      return true;
    });
    mocks.existsSync
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        throw new Error('stat failed');
      })
      .mockImplementationOnce(() => true);

    await expect(cleanupBatch('project-1', 'batch-1')).rejects.toThrow('stat failed');

    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.rmdirSync).not.toHaveBeenCalled();
  });

  it('surfaces cleanup inspection errors without recursive deletion', async () => {
    mocks.execGit.mockResolvedValueOnce({ stdout: '', stderr: '' });
    mocks.existsSync
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        throw new Error('stat failed');
      })
      .mockImplementationOnce(() => false);

    await expect(cleanupBatch('project-1', 'batch-1')).rejects.toThrow('stat failed');

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('merges branches by updating the target ref and reports conflicts', async () => {
    mocks.execGit
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'original-sha\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'merge-sha\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(true);
    expect(mocks.assertSafeRefName).toHaveBeenCalledWith('openlinear/task-1', 'task branch');
    expect(mocks.assertSafeRefName).toHaveBeenCalledWith('openlinear/batch', 'target branch');
    expect(mocks.execGit).toHaveBeenCalledWith([
      '-C',
      '/repos/project-1/.main',
      'worktree',
      'add',
      '--detach',
      '/repos/project-1/merge-temp-openlinear-task-1',
      '--',
      'openlinear/batch',
    ]);
    expect(mocks.execGit).toHaveBeenCalledWith(
      [
        '-C',
        '/repos/project-1/merge-temp-openlinear-task-1',
        'merge',
        '--no-ff',
        '-m',
        'Merge openlinear/task-1',
        '--',
        'openlinear/task-1',
      ],
      expect.objectContaining({ env: expect.objectContaining({ GIT_AUTHOR_NAME: 'OpenLinear' }) }),
    );
    expect(mocks.execGit).toHaveBeenCalledWith([
      '-C',
      '/repos/project-1/.main',
      'update-ref',
      'refs/heads/openlinear/batch',
      'merge-sha',
      'original-sha',
    ]);

    mocks.execGit.mockReset();
    mocks.execGit
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValue({ stdout: '', stderr: '' });

    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(false);
  });

  it('rejects unsafe branch names before merging, without attempting the merge itself', async () => {
    mocks.assertSafeRefName.mockImplementationOnce(() => {
      throw new Error('[Sidecar] Refusing unsafe task branch: "-x"');
    });

    await expect(mergeBranch('project-1', '-x', 'openlinear/batch')).resolves.toBe(false);
    expect(mocks.execGit).not.toHaveBeenCalled();
  });

  it('retains partial merge acquisition when setup fails', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execGit.mockRejectedValueOnce(new Error('add failed'));
    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(false);
    expect(mocks.execGit).toHaveBeenCalledTimes(1);
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('refuses an existing merge directory before changing any Git state', async () => {
    mocks.existsSync.mockReturnValue(true);
    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(false);
    expect(mocks.execGit).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('retains merge work and does not advance the target when cleanup fails', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execGit
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'original-sha', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'merge-sha', stderr: '' })
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('final cleanup failed'));
    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(false);
    expect(mocks.execGit.mock.calls.some(([args]) => args.includes('update-ref'))).toBe(false);
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('creates and pushes batch branches', async () => {
    await createBatchBranch('project-1', 'openlinear/batch-1', 'main');
    expect(mocks.assertSafeRefName).toHaveBeenCalledWith('openlinear/batch-1', 'batch branch');
    expect(mocks.assertSafeRefName).toHaveBeenCalledWith('main', 'default branch');
    expect(mocks.execGit).toHaveBeenCalledWith([
      '-C',
      '/repos/project-1/.main',
      'branch',
      '--',
      'openlinear/batch-1',
      'refs/remotes/origin/main',
    ]);

    await pushBranch('project-1', 'openlinear/batch-1', 'https://github.com/acme/repo.git', 'token');
    expect(mocks.assertSafeCloneUrl).toHaveBeenCalledWith('https://github.com/acme/repo.git', 'clone URL');
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      [
        '-C',
        '/repos/project-1/.main',
        'push',
        '--force-with-lease=refs/heads/openlinear/batch-1:',
        '--',
        'https://github.com/acme/repo.git',
        'openlinear/batch-1:refs/heads/openlinear/batch-1',
      ],
      'token',
      'https://github.com/acme/repo.git',
    );
  });

  it('rejects an unsafe clone URL before pushing a batch branch', async () => {
    mocks.assertSafeCloneUrl.mockImplementationOnce(() => {
      throw new Error('[Sidecar] Refusing unsafe clone URL: only https: URLs are allowed');
    });

    await expect(
      pushBranch('project-1', 'openlinear/batch-1', 'ext::sh -c evil', 'token'),
    ).rejects.toThrow('Refusing unsafe clone URL');
    expect(mocks.execGitWithCredentials).not.toHaveBeenCalled();
  });
});
