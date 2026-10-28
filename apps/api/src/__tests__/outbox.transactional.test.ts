/**
 * W04b atomic domain write + event: every converted call site appends its
 * event inside the transaction of its write.
 *
 * A deferred constraint trigger fails the COMMIT of any transaction whose
 * appended event mentions an armed marker. If a site's write were outside
 * the event's transaction it would survive that failure; here it must roll
 * back with it. Disarmed, the same request succeeds with exactly one event.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { appendToTarget, projectTarget, taskTarget, teamTarget, userTarget, workspaceTarget, type EventTarget } from '../events/targets';
import { createNotification } from '../routes/notifications';
import { logActivity } from '../services/activity';
import { broadcastToProject, broadcastToTask, broadcastToTeam, broadcastToUser, broadcastToWorkspace } from '../sse';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const MARKERS = `w04b_fail_markers_${RUN}`;
const FAIL_FN = `w04b_fail_on_marker_${RUN}`;
const http = useTestServer(() => createApp());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sign(userId: string, username: string): string {
  return jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
}

const users: Record<string, { id: string; username: string; jwt: string }> = {};
const fx = { workspace: '', project: '', team: '', inviteCode: '' };
const createdUserIds: string[] = [];

async function makeUser(label: string) {
  const user = await prisma.user.create({
    data: { githubId: `w04b-tx-${label}-${RUN}`, username: `w04b-tx-${label}-${RUN}`, email: `w04b-tx-${label}-${RUN}@example.com` },
  });
  createdUserIds.push(user.id);
  return { id: user.id, username: user.username, jwt: sign(user.id, user.username) };
}

async function arm(marker: string): Promise<void> {
  await prisma.$executeRawUnsafe(`INSERT INTO ${MARKERS} (marker) VALUES ($1) ON CONFLICT DO NOTHING`, marker);
}

async function disarm(marker: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM ${MARKERS} WHERE marker = $1`, marker);
}

/** Events mentioning `marker` (stream + pending, one snapshot). */
async function events(marker: string, type?: string): Promise<number> {
  const like = `%${marker}%`;
  const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT ((SELECT count(*) FROM domain_events WHERE payload::text LIKE ${like} AND (${type ?? null}::text IS NULL OR type = ${type ?? null}))
          + (SELECT count(*) FROM domain_event_outbox WHERE payload::text LIKE ${like} AND (${type ?? null}::text IS NULL OR type = ${type ?? null})))::int AS n`;
  return row?.n ?? 0;
}

async function newTask(title = `task-${randomUUID().slice(0, 6)}`, options: { teamOnly?: boolean } = {}) {
  const team = await prisma.team.update({ where: { id: fx.team }, data: { nextIssueNumber: { increment: 1 } }, select: { key: true, nextIssueNumber: true } });
  const number = team.nextIssueNumber - 1;
  return prisma.task.create({
    data: {
      title,
      projectId: options.teamOnly ? null : fx.project,
      teamId: fx.team,
      creatorId: users.owner!.id,
      number,
      identifier: `${team.key}-${number}`,
    },
  });
}

beforeAll(async () => {
  for (const label of ['owner', 'member', 'grantee', 'denyee', 'tmember', 'tleaver', 'wmember', 'wleaver', 'joiner', 'settings']) {
    users[label] = await makeUser(label);
  }
  const workspace = await prisma.workspace.create({ data: { name: `W04b tx ${RUN}`, slug: `w04b-tx-${RUN}` } });
  fx.workspace = workspace.id;
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: users.owner!.id, role: 'owner' },
      { workspaceId: workspace.id, userId: users.member!.id, role: 'member' },
      { workspaceId: workspace.id, userId: users.grantee!.id, role: 'member' },
      { workspaceId: workspace.id, userId: users.denyee!.id, role: 'member' },
      { workspaceId: workspace.id, userId: users.wleaver!.id, role: 'member' },
    ],
  });
  const project = await prisma.project.create({ data: { name: `W04b tx ${RUN}`, key: 'WTX', workspaceId: workspace.id } });
  fx.project = project.id;
  await prisma.projectAccess.create({ data: { projectId: project.id, userId: users.owner!.id, permission: 'full' } });
  const team = await prisma.team.create({
    data: {
      name: 'W04b tx', key: 'WTX', projectId: project.id, inviteCode: `WTX-${RUN}`,
      members: { create: [{ userId: users.owner!.id, role: 'owner' }, { userId: users.member!.id, role: 'member' }, { userId: users.tleaver!.id, role: 'member' }] },
    },
  });
  fx.team = team.id;
  fx.inviteCode = team.inviteCode ?? '';

  await prisma.$executeRawUnsafe(`CREATE TABLE ${MARKERS} (marker text PRIMARY KEY)`);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION ${FAIL_FN}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM ${MARKERS} m WHERE NEW.payload::text LIKE '%' || m.marker || '%') THEN
        RAISE EXCEPTION 'w04b injected commit failure';
      END IF;
      RETURN NULL;
    END $$;`);
  await prisma.$executeRawUnsafe(`
    CREATE CONSTRAINT TRIGGER ${FAIL_FN} AFTER INSERT ON domain_event_outbox
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${FAIL_FN}()`);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${FAIL_FN} ON domain_event_outbox`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FAIL_FN}()`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${MARKERS}`);
  const memberships = await prisma.workspaceMember.findMany({ where: { userId: { in: createdUserIds } }, select: { workspaceId: true } });
  const workspaceIds = [...new Set([fx.workspace, ...memberships.map((row) => row.workspaceId)])];
  await prisma.idempotencyRecord.deleteMany({ where: { principalId: { in: createdUserIds } } });
  await prisma.task.deleteMany({ where: { project: { workspaceId: { in: workspaceIds } } } });
  await prisma.task.deleteMany({ where: { teamId: fx.team, projectId: null } });
  await prisma.project.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: createdUserIds } }, { workspaceIds: { hasSome: workspaceIds } }, { projectId: fx.project }] } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

interface Site {
  name: string;
  /** Creates the subject; returns the marker its event payload will carry. */
  setup: () => Promise<{
    marker: string;
    eventType: string;
    act: () => request.Test;
    /** Observable domain state; must not change when the commit fails. */
    state: () => Promise<unknown>;
    okStatus: number;
  }>;
}

const auth = (label: string) => `Bearer ${users[label]!.jwt}`;

const sites: Site[] = [
  {
    name: 'POST /api/tasks',
    setup: async () => {
      const marker = `create-${randomUUID()}`;
      return {
        marker, eventType: 'task:created', okStatus: 201,
        act: () => http().post('/api/tasks').set('Authorization', auth('owner')).send({ title: marker, projectId: fx.project }),
        state: () => prisma.task.count({ where: { title: marker } }),
      };
    },
  },
  {
    name: 'PATCH /api/tasks/:id',
    setup: async () => {
      const task = await newTask();
      const marker = `update-${randomUUID()}`;
      return {
        marker, eventType: 'task:updated', okStatus: 200,
        act: () => http().patch(`/api/tasks/${task.id}`).set('Authorization', auth('owner')).send({ description: marker }),
        state: async () => (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).description,
      };
    },
  },
  {
    name: 'PATCH /api/tasks/bulk-status',
    setup: async () => {
      const task = await newTask();
      return {
        marker: task.id, eventType: 'tasks:bulk-updated', okStatus: 200,
        act: () => http().patch('/api/tasks/bulk-status').set('Authorization', auth('owner')).send({ projectId: fx.project, status: 'done', taskIds: [task.id] }),
        state: async () => (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status,
      };
    },
  },
  {
    name: 'POST /api/tasks/bulk-archive',
    setup: async () => {
      const task = await newTask();
      return {
        marker: task.id, eventType: 'task:deleted', okStatus: 200,
        act: () => http().post('/api/tasks/bulk-archive').set('Authorization', auth('owner')).send({ projectId: fx.project, taskIds: [task.id] }),
        state: async () => (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).archived,
      };
    },
  },
  {
    name: 'POST /api/tasks/bulk-delete',
    setup: async () => {
      const task = await newTask();
      return {
        marker: task.id, eventType: 'tasks:bulk-deleted', okStatus: 200,
        act: () => http().post('/api/tasks/bulk-delete').set('Authorization', auth('owner')).send({ projectId: fx.project, taskIds: [task.id], permanent: true }),
        state: () => prisma.task.count({ where: { id: task.id } }),
      };
    },
  },
  {
    name: 'DELETE /api/tasks/:id',
    setup: async () => {
      const task = await newTask();
      return {
        marker: task.id, eventType: 'task:deleted', okStatus: 204,
        act: () => http().delete(`/api/tasks/${task.id}`).set('Authorization', auth('owner')),
        state: async () => (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).archived,
      };
    },
  },
  {
    name: 'POST /api/tasks/:taskId/comments',
    setup: async () => {
      const task = await newTask();
      const marker = `comment-${randomUUID()}`;
      return {
        marker, eventType: 'comment:created', okStatus: 201,
        act: () => http().post(`/api/tasks/${task.id}/comments`).set('Authorization', auth('owner')).send({ body: marker }),
        state: () => prisma.comment.count({ where: { taskId: task.id } }),
      };
    },
  },
  {
    name: 'PATCH /api/comments/:id',
    setup: async () => {
      const task = await newTask();
      const comment = await prisma.comment.create({ data: { taskId: task.id, userId: users.owner!.id, body: 'original' } });
      const marker = `edited-${randomUUID()}`;
      return {
        marker, eventType: 'comment:updated', okStatus: 200,
        act: () => http().patch(`/api/comments/${comment.id}`).set('Authorization', auth('owner')).send({ body: marker }),
        state: async () => (await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).body,
      };
    },
  },
  {
    name: 'DELETE /api/comments/:id',
    setup: async () => {
      const task = await newTask();
      const comment = await prisma.comment.create({ data: { taskId: task.id, userId: users.owner!.id, body: 'doomed' } });
      return {
        marker: comment.id, eventType: 'comment:deleted', okStatus: 204,
        act: () => http().delete(`/api/comments/${comment.id}`).set('Authorization', auth('owner')),
        state: () => prisma.comment.count({ where: { id: comment.id } }),
      };
    },
  },
  {
    name: 'POST /api/projects/:id/access',
    setup: async () => ({
      marker: users.grantee!.id, eventType: 'project:access-changed', okStatus: 201,
      act: () => http().post(`/api/projects/${fx.project}/access`).set('Authorization', auth('owner')).send({ userId: users.grantee!.id, permission: 'view' }),
      state: () => prisma.projectAccess.count({ where: { projectId: fx.project, userId: users.grantee!.id } }),
    }),
  },
  {
    name: 'DELETE /api/projects/:id/access/:userId',
    setup: async () => ({
      marker: users.denyee!.id, eventType: 'project:access-changed', okStatus: 204,
      act: () => http().delete(`/api/projects/${fx.project}/access/${users.denyee!.id}`).set('Authorization', auth('owner')),
      state: () => prisma.projectAccess.count({ where: { projectId: fx.project, userId: users.denyee!.id } }),
    }),
  },
  {
    name: 'POST /api/teams/:id/members',
    setup: async () => ({
      marker: users.tmember!.id, eventType: 'team:member-added', okStatus: 201,
      act: () => http().post(`/api/teams/${fx.team}/members`).set('Authorization', auth('owner')).send({ userId: users.tmember!.id }),
      state: () => prisma.teamMember.count({ where: { teamId: fx.team, userId: users.tmember!.id } }),
    }),
  },
  {
    name: 'DELETE /api/teams/:id/members/:userId',
    setup: async () => ({
      marker: users.tleaver!.id, eventType: 'team:member-removed', okStatus: 204,
      act: () => http().delete(`/api/teams/${fx.team}/members/${users.tleaver!.id}`).set('Authorization', auth('owner')),
      state: () => prisma.teamMember.count({ where: { teamId: fx.team, userId: users.tleaver!.id } }),
    }),
  },
  {
    name: 'POST /api/teams/join',
    setup: async () => ({
      marker: users.joiner!.username, eventType: 'team:updated', okStatus: 200,
      act: () => http().post('/api/teams/join').set('Authorization', auth('joiner')).send({ inviteCode: fx.inviteCode }),
      state: () => prisma.teamMember.count({ where: { teamId: fx.team, userId: users.joiner!.id } }),
    }),
  },
  {
    name: 'POST /api/workspaces/:id/members',
    setup: async () => ({
      marker: users.wmember!.id, eventType: 'workspace:member-added', okStatus: 201,
      act: () => http().post(`/api/workspaces/${fx.workspace}/members`).set('Authorization', auth('owner')).send({ username: users.wmember!.username, role: 'member' }),
      state: () => prisma.workspaceMember.count({ where: { workspaceId: fx.workspace, userId: users.wmember!.id } }),
    }),
  },
  {
    name: 'DELETE /api/workspaces/:id/members/:userId',
    setup: async () => ({
      marker: users.wleaver!.id, eventType: 'workspace:member-removed', okStatus: 204,
      act: () => http().delete(`/api/workspaces/${fx.workspace}/members/${users.wleaver!.id}`).set('Authorization', auth('owner')),
      state: () => prisma.workspaceMember.count({ where: { workspaceId: fx.workspace, userId: users.wleaver!.id } }),
    }),
  },
  {
    name: 'POST /api/projects',
    setup: async () => {
      const marker = `proj-${randomUUID().slice(0, 8)}`;
      return {
        marker, eventType: 'project:created', okStatus: 201,
        act: () => http().post('/api/projects').set('Authorization', auth('owner')).send({ name: marker, workspaceId: fx.workspace }),
        state: () => prisma.project.count({ where: { name: marker } }),
      };
    },
  },
  {
    name: 'POST /api/teams',
    setup: async () => {
      const key = `T${randomUUID().replace(/[^0-9]/g, '').slice(0, 6)}`;
      const marker = `team-${key}`;
      return {
        marker, eventType: 'team:created', okStatus: 201,
        act: () => http().post('/api/teams').set('Authorization', auth('owner')).send({ name: marker, key, projectId: fx.project }),
        state: () => prisma.team.count({ where: { name: marker } }),
      };
    },
  },
  {
    name: 'POST /api/workspaces',
    setup: async () => {
      const marker = `ws-${randomUUID().slice(0, 8)}`;
      return {
        marker, eventType: 'workspace:joined', okStatus: 201,
        act: () => http().post('/api/workspaces').set('Authorization', auth('owner')).send({ name: marker }),
        state: () => prisma.workspace.count({ where: { name: marker } }),
      };
    },
  },
  // ── W14 conversions (apicontract): formerly post-commit broadcasts ──
  {
    name: 'POST /api/labels',
    setup: async () => {
      const marker = `lbl-${randomUUID().slice(0, 13)}`;
      return {
        marker, eventType: 'label:created', okStatus: 201,
        act: () => http().post('/api/labels').set('Authorization', auth('owner')).send({ name: marker, color: '#123456', projectId: fx.project }),
        state: () => prisma.label.count({ where: { name: marker } }),
      };
    },
  },
  {
    name: 'PATCH /api/labels/:id',
    setup: async () => {
      const label = await newLabel();
      const marker = `lbl-${randomUUID().slice(0, 13)}`;
      return {
        marker, eventType: 'label:updated', okStatus: 200,
        act: () => http().patch(`/api/labels/${label.id}`).set('Authorization', auth('owner')).send({ name: marker }),
        state: async () => (await prisma.label.findUniqueOrThrow({ where: { id: label.id } })).name,
      };
    },
  },
  {
    name: 'DELETE /api/labels/:id',
    setup: async () => {
      const label = await newLabel();
      return {
        marker: label.id, eventType: 'label:deleted', okStatus: 204,
        act: () => http().delete(`/api/labels/${label.id}`).set('Authorization', auth('owner')),
        state: () => prisma.label.count({ where: { id: label.id } }),
      };
    },
  },
  {
    name: 'POST /api/labels/tasks/:id/labels',
    setup: async () => {
      const [task, label] = await Promise.all([newTask(), newLabel()]);
      return {
        marker: label.id, eventType: 'task:label:assigned', okStatus: 201,
        act: () => http().post(`/api/labels/tasks/${task.id}/labels`).set('Authorization', auth('owner')).send({ labelId: label.id }),
        state: () => prisma.taskLabel.count({ where: { taskId: task.id, labelId: label.id } }),
      };
    },
  },
  {
    name: 'DELETE /api/labels/tasks/:id/labels/:labelId',
    setup: async () => {
      const [task, label] = await Promise.all([newTask(), newLabel()]);
      await prisma.taskLabel.create({ data: { taskId: task.id, labelId: label.id } });
      return {
        marker: label.id, eventType: 'task:label:removed', okStatus: 204,
        act: () => http().delete(`/api/labels/tasks/${task.id}/labels/${label.id}`).set('Authorization', auth('owner')),
        state: () => prisma.taskLabel.count({ where: { taskId: task.id, labelId: label.id } }),
      };
    },
  },
  {
    name: 'PATCH /api/projects/:id',
    setup: async () => {
      const marker = `pdesc-${randomUUID()}`;
      return {
        marker, eventType: 'project:updated', okStatus: 200,
        act: () => http().patch(`/api/projects/${fx.project}`).set('Authorization', auth('owner')).send({ description: marker }),
        state: async () => (await prisma.project.findUniqueOrThrow({ where: { id: fx.project } })).description,
      };
    },
  },
  {
    name: 'DELETE /api/projects/:id',
    setup: async () => {
      const project = await newProject();
      return {
        marker: project.id, eventType: 'project:deleted', okStatus: 204,
        act: () => http().delete(`/api/projects/${project.id}`).set('Authorization', auth('owner')),
        state: () => prisma.project.count({ where: { id: project.id } }),
      };
    },
  },
  {
    name: 'PATCH /api/teams/:id',
    setup: async () => {
      const marker = `tdesc-${randomUUID()}`;
      return {
        marker, eventType: 'team:updated', okStatus: 200,
        act: () => http().patch(`/api/teams/${fx.team}`).set('Authorization', auth('owner')).send({ description: marker }),
        state: async () => (await prisma.team.findUniqueOrThrow({ where: { id: fx.team } })).description,
      };
    },
  },
  {
    name: 'PATCH /api/workspaces/:id',
    setup: async () => {
      const marker = `wsname-${randomUUID()}`;
      return {
        marker, eventType: 'workspace:updated', okStatus: 200,
        act: () => http().patch(`/api/workspaces/${fx.workspace}`).set('Authorization', auth('owner')).send({ name: marker }),
        state: async () => (await prisma.workspace.findUniqueOrThrow({ where: { id: fx.workspace } })).name,
      };
    },
  },
  {
    name: 'PATCH /api/settings',
    setup: async () => {
      // The settings payload carries no free text; a dedicated user's id is the marker.
      const current = await prisma.settings.findUnique({ where: { userId: users.settings!.id } });
      return {
        marker: users.settings!.id, eventType: 'settings:updated', okStatus: 200,
        act: () => http().patch('/api/settings').set('Authorization', auth('settings')).send({ parallelLimit: (current?.parallelLimit ?? 1) === 3 ? 4 : 3 }),
        state: async () => (await prisma.settings.findUnique({ where: { userId: users.settings!.id } }))?.parallelLimit ?? null,
      };
    },
  },
  {
    name: 'PATCH /api/tasks/bulk-status (teamId scope)',
    setup: async () => {
      const task = await newTask(undefined, { teamOnly: true });
      return {
        marker: task.id, eventType: 'tasks:bulk-updated', okStatus: 200,
        act: () => http().patch('/api/tasks/bulk-status').set('Authorization', auth('owner')).send({ teamId: fx.team, status: 'done', taskIds: [task.id] }),
        state: async () => (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status,
      };
    },
  },
];

async function newLabel() {
  return prisma.label.create({
    data: { name: `l-${randomUUID().slice(0, 12)}`, color: '#654321', projectId: fx.project },
  });
}

/** A second project in the workspace (owner has full access; one team). */
async function newProject() {
  const key = `D${randomUUID().replace(/[^0-9]/g, '').slice(0, 6)}`;
  const project = await prisma.project.create({ data: { name: `del-${key}`, key, workspaceId: fx.workspace } });
  await prisma.projectAccess.create({ data: { projectId: project.id, userId: users.owner!.id, permission: 'full' } });
  await prisma.team.create({
    data: { name: `del-${key}`, key, projectId: project.id, members: { create: [{ userId: users.owner!.id, role: 'owner' }] } },
  });
  return project;
}

describe('W04b: domain write and its event commit or roll back together', () => {
  it.each(sites.map((site) => [site.name, site] as const))('%s', async (_name, site) => {
    const subject = await site.setup();
    const before = await subject.state();

    await arm(subject.marker);
    try {
      const failed = await subject.act();
      expect(failed.status, failed.text).toBeGreaterThanOrEqual(500);
    } finally {
      await disarm(subject.marker);
    }
    await sleep(30);
    expect(await subject.state()).toEqual(before);
    expect(await events(subject.marker)).toBe(0);

    const ok = await subject.act();
    expect(ok.status, ok.text).toBe(subject.okStatus);
    expect(await subject.state()).not.toEqual(before);
    for (let i = 0; i < 50 && (await prisma.domainEventOutbox.count()) > 0; i += 1) await sleep(10);
    const delivered = await prisma.$queryRaw<Array<{ type: string; source_id: bigint | null }>>`
      SELECT type, source_id FROM domain_events WHERE payload::text LIKE ${`%${subject.marker}%`} AND type = ${subject.eventType}`;
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    // Sequenced from the transactional outbox, not written post-commit.
    expect(delivered.every((row) => row.source_id !== null)).toBe(true);
  });

  it('a keyed create that fails at commit leaves no idempotency record; the retry executes', async () => {
    const marker = `keyed-${randomUUID()}`;
    const key = `w04b-tx-${randomUUID()}`;
    const send = () => http().post('/api/tasks').set('Authorization', auth('owner')).set('Idempotency-Key', key)
      .send({ title: marker, projectId: fx.project });
    await arm(marker);
    try {
      expect((await send()).status).toBeGreaterThanOrEqual(500);
    } finally {
      await disarm(marker);
    }
    expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
    expect(await prisma.task.count({ where: { title: marker } })).toBe(0);
    const retry = await send();
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBeUndefined();
    expect(await prisma.task.count({ where: { title: marker } })).toBe(1);
  });
});

describe('W14: activity and notification rows commit with their events', () => {
  async function deliveredFromOutbox(marker: string, type: string): Promise<boolean> {
    for (let i = 0; i < 50 && (await prisma.domainEventOutbox.count()) > 0; i += 1) await sleep(10);
    const rows = await prisma.$queryRaw<Array<{ source_id: bigint | null }>>`
      SELECT source_id FROM domain_events WHERE payload::text LIKE ${`%${marker}%`} AND type = ${type}`;
    return rows.length === 1 && rows[0]!.source_id !== null;
  }

  it('logActivity: a failed event rolls the activity row back; otherwise row and event commit together', async () => {
    const marker = `activity-${randomUUID()}`;
    const input = { userId: users.owner!.id, projectId: fx.project, teamId: fx.team, action: 'project_updated' as const, payload: { marker } };
    await arm(marker);
    try {
      await logActivity(input); // best-effort: never throws
    } finally {
      await disarm(marker);
    }
    expect(await prisma.activityLog.count({ where: { payload: { path: ['marker'], equals: marker } } })).toBe(0);
    expect(await events(marker)).toBe(0);

    await logActivity(input);
    expect(await prisma.activityLog.count({ where: { payload: { path: ['marker'], equals: marker } } })).toBe(1);
    expect(await deliveredFromOutbox(marker, 'activity:created')).toBe(true);
  });

  it('createNotification: a failed event rolls the notification back; otherwise both commit', async () => {
    const marker = `notify-${randomUUID()}`;
    const input = { recipientUserId: users.member!.id, actorUserId: users.owner!.id, type: 'mention' as const, body: marker };
    await arm(marker);
    try {
      await createNotification(input);
    } finally {
      await disarm(marker);
    }
    expect(await prisma.notification.count({ where: { body: marker } })).toBe(0);
    expect(await events(marker)).toBe(0);

    await createNotification(input);
    expect(await prisma.notification.count({ where: { body: marker } })).toBe(1);
    expect(await deliveredFromOutbox(marker, 'notification:created')).toBe(true);
  });
});

describe('W04b: transactional targets match the sse.ts broadcast helpers', () => {
  type Binding = { userIds: string[]; teamIds: string[]; workspaceIds: string[]; resourceType: string | null; projectId: string | null; workspaceId: string | null };

  async function stored(type: string): Promise<Binding> {
    for (let i = 0; i < 200; i += 1) {
      const row = await prisma.domainEvent.findFirst({ where: { type } });
      if (row) {
        return {
          userIds: [...row.userIds].sort(), teamIds: [...row.teamIds].sort(), workspaceIds: [...row.workspaceIds].sort(),
          resourceType: row.resourceType, projectId: row.projectId, workspaceId: row.workspaceId,
        };
      }
      await sleep(10);
    }
    throw new Error(`no event ${type}`);
  }

  async function viaTarget(target: EventTarget | null, type: string): Promise<Binding> {
    await appendToTarget(prisma, target, type, {});
    const { flushOutbox } = await import('../events/relay');
    await flushOutbox();
    return stored(type);
  }

  it('project, team, task, user and workspace bindings are identical', async () => {
    const teamOnlyTask = await prisma.task.create({ data: { title: 'team only', teamId: fx.team, creatorId: users.owner!.id } });
    const projectTask = await newTask();
    const t = (label: string) => `w04b-parity-${RUN}-${label}`;

    await broadcastToProject(fx.project, t('project-sse'), {});
    expect(await viaTarget(await projectTarget(prisma, fx.project), t('project-tx'))).toEqual(await stored(t('project-sse')));

    broadcastToTeam(fx.team, t('team-sse'), {});
    expect(await viaTarget(await teamTarget(prisma, fx.team), t('team-tx'))).toEqual(await stored(t('team-sse')));

    broadcastToTask(t('task-sse'), { id: projectTask.id, projectId: fx.project, teamId: fx.team, creatorId: users.owner!.id });
    expect(await viaTarget(await taskTarget(prisma, projectTask), t('task-tx'))).toEqual(await stored(t('task-sse')));

    broadcastToTask(t('teamtask-sse'), { id: teamOnlyTask.id, teamId: fx.team, creatorId: users.owner!.id });
    expect(await viaTarget(await taskTarget(prisma, teamOnlyTask), t('teamtask-tx'))).toEqual(await stored(t('teamtask-sse')));

    broadcastToUser(users.owner!.id, t('user-sse'), {});
    expect(await viaTarget(userTarget(users.owner!.id), t('user-tx'))).toEqual(await stored(t('user-sse')));

    broadcastToWorkspace(fx.workspace, t('ws-sse'), {});
    expect(await viaTarget(workspaceTarget(fx.workspace), t('ws-tx'))).toEqual(await stored(t('ws-sse')));

    await prisma.domainEvent.deleteMany({ where: { type: { startsWith: `w04b-parity-${RUN}` } } });
    await prisma.task.delete({ where: { id: teamOnlyTask.id } });
  });
});
