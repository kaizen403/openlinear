/**
 * W14 contract and safety fixes:
 *   - bulk endpoints need an explicit selection (TASK_IDS_REQUIRED) and an
 *     explicit scope (BULK_SCOPE_INVALID); `teamId` scope reaches a team's
 *     project-less tasks;
 *   - bulk-status matches a single PATCH (batch reset, creator notification);
 *     bulk-delete checks team roles and sends per-task events;
 *   - POST /api/tasks honours assigneeIds (team members only);
 *   - POST /api/labels/tasks/:id/labels requires the task's project label;
 *   - POST/PATCH /api/projects `teamIds` moves teams when consistent instead
 *     of always answering 409;
 *   - GET /api/tasks/:id carries parent + sub-issues, search hits carry status.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { createTestSession, makeUser, type TestUser } from './auth-helpers';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const http = useTestServer(() => createApp());

const fx = {
  workspace: '', otherWorkspace: '',
  project: '', team: '', spareTeam: '', project2: '', team2: '', otherProject: '', otherTeam: '',
  label: '', label2: '', otherLabel: '',
};
let owner: TestUser;
let member: TestUser;
let admin: TestUser;
let outsider: TestUser;
const jwt: Record<string, string> = {};
let numberSeq = 1;

async function task(input: { title?: string; projectId?: string | null; teamId?: string | null; creatorId?: string; batchId?: string; status?: 'todo' | 'in_progress' | 'done'; parentId?: string } = {}) {
  const number = 10_000 + numberSeq++;
  return prisma.task.create({
    data: {
      title: input.title ?? `t-${randomUUID().slice(0, 6)}`,
      projectId: input.projectId === undefined ? fx.project : input.projectId,
      teamId: input.teamId === undefined ? fx.team : input.teamId,
      creatorId: input.creatorId ?? owner.id,
      number,
      identifier: `CTR${RUN.slice(0, 3).toUpperCase()}-${number}`,
      batchId: input.batchId,
      status: input.status ?? 'todo',
      parentId: input.parentId,
    },
  });
}

const as = (who: string) => `Bearer ${jwt[who]}`;

beforeAll(async () => {
  owner = await makeUser('ctr-owner', RUN);
  member = await makeUser('ctr-member', RUN);
  admin = await makeUser('ctr-admin', RUN);
  outsider = await makeUser('ctr-outsider', RUN);
  for (const [name, user] of Object.entries({ owner, member, admin, outsider })) {
    jwt[name] = (await createTestSession(user)).accessToken;
  }
  const workspace = await prisma.workspace.create({ data: { name: `Contract ${RUN}`, slug: `ctr-${RUN}` } });
  const other = await prisma.workspace.create({ data: { name: `Contract other ${RUN}`, slug: `ctr-o-${RUN}` } });
  fx.workspace = workspace.id;
  fx.otherWorkspace = other.id;
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
      { workspaceId: workspace.id, userId: member.id, role: 'member' },
      { workspaceId: workspace.id, userId: admin.id, role: 'admin' },
      { workspaceId: other.id, userId: outsider.id, role: 'owner' },
    ],
  });
  const project = await prisma.project.create({ data: { name: `CTR ${RUN}`, key: 'CTRA', workspaceId: workspace.id } });
  fx.project = project.id;
  fx.team = (await prisma.team.create({
    data: { name: 'Main', key: 'CTRA', projectId: project.id, members: { create: [{ userId: owner.id, role: 'owner' }, { userId: member.id, role: 'member' }] } },
  })).id;
  fx.spareTeam = (await prisma.team.create({
    data: { name: 'Spare', key: 'SPARE', projectId: project.id, members: { create: [{ userId: owner.id, role: 'owner' }, { userId: member.id, role: 'member' }] } },
  })).id;
  const project2 = await prisma.project.create({ data: { name: `CTR2 ${RUN}`, key: 'CTRB', workspaceId: workspace.id } });
  fx.project2 = project2.id;
  fx.team2 = (await prisma.team.create({
    data: { name: 'Only', key: 'CTRB', projectId: project2.id, members: { create: [{ userId: owner.id, role: 'owner' }] } },
  })).id;
  const otherProject = await prisma.project.create({ data: { name: `CTRO ${RUN}`, key: 'CTRO', workspaceId: other.id } });
  fx.otherProject = otherProject.id;
  fx.otherTeam = (await prisma.team.create({
    data: { name: 'Other', key: 'CTRO', projectId: otherProject.id, members: { create: [{ userId: outsider.id, role: 'owner' }] } },
  })).id;
  fx.label = (await prisma.label.create({ data: { name: 'mine', color: '#111111', projectId: project.id } })).id;
  fx.label2 = (await prisma.label.create({ data: { name: 'p2', color: '#222222', projectId: project2.id } })).id;
  fx.otherLabel = (await prisma.label.create({ data: { name: 'theirs', color: '#333333', projectId: otherProject.id } })).id;
});

afterAll(async () => {
  const userIds = [owner.id, member.id, admin.id, outsider.id];
  const workspaceIds = [fx.workspace, fx.otherWorkspace];
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.idempotencyRecord.deleteMany({ where: { principalId: { in: userIds } } });
  await prisma.task.deleteMany({ where: { OR: [{ project: { workspaceId: { in: workspaceIds } } }, { creatorId: { in: userIds } }] } });
  await prisma.project.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('bulk endpoints: explicit selection and scope', () => {
  it('bulk-status without taskIds, or with an empty list, is refused and changes nothing', async () => {
    const a = await task();
    const b = await task();
    for (const body of [{ projectId: fx.project, status: 'done' }, { projectId: fx.project, status: 'done', taskIds: [] }]) {
      const res = await http().patch('/api/tasks/bulk-status').set('Authorization', as('owner')).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TASK_IDS_REQUIRED');
    }
    const statuses = await prisma.task.findMany({ where: { id: { in: [a.id, b.id] } }, select: { status: true } });
    expect(statuses.every((row) => row.status === 'todo')).toBe(true);
  });

  it('needs exactly one of projectId / teamId', async () => {
    const a = await task();
    const neither = await http().patch('/api/tasks/bulk-status').set('Authorization', as('owner')).send({ status: 'done', taskIds: [a.id] });
    expect(neither.status).toBe(400);
    expect(neither.body.code).toBe('BULK_SCOPE_INVALID');
    const both = await http().post('/api/tasks/bulk-archive').set('Authorization', as('owner')).send({ projectId: fx.project, teamId: fx.team, taskIds: [a.id] });
    expect(both.body.code).toBe('BULK_SCOPE_INVALID');
    const deleteNeither = await http().post('/api/tasks/bulk-delete').set('Authorization', as('owner')).send({ taskIds: [a.id] });
    expect(deleteNeither.body.code).toBe('BULK_SCOPE_INVALID');
  });

  it('teamId scope updates, archives and deletes the team\'s project-less tasks only', async () => {
    const teamOnly = await task({ projectId: null });
    const inProject = await task();
    const status = await http().patch('/api/tasks/bulk-status').set('Authorization', as('member'))
      .send({ teamId: fx.team, status: 'in_progress', taskIds: [teamOnly.id, inProject.id] });
    expect(status.status, status.text).toBe(200);
    expect(status.body.updated.map((row: { id: string }) => row.id)).toEqual([teamOnly.id]);
    expect(status.body.failed).toEqual([{ id: inProject.id, error: "Issue was not found among the team's issues without a project" }]);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: inProject.id } })).status).toBe('todo');

    const archive = await http().post('/api/tasks/bulk-archive').set('Authorization', as('member')).send({ teamId: fx.team, taskIds: [teamOnly.id] });
    expect(archive.status).toBe(200);
    expect(archive.body.count).toBe(1);

    const toDelete = await task({ projectId: null });
    const del = await http().post('/api/tasks/bulk-delete').set('Authorization', as('member')).send({ teamId: fx.team, taskIds: [toDelete.id], permanent: true });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toEqual([toDelete.id]);
    expect(await prisma.task.count({ where: { id: toDelete.id } })).toBe(0);
  });

  it('teamId scope requires team membership', async () => {
    const teamOnly = await task({ projectId: null });
    const res = await http().patch('/api/tasks/bulk-status').set('Authorization', as('admin')).send({ teamId: fx.team, status: 'done', taskIds: [teamOnly.id] });
    expect(res.status).toBe(404);
    const foreign = await http().patch('/api/tasks/bulk-status').set('Authorization', as('outsider')).send({ teamId: fx.team, status: 'done', taskIds: [teamOnly.id] });
    expect([403, 404]).toContain(foreign.status);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: teamOnly.id } })).status).toBe('todo');
  });
});

describe('bulk parity with single-task writes', () => {
  it('bulk-status resets the batch and notifies the creator, like PATCH /api/tasks/:id', async () => {
    const created = await task({ creatorId: member.id, batchId: `batch-${RUN}`, status: 'in_progress' });
    const res = await http().patch('/api/tasks/bulk-status').set('Authorization', as('owner')).send({ projectId: fx.project, status: 'done', taskIds: [created.id] });
    expect(res.status).toBe(200);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.batchId).toBeNull();
    const notes = await prisma.notification.findMany({ where: { userId: member.id, taskId: created.id, type: 'status_change' } });
    expect(notes).toHaveLength(1);
  });

  it('bulk-delete checks the team role (a workspace admin outside the team is refused)', async () => {
    const victim = await task();
    const res = await http().post('/api/tasks/bulk-delete').set('Authorization', as('admin')).send({ projectId: fx.project, taskIds: [victim.id], permanent: true });
    expect(res.status).toBe(404);
    expect(await prisma.task.count({ where: { id: victim.id } })).toBe(1);
  });

  it('bulk-delete appends a per-task task:deleted event', async () => {
    const victim = await task();
    const res = await http().post('/api/tasks/bulk-delete').set('Authorization', as('owner')).send({ projectId: fx.project, taskIds: [victim.id] });
    expect(res.status).toBe(200);
    const like = `%${victim.id}%`;
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT ((SELECT count(*) FROM domain_events WHERE type = 'task:deleted' AND payload::text LIKE ${like})
            + (SELECT count(*) FROM domain_event_outbox WHERE type = 'task:deleted' AND payload::text LIKE ${like}))::int AS n`;
    expect(row?.n).toBe(1);
  });
});

describe('POST /api/tasks assignees and labels', () => {
  it('honours assigneeIds: rows for every assignee, the first is the primary, assignees are notified', async () => {
    const res = await http().post('/api/tasks').set('Authorization', as('owner'))
      .send({ title: `assigned-${RUN}`, projectId: fx.project, assigneeIds: [member.id, owner.id] });
    expect(res.status, res.text).toBe(201);
    expect(res.body.assigneeId).toBe(member.id);
    expect(res.body.assignee).toMatchObject({ id: member.id });
    const rows = await prisma.taskAssignee.findMany({ where: { taskId: res.body.id }, select: { userId: true, role: true } });
    expect(rows.map((row) => row.userId).sort()).toEqual([member.id, owner.id].sort());
    expect(rows.every((row) => row.role === 'assignee')).toBe(true);
    expect(await prisma.notification.count({ where: { userId: member.id, taskId: res.body.id, type: 'assignment' } })).toBe(1);
  });

  it('an explicit assigneeId stays the primary', async () => {
    const res = await http().post('/api/tasks').set('Authorization', as('owner'))
      .send({ title: `primary-${RUN}`, projectId: fx.project, assigneeId: owner.id, assigneeIds: [member.id] });
    expect(res.status).toBe(201);
    expect(res.body.assigneeId).toBe(owner.id);
  });

  it('refuses assignees outside the task\'s team and creates nothing', async () => {
    const title = `bad-assignee-${RUN}`;
    const res = await http().post('/api/tasks').set('Authorization', as('owner'))
      .send({ title, projectId: fx.project, assigneeIds: [admin.id] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await prisma.task.count({ where: { title } })).toBe(0);
  });

  it('refuses labels on a project-less task and labels of another project', async () => {
    const teamOnly = await http().post('/api/tasks').set('Authorization', as('owner')).send({ title: `tl-${RUN}`, teamId: fx.team, labelIds: [fx.label] });
    expect(teamOnly.status).toBe(400);
    const foreign = await http().post('/api/tasks').set('Authorization', as('owner')).send({ title: `fl-${RUN}`, projectId: fx.project, labelIds: [fx.label2] });
    expect(foreign.status).toBe(400);
  });

  it('bulk create reports non-member assignees per item and sets the primary assignee', async () => {
    const res = await http().post('/api/tasks/bulk').set('Authorization', as('owner')).send({
      projectId: fx.project,
      tasks: [
        { title: `bulk-ok-${RUN}`, assigneeIds: [member.id] },
        { title: `bulk-bad-${RUN}`, assigneeIds: [admin.id] },
      ],
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.created[0].assigneeId).toBe(member.id);
    expect(res.body.failed).toEqual([{ index: 1, error: `Users are not members of this team: ${admin.id}` }]);
  });
});

describe('POST /api/labels/tasks/:id/labels', () => {
  it('attaches a label of the task\'s project', async () => {
    const t = await task();
    const res = await http().post(`/api/labels/tasks/${t.id}/labels`).set('Authorization', as('owner')).send({ labelId: fx.label });
    expect(res.status).toBe(201);
  });

  it('refuses a label of another visible project with LABEL_NOT_IN_TASK_PROJECT', async () => {
    const t = await task();
    const res = await http().post(`/api/labels/tasks/${t.id}/labels`).set('Authorization', as('owner')).send({ labelId: fx.label2 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LABEL_NOT_IN_TASK_PROJECT');
    expect(await prisma.taskLabel.count({ where: { taskId: t.id } })).toBe(0);
  });

  it('does not reveal labels of projects the caller cannot see', async () => {
    const t = await task();
    const res = await http().post(`/api/labels/tasks/${t.id}/labels`).set('Authorization', as('owner')).send({ labelId: fx.otherLabel });
    expect([403, 404]).toContain(res.status);
    expect(res.body.code).not.toBe('LABEL_NOT_IN_TASK_PROJECT');
  });
});

describe('projects with teamIds', () => {
  it('moves a spare team into the new project instead of answering 409', async () => {
    const name = `adopt-${RUN}`;
    const res = await http().post('/api/projects').set('Authorization', as('owner')).send({ name, workspaceId: fx.workspace, teamIds: [fx.spareTeam] });
    expect(res.status, res.text).toBe(201);
    expect(res.body.teams.map((team: { id: string }) => team.id)).toEqual([fx.spareTeam]);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: fx.spareTeam } });
    expect(team.projectId).toBe(res.body.id);
    // The source project keeps its other team.
    expect(await prisma.team.count({ where: { projectId: fx.project } })).toBe(1);
  });

  it('refuses a team that has tasks in its project, and creates nothing', async () => {
    await task();
    // Keep a second team in the project so only the task rule applies.
    await prisma.team.create({ data: { name: 'Keeper', key: 'KEEP', projectId: fx.project } });
    const name = `busy-${RUN}`;
    const res = await http().post('/api/projects').set('Authorization', as('owner')).send({ name, workspaceId: fx.workspace, teamIds: [fx.team] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEAM_PROJECT_CONFLICT');
    expect(res.body.details.teams).toEqual([{ teamId: fx.team, reason: 'TEAM_HAS_PROJECT_TASKS' }]);
    expect(await prisma.project.count({ where: { name } })).toBe(0);
  });

  it('refuses the last team of a project', async () => {
    const res = await http().post('/api/projects').set('Authorization', as('owner')).send({ name: `last-${RUN}`, workspaceId: fx.workspace, teamIds: [fx.team2] });
    expect(res.status).toBe(409);
    expect(res.body.details.teams).toEqual([{ teamId: fx.team2, reason: 'LAST_TEAM_OF_PROJECT' }]);
  });

  it('requires owner/admin on the team', async () => {
    const res = await http().post('/api/projects').set('Authorization', as('member')).send({ name: `member-${RUN}`, workspaceId: fx.workspace, teamIds: [fx.team] });
    expect(res.status).toBe(403);
  });

  it('PATCH /api/projects/:id with teamIds moves a team in', async () => {
    const spare = await prisma.team.create({
      data: { name: 'Spare 2', key: 'SPARE2', projectId: fx.project, members: { create: [{ userId: owner.id, role: 'owner' }] } },
    });
    const res = await http().patch(`/api/projects/${fx.project2}`).set('Authorization', as('owner')).send({ teamIds: [spare.id] });
    expect(res.status, res.text).toBe(200);
    expect(res.body.teams.map((team: { id: string }) => team.id).sort()).toEqual([fx.team2, spare.id].sort());
  });
});

describe('agent read helpers', () => {
  it('GET /api/tasks/:id carries the parent and the sub-issues', async () => {
    const parent = await task({ title: `parent-${RUN}` });
    const child = await task({ title: `child-${RUN}`, parentId: parent.id });
    const parentRes = await http().get(`/api/tasks/${parent.id}`).set('Authorization', as('owner'));
    expect(parentRes.body.parent).toBeNull();
    expect(parentRes.body.subtasks).toEqual([{ id: child.id, identifier: child.identifier, title: child.title, status: 'todo' }]);
    const childRes = await http().get(`/api/tasks/${child.id}`).set('Authorization', as('owner'));
    expect(childRes.body.parent).toMatchObject({ id: parent.id, title: parent.title });
    expect(childRes.body.subtasks).toEqual([]);
  });

  it('GET /api/search task hits carry status and project/team ids', async () => {
    const hit = await task({ title: `searchable-${RUN}` });
    const res = await http().get(`/api/search?q=searchable-${RUN}&types=tasks`).set('Authorization', as('owner'));
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([expect.objectContaining({ id: hit.id, status: 'todo', projectId: fx.project, teamId: fx.team, type: 'task' })]);
  });
});
