/**
 * P95 Phase 1 (perf1) read paths: activity feed keyset pagination and
 * compatibility, the workspace structure summary view, the workspace list
 * default-workspace path, the bounded telemetry histograms, and per-request
 * statement budgets (read from the route-timing middleware).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Subscribe Prisma query events (route timing counts statements per request).
// The threshold is far above any test query, so nothing is logged as slow.
vi.hoisted(() => {
  process.env.OPENLINEAR_SLOW_QUERY_MS = '60000';
  delete (globalThis as { prisma?: unknown }).prisma;
});

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { prisma } from '@openlinear/db';
import { BoundedHistogram, MAX_SERIES, resetTelemetry, snapshotTelemetry, startTelemetry } from '@openlinear/telemetry';
import { createApp } from '../app';
import { getRouteTimingSnapshot, resetRouteTiming } from '../middleware/route-timing';
import { decodeActivityCursor, encodeActivityCursor } from '../services/activity-feed';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { resolveTenancyContext } from '../tenancy/context';
import { scopedActivityWhere } from '../tenancy/scopes';
import { testJwtSecret } from './test-env';

const suffix = randomUUID().slice(0, 8);
const sign = (userId: string, username: string) => jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });

interface FeedBody {
  items: Array<{ id: string; createdAt: string; projectId: string | null; user: { id: string } }>;
  total: number;
  totalExact: boolean;
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

describe('perf1 read paths', () => {
  const app = createApp();
  let server: Server;
  const ids = { user: '', other: '', workspace: '', project: '', denied: '', team: '', deniedTeam: '', task: '' };
  const userIds: string[] = [];
  let token = '';
  let otherToken = '';
  let pat = '';
  const as = (bearer: string) => ({ Authorization: `Bearer ${bearer}` });

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));

    const user = await prisma.user.create({ data: { githubId: `rp-u-${suffix}`, username: `rp-u-${suffix}`, email: `rp-u-${suffix}@example.com` } });
    const other = await prisma.user.create({ data: { githubId: `rp-o-${suffix}`, username: `rp-o-${suffix}`, email: `rp-o-${suffix}@example.com` } });
    userIds.push(user.id, other.id);
    ids.user = user.id;
    ids.other = other.id;
    token = sign(user.id, user.username);
    otherToken = sign(other.id, other.username);

    const workspace = await prisma.workspace.create({ data: { name: `RP ${suffix}`, slug: `rp-${suffix}` } });
    ids.workspace = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: user.id, role: 'member' },
        { workspaceId: workspace.id, userId: other.id, role: 'owner' },
      ],
    });
    const project = await prisma.project.create({ data: { name: `rp-p-${suffix}`, key: 'RPP', workspaceId: workspace.id } });
    const denied = await prisma.project.create({ data: { name: `rp-d-${suffix}`, key: 'RPD', workspaceId: workspace.id } });
    ids.project = project.id;
    ids.denied = denied.id;
    const team = await prisma.team.create({ data: { name: 'rp team', key: 'RPT', projectId: project.id } });
    const deniedTeam = await prisma.team.create({ data: { name: 'rp denied team', key: 'RPX', projectId: denied.id } });
    ids.team = team.id;
    ids.deniedTeam = deniedTeam.id;
    await prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: user.id, role: 'member' },
        { teamId: deniedTeam.id, userId: user.id, role: 'member' },
        { teamId: team.id, userId: other.id, role: 'owner' },
      ],
    });
    await prisma.projectAccess.create({ data: { projectId: denied.id, userId: user.id, permission: 'deny' } });
    ids.task = (await prisma.task.create({ data: { title: `rp task ${suffix}`, projectId: project.id, teamId: team.id, creatorId: other.id } })).id;

    // 60 rows: visible project rows, denied-project rows, team-only rows on a
    // visible and on a denied team, own orphans and someone else's orphans.
    // Groups of three share one timestamp, so the id tiebreaker matters.
    const base = Date.now() - 3_600_000;
    const rows = [];
    for (let i = 0; i < 60; i += 1) {
      const kind = i % 6;
      rows.push({
        projectId: kind === 0 || kind === 1 ? project.id : kind === 2 ? denied.id : null,
        teamId: kind === 0 ? team.id : kind === 3 ? team.id : kind === 4 ? deniedTeam.id : null,
        taskId: kind === 0 ? ids.task : null,
        userId: kind === 5 && i % 12 === 5 ? other.id : user.id,
        action: 'task_updated' as const,
        payload: { i },
        createdAt: new Date(base + Math.floor(i / 3) * 1000),
      });
    }
    await prisma.activityLog.createMany({ data: rows });

    const raw = generatePersonalAccessToken();
    await prisma.personalAccessToken.create({
      data: { userId: user.id, name: `rp-${suffix}`, tokenHash: hashPersonalAccessToken(raw), tokenPrefix: raw.slice(0, 15), scopes: ['read'], workspaceId: workspace.id },
    });
    pat = raw;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.personalAccessToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.task.deleteMany({ where: { id: ids.task } });
    await prisma.projectAccess.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.teamMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.team.deleteMany({ where: { id: { in: [ids.team, ids.deniedTeam] } } });
    await prisma.project.deleteMany({ where: { id: { in: [ids.project, ids.denied] } } });
    const owned = await prisma.workspaceMember.findMany({ where: { userId: { in: userIds } }, select: { workspaceId: true } });
    const workspaceIds = [...new Set([ids.workspace, ...owned.map((m) => m.workspaceId)])];
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  async function expectedFeed(userId: string): Promise<string[]> {
    const ctx = await resolveTenancyContext({ userId, authSource: 'jwt', scopes: [] });
    const rows = await prisma.activityLog.findMany({
      where: scopedActivityWhere(ctx),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  describe('GET /api/activity', () => {
    it('walks every visible row exactly once, newest first, through nextCursor', async () => {
      const expected = await expectedFeed(ids.user);
      expect(expected.length).toBeGreaterThan(20);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await request(server)
          .get('/api/activity')
          .query({ pageSize: 7, ...(cursor ? { cursor } : {}) })
          .set(as(token));
        expect(res.status).toBe(200);
        const body = res.body as FeedBody;
        expect(body.items.length).toBeLessThanOrEqual(7);
        expect(body.hasMore).toBe(body.nextCursor !== null);
        seen.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor && pages < 50);
      expect(seen).toEqual(expected);
      // Denied project rows and the denied team's team-only rows never appear.
      const leaked = await prisma.activityLog.count({
        where: { id: { in: seen }, OR: [{ projectId: ids.denied }, { teamId: ids.deniedTeam, projectId: null }] },
      });
      expect(leaked).toBe(0);
    });

    it('keeps page/pageSize paging and the response envelope; total is exact only on request', async () => {
      const expected = await expectedFeed(ids.user);
      const res = await request(server).get('/api/activity').query({ page: 2, pageSize: 5 }).set(as(token));
      expect(res.status).toBe(200);
      const body = res.body as FeedBody;
      expect(Object.keys(body).sort()).toEqual(['hasMore', 'items', 'nextCursor', 'page', 'pageSize', 'total', 'totalExact']);
      expect(body.items.map((item) => item.id)).toEqual(expected.slice(5, 10));
      expect(body.items[0].user.id).toBeDefined();
      expect(body).toMatchObject({ page: 2, pageSize: 5, hasMore: true, total: 10, totalExact: false });

      const exact = await request(server).get('/api/activity').query({ page: 2, pageSize: 5, count: 'exact' }).set(as(token));
      expect(exact.body).toMatchObject({ total: expected.length, totalExact: true, hasMore: true });
      expect((exact.body as FeedBody).items.map((item) => item.id)).toEqual(expected.slice(5, 10));

      const last = await request(server).get('/api/activity').query({ page: Math.ceil(expected.length / 5), pageSize: 5 }).set(as(token));
      expect(last.body).toMatchObject({ hasMore: false, nextCursor: null, total: expected.length });
    });

    it('filters by project with the cursor and rejects malformed cursors', async () => {
      const first = await request(server).get('/api/activity').query({ projectId: ids.project, pageSize: 4 }).set(as(token));
      expect(first.status).toBe(200);
      const second = await request(server)
        .get('/api/activity')
        .query({ projectId: ids.project, pageSize: 4, cursor: (first.body as FeedBody).nextCursor })
        .set(as(token));
      const firstIds = (first.body as FeedBody).items.map((item) => item.id);
      const secondIds = (second.body as FeedBody).items.map((item) => item.id);
      expect(secondIds.length).toBeGreaterThan(0);
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
      for (const item of [...(first.body as FeedBody).items, ...(second.body as FeedBody).items]) {
        expect(item.projectId).toBe(ids.project);
      }
      // Denied project stays denied whatever the cursor.
      const denied = await request(server).get('/api/activity').query({ projectId: ids.denied }).set(as(token));
      expect(denied.status).toBe(403);

      for (const bad of ['not-base64!', Buffer.from('2026-01-01|x y').toString('base64url'), 'a'.repeat(201)]) {
        const res = await request(server).get('/api/activity').query({ cursor: bad }).set(as(token));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      const unknownCount = await request(server).get('/api/activity').query({ count: 'approximate' }).set(as(token));
      expect(unknownCount.status).toBe(400);
    });

    it('round-trips cursors', () => {
      const cursor = { createdAt: new Date('2026-10-26T01:02:03.456Z'), id: randomUUID() };
      expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
      expect(decodeActivityCursor('')).toBeNull();
    });
  });

  describe('GET /api/workspaces/:id/structure', () => {
    it('keeps the full shape by default and serves a lighter summary on request', async () => {
      const full = await request(server).get(`/api/workspaces/${ids.workspace}/structure`).set(as(token));
      expect(full.status).toBe(200);
      expect(Array.isArray(full.body.members)).toBe(true);
      expect(full.body.members).toHaveLength(2);
      const fullProject = full.body.projects.find((p: { id: string }) => p.id === ids.project);
      expect(Array.isArray(fullProject.teams[0].members)).toBe(true);
      expect(full.body.role).toBe('member');
      expect(full.body.currentMember.userId).toBe(ids.user);

      const summary = await request(server).get(`/api/workspaces/${ids.workspace}/structure?view=summary`).set(as(token));
      expect(summary.status).toBe(200);
      expect(summary.body.view).toBe('summary');
      expect(summary.body.members).toBeUndefined();
      expect(summary.body._count).toEqual({ members: 2, projects: 2 });
      expect(summary.body.role).toBe('member');
      expect(summary.body.currentMember).toMatchObject({ userId: ids.user, role: 'member', user: { id: ids.user } });
      const project = summary.body.projects.find((p: { id: string }) => p.id === ids.project);
      expect(project).toMatchObject({ id: ids.project, key: 'RPP', _count: { tasks: 1 } });
      expect(project.teams).toEqual([
        { id: ids.team, name: 'rp team', key: 'RPT', color: expect.any(String), projectId: ids.project, _count: { members: 2, tasks: 1 } },
      ]);
      expect(summary.body.projects.map((p: { id: string }) => p.id)).toEqual(full.body.projects.map((p: { id: string }) => p.id));
      expect(JSON.stringify(summary.body).length).toBeLessThan(JSON.stringify(full.body).length);
    });

    it('validates view and fields, and keeps the membership check', async () => {
      const bad = await request(server).get(`/api/workspaces/${ids.workspace}/structure?view=everything`).set(as(token));
      expect(bad.status).toBe(400);
      const picked = await request(server).get(`/api/workspaces/${ids.workspace}/structure?view=summary&fields=id,name,_count`).set(as(token));
      expect(Object.keys(picked.body).sort()).toEqual(['_count', 'id', 'name']);
      const badField = await request(server).get(`/api/workspaces/${ids.workspace}/structure?fields=secret`).set(as(token));
      expect(badField.status).toBe(400);

      const stranger = await prisma.user.create({ data: { githubId: `rp-s-${suffix}`, username: `rp-s-${suffix}`, email: `rp-s-${suffix}@example.com` } });
      userIds.push(stranger.id);
      for (const view of ['full', 'summary']) {
        const res = await request(server).get(`/api/workspaces/${ids.workspace}/structure?view=${view}`).set(as(sign(stranger.id, stranger.username)));
        // Non-members get the same existence-hiding 404 as before.
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('OWNERSHIP_REQUIRED');
      }
      // A workspace-bound PAT reaches its own workspace only.
      const viaPat = await request(server).get(`/api/workspaces/${ids.workspace}/structure?view=summary`).set(as(pat));
      expect(viaPat.status).toBe(200);
    });
  });

  describe('GET /api/workspaces', () => {
    it('creates the default workspace once for a user without memberships', async () => {
      const fresh = await prisma.user.create({ data: { githubId: `rp-f-${suffix}`, username: `rp-f-${suffix}`, email: `rp-f-${suffix}@example.com` } });
      userIds.push(fresh.id);
      const freshToken = sign(fresh.id, fresh.username);
      const first = await request(server).get('/api/workspaces').set(as(freshToken));
      expect(first.status).toBe(200);
      expect(first.body).toHaveLength(1);
      expect(first.body[0].role).toBe('owner');
      const second = await request(server).get('/api/workspaces').set(as(freshToken));
      expect(second.body.map((w: { id: string }) => w.id)).toEqual(first.body.map((w: { id: string }) => w.id));
      expect(await prisma.workspaceMember.count({ where: { userId: fresh.id } })).toBe(1);

      const member = await request(server).get('/api/workspaces').set(as(otherToken));
      expect(member.body.map((w: { id: string }) => w.id)).toContain(ids.workspace);
    });
  });

  describe('statement budgets (route timing, tenancy cache off under NODE_ENV=test)', () => {
    beforeEach(() => resetRouteTiming());

    async function statementsFor(path: string, route: string, bearer = token): Promise<number> {
      resetRouteTiming();
      const res = await request(server).get(path).set(as(bearer));
      expect(res.status).toBe(200);
      const entry = getRouteTimingSnapshot().find((e) => e.method === 'GET' && e.route === route);
      expect(entry).toBeDefined();
      return entry!.maxQueries;
    }

    it('keeps the hot read paths within their statement budgets', async () => {
      // Every request: 1 session lookup + 3 principal reads (cache disabled in tests).
      const budgets: Array<[string, string, number]> = [
        ['/api/activity?pageSize=10', '/api/activity', 4 + 2],
        [`/api/activity?pageSize=10&projectId=${ids.project}`, '/api/activity', 4 + 1 + 2],
        ['/api/usage/summary', '/api/usage/summary', 4 + 1],
        ['/api/usage/by-task', '/api/usage/by-task', 4 + 1],
        ['/api/dashboard/tasks', '/api/dashboard/tasks', 4 + 1],
        ['/api/inbox/count', '/api/inbox/count', 4 + 1],
        ['/api/notifications?pageSize=5', '/api/notifications', 4 + 3],
        ['/api/workspaces', '/api/workspaces', 4 + 2],
        // +1 since the W14 API-contract slice: GET /api/tasks/:id now also returns
        // `parent` and `subtasks` (one extra query by design). +1 for W17a:
        // `blockedBy`/`blocking`, both directions in one statement. +1 for
        // W17b: the plan the task came from.
        [`/api/tasks/${ids.task}`, '/api/tasks/:id', 4 + 2 + 10],
      ];
      for (const [path, route, budget] of budgets) {
        expect({ path, statements: await statementsFor(path, route) }).toEqual({ path, statements: budget });
      }
    });
  });

  describe('@openlinear/telemetry histograms', () => {
    it('keeps fixed memory per series and meaningful percentiles', () => {
      const histogram = new BoundedHistogram();
      for (let i = 1; i <= 100_000; i += 1) histogram.record(i / 100); // 0.01 .. 1000 ms
      const summary = histogram.summary();
      expect(summary.count).toBe(100_000);
      expect(summary.min).toBe(0.01);
      expect(summary.max).toBe(1000);
      expect(Math.abs(summary.p50 - 500) / 500).toBeLessThan(0.05);
      expect(Math.abs(summary.p95 - 950) / 950).toBeLessThan(0.05);
      expect(Math.abs(summary.p99 - 990) / 990).toBeLessThan(0.05);
      expect(summary.mean).toBeCloseTo(500.005, 2);

      const zeros = new BoundedHistogram();
      zeros.record(0);
      zeros.record(0);
      expect(zeros.summary()).toMatchObject({ count: 2, p50: 0, p99: 0, max: 0 });
    });

    it('caps the number of series and still reports means', () => {
      const hooks = startTelemetry();
      resetTelemetry();
      for (let i = 0; i < MAX_SERIES + 50; i += 1) hooks.histogram('http.duration_ms', i + 1, { route: `/r/${i}` });
      for (let i = 0; i < 10; i += 1) hooks.histogram('http.duration_ms', 5, { route: '/r/0' });
      const snapshot = snapshotTelemetry();
      expect(Object.keys(snapshot.histograms)).toHaveLength(MAX_SERIES + 1);
      expect(snapshot.histogramSummaries['http.duration_ms|overflow=true'].count).toBe(50);
      expect(snapshot.histogramSummaries['http.duration_ms|route=/r/0'].count).toBe(11);
      expect(snapshot.histograms['http.duration_ms|route=/r/0']).toBeCloseTo((1 + 50) / 11, 3);
      resetTelemetry();
    });
  });
});
