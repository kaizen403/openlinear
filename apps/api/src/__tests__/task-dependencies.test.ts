/**
 * W17a: "blocked by" relations — add/list/remove, same-project scope, no
 * self-edges, no cycles (also under concurrent opposite writes), the
 * execution gate (TASK_BLOCKED unless allowBlocked), batch edge queries,
 * access, and edges dropped when a task changes project.
 *
 * Real PostgreSQL (TEST_DATABASE_URL); fixtures delete only what they create.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const http = useTestServer(() => createApp());
const ids = { users: [] as string[], workspaces: [] as string[] };
const tokens = { owner: '', viewer: '', stranger: '' };
const t: Record<string, string> = {};
let projectId = '';
let otherProjectId = '';

type Body = Record<string, unknown>;

function as(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function block(taskId: string, dependsOnTaskId: string, token = tokens.owner) {
  return http().post(`/api/tasks/${taskId}/dependencies`).set(as(token)).send({ dependsOnTaskId });
}

function idsOf(list: unknown): string[] {
  return (list as Array<{ id: string }>).map((item) => item.id);
}

beforeAll(async () => {
  const owner = await prisma.user.create({ data: { username: `w17-${RUN}`, email: `w17-${RUN}@example.com` } });
  const viewer = await prisma.user.create({ data: { username: `w17-v-${RUN}`, email: `w17-v-${RUN}@example.com` } });
  const stranger = await prisma.user.create({ data: { username: `w17-x-${RUN}`, email: `w17-x-${RUN}@example.com` } });
  ids.users.push(owner.id, viewer.id, stranger.id);
  tokens.owner = jwt.sign({ userId: owner.id, username: owner.username }, testJwtSecret(), { expiresIn: '1h' });
  tokens.viewer = jwt.sign({ userId: viewer.id, username: viewer.username }, testJwtSecret(), { expiresIn: '1h' });
  tokens.stranger = jwt.sign({ userId: stranger.id, username: stranger.username }, testJwtSecret(), { expiresIn: '1h' });
  const workspace = await prisma.workspace.create({ data: { name: `W17 ${RUN}`, slug: `w17-${RUN}` } });
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.createMany({ data: [
    { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
    { workspaceId: workspace.id, userId: viewer.id, role: 'member' },
  ] });
  const project = await prisma.project.create({ data: { name: `Deps ${RUN}`, workspaceId: workspace.id, key: `DP${RUN.slice(0, 3).toUpperCase()}` } });
  const other = await prisma.project.create({ data: { name: `Other ${RUN}`, workspaceId: workspace.id, key: `DO${RUN.slice(0, 3).toUpperCase()}` } });
  projectId = project.id;
  otherProjectId = other.id;
  await prisma.projectAccess.create({ data: { projectId, userId: viewer.id, permission: 'view' } });
  const team = await prisma.team.create({ data: { name: `W17 ${RUN}`, key: `TD${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  const otherTeam = await prisma.team.create({ data: { name: `W17 o ${RUN}`, key: `TO${RUN.slice(0, 2).toUpperCase()}`, projectId: otherProjectId } });
  await prisma.teamMember.createMany({ data: [
    { teamId: team.id, userId: owner.id, role: 'owner' },
    { teamId: otherTeam.id, userId: owner.id, role: 'owner' },
  ] });
  let number = 0;
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N']) {
    number += 1;
    const task = await prisma.task.create({ data: {
      title: `Task ${name}`, projectId, teamId: team.id, workspaceId: workspace.id, creatorId: owner.id,
      number, identifier: `DP-${number}`,
    } });
    t[name] = task.id;
  }
  const outside = await prisma.task.create({ data: { title: 'Elsewhere', projectId: otherProjectId, teamId: otherTeam.id, workspaceId: workspace.id, creatorId: owner.id } });
  t.X = outside.id;
});

afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.task.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('W17a task dependencies', () => {
  it('adds a blocker once, and shows it in both directions and on the task', async () => {
    const first = await block(t.B!, t.A!);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, blockedBy: [{ id: t.A, identifier: 'DP-1', status: 'todo', resolved: false }], blocking: [] });
    const again = await block(t.B!, t.A!);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false });

    const task = await http().get(`/api/tasks/${t.B}`).set(as(tokens.owner));
    expect(task.body).toMatchObject({ blockedByIds: [t.A], openBlockerCount: 1 });
    expect(idsOf(task.body.blockedBy)).toEqual([t.A]);
    const blocker = await http().get(`/api/tasks/${t.A}`).set(as(tokens.owner));
    expect(idsOf(blocker.body.blocking)).toEqual([t.B]);
    expect(blocker.body).toMatchObject({ openBlockerCount: 0, blockedByIds: [] });

    const list = await http().get(`/api/tasks?projectId=${projectId}&pageSize=50`).set(as(tokens.owner));
    const row = (list.body.items as Body[]).find((item) => item.id === t.B);
    expect(row).toMatchObject({ blockedByIds: [t.A], openBlockerCount: 1 });
  });

  it('refuses self-edges and tasks in another project', async () => {
    expect((await block(t.A!, t.A!)).body).toMatchObject({ code: 'DEPENDENCY_SELF' });
    const cross = await block(t.A!, t.X!);
    expect(cross.status).toBe(400);
    expect(cross.body).toMatchObject({ code: 'DEPENDENCY_SCOPE' });
  });

  it('refuses direct and transitive cycles', async () => {
    expect((await block(t.C!, t.B!)).status).toBe(201); // C ← B ← A
    const direct = await block(t.A!, t.B!);
    expect(direct.status).toBe(409);
    expect(direct.body).toMatchObject({ code: 'DEPENDENCY_CYCLE' });
    const transitive = await block(t.A!, t.C!);
    expect(transitive.status).toBe(409);
    expect(transitive.body.message).toContain('DP-3 already waits on DP-1');
  });

  it('lets exactly one of two concurrent opposite edges win', async () => {
    const [one, two] = await Promise.all([block(t.D!, t.E!), block(t.E!, t.D!)]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    expect(await prisma.taskDependency.count({ where: { OR: [{ taskId: t.D }, { taskId: t.E }] } })).toBe(1);
  });

  it('refuses to start a blocked task unless the caller runs it anyway; a done blocker unblocks', async () => {
    expect((await block(t.F!, t.G!)).status).toBe(201);
    const refused = await http().post('/api/executions/attempts').set(as(tokens.owner)).send({ taskId: t.F });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'TASK_BLOCKED', details: { blockers: [{ id: t.G, identifier: 'DP-7', status: 'todo' }] } });
    expect(refused.body.message).toContain('blocked by DP-7');
    expect(await prisma.executionAttempt.count({ where: { taskId: t.F } })).toBe(0);

    const anyway = await http().post('/api/executions/attempts').set(as(tokens.owner)).send({ taskId: t.F, allowBlocked: true });
    expect(anyway.status).toBe(201);
    await prisma.executionAttempt.deleteMany({ where: { taskId: t.F } });

    await http().patch(`/api/tasks/${t.G}`).set(as(tokens.owner)).send({ status: 'done' }).expect(200);
    const unblocked = await http().get(`/api/tasks/${t.F}`).set(as(tokens.owner));
    expect(unblocked.body).toMatchObject({ openBlockerCount: 0, blockedBy: [{ id: t.G, resolved: true }] });
    expect((await http().post('/api/executions/attempts').set(as(tokens.owner)).send({ taskId: t.F })).status).toBe(201);
  });

  it('a cancelled blocker still blocks (a failed run ends as cancelled)', async () => {
    // Its own pair: E/D take part in the concurrency race above.
    expect((await block(t.J!, t.I!)).status).toBe(201);
    await http().patch(`/api/tasks/${t.I}`).set(as(tokens.owner)).send({ status: 'cancelled' }).expect(200);
    const task = await http().get(`/api/tasks/${t.J}`).set(as(tokens.owner));
    expect(task.body).toMatchObject({ openBlockerCount: 1, blockedBy: [{ id: t.I, status: 'cancelled', resolved: false }] });
    expect((await http().post('/api/executions/attempts').set(as(tokens.owner)).send({ taskId: t.J })).body).toMatchObject({ code: 'TASK_BLOCKED' });
    await http().delete(`/api/tasks/${t.J}/dependencies/${t.I}`).set(as(tokens.owner)).expect(204);
  });

  it('answers the unfinished blockers transitively, stopping at done ones (run with blockers)', async () => {
    // The graph so far: C ← B ← A, both open.
    const closure = await http().get(`/api/tasks/${t.C}/dependencies/closure`).set(as(tokens.owner));
    expect(closure.status).toBe(200);
    expect(closure.body.truncated).toBe(false);
    expect(idsOf(closure.body.tasks).sort()).toEqual([t.A, t.B].sort());
    // F's only blocker G is done: nothing to run first.
    expect((await http().get(`/api/tasks/${t.F}/dependencies/closure`).set(as(tokens.owner))).body).toEqual({ tasks: [], truncated: false });
    expect((await http().get(`/api/tasks/${t.C}/dependencies/closure`).set(as(tokens.stranger))).status).toBeGreaterThanOrEqual(403);
  });

  it('answers the edges among a set of tasks (batch ordering)', async () => {
    const res = await http().get(`/api/tasks/dependencies?taskIds=${t.A},${t.B},${t.C}`).set(as(tokens.owner));
    expect(res.status).toBe(200);
    expect(res.body.edges).toEqual([
      { taskId: t.B, dependsOnTaskId: t.A },
      { taskId: t.C, dependsOnTaskId: t.B },
    ]);
    expect((await http().get('/api/tasks/dependencies').set(as(tokens.owner))).status).toBe(400);
    expect((await http().get(`/api/tasks/dependencies?taskIds=${t.A}`).set(as(tokens.stranger))).status).toBeGreaterThanOrEqual(403);
  });

  it('lets viewers read but not change dependencies; strangers get nothing', async () => {
    const read = await http().get(`/api/tasks/${t.B}/dependencies`).set(as(tokens.viewer));
    expect(read.status).toBe(200);
    expect(idsOf(read.body.blockedBy)).toEqual([t.A]);
    expect((await block(t.H!, t.A!, tokens.viewer)).status).toBe(403);
    expect((await http().delete(`/api/tasks/${t.B}/dependencies/${t.A}`).set(as(tokens.viewer))).status).toBe(403);
    const hidden = await http().get(`/api/tasks/${t.B}/dependencies`).set(as(tokens.stranger));
    expect(hidden.status).toBeGreaterThanOrEqual(403);
    expect(hidden.status).toBeLessThan(500);
  });

  it('removes an edge idempotently', async () => {
    expect((await http().delete(`/api/tasks/${t.C}/dependencies/${t.B}`).set(as(tokens.owner))).status).toBe(204);
    expect((await http().delete(`/api/tasks/${t.C}/dependencies/${t.B}`).set(as(tokens.owner))).status).toBe(204);
    const after = await http().get(`/api/tasks/${t.C}/dependencies`).set(as(tokens.owner));
    expect(after.body).toEqual({ blockedBy: [], blocking: [] });
  });

  it('FE-11: suggests similar open issues in the project (archived and cancelled ones left out)', async () => {
    const team = await prisma.team.findFirstOrThrow({ where: { projectId } });
    const workspaceId = ids.workspaces[0];
    const make = (title: string, extra: { archived?: boolean; status?: 'cancelled' } = {}) =>
      prisma.task.create({ data: { title, projectId, teamId: team.id, workspaceId, creatorId: ids.users[0], ...extra } });
    const close = await make('Fix the login form validation');
    const closer = await make('Login form validation is broken');
    await make('Add a billing page');
    await make('Login form validation (old)', { archived: true });
    await make('Login form validation retry', { status: 'cancelled' });

    const res = await http().get(`/api/tasks/similar?projectId=${projectId}&title=${encodeURIComponent('login form validation')}`).set(as(tokens.owner));
    expect(res.status).toBe(200);
    const found = res.body.items as Array<{ id: string; title: string; score: number }>;
    expect(found.map((item) => item.id).sort()).toEqual([close.id, closer.id].sort());
    expect(found.every((item) => item.score > 0 && item.score <= 1)).toBe(true);
    // Excluding the task being edited; too-short titles answer nothing.
    const excluding = await http().get(`/api/tasks/similar?projectId=${projectId}&title=${encodeURIComponent('login form validation')}&excludeTaskId=${close.id}`).set(as(tokens.owner));
    expect((excluding.body.items as Array<{ id: string }>).map((item) => item.id)).toEqual([closer.id]);
    expect((await http().get(`/api/tasks/similar?projectId=${projectId}&title=abc`).set(as(tokens.owner))).body).toEqual({ items: [] });
    expect((await http().get(`/api/tasks/similar?projectId=${projectId}&title=login`).set(as(tokens.stranger))).status).toBeGreaterThanOrEqual(403);
  });

  it('tells the assignee when the last blocker is done (and not while another still blocks)', async () => {
    const viewerId = ids.users[1]!;
    await prisma.task.updateMany({ where: { id: { in: [t.L!, t.N!] } }, data: { assigneeId: viewerId } });
    expect((await block(t.L!, t.K!)).status).toBe(201);
    expect((await block(t.N!, t.K!)).status).toBe(201);
    expect((await block(t.N!, t.M!)).status).toBe(201);
    await http().patch(`/api/tasks/${t.K}`).set(as(tokens.owner)).send({ status: 'done' }).expect(200);
    const notes = await prisma.notification.findMany({ where: { userId: viewerId, taskId: { in: [t.L!, t.N!] } }, select: { taskId: true, body: true, type: true } });
    expect(notes).toEqual([{ taskId: t.L, type: 'status_change', body: 'DP-12 is unblocked: everything it waited on is done' }]);
    await prisma.notification.deleteMany({ where: { userId: viewerId } });
  });

  it('drops the edges of a task that moves to another project', async () => {
    expect((await block(t.H!, t.A!)).status).toBe(201);
    await http().patch(`/api/tasks/${t.H}`).set(as(tokens.owner)).send({ projectId: otherProjectId }).expect(200);
    expect(await prisma.taskDependency.count({ where: { OR: [{ taskId: t.H }, { dependsOnTaskId: t.H }] } })).toBe(0);
    // B ← A is untouched.
    expect(await prisma.taskDependency.count({ where: { taskId: t.B, dependsOnTaskId: t.A } })).toBe(1);
  });
});
