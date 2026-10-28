/**
 * W02a: explicit project deny (and lost membership) honored on comments,
 * mentions/notifications, historical usage, agent-run history, chat reads,
 * team listing, team-only tasks and workspace-scoped search.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { searchWorkspaceData } from '../services/search';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const suffix = randomUUID().slice(0, 8);

function sign(userId: string, username: string): string {
  return jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
}

describe('W02a explicit project deny across comments, reporting, chat and teams', () => {
  const app = createApp();
  const http = useTestServer(() => app);
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tokens: Record<string, string> = {};
  const users: Record<string, { id: string; username: string }> = {};
  const ids = {
    workspace: '',
    otherWorkspace: '',
    projectP: '',
    projectQ: '',
    teamX: '',
    teamY: '',
    taskT: '',
    taskT2: '',
    teamOnlyX: '',
    teamOnlyY: '',
    commentDenied: '',
    commentViewer: '',
    commentOwner: '',
    notificationDenied: '',
    notificationPlain: '',
    runDenied: '',
    chatProject: '',
    chatPlain: '',
  };

  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    for (const label of ['owner', 'denied', 'viewer', 'admin', 'teamY']) {
      const user = await prisma.user.create({
        data: { githubId: `ds-${label}-${suffix}`, username: `ds${label}${suffix}`, email: `ds-${label}-${suffix}@example.com` },
      });
      userIds.push(user.id);
      users[label] = user;
      tokens[label] = sign(user.id, user.username);
    }
    const workspace = await prisma.workspace.create({ data: { name: `DS ${suffix}`, slug: `ds-${suffix}` } });
    const other = await prisma.workspace.create({ data: { name: `DS other ${suffix}`, slug: `ds-o-${suffix}` } });
    workspaceIds.push(workspace.id, other.id);
    ids.workspace = workspace.id;
    ids.otherWorkspace = other.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: users.owner.id, role: 'owner' },
        { workspaceId: workspace.id, userId: users.denied.id, role: 'member' },
        { workspaceId: workspace.id, userId: users.viewer.id, role: 'member' },
        { workspaceId: workspace.id, userId: users.admin.id, role: 'admin' },
        { workspaceId: workspace.id, userId: users.teamY.id, role: 'member' },
        { workspaceId: other.id, userId: users.owner.id, role: 'owner' },
      ],
    });
    const projectP = await prisma.project.create({ data: { name: 'DS P', workspaceId: workspace.id, key: 'DSP' } });
    const projectQ = await prisma.project.create({ data: { name: 'DS Q', workspaceId: workspace.id, key: 'DSQ' } });
    ids.projectP = projectP.id;
    ids.projectQ = projectQ.id;
    await prisma.projectAccess.createMany({
      data: [
        { projectId: projectP.id, userId: users.denied.id, permission: 'deny' },
        { projectId: projectP.id, userId: users.viewer.id, permission: 'view' },
      ],
    });
    const teamX = await prisma.team.create({ data: { name: 'DS X', key: 'DSX', projectId: projectP.id } });
    const teamY = await prisma.team.create({ data: { name: 'DS Y', key: 'DSY', projectId: projectQ.id } });
    ids.teamX = teamX.id;
    ids.teamY = teamY.id;
    await prisma.teamMember.createMany({
      data: [
        { teamId: teamX.id, userId: users.owner.id, role: 'owner' },
        { teamId: teamX.id, userId: users.denied.id, role: 'admin' },
        { teamId: teamX.id, userId: users.viewer.id, role: 'member' },
        { teamId: teamX.id, userId: users.admin.id, role: 'admin' },
        { teamId: teamY.id, userId: users.teamY.id, role: 'owner' },
      ],
    });
    const taskT = await prisma.task.create({
      data: { title: `ds-secret-${suffix}`, projectId: projectP.id, teamId: teamX.id, creatorId: users.denied.id },
    });
    const taskT2 = await prisma.task.create({
      data: { title: `ds-viewer-created-${suffix}`, projectId: projectP.id, teamId: teamX.id, creatorId: users.viewer.id },
    });
    ids.taskT = taskT.id;
    ids.taskT2 = taskT2.id;
    ids.teamOnlyX = (await prisma.task.create({ data: { title: `ds-team-only-x-${suffix}`, teamId: teamX.id, creatorId: users.owner.id } })).id;
    ids.teamOnlyY = (await prisma.task.create({ data: { title: `ds-team-only-y-${suffix}`, teamId: teamY.id, creatorId: users.teamY.id } })).id;
    ids.commentDenied = (await prisma.comment.create({ data: { taskId: taskT.id, userId: users.denied.id, body: 'denied-original' } })).id;
    ids.commentViewer = (await prisma.comment.create({ data: { taskId: taskT.id, userId: users.viewer.id, body: 'viewer-original' } })).id;
    ids.commentOwner = (await prisma.comment.create({ data: { taskId: taskT.id, userId: users.owner.id, body: 'owner-original' } })).id;
    ids.notificationDenied = (await prisma.notification.create({ data: { userId: users.denied.id, type: 'mention', taskId: taskT.id, body: 'ds-secret-quote' } })).id;
    ids.notificationPlain = (await prisma.notification.create({ data: { userId: users.denied.id, type: 'comment', body: 'not task bound' } })).id;
    ids.runDenied = (await prisma.agentRun.create({ data: { taskId: taskT.id, userId: users.denied.id, agent: 'opencode', model: 'm', costUsd: 5 } })).id;
    ids.chatProject = (await prisma.chatSession.create({ data: { userId: users.denied.id, workspaceId: workspace.id, projectId: projectP.id, title: 'project chat' } })).id;
    ids.chatPlain = (await prisma.chatSession.create({ data: { userId: users.denied.id, workspaceId: workspace.id, title: 'plain chat' } })).id;
  });

  afterAll(async () => {
    await prisma.task.deleteMany({ where: { OR: [{ projectId: { in: [ids.projectP, ids.projectQ] } }, { teamId: { in: [ids.teamX, ids.teamY] } }, { creatorId: { in: userIds } }] } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { members: { some: { userId: { in: userIds } } } } });
    await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: userIds } }, { workspaceIds: { hasSome: workspaceIds } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  describe('comment mutations require current task permission', () => {
    it('stops a denied author from editing or deleting their own comment', async () => {
      const patch = await http().patch(`/api/comments/${ids.commentDenied}`).set(as('denied')).send({ body: 'rewritten' });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe('OWNERSHIP_REQUIRED');
      const del = await http().delete(`/api/comments/${ids.commentDenied}`).set(as('denied'));
      expect(del.status).toBe(403);
      const row = await prisma.comment.findUnique({ where: { id: ids.commentDenied } });
      expect(row?.body).toBe('denied-original');
    });

    it('stops a denied team admin from deleting other users comments', async () => {
      const del = await http().delete(`/api/comments/${ids.commentOwner}`).set(as('denied'));
      expect(del.status).toBe(403);
      expect(await prisma.comment.count({ where: { id: ids.commentOwner } })).toBe(1);
    });

    it('stops a view-only author from editing their comment', async () => {
      const patch = await http().patch(`/api/comments/${ids.commentViewer}`).set(as('viewer')).send({ body: 'rewritten' });
      expect(patch.status).toBe(403);
      expect((await prisma.comment.findUnique({ where: { id: ids.commentViewer } }))?.body).toBe('viewer-original');
    });

    it('still lets an author edit and an allowed team admin delete', async () => {
      const patch = await http().patch(`/api/comments/${ids.commentOwner}`).set(as('owner')).send({ body: 'owner-edited' });
      expect(patch.status).toBe(200);
      const del = await http().delete(`/api/comments/${ids.commentViewer}`).set(as('admin'));
      expect(del.status).toBe(204);
    });
  });

  describe('notifications never carry task content to users who cannot read the task', () => {
    it('drops @mentions of a denied user and keeps allowed ones', async () => {
      const res = await http()
        .post(`/api/tasks/${ids.taskT}/comments`)
        .set(as('owner'))
        .send({ body: `ping @${users.denied.username} and @${users.viewer.username}` });
      expect(res.status).toBe(201);
      expect(res.body.mentions).toEqual([users.viewer.id]);
      expect(await prisma.notification.count({ where: { commentId: res.body.id, userId: users.denied.id } })).toBe(0);
      expect(await prisma.notification.count({ where: { commentId: res.body.id, userId: users.viewer.id } })).toBe(1);
    });

    it('skips status-change notifications to a creator who lost access', async () => {
      const deniedCreator = await http().patch(`/api/tasks/${ids.taskT}`).set(as('owner')).send({ status: 'in_progress' });
      expect(deniedCreator.status).toBe(200);
      expect(await prisma.notification.count({ where: { taskId: ids.taskT, userId: users.denied.id, type: 'status_change' } })).toBe(0);
      const allowedCreator = await http().patch(`/api/tasks/${ids.taskT2}`).set(as('owner')).send({ status: 'in_progress' });
      expect(allowedCreator.status).toBe(200);
      expect(await prisma.notification.count({ where: { taskId: ids.taskT2, userId: users.viewer.id, type: 'status_change' } })).toBe(1);
    });

    it('hides stored notifications about a denied task from list, count and read', async () => {
      const list = await http().get('/api/notifications').set(as('denied'));
      expect(list.status).toBe(200);
      const listed = list.body.items.map((n: { id: string }) => n.id);
      expect(listed).not.toContain(ids.notificationDenied);
      expect(listed).toContain(ids.notificationPlain);
      expect(JSON.stringify(list.body)).not.toContain('ds-secret-quote');
      expect(list.body.unreadCount).toBe(1);
      const read = await http().patch(`/api/notifications/${ids.notificationDenied}/read`).set(as('denied'));
      expect(read.status).toBe(404);
    });
  });

  describe('historical reporting follows current task visibility', () => {
    it('excludes runs on denied-project tasks from usage summary and by-task', async () => {
      const summary = await http().get('/api/usage/summary').set(as('denied'));
      expect(summary.status).toBe(200);
      expect(summary.body.totalRuns).toBe(0);
      expect(summary.body.totalCostUsd).toBe(0);
      const byTask = await http().get('/api/usage/by-task').set(as('denied'));
      expect(byTask.body.items).toEqual([]);
      expect(JSON.stringify(byTask.body)).not.toContain('ds-secret');
      const ownerView = await http().get('/api/usage/by-task').set(as('owner'));
      expect(ownerView.body.items.map((i: { taskId: string }) => i.taskId)).toContain(ids.taskT);
    });

    it('excludes denied-project runs from the caller own run history', async () => {
      const mine = await http().get('/api/agent-runs').query({ userId: 'me' }).set(as('denied'));
      expect(mine.status).toBe(200);
      expect(mine.body.items.map((r: { id: string }) => r.id)).not.toContain(ids.runDenied);
    });
  });

  describe('chat reads re-check project access', () => {
    it('hides a project-scoped session after the owner is denied the project', async () => {
      const read = await http().get(`/api/chat/sessions/${ids.chatProject}`).set(as('denied'));
      expect(read.status).toBe(403);
      const plain = await http().get(`/api/chat/sessions/${ids.chatPlain}`).set(as('denied'));
      expect(plain.status).toBe(200);
      const list = await http().get('/api/chat/sessions').query({ workspaceId: ids.workspace }).set(as('denied'));
      expect(list.status).toBe(200);
      const listed = list.body.data.map((s: { id: string }) => s.id);
      expect(listed).toContain(ids.chatPlain);
      expect(listed).not.toContain(ids.chatProject);
    });
  });

  describe('teams and team-only tasks', () => {
    it('removes teams of a denied project from listing and reads', async () => {
      const list = await http().get('/api/teams').set(as('denied'));
      expect(list.body.map((t: { id: string }) => t.id)).not.toContain(ids.teamX);
      expect((await http().get(`/api/teams/${ids.teamX}`).set(as('denied'))).status).toBe(403);
      expect((await http().get(`/api/teams/${ids.teamX}`).set(as('owner'))).status).toBe(200);
    });

    it('applies the team project deny to team-only tasks', async () => {
      expect((await http().get(`/api/tasks/${ids.teamOnlyX}`).set(as('denied'))).status).toBe(403);
      expect((await http().get(`/api/tasks/${ids.teamOnlyX}`).set(as('owner'))).status).toBe(200);
      const listed = await http().get('/api/tasks').set(as('denied'));
      expect(listed.body.items.map((t: { id: string }) => t.id)).not.toContain(ids.teamOnlyX);
    });

    it('keeps team-only tasks private to their team (cross-team)', async () => {
      expect((await http().get(`/api/tasks/${ids.teamOnlyY}`).set(as('owner'))).status).toBe(403);
      expect((await http().get(`/api/tasks/${ids.teamOnlyY}`).set(as('teamY'))).status).toBe(200);
      const search = await http().get('/api/search').query({ q: `ds-team-only-y-${suffix}` }).set(as('owner'));
      expect(search.body.tasks).toEqual([]);
    });

    it('still lets a denied member leave the team', async () => {
      const left = await http().delete(`/api/teams/${ids.teamX}/members/${users.denied.id}`).set(as('denied'));
      expect(left.status).toBe(204);
      expect(await prisma.teamMember.count({ where: { teamId: ids.teamX, userId: users.denied.id } })).toBe(0);
    });

    it('applies a revoked team membership on the next request', async () => {
      expect((await http().get(`/api/tasks/${ids.teamOnlyX}`).set(as('viewer'))).status).toBe(200);
      const removed = await http().delete(`/api/teams/${ids.teamX}/members/${users.viewer.id}`).set(as('owner'));
      expect(removed.status).toBe(204);
      expect((await http().get(`/api/tasks/${ids.teamOnlyX}`).set(as('viewer'))).status).toBe(403);
    });
  });

  describe('workspace-scoped search (chat tool path)', () => {
    it('does not return tasks from the caller other workspaces', async () => {
      const scoped = await searchWorkspaceData({ userId: users.owner.id, workspaceId: ids.otherWorkspace, query: `ds-secret-${suffix}` });
      expect(scoped.tasks).toEqual([]);
      const home = await searchWorkspaceData({ userId: users.owner.id, workspaceId: ids.workspace, query: `ds-secret-${suffix}` });
      expect(home.tasks.map((t) => t.id)).toContain(ids.taskT);
    });
  });
});
