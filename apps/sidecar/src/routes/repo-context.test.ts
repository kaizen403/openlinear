import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express, { type NextFunction, type Response } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthedRequest, SidecarPrincipal } from '../auth/principal';
import { setCloudApiConfig } from '../config/cloud-api';
import { ContextEngine } from '../context';
import { createErrorHandler, HttpError } from '../lib/errors';
import type { TaskContextSource } from './repo-context';

/**
 * FE-11 / W16b `GET /api/tasks/:id/related-files`: authenticated like every
 * sidecar route, reads the task as the caller, finds the project repository
 * on this device (local folder, else the sidecar's mirror) and answers 200
 * with citations — or an empty list with a status and reason.
 */

vi.mock('../auth/principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/principal')>();
  return {
    ...actual,
    requireSidecarAuth: (req: AuthedRequest, res: Response, next: NextFunction) => {
      const token = actual.bearerFrom(req);
      if (!token) {
        res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED', message: 'Authentication required' });
        return;
      }
      const principal: SidecarPrincipal = { userId: token, authSource: 'session', scopes: [], workspaceRestriction: null, tokenHash: 'h' };
      req.principal = principal;
      req.credential = { principal, token };
      req.userId = principal.userId;
      next();
    },
  };
});

const { createRepoContextRouter, loadTaskContextSource, mirrorIdentity, resolveProjectRepository } = await import('./repo-context');

let root = '';
let reposRoot = '';
let folder = '';
let folderHead = '';
let mirrorHead = '';
let server: Server | undefined;
let base = '';
const state: { tasks: Record<string, TaskContextSource | HttpError>; enabled: boolean; engine: ContextEngine; slowEngine: ContextEngine } = {
  tasks: {},
  enabled: true,
  engine: new ContextEngine({ cache: null }),
  slowEngine: new ContextEngine({ cache: null }),
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim();
}

function repo(path: string, files: Record<string, string>): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'base');
  return git(path, 'rev-parse', 'HEAD');
}

const task = (project: TaskContextSource['project']): TaskContextSource => ({
  title: 'Users get logged out after an hour',
  description: 'The access token is not renewed before it expires.',
  labels: ['auth'],
  project,
});

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-related-files-')));
  reposRoot = join(root, 'repos');
  folder = join(root, 'my-app');
  folderHead = repo(folder, {
    'src/auth/session.ts': 'export async function refreshAccessToken() {\n  // renew the access token before it expires\n}\n',
    'src/billing/invoice.ts': 'export function computeTax() {}\n',
  });
  const upstream = join(root, 'upstream');
  mirrorHead = repo(upstream, { 'lib/session_refresh.py': 'def renew_access_token(session):\n    """Renew the token before it expires."""\n' });
  const mirror = join(reposRoot, 'acme', 'app.git');
  mkdirSync(dirname(mirror), { recursive: true });
  git(root, 'clone', '-q', '--bare', upstream, mirror);
  git(mirror, 'update-ref', 'refs/remotes/origin/main', mirrorHead);

  state.tasks = {
    local: task({ localPath: folder, repository: { fullName: 'acme/app', cloneUrl: 'https://github.com/acme/app.git', defaultBranch: 'main' } }),
    mirror: task({ localPath: null, repository: { fullName: 'acme/app', cloneUrl: 'https://github.com/acme/app.git', defaultBranch: 'main' } }),
    uncloned: task({ localPath: null, repository: { fullName: 'acme/other', cloneUrl: 'https://github.com/acme/other.git', defaultBranch: 'main' } }),
    gone: task({ localPath: join(root, 'deleted-folder'), repository: null }),
    loose: task(null),
    denied: new HttpError(403, 'OWNERSHIP_REQUIRED', 'Required role is missing'),
  };

  const loadTask = async (_credential: unknown, taskId: string) => {
    const found = state.tasks[taskId];
    if (!found) throw new HttpError(404, 'NOT_FOUND', 'Task not found');
    if (found instanceof HttpError) throw found;
    return found;
  };
  const app = express();
  const common = { loadTask, reposRoot: () => reposRoot, settings: () => ({ enabled: state.enabled, maxChars: 6_000 }) };
  app.use('/api/tasks', createRepoContextRouter({ ...common, engine: () => state.engine }));
  // The same route answering without waiting for an index build.
  app.use('/nowait/api/tasks', createRepoContextRouter({ ...common, engine: () => state.slowEngine, waitMs: 0 }));
  app.use(createErrorHandler());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  setCloudApiConfig(null);
});

async function related(taskId: string, token: string | null = 'user-1', prefix = '') {
  const res = await fetch(`${base}${prefix}/api/tasks/${taskId}/related-files`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() as Record<string, unknown>, headers: res.headers };
}

describe('GET /api/tasks/:id/related-files', () => {
  it('requires authentication', async () => {
    expect((await related('local', null)).status).toBe(401);
  });

  it('cites related files of the local folder at its HEAD (no file content)', async () => {
    const { status, body, headers } = await related('local');
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({ status: 'ready', reason: null, repository: { source: 'local-folder', commit: folderHead } });
    const files = body.files as Array<Record<string, unknown>>;
    expect(files[0]).toMatchObject({ path: 'src/auth/session.ts', startLine: 1, endLine: 3 });
    expect(files[0]?.reasons).toEqual(expect.arrayContaining(['declares refreshAccessToken']));
    expect(JSON.stringify(body)).not.toContain('renew the access token before');
  });

  it("uses the sidecar's mirror at the default branch when there is no local folder", async () => {
    const { body } = await related('mirror');
    expect(body).toMatchObject({ status: 'ready', repository: { source: 'mirror', commit: mirrorHead } });
    expect((body.files as Array<{ path: string }>)[0]?.path).toBe('lib/session_refresh.py');
  });

  it('answers 200 with a reason when no repository is on this device, or when turned off', async () => {
    expect((await related('uncloned')).body).toMatchObject({ status: 'unavailable', files: [], reason: expect.stringContaining('has not been cloned on this device') });
    expect((await related('gone')).body).toMatchObject({ status: 'unavailable', reason: 'The project folder is not on this device' });
    expect((await related('loose')).body).toMatchObject({ status: 'unavailable', reason: 'The task is not in a project' });
    state.enabled = false;
    try {
      expect((await related('local')).body).toMatchObject({ status: 'disabled', files: [] });
    } finally {
      state.enabled = true;
    }
  });

  it('says "indexing" (retry later) when the index is not ready in time', async () => {
    expect((await related('local', 'user-1', '/nowait')).body).toMatchObject({ status: 'indexing', files: [], retryAfterMs: 3_000 });
    await state.slowEngine.ensureIndex(folder, folderHead, `local:${folder}`);
    expect((await related('local', 'user-1', '/nowait')).body).toMatchObject({ status: 'ready' });
  });

  it('passes the control plane decision through', async () => {
    expect((await related('denied')).status).toBe(403);
    expect((await related('missing')).status).toBe(404);
  });
});

describe('repository resolution', () => {
  it('derives the mirror identity like the workspace does, refusing unsafe segments', () => {
    expect(mirrorIdentity('https://github.com/acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
    expect(mirrorIdentity('https://github.com/acme/bad name')).toBeNull();
    expect(mirrorIdentity('https://github.com/-acme/app')).toBeNull();
    expect(mirrorIdentity('not a url')).toBeNull();
  });

  it('refuses a local folder inside OpenLinear storage and a folder that is not the repository root', async () => {
    expect(await resolveProjectRepository({ localPath: join(reposRoot, 'acme', 'app.git'), repository: null }, reposRoot)).toEqual({ ok: false, reason: 'The project folder lies inside OpenLinear storage' });
    expect(await resolveProjectRepository({ localPath: join(folder, 'src'), repository: null }, reposRoot)).toEqual({ ok: false, reason: 'The project folder is not the root of a git repository' });
    expect(await resolveProjectRepository({ localPath: 'relative/path', repository: null }, reposRoot)).toEqual({ ok: false, reason: 'The project folder path is not absolute' });
    expect(await resolveProjectRepository({ localPath: null, repository: { fullName: 'a/b', cloneUrl: 'https://github.com/a/b.git', defaultBranch: '-bad' } }, reposRoot))
      .toEqual({ ok: false, reason: 'The repository default branch is not supported' });
  });

  it('reads the task and project as the caller', async () => {
    const calls: string[] = [];
    setCloudApiConfig({
      baseUrl: 'http://127.0.0.1:9',
      fetch: async (input) => {
        const url = String(input);
        calls.push(url.replace('http://127.0.0.1:9', ''));
        const body = url.endsWith('/api/tasks/t1')
          ? { id: 't1', title: 'T', description: null, projectId: 'p1', labels: [{ id: 'l1', name: 'auth', color: '#fff' }] }
          : url.endsWith('/api/projects/p1')
            ? { id: 'p1', localPath: '/home/me/app', repository: { id: 'r', name: 'app', fullName: 'acme/app', cloneUrl: 'https://github.com/acme/app.git', defaultBranch: 'main' } }
            : { error: 'Not found', code: 'NOT_FOUND' };
        return new Response(JSON.stringify(body), { status: url.endsWith('/api/tasks/t2') ? 404 : 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const credential = { principal: { userId: 'u', authSource: 'session' as const, scopes: [], workspaceRestriction: null, tokenHash: 'h' }, token: 'tok' };
    expect(await loadTaskContextSource(credential, 't1')).toEqual({
      title: 'T',
      description: null,
      labels: ['auth'],
      project: { localPath: '/home/me/app', repository: { fullName: 'acme/app', cloneUrl: 'https://github.com/acme/app.git', defaultBranch: 'main' } },
    });
    expect(calls).toEqual(['/api/tasks/t1', '/api/projects/p1']);
    await expect(loadTaskContextSource(credential, 't2')).rejects.toMatchObject({ statusCode: 404 });
  });
});
