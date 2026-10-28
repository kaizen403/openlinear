/**
 * W02b PAT policy: the route registry is the single source of truth and the
 * middleware enforces it.
 *   - undeclared routes refuse every PAT (default deny), sessions unaffected;
 *   - registry scopes apply even when a route uses bare `requireAuth`, and win
 *     over a weaker inline `requireAuth([...])`;
 *   - read vs write scopes on representative routes of every module;
 *   - workspace-bound PATs and account-level repositories;
 *   - `lastUsedAt` is throttled without weakening revocation;
 *   - `localPath` is no longer authorized by the `x-openlinear-client` header.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { findRouteDeclaration, registerRouteDeclarations, type RouteDeclaration } from '../registry';
import { PAT_LAST_USED_WRITE_INTERVAL_MS, resetPatUsageThrottle } from '../services/pats';
import type { Server } from 'node:http';
import { closeServer, createPat, createTestSession, listen, makeUser, type TestSession, type TestUser } from './auth-helpers';

const suffix = randomUUID().slice(0, 8);

const GATE_CODES = ['INSUFFICIENT_SCOPE', 'SESSION_REQUIRED', 'PAT_WORKSPACE_RESTRICTED', 'PAT_ROUTE_UNDECLARED'];

function code(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
    ? (body as { code: string }).code
    : undefined;
}

type Method = RouteDeclaration['method'];
type Lower = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface MatrixRow {
  module: string;
  method: Method;
  /** Registry pattern. */
  route: string;
  allow: string[][];
  deny: string[][];
}

/**
 * Read vs write per module. `deny` rows that name another family's scope
 * (for example `labels:write` creating a task, `write` deleting a workspace)
 * were accepted before W02b, when routes defaulted to generic read/write.
 */
const MATRIX: MatrixRow[] = [
  { module: 'tasks', method: 'GET', route: '/api/tasks', allow: [['tasks:read'], ['read']], deny: [['projects:read'], ['labels:write']] },
  { module: 'tasks', method: 'POST', route: '/api/tasks', allow: [['tasks:write'], ['write']], deny: [['tasks:read'], ['projects:write'], ['labels:write']] },
  { module: 'comments', method: 'GET', route: '/api/tasks/:taskId/comments', allow: [['tasks:read']], deny: [['projects:read']] },
  { module: 'comments', method: 'POST', route: '/api/tasks/:taskId/comments', allow: [['tasks:write']], deny: [['tasks:read'], ['projects:write']] },
  { module: 'labels', method: 'GET', route: '/api/labels', allow: [['projects:read']], deny: [['tasks:read']] },
  { module: 'labels', method: 'POST', route: '/api/labels', allow: [['labels:write'], ['write']], deny: [['tasks:write'], ['projects:write'], ['read']] },
  { module: 'projects', method: 'GET', route: '/api/projects', allow: [['projects:read']], deny: [['tasks:read']] },
  { module: 'projects', method: 'POST', route: '/api/projects', allow: [['projects:write']], deny: [['tasks:write'], ['projects:read']] },
  { module: 'projects', method: 'POST', route: '/api/projects/:id/access', allow: [['admin']], deny: [['write'], ['projects:write']] },
  { module: 'teams', method: 'GET', route: '/api/teams/:id', allow: [['projects:read']], deny: [['tasks:read']] },
  { module: 'teams', method: 'POST', route: '/api/teams/:id/members', allow: [['admin']], deny: [['write'], ['projects:write']] },
  { module: 'workspaces', method: 'GET', route: '/api/workspaces', allow: [['workspaces:read'], ['read']], deny: [['tasks:read']] },
  { module: 'workspaces', method: 'PATCH', route: '/api/workspaces/:id', allow: [['admin']], deny: [['write']] },
  { module: 'workspaces', method: 'DELETE', route: '/api/workspaces/:id', allow: [['admin']], deny: [['write']] },
  { module: 'audit', method: 'GET', route: '/api/workspaces/:workspaceId/audit-log', allow: [['admin']], deny: [['read'], ['write']] },
  { module: 'invitations', method: 'GET', route: '/api/invitations/pending', allow: [['workspaces:read']], deny: [['tasks:read']] },
  { module: 'invitations', method: 'POST', route: '/api/invitations', allow: [['admin']], deny: [['write']] },
  { module: 'members', method: 'GET', route: '/api/members/search', allow: [['workspaces:read']], deny: [['tasks:read']] },
  { module: 'inbox', method: 'GET', route: '/api/inbox', allow: [['tasks:read']], deny: [['projects:read']] },
  { module: 'inbox', method: 'PATCH', route: '/api/inbox/read-all', allow: [['tasks:write']], deny: [['tasks:read']] },
  { module: 'notifications', method: 'GET', route: '/api/notifications', allow: [['tasks:read']], deny: [['projects:read']] },
  { module: 'notifications', method: 'PUT', route: '/api/notifications/preferences', allow: [['write']], deny: [['tasks:write'], ['read']] },
  { module: 'activity', method: 'GET', route: '/api/activity', allow: [['tasks:read']], deny: [['labels:write']] },
  { module: 'dashboard', method: 'GET', route: '/api/dashboard/projects', allow: [['projects:read']], deny: [['tasks:read']] },
  { module: 'search', method: 'GET', route: '/api/search', allow: [['tasks:read', 'projects:read'], ['read']], deny: [['tasks:read']] },
  { module: 'usage', method: 'GET', route: '/api/usage/summary', allow: [['tasks:read']], deny: [['projects:read']] },
  { module: 'agent-runs', method: 'GET', route: '/api/agent-runs', allow: [['tasks:read']], deny: [['projects:read']] },
  { module: 'agent-runs', method: 'POST', route: '/api/agent-runs', allow: [['tasks:write']], deny: [['tasks:read']] },
  { module: 'chat', method: 'GET', route: '/api/chat/sessions', allow: [['read']], deny: [['tasks:read'], ['projects:read']] },
  { module: 'chat', method: 'POST', route: '/api/chat/sessions', allow: [['write']], deny: [['tasks:write'], ['read']] },
  { module: 'repos', method: 'GET', route: '/api/repos', allow: [['read']], deny: [['tasks:read']] },
  { module: 'repos', method: 'POST', route: '/api/repos/import', allow: [['write']], deny: [['tasks:write']] },
  { module: 'settings', method: 'GET', route: '/api/settings', allow: [['read']], deny: [['projects:read']] },
  { module: 'settings', method: 'PATCH', route: '/api/settings', allow: [['write']], deny: [['labels:write'], ['read']] },
  { module: 'users', method: 'GET', route: '/api/users/me', allow: [['read']], deny: [['tasks:read']] },
  { module: 'users', method: 'GET', route: '/api/users/me/scm-token', allow: [['admin']], deny: [['write']] },
  { module: 'mcp', method: 'POST', route: '/api/mcp/log', allow: [['tasks:write']], deny: [['read'], ['tasks:read']] },
  { module: 'mcp', method: 'GET', route: '/api/mcp/usage', allow: [['read']], deny: [['tasks:read']] },
  { module: 'uploads', method: 'GET', route: '/uploads/:filename', allow: [['read']], deny: [['tasks:read']] },
  { module: 'models', method: 'GET', route: '/api/models', allow: [['tasks:read'], ['labels:write']], deny: [] },
];

function concrete(route: string): string {
  return route.replace(/:([A-Za-z]+)/g, (_match, param: string) => (param === 'filename' ? `missing-${suffix}.txt` : randomUUID()));
}

describe('W02b registry-driven PAT policy', () => {
  const app = createApp();
  let server: Server | undefined;
  let baseUrl = '';
  let owner: TestUser;
  let ownerSession: TestSession;
  let workspaceId = '';
  let linkedRepo = '';
  let unlinkedRepo = '';
  const pats = new Map<string, string>();

  async function patFor(scopes: string[]): Promise<string> {
    const key = scopes.join(',');
    const existing = pats.get(key);
    if (existing) return existing;
    const created = await createPat(owner.id, scopes);
    pats.set(key, created.token);
    return created.token;
  }

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(app));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    owner = await makeUser('pat-policy', suffix);
    ownerSession = await createTestSession(owner);
    const workspace = await prisma.workspace.create({ data: { name: `PAT policy ${suffix}`, slug: `pat-policy-${suffix}` } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId: owner.id, role: 'owner' } });
    linkedRepo = (await prisma.repository.create({
      data: { githubRepoId: 880_000 + Math.floor(Math.random() * 9_000), name: 'linked', fullName: `pp/linked-${suffix}`, cloneUrl: 'https://example.invalid/linked.git', userId: owner.id },
    })).id;
    unlinkedRepo = (await prisma.repository.create({
      data: { githubRepoId: 890_000 + Math.floor(Math.random() * 9_000), name: 'unlinked', fullName: `pp/unlinked-${suffix}`, cloneUrl: 'https://example.invalid/unlinked.git', userId: owner.id },
    })).id;
    await prisma.project.create({ data: { name: `PAT policy project ${suffix}`, workspaceId, key: 'PPP', repositoryId: linkedRepo } });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeServer(server);
    await prisma.project.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { OR: [{ id: workspaceId }, { members: { some: { userId: owner.id } } }] } });
    await prisma.user.deleteMany({ where: { id: owner.id } });
  });

  describe('default deny and registry precedence', () => {
    const extra = express();
    extra.use(express.json());
    extra.get('/api/w02b-undeclared', requireAuth, (_req, res) => { res.json({ ok: true }); });
    const mounted = express.Router();
    mounted.get('/thing', (_req, res) => { res.json({ ok: true }); });
    extra.use('/api/w02b-mounted', requireAuth, mounted);
    extra.get('/api/w02b-declared', requireAuth(['tasks:read']), (req: AuthRequest, res) => { res.json({ userId: req.userId }); });
    let extraServer: Server | undefined;
    let extraUrl = '';

    afterAll(async () => {
      await closeServer(extraServer);
    });

    beforeAll(async () => {
      ({ server: extraServer, baseUrl: extraUrl } = await listen(extra));
      registerRouteDeclarations([{
        method: 'GET',
        path: '/api/w02b-declared',
        auth: 'session_or_pat',
        scope: 'test',
        patScopes: ['admin'],
        enforcement: 'self',
        enforcedBy: 'test',
        workspaceBinding: 'refused',
      }]);
    });

    it('refuses PATs on routes the registry does not declare, but not sessions', async () => {
      const admin = await patFor(['admin']);
      const route = await request(extraUrl).get('/api/w02b-undeclared').set('Authorization', `Bearer ${admin}`);
      expect(route.status).toBe(403);
      expect(code(route.body)).toBe('PAT_ROUTE_UNDECLARED');
      const viaMount = await request(extraUrl).get('/api/w02b-mounted/thing').set('Authorization', `Bearer ${admin}`);
      expect(viaMount.status).toBe(403);
      expect(code(viaMount.body)).toBe('PAT_ROUTE_UNDECLARED');
      const session = await request(extraUrl).get('/api/w02b-undeclared').set('Authorization', `Bearer ${ownerSession.accessToken}`);
      expect(session.status).toBe(200);
    });

    it('applies the registry scope over a weaker inline requirement, and the binding stance', async () => {
      const weak = await request(extraUrl).get('/api/w02b-declared').set('Authorization', `Bearer ${await patFor(['tasks:read'])}`);
      expect(weak.status).toBe(403);
      expect(code(weak.body)).toBe('INSUFFICIENT_SCOPE');
      expect(weak.body.details.requiredScopes).toEqual(['admin', 'tasks:read']);
      const ok = await request(extraUrl).get('/api/w02b-declared').set('Authorization', `Bearer ${await patFor(['admin'])}`);
      expect(ok.status).toBe(200);
      const bound = await createPat(owner.id, ['admin'], { workspaceId });
      const refused = await request(extraUrl).get('/api/w02b-declared').set('Authorization', `Bearer ${bound.token}`);
      expect(refused.status).toBe(403);
      expect(code(refused.body)).toBe('PAT_WORKSPACE_RESTRICTED');
    });

    it('validates declarations it is given', () => {
      expect(() => registerRouteDeclarations([{
        method: 'GET', path: '/api/w02b-bad', auth: 'session_or_pat', scope: 'test', patScopes: [], enforcement: 'self', enforcedBy: 'test', workspaceBinding: 'refused',
      }])).toThrow(/declares no patScopes/);
    });
  });

  describe('read vs write scopes on every module', () => {
    it.each(MATRIX.map((row) => [`${row.module} ${row.method} ${row.route}`, row] as const))('%s', async (_name, row) => {
      expect(findRouteDeclaration(row.method, row.route), 'matrix row must be a registry route').toBeDefined();
      const path = concrete(row.route);
      const send = async (scopes: string[]) => {
        const token = await patFor(scopes);
        let req = request(baseUrl)[row.method.toLowerCase() as Lower](path).set('Authorization', `Bearer ${token}`);
        if (row.method !== 'GET' && row.method !== 'DELETE') req = req.send({});
        return req;
      };
      for (const scopes of row.deny) {
        const res = await send(scopes);
        expect({ scopes, status: res.status, code: code(res.body) }).toEqual({ scopes, status: 403, code: 'INSUFFICIENT_SCOPE' });
      }
      for (const scopes of row.allow) {
        const res = await send(scopes);
        expect({ scopes, passedGate: res.status !== 401 && !GATE_CODES.includes(code(res.body) ?? '') }).toEqual({ scopes, passedGate: true });
      }
    });
  });

  describe('workspace-bound PATs and repositories', () => {
    it('reads a repository only when it backs a project inside the binding', async () => {
      const bound = await createPat(owner.id, ['read'], { workspaceId });
      const unbound = await patFor(['read']);
      const asBound = (path: string) => request(baseUrl).get(path).set('Authorization', `Bearer ${bound.token}`);
      expect((await asBound(`/api/repos/${linkedRepo}`)).status).toBe(200);
      expect((await asBound(`/api/repos/${unlinkedRepo}`)).status).toBe(404);
      const list = await asBound('/api/repos');
      expect(list.status).toBe(403);
      expect(code(list.body)).toBe('PAT_WORKSPACE_RESTRICTED');
      for (const repo of [linkedRepo, unlinkedRepo]) {
        expect((await request(baseUrl).get(`/api/repos/${repo}`).set('Authorization', `Bearer ${unbound}`)).status).toBe(200);
      }
    });
  });

  describe('lastUsedAt throttling', () => {
    it('writes lastUsedAt at most once per interval and still rejects a revoked token at once', async () => {
      resetPatUsageThrottle();
      const pat = await createPat(owner.id, ['workspaces:read']);
      const use = () => request(baseUrl).get('/api/workspaces').set('Authorization', `Bearer ${pat.token}`);
      const lastUsed = async () => (await prisma.personalAccessToken.findUnique({ where: { id: pat.id } }))?.lastUsedAt ?? null;

      expect((await use()).status).toBe(200);
      await vi.waitFor(async () => expect(await lastUsed()).toBeInstanceOf(Date));

      // Inside the interval: no further writes.
      await prisma.personalAccessToken.update({ where: { id: pat.id }, data: { lastUsedAt: null } });
      for (let i = 0; i < 3; i += 1) expect((await use()).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await lastUsed()).toBeNull();

      // Another replica (fresh in-process state) does not write a recent value either.
      const recent = new Date(Date.now() - 5_000);
      await prisma.personalAccessToken.update({ where: { id: pat.id }, data: { lastUsedAt: recent } });
      resetPatUsageThrottle();
      expect((await use()).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await lastUsed())?.getTime()).toBe(recent.getTime());

      // Older than the interval: written again.
      const stale = new Date(Date.now() - PAT_LAST_USED_WRITE_INTERVAL_MS - 5_000);
      await prisma.personalAccessToken.update({ where: { id: pat.id }, data: { lastUsedAt: stale } });
      resetPatUsageThrottle();
      expect((await use()).status).toBe(200);
      await vi.waitFor(async () => expect((await lastUsed())?.getTime()).toBeGreaterThan(stale.getTime()));

      // Throttling never caches validity.
      await prisma.personalAccessToken.update({ where: { id: pat.id }, data: { revokedAt: new Date() } });
      expect((await use()).status).toBe(401);
    });
  });

  describe('localPath is not authorized by a client header', () => {
    const localPath = `/Users/someone/code/w02b-${suffix}`;

    it('refuses localPath from a PAT even with x-openlinear-client: desktop', async () => {
      const pat = await patFor(['projects:write']);
      const res = await request(baseUrl)
        .post('/api/projects')
        .set('Authorization', `Bearer ${pat}`)
        .set('x-openlinear-client', 'desktop')
        .send({ name: `pat-local-${suffix}`, workspaceId, key: 'PLX', localPath });
      expect(res.status).toBe(403);
      expect(code(res.body)).toBe('DESKTOP_REQUIRED');
      expect(await prisma.project.count({ where: { localPath } })).toBe(0);
    });

    it('still lets the desktop app (interactive session) set it', async () => {
      const res = await request(baseUrl)
        .post('/api/projects')
        .set('Authorization', `Bearer ${ownerSession.accessToken}`)
        .set('x-openlinear-client', 'desktop')
        .send({ name: `session-local-${suffix}`, workspaceId, key: 'SLX', localPath });
      expect(res.status).toBe(201);
      const pat = await patFor(['projects:write']);
      const patch = await request(baseUrl)
        .patch(`/api/projects/${res.body.id as string}`)
        .set('Authorization', `Bearer ${pat}`)
        .set('x-openlinear-client', 'desktop')
        .send({ localPath: `${localPath}-moved` });
      expect(patch.status).toBe(403);
      expect(code(patch.body)).toBe('DESKTOP_REQUIRED');
    });
  });
});
