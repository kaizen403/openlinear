/**
 * W02a PrincipalContext: PAT workspace binding and scope propagation across
 * every surface the MCP worker / API client reaches, plus revocation taking
 * effect on the next request.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { dispatchTool } from '../services/chat-tools';
import { resolveTenancyContext, runWithPrincipal } from '../tenancy/context';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const suffix = randomUUID().slice(0, 8);

function sign(userId: string, username: string): string {
  return jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
}

async function createPat(userId: string, scopes: string[], workspaceId: string | null = null) {
  const token = generatePersonalAccessToken();
  const row = await prisma.personalAccessToken.create({
    data: {
      userId,
      name: `principal-${suffix}`,
      tokenHash: hashPersonalAccessToken(token),
      tokenPrefix: token.slice(0, 15),
      scopes,
      workspaceId,
    },
  });
  return { token, id: row.id };
}

describe('W02a PrincipalContext and PAT workspace binding', () => {
  const app = createApp();
  const http = useTestServer(() => app);
  const ids = {
    dual: '',
    ownerB: '',
    workspaceA: '',
    workspaceB: '',
    workspaceC: '',
    projectA: '',
    projectB: '',
    teamA: '',
    teamB: '',
    teamBInvite: '',
    taskA: '',
    taskB: '',
    runA: '',
    runB: '',
    notificationA: '',
    notificationB: '',
    activityA: '',
    activityB: '',
    invitationC: '',
  };
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  let dualJwt = '';
  let ownerBJwt = '';
  let bound = '';
  let boundRead = '';
  let unbound = '';
  const inviteCode = `INV-${suffix.toUpperCase()}`;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const mk = async (label: string) => {
      const user = await prisma.user.create({
        data: { githubId: `pc-${label}-${suffix}`, username: `pc-${label}-${suffix}`, email: `pc-${label}-${suffix}@example.com` },
      });
      userIds.push(user.id);
      return user;
    };
    const dual = await mk('dual');
    const ownerB = await mk('owner-b');
    ids.dual = dual.id;
    ids.ownerB = ownerB.id;
    dualJwt = sign(dual.id, dual.username);
    ownerBJwt = sign(ownerB.id, ownerB.username);

    const wsA = await prisma.workspace.create({ data: { name: `PC A ${suffix}`, slug: `pc-a-${suffix}` } });
    const wsB = await prisma.workspace.create({ data: { name: `PC B ${suffix}`, slug: `pc-b-${suffix}` } });
    const wsC = await prisma.workspace.create({ data: { name: `PC C ${suffix}`, slug: `pc-c-${suffix}` } });
    workspaceIds.push(wsA.id, wsB.id, wsC.id);
    ids.workspaceA = wsA.id;
    ids.workspaceB = wsB.id;
    ids.workspaceC = wsC.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: wsA.id, userId: dual.id, role: 'owner' },
        { workspaceId: wsB.id, userId: ownerB.id, role: 'owner' },
        { workspaceId: wsB.id, userId: dual.id, role: 'admin' },
        { workspaceId: wsC.id, userId: ownerB.id, role: 'owner' },
      ],
    });

    const projectA = await prisma.project.create({ data: { name: `pc-project-a-${suffix}`, workspaceId: wsA.id, key: 'PCA' } });
    const projectB = await prisma.project.create({ data: { name: `pc-project-b-${suffix}`, workspaceId: wsB.id, key: 'PCB' } });
    ids.projectA = projectA.id;
    ids.projectB = projectB.id;
    const teamA = await prisma.team.create({ data: { name: 'PC team A', key: 'PCA', projectId: projectA.id } });
    const teamB = await prisma.team.create({ data: { name: 'PC team B', key: 'PCB', projectId: projectB.id } });
    const teamBInvite = await prisma.team.create({ data: { name: 'PC invite team', key: 'PCI', projectId: projectB.id, inviteCode } });
    ids.teamA = teamA.id;
    ids.teamB = teamB.id;
    ids.teamBInvite = teamBInvite.id;
    await prisma.teamMember.createMany({
      data: [
        { teamId: teamA.id, userId: dual.id, role: 'owner' },
        { teamId: teamB.id, userId: dual.id, role: 'owner' },
        { teamId: teamB.id, userId: ownerB.id, role: 'owner' },
      ],
    });
    const taskA = await prisma.task.create({
      data: { title: `pc-secret-a-${suffix}`, status: 'done', projectId: projectA.id, teamId: teamA.id, creatorId: dual.id },
    });
    const taskB = await prisma.task.create({
      data: { title: `pc-secret-b-${suffix}`, status: 'done', projectId: projectB.id, teamId: teamB.id, creatorId: dual.id },
    });
    ids.taskA = taskA.id;
    ids.taskB = taskB.id;
    ids.runA = (await prisma.agentRun.create({ data: { taskId: taskA.id, userId: dual.id, agent: 'opencode', model: 'm', costUsd: 1 } })).id;
    ids.runB = (await prisma.agentRun.create({ data: { taskId: taskB.id, userId: dual.id, agent: 'opencode', model: 'm', costUsd: 2 } })).id;
    ids.notificationA = (await prisma.notification.create({ data: { userId: dual.id, type: 'mention', taskId: taskA.id, body: 'a' } })).id;
    ids.notificationB = (await prisma.notification.create({ data: { userId: dual.id, type: 'mention', taskId: taskB.id, body: 'b' } })).id;
    ids.activityA = (await prisma.activityLog.create({ data: { projectId: projectA.id, teamId: teamA.id, userId: dual.id, action: 'task_created', payload: {} } })).id;
    ids.activityB = (await prisma.activityLog.create({ data: { projectId: projectB.id, teamId: teamB.id, userId: dual.id, action: 'task_created', payload: {} } })).id;
    ids.invitationC = (await prisma.invitation.create({
      data: { email: dual.email!, workspaceId: wsC.id, invitedById: ownerB.id, expiresAt: new Date(Date.now() + 86_400_000) },
    })).id;

    bound = (await createPat(dual.id, ['admin'], wsA.id)).token;
    boundRead = (await createPat(dual.id, ['read'], wsA.id)).token;
    unbound = (await createPat(dual.id, ['admin'])).token;
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { members: { some: { userId: { in: userIds } } } } });
    await prisma.task.deleteMany({ where: { creatorId: { in: userIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: userIds } }, { workspaceIds: { hasSome: workspaceIds } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it('narrows the principal snapshot to the bound workspace', async () => {
    const ctx = await resolveTenancyContext({
      userId: ids.dual, authSource: 'pat', scopes: ['admin'], credentialId: 'pat', workspaceRestriction: ids.workspaceA,
    });
    expect([...ctx.workspaces.keys()]).toEqual([ids.workspaceA]);
    expect(ctx.teams.has(ids.teamA)).toBe(true);
    expect(ctx.teams.has(ids.teamB)).toBe(false);
    expect(ctx.workspaceRestriction).toBe(ids.workspaceA);
  });

  it('lists only the bound workspace, its projects and its teams', async () => {
    const ws = await http().get('/api/workspaces').set(as(bound));
    expect(ws.status).toBe(200);
    expect(ws.body.map((w: { id: string }) => w.id)).toEqual([ids.workspaceA]);
    const wsUnbound = await http().get('/api/workspaces').set(as(unbound));
    expect(wsUnbound.body.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining([ids.workspaceA, ids.workspaceB]));

    const projects = await http().get('/api/projects').set(as(bound));
    const projectIds = projects.body.map((p: { id: string }) => p.id);
    expect(projectIds).toContain(ids.projectA);
    expect(projectIds).not.toContain(ids.projectB);
    const projectsInB = await http().get('/api/projects').query({ workspaceId: ids.workspaceB }).set(as(bound));
    expect(projectsInB.body).toEqual([]);
    const projectsUnbound = await http().get('/api/projects').query({ workspaceId: ids.workspaceB }).set(as(unbound));
    expect(projectsUnbound.body.map((p: { id: string }) => p.id)).toContain(ids.projectB);

    const teams = await http().get('/api/teams').set(as(bound));
    const teamIds = teams.body.map((t: { id: string }) => t.id);
    expect(teamIds).toContain(ids.teamA);
    expect(teamIds).not.toContain(ids.teamB);
    const teamsInB = await http().get('/api/teams').query({ workspaceId: ids.workspaceB }).set(as(bound));
    expect(teamsInB.body).toEqual([]);
  });

  it('denies reads and writes of another workspace task, through every MCP task path', async () => {
    expect((await http().get(`/api/tasks/${ids.taskB}`).set(as(bound))).status).toBe(403);
    expect((await http().get(`/api/tasks/${ids.taskB}`).set(as(unbound))).status).toBe(200);
    expect((await http().get('/api/tasks').query({ projectId: ids.projectB }).set(as(bound))).status).toBe(403);

    const listed = await http().get('/api/tasks').set(as(bound));
    expect(listed.status).toBe(200);
    const listedIds = listed.body.items.map((t: { id: string }) => t.id);
    expect(listedIds).toContain(ids.taskA);
    expect(listedIds).not.toContain(ids.taskB);

    const patch = await http().patch(`/api/tasks/${ids.taskB}`).set(as(bound)).send({ title: 'hijacked' });
    expect(patch.status).toBe(403);
    const execution = await http().patch(`/api/tasks/${ids.taskB}/execution`).set(as(bound)).send({ outcome: 'hijacked' });
    expect(execution.status).toBe(403);
    const after = await prisma.task.findUnique({ where: { id: ids.taskB } });
    expect(after?.title).toBe(`pc-secret-b-${suffix}`);
    expect(after?.outcome).toBeNull();

    const before = await prisma.task.count({ where: { projectId: ids.projectB } });
    expect((await http().post('/api/tasks').set(as(bound)).send({ title: 'x', projectId: ids.projectB })).status).toBe(403);
    expect((await http().post('/api/tasks/bulk').set(as(bound)).send({ projectId: ids.projectB, tasks: [{ title: 'x' }] })).status).toBe(403);
    expect((await http().patch('/api/tasks/bulk-status').set(as(bound)).send({ projectId: ids.projectB, status: 'todo', taskIds: [ids.taskB] })).status).toBe(403);
    expect(await prisma.task.count({ where: { projectId: ids.projectB } })).toBe(before);
    expect((await prisma.task.findUnique({ where: { id: ids.taskB } }))?.status).toBe('done');

    const created = await http().post('/api/tasks').set(as(bound)).send({ title: `pc-in-a-${suffix}`, projectId: ids.projectA });
    expect(created.status).toBe(201);
  });

  it('enforces the binding on labels (phases), projects and agent runs', async () => {
    expect((await http().get('/api/labels').query({ projectId: ids.projectB }).set(as(bound))).status).toBe(403);
    expect((await http().post('/api/labels').set(as(bound)).send({ projectId: ids.projectB, name: 'phase:1 — x', color: '#112233' })).status).toBe(403);
    expect(await prisma.label.count({ where: { projectId: ids.projectB } })).toBe(0);

    expect((await http().get(`/api/projects/${ids.projectB}`).set(as(bound))).status).toBe(403);
    const crossCreate = await http().post('/api/projects').set(as(bound)).send({ name: 'pc-cross', workspaceId: ids.workspaceB });
    expect(crossCreate.status).toBe(403);
    const defaultCreate = await http().post('/api/projects').set(as(bound)).send({ name: `pc-default-${suffix}`, key: 'PCD' });
    expect(defaultCreate.status).toBe(201);
    expect(defaultCreate.body.workspaceId).toBe(ids.workspaceA);

    expect((await http().get('/api/agent-runs').query({ taskId: ids.taskB }).set(as(bound))).status).toBe(403);
    expect((await http().post('/api/agent-runs').set(as(bound)).send({ taskId: ids.taskB, agent: 'opencode', model: 'm' })).status).toBe(403);
    const progress = await http().post('/api/agent-runs/progress').set(as(bound)).send({ runId: ids.runB, events: [{ seq: 1, type: 'message' }] });
    expect(progress.status).toBe(403);
    expect(await prisma.agentRunEvent.count({ where: { runId: ids.runB } })).toBe(0);
    const mine = await http().get('/api/agent-runs').query({ userId: 'me' }).set(as(bound));
    const runIds = mine.body.items.map((r: { id: string }) => r.id);
    expect(runIds).toContain(ids.runA);
    expect(runIds).not.toContain(ids.runB);
  });

  it('keeps reporting, search, inbox, activity and notifications inside the bound workspace', async () => {
    const usage = await http().get('/api/usage/summary').set(as(bound));
    expect(usage.body.totalRuns).toBe(1);
    expect(usage.body.totalCostUsd).toBe(1);
    expect((await http().get('/api/usage/summary').set(as(dualJwt))).body.totalRuns).toBe(2);
    const byTask = await http().get('/api/usage/by-task').set(as(bound));
    expect(byTask.body.items.map((i: { taskId: string }) => i.taskId)).toEqual([ids.taskA]);

    const search = await http().get('/api/search').query({ q: `pc-secret` }).set(as(bound));
    const found = search.body.tasks.map((t: { id: string }) => t.id);
    expect(found).toContain(ids.taskA);
    expect(found).not.toContain(ids.taskB);
    expect(search.body.projects.map((p: { id: string }) => p.id)).not.toContain(ids.projectB);

    const inbox = await http().get('/api/inbox').set(as(bound));
    const inboxIds = inbox.body.items.map((t: { id: string }) => t.id);
    expect(inboxIds).toContain(ids.taskA);
    expect(inboxIds).not.toContain(ids.taskB);

    const activity = await http().get('/api/activity').set(as(bound));
    const activityIds = activity.body.items.map((a: { id: string }) => a.id);
    expect(activityIds).toContain(ids.activityA);
    expect(activityIds).not.toContain(ids.activityB);

    const notifications = await http().get('/api/notifications').set(as(bound));
    const notificationIds = notifications.body.items.map((n: { id: string }) => n.id);
    expect(notificationIds).toContain(ids.notificationA);
    expect(notificationIds).not.toContain(ids.notificationB);
    expect((await http().patch(`/api/notifications/${ids.notificationB}/read`).set(as(bound))).status).toBe(404);
    const withJwt = await http().get('/api/notifications').set(as(dualJwt));
    expect(withJwt.body.items.map((n: { id: string }) => n.id)).toEqual(expect.arrayContaining([ids.notificationA, ids.notificationB]));
  });

  it('refuses workspace administration of another workspace', async () => {
    expect((await http().get('/api/members/search').query({ workspaceId: ids.workspaceB }).set(as(bound))).status).toBe(403);
    expect((await http().get(`/api/workspaces/${ids.workspaceB}/audit-log`).set(as(bound))).status).toBe(403);
    expect((await http().get(`/api/workspaces/${ids.workspaceB}/audit-log`).set(as(dualJwt))).status).toBe(200);
    expect((await http().get('/api/chat/sessions').query({ workspaceId: ids.workspaceB }).set(as(bound))).status).toBe(403);
    expect((await http().get('/api/invitations').query({ workspaceId: ids.workspaceB }).set(as(bound))).status).toBe(403);
  });

  it('cannot widen itself: no new workspace, team invite or invitation outside its workspace', async () => {
    const ws = await http().post('/api/workspaces').set(as(bound)).send({ name: 'pc-escape' });
    expect(ws.status).toBe(403);
    expect(ws.body.code).toBe('PAT_WORKSPACE_RESTRICTED');

    const join = await http().post('/api/teams/join').set(as(bound)).send({ inviteCode });
    expect(join.status).toBe(403);
    expect(await prisma.teamMember.count({ where: { teamId: ids.teamBInvite, userId: ids.dual } })).toBe(0);

    const pending = await http().get('/api/invitations/pending').set(as(bound));
    expect(pending.body.map((i: { id: string }) => i.id)).not.toContain(ids.invitationC);
    const accept = await http().post(`/api/invitations/${ids.invitationC}/accept`).set(as(bound)).send({});
    expect(accept.status).toBe(403);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: ids.workspaceC, userId: ids.dual } })).toBe(0);
  });

  it('does not release the account-wide SCM token to a workspace-bound PAT', async () => {
    const boundRes = await http().get('/api/users/me/scm-token').set(as(bound));
    expect(boundRes.status).toBe(403);
    expect(boundRes.body.code).toBe('PAT_WORKSPACE_RESTRICTED');
    const unboundRes = await http().get('/api/users/me/scm-token').set(as(unbound));
    expect(unboundRes.status).toBe(404);
    expect(unboundRes.body.code).toBe('GITHUB_NOT_LINKED');
  });

  it('still enforces PAT scopes inside the bound workspace, including chat tools', async () => {
    const res = await http().post('/api/tasks').set(as(boundRead)).send({ title: 'x', projectId: ids.projectA });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_SCOPE');

    const session = await prisma.chatSession.create({ data: { userId: ids.dual, workspaceId: ids.workspaceA } });
    const principal = await resolveTenancyContext({
      userId: ids.dual, authSource: 'pat', scopes: ['read'], credentialId: 'p', workspaceRestriction: ids.workspaceA,
    });
    const result = await runWithPrincipal(principal, () => dispatchTool(
      'create_issue',
      { userId: ids.dual, sessionId: session.id, workspaceId: ids.workspaceA, toolCallId: `tc-${suffix}` },
      { title: 'from tool', projectId: ids.projectA },
    ));
    expect(result.code).toBe('INSUFFICIENT_SCOPE');
    expect(await prisma.chatToolCall.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it('never creates a default workspace on behalf of a bound PAT whose membership is gone', async () => {
    const lonely = await prisma.user.create({
      data: { githubId: `pc-lonely-${suffix}`, username: `pc-lonely-${suffix}`, email: `pc-lonely-${suffix}@example.com` },
    });
    userIds.push(lonely.id);
    const pat = await createPat(lonely.id, ['admin'], ids.workspaceA);
    const res = await http().get('/api/workspaces').set(as(pat.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(await prisma.workspaceMember.count({ where: { userId: lonely.id } })).toBe(0);
    expect((await http().get(`/api/projects/${ids.projectA}`).set(as(pat.token))).status).toBe(403);
  });

  it('revokes PATs bound to a deleted workspace instead of widening them', async () => {
    const ws = await prisma.workspace.create({ data: { name: `PC D ${suffix}`, slug: `pc-d-${suffix}` } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: ids.dual, role: 'owner' } });
    const pat = await createPat(ids.dual, ['admin'], ws.id);
    const deleted = await http().delete(`/api/workspaces/${ws.id}`).set(as(dualJwt));
    expect(deleted.status).toBe(204);
    const row = await prisma.personalAccessToken.findUnique({ where: { id: pat.id } });
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect((await http().get('/api/workspaces').set(as(pat.token))).status).toBe(401);
  });

  it('applies a revoked workspace membership on the very next request, for sessions and PATs', async () => {
    expect((await http().get(`/api/projects/${ids.projectB}`).set(as(dualJwt))).status).toBe(200);
    expect((await http().get(`/api/tasks/${ids.taskB}`).set(as(unbound))).status).toBe(200);

    const removed = await http().delete(`/api/workspaces/${ids.workspaceB}/members/${ids.dual}`).set(as(ownerBJwt));
    expect(removed.status).toBe(204);

    expect([403, 404]).toContain((await http().get(`/api/projects/${ids.projectB}`).set(as(dualJwt))).status);
    expect([403, 404]).toContain((await http().get(`/api/tasks/${ids.taskB}`).set(as(unbound))).status);
    expect([403, 404]).toContain((await http().get(`/api/teams/${ids.teamB}`).set(as(unbound))).status);
    const usage = await http().get('/api/usage/by-task').set(as(dualJwt));
    expect(usage.body.items.map((i: { taskId: string }) => i.taskId)).not.toContain(ids.taskB);
  });
});
