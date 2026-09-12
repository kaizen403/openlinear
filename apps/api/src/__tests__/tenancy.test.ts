import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';
import { testJwtSecret } from './test-env';
import { resolveTenancyContext } from '../tenancy/context';
import { scopedTaskWhere, scopedProjectWhere, scopedActivityWhere } from '../tenancy/scopes';

const JWT_SECRET = testJwtSecret();
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function sign(userId: string, username: string) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Phase 1.1 tenancy (F-010 / F-027 / F-029 / F-032 / F-028 / F-116)', () => {
  const app = createApp();
  const ids = {
    allowedUser: '',
    deniedUser: '',
    workspace: '',
    project: '',
    team: '',
    hiddenTask: '',
    visibleTask: '',
    activity: '',
  };
  let deniedToken = '';
  let allowedToken = '';

  beforeAll(async () => {
    const allowed = await prisma.user.create({
      data: {
        githubId: `tenancy-ok-${suffix}`,
        username: `tenancy-ok-${suffix}`,
        email: `tenancy-ok-${suffix}@example.com`,
      },
    });
    const denied = await prisma.user.create({
      data: {
        githubId: `tenancy-deny-${suffix}`,
        username: `tenancy-deny-${suffix}`,
        email: `tenancy-deny-${suffix}@example.com`,
      },
    });
    ids.allowedUser = allowed.id;
    ids.deniedUser = denied.id;
    allowedToken = sign(allowed.id, allowed.username);
    deniedToken = sign(denied.id, denied.username);

    const workspace = await prisma.workspace.create({
      data: { name: `Tenancy WS ${suffix}`, slug: `tenancy-ws-${suffix}` },
    });
    ids.workspace = workspace.id;

    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: allowed.id, role: 'owner' },
        { workspaceId: workspace.id, userId: denied.id, role: 'member' },
      ],
    });

    const project = await prisma.project.create({
      data: { name: 'Denied Project', workspaceId: workspace.id, key: 'DENY' },
    });
    ids.project = project.id;

    const team = await prisma.team.create({
      data: { name: 'Denied Team', key: 'DNY', projectId: project.id },
    });
    ids.team = team.id;

    await prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: allowed.id, role: 'owner' },
        { teamId: team.id, userId: denied.id, role: 'member' },
      ],
    });

    await prisma.projectAccess.create({
      data: { projectId: project.id, userId: denied.id, permission: 'deny' },
    });

    const hidden = await prisma.task.create({
      data: {
        title: `secret-deny-${suffix}`,
        description: `classified-${suffix}`,
        identifier: `DENY-1`,
        priority: 'high',
        status: 'done',
        teamId: team.id,
        projectId: project.id,
        creatorId: allowed.id,
        inboxRead: false,
      },
    });
    ids.hiddenTask = hidden.id;

    const visibleProject = await prisma.project.create({
      data: { name: 'Open Project', workspaceId: workspace.id, key: 'OPEN' },
    });
    const visibleTeam = await prisma.team.create({
      data: { name: 'Open Team', key: 'OPN', projectId: visibleProject.id },
    });
    await prisma.teamMember.create({
      data: { teamId: visibleTeam.id, userId: denied.id, role: 'member' },
    });
    const visible = await prisma.task.create({
      data: {
        title: `visible-ok-${suffix}`,
        priority: 'medium',
        status: 'todo',
        teamId: visibleTeam.id,
        projectId: visibleProject.id,
        creatorId: denied.id,
      },
    });
    ids.visibleTask = visible.id;

    const activity = await prisma.activityLog.create({
      data: {
        projectId: project.id,
        teamId: team.id,
        userId: allowed.id,
        action: 'task_created',
        payload: { title: `secret-deny-${suffix}` },
      },
    });
    ids.activity = activity.id;
  }, 30000);

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { id: ids.activity } });
    await prisma.task.deleteMany({ where: { id: { in: [ids.hiddenTask, ids.visibleTask].filter(Boolean) } } });
    await prisma.teamMember.deleteMany({ where: { teamId: ids.team } });
    await prisma.projectAccess.deleteMany({ where: { projectId: ids.project } });
    await prisma.team.deleteMany({ where: { project: { workspaceId: ids.workspace } } });
    await prisma.project.deleteMany({ where: { workspaceId: ids.workspace } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: ids.workspace } });
    await prisma.workspace.deleteMany({ where: { id: ids.workspace } });
    await prisma.user.deleteMany({ where: { id: { in: [ids.allowedUser, ids.deniedUser].filter(Boolean) } } });
  }, 30000);

  it('scopedTaskWhere excludes tasks in denied projects even when the user is a team member', async () => {
    const ctx = await resolveTenancyContext({
      userId: ids.deniedUser,
      authSource: 'jwt',
      scopes: [],
    });
    expect(ctx.teams.has(ids.team)).toBe(true);
    expect(ctx.projectGrants.get(ids.project)).toBe('deny');

    const hidden = await prisma.task.findMany({
      where: { AND: [scopedTaskWhere(ctx), { id: ids.hiddenTask }] },
    });
    expect(hidden).toHaveLength(0);

    const visible = await prisma.task.findMany({
      where: { AND: [scopedTaskWhere(ctx), { id: ids.visibleTask }] },
    });
    expect(visible).toHaveLength(1);
  });

  it('scopedProjectWhere excludes denied projects from workspace-derived access', async () => {
    const ctx = await resolveTenancyContext({
      userId: ids.deniedUser,
      authSource: 'jwt',
      scopes: [],
    });
    const projects = await prisma.project.findMany({
      where: { AND: [scopedProjectWhere(ctx), { id: ids.project }] },
    });
    expect(projects).toHaveLength(0);
  });

  it('GET /api/search does not return denied-project titles or descriptions (F-010, F-028)', async () => {
    const res = await request(app)
      .get('/api/search')
      .query({ q: `secret-deny-${suffix}` })
      .set('Authorization', `Bearer ${deniedToken}`);

    expect(res.status).toBe(200);
    expect(res.body.tasks.some((t: { id: string }) => t.id === ids.hiddenTask)).toBe(false);
    expect(res.body.projects.some((p: { id: string }) => p.id === ids.project)).toBe(false);
  });

  it('GET /api/search still finds tasks the denied user is allowed to see', async () => {
    const res = await request(app)
      .get('/api/search')
      .query({ q: `visible-ok-${suffix}` })
      .set('Authorization', `Bearer ${deniedToken}`);

    expect(res.status).toBe(200);
    expect(res.body.tasks.some((t: { id: string }) => t.id === ids.visibleTask)).toBe(true);
  });

  it('GET /api/inbox and /count omit completed tasks from denied projects (F-027)', async () => {
    const count = await request(app)
      .get('/api/inbox/count')
      .set('Authorization', `Bearer ${deniedToken}`);
    expect(count.status).toBe(200);

    const list = await request(app)
      .get('/api/inbox')
      .set('Authorization', `Bearer ${deniedToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((t: { id: string }) => t.id === ids.hiddenTask)).toBe(false);

    const asOwner = await request(app)
      .get('/api/inbox')
      .set('Authorization', `Bearer ${allowedToken}`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.items.some((t: { id: string }) => t.id === ids.hiddenTask)).toBe(true);
  });

  it('GET /api/dashboard/tasks and /projects omit denied-project work (F-032)', async () => {
    const tasks = await request(app)
      .get('/api/dashboard/tasks')
      .set('Authorization', `Bearer ${deniedToken}`);
    expect(tasks.status).toBe(200);
    expect(tasks.body.total).toBeGreaterThanOrEqual(1);

    const asOwner = await request(app)
      .get('/api/dashboard/tasks')
      .set('Authorization', `Bearer ${allowedToken}`);
    expect(asOwner.body.total).toBeGreaterThan(tasks.body.total);

    const projects = await request(app)
      .get('/api/dashboard/projects')
      .set('Authorization', `Bearer ${deniedToken}`);
    expect(projects.status).toBe(200);
    expect(projects.body.projects.some((p: { id: string }) => p.id === ids.project)).toBe(false);
  });

  it('GET /api/activity includes workspace-derived projects and excludes deny (F-029)', async () => {
    const ctx = await resolveTenancyContext({
      userId: ids.deniedUser,
      authSource: 'jwt',
      scopes: [],
    });
    const deniedRows = await prisma.activityLog.findMany({
      where: { AND: [scopedActivityWhere(ctx), { id: ids.activity }] },
    });
    expect(deniedRows).toHaveLength(0);

    const res = await request(app)
      .get('/api/activity')
      .set('Authorization', `Bearer ${deniedToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.some((row: { id: string }) => row.id === ids.activity)).toBe(false);

    const asOwner = await request(app)
      .get('/api/activity')
      .set('Authorization', `Bearer ${allowedToken}`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.items.some((row: { id: string }) => row.id === ids.activity)).toBe(true);
  });
});
