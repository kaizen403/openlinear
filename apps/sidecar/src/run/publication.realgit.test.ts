import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEffectKey } from '@openlinear/execution-core';
import { commitMessage, createGitPublication } from './publication';
import { fakeSnapshot } from './test-support';
import { createLocalWorkspace } from './workspace';

/**
 * Publication effects against real git (local bare origin) and a loopback
 * GitHub stub: the commit is its own receipt (effect trailer), the remote
 * ref is the push receipt, a push never clobbers a moved branch, and an
 * existing PR is found instead of POSTing a second one.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('run publication (real git)', () => {
  let root = '';
  let origin = '';
  let github: Server | undefined;
  const posts: string[] = [];
  let existingPr: string | null = null;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ol-run-pub-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OPENLINEAR_ALLOW_FILE_GIT', '1');
    vi.stubEnv('OPENLINEAR_APP_DATA', root);
    vi.stubEnv('REPOS_DIR', '');
    origin = join(root, 'origin.git');
    git(root, ['init', '--bare', '--initial-branch=main', origin]);
    const seed = join(root, 'seed');
    mkdirSync(seed);
    git(seed, ['init']);
    writeFileSync(join(seed, 'README.md'), 'seed\n');
    git(seed, ['add', '.']);
    git(seed, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'seed']);
    git(seed, ['push', origin, 'HEAD:main']);
    posts.length = 0;
    existingPr = null;
    github = http.createServer((req, res) => {
      if (req.method === 'POST') {
        posts.push(req.url ?? '');
        existingPr = 'https://github.com/acme/repo/pull/5';
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ html_url: existingPr }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(existingPr ? [{ html_url: existingPr }] : []));
    });
    await new Promise<void>((resolve) => github?.listen(0, '127.0.0.1', () => resolve()));
    const address = github.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    vi.stubEnv('OPENLINEAR_GITHUB_API_URL', `http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (github) {
      github.closeAllConnections();
      await new Promise<void>((resolve) => github?.close(() => resolve()));
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('commits once with the effect trailer, pushes the exact commit and reuses an existing PR', async () => {
    const workspace = createLocalWorkspace();
    const snapshot = fakeSnapshot('task-1', { repository: { id: 'r', name: 'repo', fullName: 'acme/repo', cloneUrl: origin, defaultBranch: 'main' } });
    const ws = await workspace.acquire({ runId: 'run-pub-1', snapshot, token: null });
    expect(ws).toMatchObject({ branch: 'openlinear/run-pub-1', owned: true });
    expect(workspace.exists(ws)).toBe(true);
    const publication = createGitPublication();
    const key = runEffectKey('run-pub-1', 'git.commit');

    expect(await publication.findCommit({ worktree: ws.worktreePath, key })).toBeNull();
    expect(await publication.commit({ worktree: ws.worktreePath, title: 'Nothing yet', runId: 'run-pub-1', key })).toEqual({ status: 'no_changes' });
    writeFileSync(join(ws.worktreePath, 'feature.txt'), 'work\n');
    const committed = await publication.commit({ worktree: ws.worktreePath, title: 'Add the feature!', runId: 'run-pub-1', key });
    expect(committed.status).toBe('committed');
    const sha = committed.status === 'committed' ? committed.sha : '';
    expect(await publication.findCommit({ worktree: ws.worktreePath, key })).toBe(sha);
    expect(git(ws.worktreePath, ['log', '-1', '--format=%B'])).toContain(`OpenLinear-Effect: ${key}`);
    // Recovery probe: the commit is already there, a redispatch would find no changes.
    expect(await publication.commit({ worktree: ws.worktreePath, title: 'Add the feature!', runId: 'run-pub-1', key })).toEqual({ status: 'no_changes' });

    expect(await publication.remoteSha({ worktree: ws.worktreePath, branch: ws.branch, token: null })).toBeNull();
    await publication.push({ worktree: ws.worktreePath, branch: ws.branch, sha, token: null, expectedRemote: null });
    expect(await publication.remoteSha({ worktree: ws.worktreePath, branch: ws.branch, token: null })).toBe(sha);
    expect(git(origin, ['rev-parse', `refs/heads/${ws.branch}`])).toBe(sha);
    // Re-pushing the same commit is an idempotent no-op (recovery redispatch).
    await publication.push({ worktree: ws.worktreePath, branch: ws.branch, sha, token: null, expectedRemote: null });
    // Another writer moves the branch: the absent-target lease refuses to clobber it.
    const other = join(root, 'other');
    git(root, ['clone', origin, other]);
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
    git(other, ['add', '.']);
    git(other, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'theirs']);
    git(other, ['push', '--force', 'origin', `HEAD:refs/heads/${ws.branch}`]);
    await expect(publication.push({ worktree: ws.worktreePath, branch: ws.branch, sha, token: null, expectedRemote: null })).rejects.toThrow();
    expect(git(origin, ['rev-parse', `refs/heads/${ws.branch}`])).not.toBe(sha);

    expect(await publication.findPullRequest({ fullName: 'acme/repo', branch: ws.branch, base: 'main', token: 'gho_x' })).toBeNull();
    const url = await publication.createPullRequest({ fullName: 'acme/repo', branch: ws.branch, base: 'main', title: 't', body: 'b', token: 'gho_x' });
    expect(url).toBe('https://github.com/acme/repo/pull/5');
    expect(await publication.findPullRequest({ fullName: 'acme/repo', branch: ws.branch, base: 'main', token: 'gho_x' })).toBe(url);
    expect(posts).toHaveLength(1);
    expect(await publication.findPullRequest({ fullName: 'acme/repo', branch: ws.branch, base: 'main', token: null })).toBeNull();

    await workspace.release(ws);
    expect(workspace.exists(ws)).toBe(false);
  });

  it('formats a commit message whose trailer is the effect receipt', () => {
    expect(commitMessage('Fix: the *bug*', 'r1', 'r1:git.commit')).toBe('feat: fix the bug\n\nOpenLinear-Run: r1\nOpenLinear-Effect: r1:git.commit\n');
    expect(commitMessage('!!!', 'r1', 'k')).toContain('feat: openlinear task');
  });
});
