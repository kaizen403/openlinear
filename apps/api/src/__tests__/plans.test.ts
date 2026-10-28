/**
 * W17b reviewable plans: validation before storing, immutable revisions with
 * diffs and optimistic concurrency, approval that creates tasks (with the
 * acceptance checklist) and their dependencies once, three-way updates that
 * keep edits made on the tasks, deleted tasks not recreated, loops with
 * hand-made dependencies refused atomically, access, archive.
 *
 * Real PostgreSQL (TEST_DATABASE_URL); fixtures delete only what they create.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import type { PlanSpec } from '../schemas/plans';
import { diffPlanSpecs, taskDescriptionFor, topologicalOrder, validatePlanSpec } from '../services/plans';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const http = useTestServer(() => createApp());
const ids = { users: [] as string[], workspaces: [] as string[] };
const tokens = { owner: '', viewer: '', stranger: '' };
let projectId = '';

type Body = Record<string, unknown>;
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

const SPEC_V1: PlanSpec = {
  summary: 'Ship login',
  tasks: [
    { key: 'schema', title: 'Design the users table', acceptance: ['Migration applies on a fresh DB'], estimate: 's' },
    { key: 'api', title: 'Login endpoint', description: 'POST /login', blockedBy: ['schema'], acceptance: ['401 on a bad password', '200 sets a session'], estimate: 'm' },
    { key: 'ui', title: 'Login form', blockedBy: ['api'] },
  ],
};

async function createPlan(spec: unknown = SPEC_V1, title = 'Login', headers: Record<string, string> = {}) {
  return http().post(`/api/projects/${projectId}/plans`).set({ ...as(tokens.owner), ...headers }).send({ title, spec });
}

async function approve(planId: string, revision: number, token = tokens.owner) {
  return http().post(`/api/plans/${planId}/approve`).set(as(token)).send({ revision });
}

async function revise(planId: string, baseRevision: number, spec: unknown, token = tokens.owner) {
  return http().post(`/api/plans/${planId}/revisions`).set(as(token)).send({ baseRevision, spec });
}

function createdByKey(body: Body): Record<string, string> {
  const created = (body.approval as { created: Array<{ key: string; taskId: string }> }).created;
  return Object.fromEntries(created.map((row) => [row.key, row.taskId]));
}

beforeAll(async () => {
  const owner = await prisma.user.create({ data: { username: `w17b-${RUN}`, email: `w17b-${RUN}@example.com` } });
  const viewer = await prisma.user.create({ data: { username: `w17b-v-${RUN}`, email: `w17b-v-${RUN}@example.com` } });
  const stranger = await prisma.user.create({ data: { username: `w17b-x-${RUN}`, email: `w17b-x-${RUN}@example.com` } });
  ids.users.push(owner.id, viewer.id, stranger.id);
  for (const [key, user] of [['owner', owner], ['viewer', viewer], ['stranger', stranger]] as const) {
    tokens[key] = jwt.sign({ userId: user.id, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
  }
  const workspace = await prisma.workspace.create({ data: { name: `W17b ${RUN}`, slug: `w17b-${RUN}` } });
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.createMany({ data: [
    { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
    { workspaceId: workspace.id, userId: viewer.id, role: 'member' },
  ] });
  const project = await prisma.project.create({ data: { name: `Plans ${RUN}`, workspaceId: workspace.id, key: `PL${RUN.slice(0, 3).toUpperCase()}` } });
  projectId = project.id;
  await prisma.projectAccess.create({ data: { projectId, userId: viewer.id, permission: 'view' } });
  const team = await prisma.team.create({ data: { name: `W17b ${RUN}`, key: `PT${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: 'owner' } });
});

afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.idempotencyRecord.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.task.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('W17b plan spec checks (pure)', () => {
  it('reports duplicate keys, unknown and self blockers, loops; warns about untestable and unestimated work', () => {
    const bad = validatePlanSpec({ tasks: [
      { key: 'a', title: 'A', blockedBy: ['a', 'ghost'] },
      { key: 'a', title: 'A again' },
    ] });
    expect(bad.errors.map((issue) => issue.code)).toEqual(['DUPLICATE_KEY', 'SELF_BLOCK', 'UNKNOWN_BLOCKER']);
    const loop = validatePlanSpec({ tasks: [{ key: 'a', title: 'A', blockedBy: ['b'] }, { key: 'b', title: 'B', blockedBy: ['a'] }, { key: 'c', title: 'C' }] });
    expect(loop.errors).toEqual([{ code: 'CYCLE', message: 'These tasks block each other in a loop: a, b', keys: ['a', 'b'] }]);
    const ok = validatePlanSpec(SPEC_V1);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.map((issue) => [issue.code, issue.keys])).toEqual([['NO_ACCEPTANCE', ['ui']], ['NO_ESTIMATE', ['ui']]]);
  });

  it('orders blockers first, writes the acceptance checklist and diffs revisions by key', () => {
    expect(topologicalOrder({ tasks: [{ key: 'ui', title: 'UI', blockedBy: ['api'] }, { key: 'api', title: 'API' }] })).toEqual(['api', 'ui']);
    expect(taskDescriptionFor({ key: 'a', title: 'A', description: ' Do it ', acceptance: ['works', 'tested'] })).toBe('Do it\n\n## Acceptance criteria\n- [ ] works\n- [ ] tested');
    expect(taskDescriptionFor({ key: 'a', title: 'A' })).toBeNull();
    expect(diffPlanSpecs(
      { tasks: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B', blockedBy: ['a'] }] },
      { tasks: [{ key: 'a', title: 'A2', priority: 'high' }, { key: 'c', title: 'C' }] },
    )).toEqual({ added: ['c'], removed: ['b'], changed: [{ key: 'a', fields: ['title', 'priority'] }] });
    expect(diffPlanSpecs({ tasks: [{ key: 'a', title: 'A' }] }, { tasks: [{ key: 'a', title: 'A', risk: 'high' }] }).changed).toEqual([{ key: 'a', fields: ['risk'] }]);
  });
});

describe('W17b plans API', () => {
  it('refuses an invalid plan before storing anything', async () => {
    const res = await createPlan({ tasks: [{ key: 'a', title: 'A', blockedBy: ['b'] }, { key: 'b', title: 'B', blockedBy: ['a'] }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'PLAN_INVALID', details: { issues: [{ code: 'CYCLE', keys: ['a', 'b'] }] } });
    expect(await prisma.plan.count({ where: { projectId } })).toBe(0);
  });

  it('creates a draft (retry-safe with an Idempotency-Key) that creates no tasks', async () => {
    const key = `plan-${RUN}`;
    const first = await createPlan(SPEC_V1, 'Login', { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'draft', latestRevision: 1, approvedRevision: null, revision: { number: 1, order: ['schema', 'api', 'ui'], diff: null }, tasks: [] });
    expect((first.body.revision as Body).warnings).toEqual([expect.objectContaining({ code: 'NO_ACCEPTANCE', keys: ['ui'] }), expect.objectContaining({ code: 'NO_ESTIMATE' })]);
    const replay = await createPlan(SPEC_V1, 'Login', { 'Idempotency-Key': key });
    expect(replay.body.id).toBe(first.body.id);
    expect(await prisma.plan.count({ where: { projectId } })).toBe(1);
    expect(await prisma.task.count({ where: { projectId } })).toBe(0);
  });

  it('runs the full lifecycle: revise (diff, conflicts, no-op), approve once, three-way update, deleted tasks stay deleted', async () => {
    const plan = (await createPlan(SPEC_V1, 'Lifecycle')).body;
    const planId = plan.id as string;

    // Revisions: based on the latest, identical specs add none.
    const spec2 = { ...SPEC_V1, tasks: SPEC_V1.tasks.map((task) => (task.key === 'ui' ? { ...task, acceptance: ['Form submits on Enter'], estimate: 's' } : task)) };
    expect((await revise(planId, 5, spec2)).body).toMatchObject({ code: 'PLAN_REVISION_CONFLICT', details: { latestRevision: 1 } });
    const r2 = await revise(planId, 1, spec2);
    expect(r2.status).toBe(201);
    expect(r2.body).toMatchObject({ unchanged: false, plan: { latestRevision: 2, revision: { number: 2, warnings: [], diff: { added: [], removed: [], changed: [{ key: 'ui', fields: ['acceptance', 'estimate'] }] } } } });
    const same = await revise(planId, 2, spec2);
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ unchanged: true, plan: { latestRevision: 2 } });

    // Only the latest revision can be approved.
    expect((await approve(planId, 1)).body).toMatchObject({ code: 'PLAN_REVISION_STALE' });
    const approved = await approve(planId, 2);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ approval: { alreadyApproved: false, updated: [], removed: [], skipped: [], dependencies: { added: 2, removed: 0 } }, plan: { status: 'approved', approvedRevision: 2 } });
    const keys = createdByKey(approved.body);
    expect(Object.keys(keys)).toEqual(['schema', 'api', 'ui']);
    const apiTask = await prisma.task.findUniqueOrThrow({ where: { id: keys.api } });
    expect(apiTask).toMatchObject({ title: 'Login endpoint', status: 'todo', projectId, description: 'POST /login\n\n## Acceptance criteria\n- [ ] 401 on a bad password\n- [ ] 200 sets a session' });
    expect(apiTask.identifier).toMatch(/^PT[A-Z0-9]{2}-\d+$/);
    expect(await prisma.taskDependency.findMany({ where: { taskId: { in: Object.values(keys) } }, select: { taskId: true, dependsOnTaskId: true }, orderBy: { createdAt: 'asc' } }))
      .toEqual([{ taskId: keys.api, dependsOnTaskId: keys.schema }, { taskId: keys.ui, dependsOnTaskId: keys.api }]);
    const detail = await http().get(`/api/tasks/${keys.api}`).set(as(tokens.owner));
    expect(detail.body.plan).toEqual({ id: planId, key: 'api', title: 'Lifecycle', status: 'approved', approvedRevision: 2 });
    const planTasks = (await http().get(`/api/plans/${planId}`).set(as(tokens.owner))).body.tasks as Body[];
    expect(planTasks.map((task) => task.key)).toEqual(['schema', 'api', 'ui']);
    expect(planTasks.every((task) => task.running === false && task.status === 'todo')).toBe(true);
    // A task an execution holds is reported as running (Run plan skips it).
    await prisma.task.update({ where: { id: keys.ui }, data: { status: 'in_progress', sessionId: 'ses_plan_run' } });
    const held = (await http().get(`/api/plans/${planId}`).set(as(tokens.owner))).body.tasks as Body[];
    expect(held.find((task) => task.key === 'ui')).toMatchObject({ running: true });
    await prisma.task.update({ where: { id: keys.ui }, data: { status: 'todo', sessionId: null } });

    // Approving again changes nothing.
    const again = await approve(planId, 2);
    expect(again.body).toMatchObject({ approval: { alreadyApproved: true, created: [] } });
    expect(await prisma.task.count({ where: { projectId, title: 'Login endpoint' } })).toBe(1);

    // Someone edits the API task's title on the board; someone deletes the schema task.
    await http().patch(`/api/tasks/${keys.api}`).set(as(tokens.owner)).send({ title: 'Login endpoint (renamed on the board)' }).expect(200);
    await http().delete(`/api/tasks/${keys.schema}?permanent=true`).set(as(tokens.owner)).expect(204);

    // Revision 3: api gets a new description (its title is unchanged in the plan), ui no
    // longer waits on api, and a new "docs" task; "schema" stays in the spec.
    const spec3 = {
      tasks: [
        SPEC_V1.tasks[0],
        { ...SPEC_V1.tasks[1], description: 'POST /api/login' },
        { key: 'ui', title: 'Login form', acceptance: ['Form submits on Enter'], estimate: 's' },
        { key: 'docs', title: 'Document login', blockedBy: ['api'], acceptance: ['README section'], estimate: 'xs' },
      ],
    };
    expect((await revise(planId, 2, spec3)).status).toBe(201);
    const third = await approve(planId, 3);
    expect(third.status).toBe(200);
    const report = third.body.approval as Body;
    expect(report).toMatchObject({
      alreadyApproved: false,
      updated: [{ key: 'api', taskId: keys.api, fields: ['description'] }],
      skipped: [{ key: 'schema', reason: 'deleted' }],
      dependencies: { added: 1, removed: 1 },
    });
    expect((report.created as Array<{ key: string }>).map((row) => row.key)).toEqual(['docs']);
    // The board edit survives; the plan's change lands.
    expect(await prisma.task.findUniqueOrThrow({ where: { id: keys.api } })).toMatchObject({
      title: 'Login endpoint (renamed on the board)',
      description: 'POST /api/login\n\n## Acceptance criteria\n- [ ] 401 on a bad password\n- [ ] 200 sets a session',
    });
    expect(await prisma.task.count({ where: { projectId, title: 'Design the users table' } })).toBe(0);
    expect(await prisma.taskDependency.count({ where: { taskId: keys.ui } })).toBe(0);
  });

  it('refuses an approval whose dependencies would loop with hand-made ones, writing nothing', async () => {
    const plan = (await createPlan({ tasks: [{ key: 'a', title: 'Loop A' }, { key: 'b', title: 'Loop B' }] }, 'Loop')).body;
    const planId = plan.id as string;
    const keys = createdByKey((await approve(planId, 1)).body);
    // By hand: A waits on B.
    await http().post(`/api/tasks/${keys.a}/dependencies`).set(as(tokens.owner)).send({ dependsOnTaskId: keys.b }).expect(201);
    // The plan now says B waits on A (and adds a task).
    expect((await revise(planId, 1, { tasks: [{ key: 'a', title: 'Loop A' }, { key: 'b', title: 'Loop B', blockedBy: ['a'] }, { key: 'c', title: 'Loop C' }] })).status).toBe(201);
    const refused = await approve(planId, 2);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'PLAN_CONFLICT' });
    expect(await prisma.task.count({ where: { projectId, title: 'Loop C' } })).toBe(0);
    expect(await prisma.plan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({ approvedRevision: 1 });
  });

  it('lets viewers read but not write; strangers get nothing; archived plans are read-only', async () => {
    const plan = (await createPlan({ tasks: [{ key: 'x', title: 'Access' }] }, 'Access')).body;
    const planId = plan.id as string;
    expect((await http().get(`/api/plans/${planId}`).set(as(tokens.viewer))).status).toBe(200);
    expect((await http().get(`/api/projects/${projectId}/plans`).set(as(tokens.viewer))).body.items.length).toBeGreaterThan(0);
    expect((await approve(planId, 1, tokens.viewer)).status).toBe(403);
    expect((await revise(planId, 1, { tasks: [{ key: 'x', title: 'Changed' }] }, tokens.viewer)).status).toBe(403);
    const hidden = await http().get(`/api/plans/${planId}`).set(as(tokens.stranger));
    expect(hidden.status).toBeGreaterThanOrEqual(403);
    expect(hidden.status).toBeLessThan(500);

    await http().post(`/api/plans/${planId}/archive`).set(as(tokens.owner)).expect(200);
    expect((await approve(planId, 1)).body).toMatchObject({ code: 'PLAN_ARCHIVED' });
    expect((await revise(planId, 1, { tasks: [{ key: 'x', title: 'Changed' }] })).body).toMatchObject({ code: 'PLAN_ARCHIVED' });
  });

  it('lists the project plans with progress', async () => {
    const res = await http().get(`/api/projects/${projectId}/plans`).set(as(tokens.owner));
    const lifecycle = (res.body.items as Body[]).find((item) => item.title === 'Lifecycle');
    expect(lifecycle).toMatchObject({ status: 'approved', latestRevision: 3, approvedRevision: 3, taskCount: 4, createdTaskCount: 3, doneTaskCount: 0 });
  });
});
