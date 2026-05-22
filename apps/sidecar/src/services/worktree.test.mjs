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
