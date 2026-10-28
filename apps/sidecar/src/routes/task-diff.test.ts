import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, createErrorHandler } from '../lib/errors';
import { GitConfigPolicyError } from '../sandbox/git-hardening';
import type { ComputeTaskDiffInput } from '../services/review/git-diff';
import type { ResolvedTaskWorkspace, TaskDiffResponse } from '../services/review/types';

/**
 * GET /api/tasks/:id/diff — auth, authorization, error mapping and
 * single-flight, with the resolver and the computation mocked; plus an
 * end-to-end request against a real fixture repository.
 */
const mocks = vi.hoisted(() => ({
  requireSidecarAuth: vi.fn(),
  authorize: vi.fn(),
  resolve: vi.fn(),
  compute: vi.fn(),
}));

vi.mock('../auth/principal', () => ({
  requireSidecarAuth: mocks.requireSidecarAuth,
  credentialOf: (req: Request & { credential?: unknown }) => req.credential,
}));
vi.mock('../auth/task-access', () => ({ authorizeTaskAccess: mocks.authorize }));
vi.mock('../services/review/workspace-resolver', () => ({ resolveTaskWorkspace: mocks.resolve }));
vi.mock('../services/review/git-diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/review/git-diff')>();
  return { ...actual, computeTaskDiff: mocks.compute };
});

const actualGitDiff = await vi.importActual<typeof import('../services/review/git-diff')>('../services/review/git-diff');
const { default: router, taskDiffComputationsInFlight } = await import('./task-diff');

const gitAvailable = spawnSync('git', ['--version']).status === 0;

let server: Server | undefined;
let baseUrl = '';
let fixtureRoot = '';

function authenticate(req: Request & { credential?: unknown }, _res: Response, next: NextFunction): void {
  req.credential = { principal: { userId: 'user-1', authSource: 'session', scopes: [], workspaceRestriction: null, tokenHash: 'h' }, token: 'token-1' };
  next();
}

function workspace(overrides: Partial<ResolvedTaskWorkspace> = {}): ResolvedTaskWorkspace {
  return { worktreePath: '/fake/worktree', branch: 'openlinear/run-1', baseRef: 'main', ownerUserId: 'user-1', source: 'v2', ...overrides };
}

function response(overrides: Partial<TaskDiffResponse> = {}): TaskDiffResponse {
  return {
    base: { ref: 'origin/main', sha: 'a'.repeat(40) },
    head: { ref: 'openlinear/run-1', sha: 'b'.repeat(40), dirty: true },
    revision: 'c'.repeat(64),
    source: 'v2',
    files: [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 1, hunks: [] }],
    truncated: false,
    stats: { files: 1, additions: 1, deletions: 1, shownFiles: 1, binaryFiles: 0, untrackedFiles: 0 },
    limits: { maxFiles: 300, maxLinesPerFile: 5000, maxTotalLines: 20000, maxLineChars: 1000, maxPatchBytes: 8388608, maxUntrackedFileBytes: 524288 },
    ...overrides,
  };
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: 'Bearer token-1' } });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text, headers: res.headers };
}

beforeAll(async () => {
  fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-task-diff-route-')));
  const app = express();
  app.use('/api/tasks', router);
  // Stand-in for the execution router mounted after it in app.ts.
  app.use('/api/tasks', (req: Request & { credential?: unknown }, res: Response) => {
    res.json({ reached: req.path, sawCredential: req.credential !== undefined });
  });
  app.use(createErrorHandler());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSidecarAuth.mockImplementation(authenticate);
  mocks.authorize.mockResolvedValue({ id: 'task-1' });
  mocks.resolve.mockResolvedValue(workspace());
  mocks.compute.mockResolvedValue(response());
});

describe('GET /api/tasks/:id/diff', () => {
  it('serves the diff with the contract shape and no-store caching', async () => {
    const res = await get('/api/tasks/task-1/diff');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(response());
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mocks.compute).toHaveBeenCalledWith({ worktreePath: '/fake/worktree', baseRef: 'main', source: 'v2' });
    expect(mocks.resolve).toHaveBeenCalledWith('task-1', { persistedBranch: expect.any(Function) });
  });

  it('serves the run owner without a control-plane call and forwards ?base', async () => {
    await get('/api/tasks/task-1/diff?base=origin%2Fmain');
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.compute).toHaveBeenCalledWith(expect.objectContaining({ base: 'origin/main' }));
  });

  it('refuses a different principal than the run owner', async () => {
    mocks.resolve.mockResolvedValue(workspace({ ownerUserId: 'someone-else' }));
    const res = await get('/api/tasks/task-1/diff');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RUN_PRINCIPAL_MISMATCH' });
    expect(mocks.compute).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('authorizes an unknown owner through the control plane (full access) and passes its errors through', async () => {
    mocks.resolve.mockResolvedValue(workspace({ ownerUserId: null, source: 'legacy-disk', baseRef: null }));
    expect((await get('/api/tasks/task-1/diff')).status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-1' }), 'task-1', 'full');

    mocks.authorize.mockRejectedValueOnce(new HttpError(403, 'OWNERSHIP_REQUIRED', 'Required role is missing'));
    const denied = await get('/api/tasks/task-1/diff');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'OWNERSHIP_REQUIRED' });

    mocks.authorize.mockRejectedValueOnce(new HttpError(503, 'CLOUD_API_UNREACHABLE', 'OpenLinear API is unreachable'));
    expect((await get('/api/tasks/task-1/diff')).body).toMatchObject({ code: 'CLOUD_API_UNREACHABLE' });
  });

  it('answers 404 DIFF_WORKSPACE_NOT_FOUND (after authorization) when there is no checkout', async () => {
    mocks.resolve.mockResolvedValue(null);
    const res = await get('/api/tasks/task-1/diff');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DIFF_WORKSPACE_NOT_FOUND' });
    expect(String(res.body.message)).toMatch(/no attempt worktree/i);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), 'task-1', 'full');
    expect(mocks.compute).not.toHaveBeenCalled();
  });

  it('maps a config-policy refusal to 409 with key names only', async () => {
    mocks.compute.mockRejectedValue(new GitConfigPolicyError(
      '[git] refusing to run in /secret/worktree: repository config contains keys the sidecar does not allow (diff.evil.textconv)',
      ['diff.evil.textconv'],
    ));
    const res = await get('/api/tasks/task-1/diff');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'GIT_CONFIG_UNSAFE', details: { keys: ['diff.evil.textconv'] } });
    expect(res.text).not.toContain('/secret/worktree');
  });

  it('rejects an unsafe base and a bad task id before doing any work', async () => {
    for (const query of ['?base=--output%3Dx', '?base=a..b', '?base=a&base=b']) {
      const res = await get(`/api/tasks/task-1/diff${query}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_BASE_REF' });
    }
    const badId = await get('/api/tasks/%20%20/diff');
    expect(badId.status).toBe(400);
    expect(badId.body).toMatchObject({ code: 'INVALID_TASK_ID' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.compute).not.toHaveBeenCalled();
  });

  it('answers 500 DIFF_FAILED without leaking git stderr', async () => {
    const failure = Object.assign(new Error('Command failed: git diff\nfatal: /secret/path is broken'), { code: 128, stderr: 'fatal: /secret/path is broken' });
    mocks.compute.mockRejectedValue(failure);
    const res = await get('/api/tasks/task-1/diff');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'DIFF_FAILED', message: 'Failed to compute the task diff' });
    expect(res.text).not.toContain('secret');
  });

  it('shares one computation between concurrent requests', async () => {
    let release: (value: TaskDiffResponse) => void = () => undefined;
    mocks.compute.mockImplementation(() => new Promise<TaskDiffResponse>((resolve) => {
      release = resolve;
    }));
    const first = get('/api/tasks/task-1/diff');
    const second = get('/api/tasks/task-1/diff');
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(taskDiffComputationsInFlight()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release(response({ revision: 'd'.repeat(64) }));
    const [a, b] = await Promise.all([first, second]);
    expect(mocks.compute).toHaveBeenCalledTimes(1);
    expect(a.body.revision).toBe('d'.repeat(64));
    expect(b.body.revision).toBe('d'.repeat(64));
    expect(taskDiffComputationsInFlight()).toBe(0);

    // A different base is a different computation.
    mocks.compute.mockResolvedValue(response());
    await Promise.all([get('/api/tasks/task-1/diff?base=main'), get('/api/tasks/task-1/diff')]);
    expect(mocks.compute).toHaveBeenCalledTimes(3);
  });

  it('does not authenticate or handle other /api/tasks paths', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/x/execute`, { method: 'POST' });
    expect(await res.json()).toEqual({ reached: '/x/execute', sawCredential: false });
    const logs = await get('/api/tasks/x/logs');
    expect(logs.body).toEqual({ reached: '/x/logs', sawCredential: false });
    expect(mocks.requireSidecarAuth).not.toHaveBeenCalled();
  });

  it('requires authentication on the diff route itself', async () => {
    mocks.requireSidecarAuth.mockImplementation((_req: Request, res: Response) => {
      res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED', message: 'Authentication required' });
    });
    const res = await get('/api/tasks/task-1/diff');
    expect(res.status).toBe(401);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.skipIf(!gitAvailable)('computes a real diff end to end and refuses a planted driver with 409', async () => {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: fixtureRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid',
    };
    const repo = join(fixtureRoot, 'repo');
    const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'ignore' });
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
    writeFileSync(join(repo, 'a.txt'), 'before\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(['checkout', '-q', '-b', 'openlinear/run-1']);
    writeFileSync(join(repo, 'a.txt'), 'after\n');
    mocks.compute.mockImplementation((input: ComputeTaskDiffInput) => actualGitDiff.computeTaskDiff(input));
    mocks.resolve.mockResolvedValue(workspace({ worktreePath: repo }));

    const ok = await get('/api/tasks/task-1/diff');
    expect(ok.status).toBe(200);
    const body = ok.body as unknown as TaskDiffResponse;
    expect(body.base.ref).toBe('origin/main');
    expect(body.head).toMatchObject({ ref: 'openlinear/run-1', dirty: true });
    expect(body.files[0].hunks[0].lines).toEqual([{ kind: 'del', oldNo: 1, text: 'before' }, { kind: 'add', newNo: 1, text: 'after' }]);

    const payload = join(fixtureRoot, 'payload.sh');
    git(['config', 'diff.evil.textconv', payload]);
    const refused = await get('/api/tasks/task-1/diff');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'GIT_CONFIG_UNSAFE', details: { keys: ['diff.evil.textconv'] } });
    expect(refused.text).not.toContain(payload);
  });
});
