import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  execFileAsync: vi.fn(),
  execGitWithCredentials: vi.fn(),
  getGitIdentityEnv: vi.fn(() => ({ GIT_AUTHOR_NAME: 'OpenLinear' })),
  buildReposPath: vi.fn((...segments) => `/repos/${segments.join('/')}`),
  assertPathInsideReposDir: vi.fn((path) => path),
}));

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  rmSync: mocks.rmSync,
}));

vi.mock('./execution/exec', () => ({ execFileAsync: mocks.execFileAsync }));
vi.mock('./git-credentials', () => ({ execGitWithCredentials: mocks.execGitWithCredentials }));
vi.mock('./git-identity', () => ({ getGitIdentityEnv: mocks.getGitIdentityEnv }));
vi.mock('./repo-storage', () => ({
  buildReposPath: mocks.buildReposPath,
  assertPathInsideReposDir: mocks.assertPathInsideReposDir,
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
    mocks.getGitIdentityEnv.mockReturnValue({ GIT_AUTHOR_NAME: 'OpenLinear' });
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mocks.execGitWithCredentials.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('fetches an existing bare repo or clones a new one', async () => {
    mocks.existsSync.mockReturnValueOnce(true);
    await expect(ensureMainRepo('project-1', 'https://github.com/acme/repo.git', 'token')).resolves.toBe('/repos/project-1/.main');
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      ['-C', '/repos/project-1/.main', 'fetch', 'origin', '--prune'],
      'token',
      'https://github.com/acme/repo.git',
    );

    mocks.execGitWithCredentials.mockClear();
    mocks.existsSync.mockReturnValue(false);
    await expect(ensureMainRepo('project-1', 'https://github.com/acme/repo.git', null)).resolves.toBe('/repos/project-1/.main');
    expect(mocks.mkdirSync).toHaveBeenCalledWith('/repos/project-1', { recursive: true });
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      ['clone', '--bare', 'https://github.com/acme/repo.git', '/repos/project-1/.main'],
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
      ['clone', '--bare', 'https://github.com/acme/repo.git', '/repos/project-1/.main'],
      null,
      'https://github.com/acme/repo.git',
    );
  });

  it('rethrows main repo preparation failures', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.execGitWithCredentials.mockRejectedValue(new Error('fetch failed'));

    await expect(ensureMainRepo('project-1', 'https://github.com/acme/repo.git', 'token'))
      .rejects.toThrow('fetch failed');
  });

  it('creates task and combined worktrees after clearing stale branches', async () => {
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: 'worktree /repos/project-1/batch-batch-1/task-task-1\nbranch refs/heads/openlinear/task-1\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(createWorktree('project-1', 'batch-1', 'task-1', 'main')).resolves.toBe(
      '/repos/project-1/batch-batch-1/task-task-1',
    );
    expect(mocks.execFileAsync).toHaveBeenCalledWith('git', [
      '-C',
      '/repos/project-1/.main',
      'worktree',
      'add',
      '/repos/project-1/batch-batch-1/task-task-1',
      '-b',
      'openlinear/task-1',
      'main',
    ]);

    mocks.execFileAsync.mockClear();
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    await expect(createBatchWorktree('project-1', 'batch-1', 'openlinear/batch-1', 'main')).resolves.toBe(
      '/repos/project-1/batch-batch-1/combined',
    );
  });

  it('skips stale worktrees outside repo storage and handles stale cleanup failures', async () => {
    mocks.assertPathInsideReposDir.mockImplementation((path) => {
      if (path === '/outside/task') throw new Error('outside');
      return path;
    });
    mocks.existsSync.mockImplementation((path) => {
      if (path === '/repos/project-1/batch-batch-1') return true;
      if (path === '/repos/project-1/batch-batch-1/task-task-1') return false;
      if (path === '/repos/project-1/batch-batch-1/task-stale') return true;
      return false;
    });
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: [
          'worktree /outside/task',
          'branch refs/heads/openlinear/task-1',
          '',
          'worktree /repos/project-1/batch-batch-1/task-other',
          'branch refs/heads/openlinear/other',
          '',
          'worktree /repos/project-1/batch-batch-1/task-stale',
          'branch refs/heads/openlinear/task-1',
          '',
        ].join('\n'),
        stderr: '',
      })
      .mockRejectedValueOnce(new Error('remove stale failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(createWorktree('project-1', 'batch-1', 'task-1', 'main')).resolves.toBe(
      '/repos/project-1/batch-batch-1/task-task-1',
    );

    expect(mocks.rmSync).toHaveBeenCalledWith('/repos/project-1/batch-batch-1/task-stale', {
      recursive: true,
      force: true,
    });

    mocks.rmSync.mockClear();
    mocks.assertPathInsideReposDir.mockImplementation((path) => path);
    mocks.existsSync.mockImplementation((path) => {
      if (path === '/repos/project-1/batch-batch-1/task-stale') return false;
      return false;
    });
    mocks.execFileAsync
      .mockReset()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: 'worktree /repos/project-1/batch-batch-1/task-stale\nbranch refs/heads/openlinear/task-1\n',
        stderr: '',
      })
      .mockRejectedValueOnce(new Error('remove stale failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(createWorktree('project-1', 'batch-1', 'task-1', 'main')).resolves.toBe(
      '/repos/project-1/batch-batch-1/task-task-1',
    );

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('creates a combined worktree without recreating an existing batch directory', async () => {
    mocks.existsSync.mockImplementation((path) => path === '/repos/project-1/batch-batch-1');
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(createBatchWorktree('project-1', 'batch-1', 'openlinear/batch-1', 'main')).resolves.toBe(
      '/repos/project-1/batch-batch-1/combined',
    );

    expect(mocks.mkdirSync).not.toHaveBeenCalled();
  });

  it('removes partially-created task and batch worktrees after creation failures', async () => {
    mocks.existsSync
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('add failed'))
      .mockRejectedValueOnce(new Error('remove failed'));

    await expect(createWorktree('project-1', 'batch-1', 'task-1', 'main')).rejects.toThrow('add failed');
    expect(mocks.rmSync).toHaveBeenCalledWith('/repos/project-1/batch-batch-1/task-task-1', {
      recursive: true,
      force: true,
    });

    mocks.rmSync.mockClear();
    mocks.existsSync
      .mockReset()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mocks.execFileAsync
      .mockReset()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('batch add failed'))
      .mockRejectedValueOnce(new Error('batch remove failed'));

    await expect(createBatchWorktree('project-1', 'batch-1', 'openlinear/batch-1', 'main'))
      .rejects.toThrow('batch add failed');
    expect(mocks.rmSync).toHaveBeenCalledWith('/repos/project-1/batch-batch-1/combined', {
      recursive: true,
      force: true,
    });
  });

  it('does not remove failed worktree paths that were never created', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('add failed'));

    await expect(createWorktree('project-1', 'batch-1', 'task-1', 'main')).rejects.toThrow('add failed');

    expect(mocks.rmSync).not.toHaveBeenCalled();

    mocks.execFileAsync.mockReset();
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('batch add failed'));

    await expect(createBatchWorktree('project-1', 'batch-1', 'openlinear/batch-1', 'main'))
      .rejects.toThrow('batch add failed');

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('lists, removes, and cleans up worktrees safely', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.execFileAsync.mockResolvedValueOnce({
      stdout: 'worktree /repos/project-1/.main\n\nworktree /repos/project-1/batch-batch-1/task-task-1\n',
      stderr: '',
    });

    await expect(listWorktrees('project-1')).resolves.toEqual([
      '/repos/project-1/.main',
      '/repos/project-1/batch-batch-1/task-task-1',
    ]);

    await removeWorktree('project-1', '/repos/project-1/batch-batch-1/task-task-1');
    expect(mocks.execFileAsync).toHaveBeenCalledWith('git', [
      '-C',
      '/repos/project-1/.main',
      'worktree',
      'remove',
      '/repos/project-1/batch-batch-1/task-task-1',
      '--force',
    ]);

    mocks.execFileAsync.mockClear();
    mocks.execFileAsync.mockResolvedValueOnce({
      stdout: 'worktree /repos/project-1/batch-batch-1/task-task-1\nworktree /outside\n',
      stderr: '',
    });
    mocks.assertPathInsideReposDir.mockImplementation((path) => {
      if (path === '/outside') throw new Error('outside');
      return path;
    });

    await cleanupBatch('project-1', 'batch-1');
    expect(mocks.rmSync).toHaveBeenCalledWith('/repos/project-1/batch-batch-1', { recursive: true, force: true });
  });

  it('logs remove failures and only deletes worktree paths that remain on disk', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execFileAsync.mockRejectedValueOnce(new Error('remove failed'));

    await removeWorktree('project-1', '/repos/project-1/batch-batch-1/task-task-1');

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('ignores listed worktrees outside the target batch', async () => {
    mocks.existsSync.mockImplementation((path) => path === '/repos/project-1/.main');
    mocks.execFileAsync.mockResolvedValueOnce({
      stdout: 'worktree /repos/project-1/other/task-task-1\n',
      stderr: '',
    });

    await cleanupBatch('project-1', 'batch-1');

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('returns an empty worktree list and removes the batch directory when listing fails', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.execFileAsync.mockRejectedValue(new Error('list failed'));

    await expect(listWorktrees('project-1')).resolves.toEqual([]);
    await cleanupBatch('project-1', 'batch-1');

    expect(mocks.rmSync).toHaveBeenCalledWith('/repos/project-1/batch-batch-1', {
      recursive: true,
      force: true,
    });
  });

  it('returns an empty worktree list when the main repo is missing', async () => {
    mocks.existsSync.mockReturnValue(false);

    await expect(listWorktrees('project-1')).resolves.toEqual([]);

    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });

  it('force-removes the batch directory when cleanup throws after listing', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
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

    await cleanupBatch('project-1', 'batch-1');

    expect(mocks.rmSync).toHaveBeenCalledWith('/repos/project-1/batch-batch-1', {
      recursive: true,
      force: true,
    });
  });

  it('does not force-remove a batch directory that disappears after cleanup errors', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
    mocks.existsSync
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        throw new Error('stat failed');
      })
      .mockImplementationOnce(() => false);

    await cleanupBatch('project-1', 'batch-1');

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('merges branches by updating the target ref and reports conflicts', async () => {
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'merge-sha\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(true);
    expect(mocks.execFileAsync).toHaveBeenCalledWith('git', [
      '-C',
      '/repos/project-1/.main',
      'update-ref',
      'refs/heads/openlinear/batch',
      'merge-sha',
    ]);

    mocks.execFileAsync.mockReset();
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValue({ stdout: '', stderr: '' });

    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(false);
  });

  it('returns false and removes merge temp directories when setup and cleanup fail', async () => {
    mocks.existsSync
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mocks.execFileAsync
      .mockRejectedValueOnce(new Error('add failed'))
      .mockRejectedValueOnce(new Error('remove failed'));

    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(false);

    expect(mocks.rmSync).toHaveBeenCalledWith('/repos/project-1/merge-temp', { recursive: true, force: true });
  });

  it('clears stale merge temp directories before merging', async () => {
    mocks.existsSync.mockReturnValueOnce(true).mockReturnValue(false);
    mocks.execFileAsync
      .mockRejectedValueOnce(new Error('stale remove failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'merge-sha\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(true);

    expect(mocks.rmSync).toHaveBeenCalledWith('/repos/project-1/merge-temp', { recursive: true, force: true });
  });

  it('falls back to deleting merge temp after a successful merge cleanup failure', async () => {
    mocks.existsSync.mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValue(false);
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'merge-sha\n', stderr: '' })
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(true);

    expect(mocks.rmSync).toHaveBeenCalledWith('/repos/project-1/merge-temp', { recursive: true, force: true });
  });

  it('skips deleting merge temp when cleanup failures leave no directory behind', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'merge-sha\n', stderr: '' })
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('final cleanup failed'));

    await expect(mergeBranch('project-1', 'openlinear/task-1', 'openlinear/batch')).resolves.toBe(true);

    expect(mocks.rmSync).not.toHaveBeenCalled();
  });

  it('creates and pushes batch branches', async () => {
    await createBatchBranch('project-1', 'openlinear/batch-1', 'main');
    expect(mocks.execFileAsync).toHaveBeenCalledWith('git', [
      '-C',
      '/repos/project-1/.main',
      'branch',
      'openlinear/batch-1',
      'main',
    ]);

    await pushBranch('project-1', 'openlinear/batch-1', 'https://github.com/acme/repo.git', 'token');
    expect(mocks.execGitWithCredentials).toHaveBeenCalledWith(
      ['-C', '/repos/project-1/.main', 'push', '--force-with-lease', 'https://github.com/acme/repo.git', 'openlinear/batch-1'],
      'token',
      'https://github.com/acme/repo.git',
    );
  });
});
