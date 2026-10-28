/**
 * P95 Phase 1 (perf1): the cross-request principal cache (on in production,
 * off by default under NODE_ENV=test) must not delay revocation. This file
 * forces it on and checks, through the API, that removing a workspace member,
 * adding a project deny and revoking a PAT take effect on the very next
 * request of every read path perf1 touched; plus the cache's own hygiene
 * (bound, eviction, invalidation index, in-flight invalidation race).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENLINEAR_TENANCY_CACHE = '1';
});

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import {
  clearTenancyCache,
  invalidateTenancyCache,
  resolveTenancyContext,
  tenancyCacheSize,
} from '../tenancy/context';
import { testJwtSecret } from './test-env';

const suffix = randomUUID().slice(0, 8);
const sign = (userId: string, username: string) => jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });

describe('perf1: principal cache keeps revocation immediate', () => {
  const app = createApp();
  let server: Server;
  const ids = { owner: '', member: '', workspace: '', project: '', team: '', task: '', activity: '' };
  const userIds: string[] = [];
  let ownerToken = '';
  let memberToken = '';
  let memberUsername = '';
  const as = (bearer: string) => ({ Authorization: `Bearer ${bearer}` });

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const owner = await prisma.user.create({ data: { githubId: `tc-o-${suffix}`, username: `tc-o-${suffix}`, email: `tc-o-${suffix}@example.com` } });
    const member = await prisma.user.create({ data: { githubId: `tc-m-${suffix}`, username: `tc-m-${suffix}`, email: `tc-m-${suffix}@example.com` } });
    userIds.push(owner.id, member.id);
    ids.owner = owner.id;
    ids.member = member.id;
    memberUsername = member.username;
    ownerToken = sign(owner.id, owner.username);
    memberToken = sign(member.id, member.username);

    const workspace = await prisma.workspace.create({ data: { name: `TC ${suffix}`, slug: `tc-${suffix}` } });
    ids.workspace = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
        { workspaceId: workspace.id, userId: member.id, role: 'member' },
      ],
    });
    const project = await prisma.project.create({ data: { name: `tc-p-${suffix}`, key: 'TCP', workspaceId: workspace.id } });
    ids.project = project.id;
    ids.team = (await prisma.team.create({ data: { name: 'tc team', key: 'TCT', projectId: project.id } })).id;
    const task = await prisma.task.create({
      data: { title: `tc task ${suffix}`, status: 'done', projectId: project.id, teamId: ids.team, creatorId: owner.id },
    });
    ids.task = task.id;
    ids.activity = (await prisma.activityLog.create({
      data: { projectId: project.id, teamId: ids.team, taskId: task.id, userId: owner.id, action: 'task_created', payload: {} },
    })).id;
    await prisma.agentRun.create({ data: { taskId: task.id, userId: member.id, agent: 'opencode', model: 'm', costUsd: 1 } });
    await prisma.notification.create({ data: { userId: member.id, type: 'mention', taskId: task.id, body: 'tc' } });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agentRun.deleteMany({ where: { taskId: ids.task } });
    await prisma.activityLog.deleteMany({ where: { id: ids.activity } });
    await prisma.personalAccessToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { workspaceId: ids.workspace } });
    await prisma.task.deleteMany({ where: { id: ids.task } });
    await prisma.projectAccess.deleteMany({ where: { projectId: ids.project } });
    await prisma.teamMember.deleteMany({ where: { teamId: ids.team } });
    await prisma.team.deleteMany({ where: { id: ids.team } });
    await prisma.project.deleteMany({ where: { id: ids.project } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: ids.workspace } });
    await prisma.workspace.deleteMany({ where: { id: ids.workspace } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    clearTenancyCache();
    delete process.env.OPENLINEAR_TENANCY_CACHE;
    delete process.env.OPENLINEAR_TENANCY_CACHE_MAX;
  });

  beforeEach(() => clearTenancyCache());

  /** What the member sees on every perf1 read path. */
  async function memberView(bearer = memberToken) {
    const [dashboard, inbox, activity, usage, byTask, notifications, task] = await Promise.all([
      request(server).get('/api/dashboard/tasks').set(as(bearer)),
      request(server).get('/api/inbox/count').set(as(bearer)),
      request(server).get('/api/activity').set(as(bearer)),
      request(server).get('/api/usage/summary').set(as(bearer)),
      request(server).get('/api/usage/by-task').set(as(bearer)),
      request(server).get('/api/notifications').set(as(bearer)),
      request(server).get(`/api/tasks/${ids.task}`).set(as(bearer)),
    ]);
    return {
      dashboardTotal: dashboard.body.total as number,
      inboxTotal: inbox.body.total as number,
      activity: (activity.body.items as Array<{ id: string }>).some((row) => row.id === ids.activity),
      usageRuns: usage.body.totalRuns as number,
      byTask: (byTask.body.items as Array<{ taskId: string }>).some((row) => row.taskId === ids.task),
      notifications: (notifications.body.items as Array<{ taskId: string | null }>).some((row) => row.taskId === ids.task),
      taskStatus: task.status,
    };
  }

  const visible = { dashboardTotal: 1, inboxTotal: 1, activity: true, usageRuns: 1, byTask: true, notifications: true, taskStatus: 200 };
  const hidden = { dashboardTotal: 0, inboxTotal: 0, activity: false, usageRuns: 0, byTask: false, notifications: false, taskStatus: 403 };

  it('removing a workspace member hides everything on the next request, with the principal cached', async () => {
    expect(await memberView()).toEqual(visible);
    expect(tenancyCacheSize()).toBeGreaterThan(0);

    const removed = await request(server).delete(`/api/workspaces/${ids.workspace}/members/${ids.member}`).set(as(ownerToken));
    expect(removed.status).toBe(204);
    expect(await memberView()).toEqual(hidden);

    const added = await request(server)
      .post(`/api/workspaces/${ids.workspace}/members`)
      .set(as(ownerToken))
      .send({ username: memberUsername, role: 'member' });
    expect(added.status).toBe(201);
    expect(await memberView()).toEqual(visible);
  });

  it('a new project deny applies on the next request; a grant restores access', async () => {
    expect(await memberView()).toEqual(visible);
    const denied = await request(server).post(`/api/projects/${ids.project}/access`).set(as(ownerToken)).send({ userId: ids.member, permission: 'deny' });
    expect(denied.status).toBeLessThan(300);
    expect(await memberView()).toEqual(hidden);

    const granted = await request(server).post(`/api/projects/${ids.project}/access`).set(as(ownerToken)).send({ userId: ids.member, permission: 'view' });
    expect(granted.status).toBeLessThan(300);
    expect(await memberView()).toEqual(visible);

    // DELETE …/access/:userId revokes, i.e. writes a deny for a workspace project.
    const revoked = await request(server).delete(`/api/projects/${ids.project}/access/${ids.member}`).set(as(ownerToken));
    expect(revoked.status).toBeLessThan(300);
    expect(await memberView()).toEqual(hidden);

    await request(server).post(`/api/projects/${ids.project}/access`).set(as(ownerToken)).send({ userId: ids.member, permission: 'full' });
    expect(await memberView()).toEqual(visible);
  });

  it('a revoked PAT is refused on its next request even though its principal is cached', async () => {
    const raw = generatePersonalAccessToken();
    const pat = await prisma.personalAccessToken.create({
      data: { userId: ids.member, name: `tc-${suffix}`, tokenHash: hashPersonalAccessToken(raw), tokenPrefix: raw.slice(0, 15), scopes: ['read'] },
    });
    const before = await request(server).get('/api/dashboard/tasks').set(as(raw));
    expect(before.status).toBe(200);
    expect(before.body.total).toBe(1);

    const revoked = await request(server).delete(`/api/pats/${pat.id}`).set(as(memberToken));
    expect(revoked.status).toBeLessThan(300);
    for (const path of ['/api/dashboard/tasks', '/api/usage/summary', '/api/activity', `/api/workspaces/${ids.workspace}/structure?view=summary`]) {
      expect((await request(server).get(path).set(as(raw))).status).toBe(401);
    }
  });

  it('does not cache a principal whose reads overlapped an invalidation', async () => {
    const auth = { userId: ids.member, authSource: 'jwt' as const, scopes: [] };
    const inFlight = resolveTenancyContext(auth);
    invalidateTenancyCache(ids.member); // lands after the reads started
    const stale = await inFlight;
    expect(stale.workspaces.has(ids.workspace)).toBe(true);
    expect(tenancyCacheSize()).toBe(0);

    // A membership change that skipped invalidation is still seen, because
    // the overlapping read above was not cached.
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: ids.workspace, userId: ids.member } } });
    const fresh = await resolveTenancyContext(auth);
    expect(fresh.workspaces.has(ids.workspace)).toBe(false);
    expect(tenancyCacheSize()).toBe(1);
    await prisma.workspaceMember.create({ data: { workspaceId: ids.workspace, userId: ids.member, role: 'member' } });
    invalidateTenancyCache(ids.member);
    expect(tenancyCacheSize()).toBe(0);
  });

  it('bounds the cache and evicts oldest first', async () => {
    process.env.OPENLINEAR_TENANCY_CACHE_MAX = '3';
    try {
      const principals = Array.from({ length: 5 }, (_, i) => ({
        userId: ids.member,
        authSource: 'pat' as const,
        scopes: ['read'],
        credentialId: `cred-${i}-${suffix}`,
      }));
      const first = await resolveTenancyContext(principals[0]);
      for (const auth of principals.slice(1)) await resolveTenancyContext(auth);
      expect(tenancyCacheSize()).toBe(3);
      // The oldest entry was evicted: resolving it again builds a new object.
      expect(await resolveTenancyContext(principals[0])).not.toBe(first);
      // The newest is still a hit.
      const newest = await resolveTenancyContext(principals[4]);
      expect(await resolveTenancyContext(principals[4])).toBe(newest);
      invalidateTenancyCache(ids.member);
      expect(tenancyCacheSize()).toBe(0);
    } finally {
      delete process.env.OPENLINEAR_TENANCY_CACHE_MAX;
    }
  });
});
