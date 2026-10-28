/**
 * W20 / FE-14 recurring issues: create/read/update/pause/resume/delete over
 * HTTP with permissions and quotas, and the `schedule-run` job against real
 * PostgreSQL: one issue per slot (two workers racing create exactly one),
 * local time across daylight saving, catch-up after downtime (most recent
 * missed slot only), "run now" idempotent per minute, schedules pausing
 * themselves when their owner loses access, project deletion.
 *
 * The job is driven with explicit `now` values in the past (back-dated
 * `nextRunAt`), so schedules created with the real clock never become due
 * here. Fixtures delete only what they create (TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { nextSlotAfter } from '../services/schedule-slots';
import { MAX_ACTIVE_SCHEDULES_PER_PROJECT, MAX_SCHEDULES_PER_PROJECT, runDueSchedules, runScheduleNow } from '../services/schedules';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const http = useTestServer(() => createApp());
const ids = { users: [] as string[], workspaces: [] as string[], projects: [] as string[] };
const users = { owner: '', member: '', viewer: '', stranger: '', leaver: '' };
const tokens = { owner: '', member: '', viewer: '', stranger: '', leaver: '' };
let workspaceId = '';
let projectId = '';
let teamId = '';
let teamKey = '';
let labelId = '';
let foreignLabelId = '';

type Body = Record<string, unknown>;
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const at = (iso: string) => new Date(iso);

const WEEKLY = { title: 'Weekly triage', cadence: 'weekly', weekday: 1, hour: 9, minute: 0, timezone: 'Europe/Berlin' } as const;

async function create(body: Body, token = tokens.owner, headers: Record<string, string> = {}, project = projectId) {
  return http().post(`/api/projects/${project}/schedules`).set({ ...as(token), ...headers }).send(body);
}

/** A schedule created over HTTP, then back-dated so the job sees it due at `nextRunAt`. */
async function dueSchedule(body: Body, nextRunAt: string, token = tokens.owner): Promise<string> {
  const res = await create(body, token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await prisma.issueSchedule.update({ where: { id: res.body.id as string }, data: { nextRunAt: at(nextRunAt) } });
  return res.body.id as string;
}

async function scheduledTasks(scheduleId: string) {
  return prisma.task.findMany({
    where: { scheduleOccurrence: { scheduleId } },
    include: { labels: true, scheduleOccurrence: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Events of `type` whose payload `field` is `value`, delivered or still in the
 * outbox. One snapshot for both tables: the sequencer moves rows from the
 * outbox to `domain_events` right after commit, so two independent reads
 * could count one event twice.
 */
async function countEvents(type: string, field: string, value: string): Promise<number> {
  const where = { type, payload: { path: [field], equals: value } };
  const [stream, outbox] = await prisma.$transaction(
    async (tx) => [await tx.domainEvent.count({ where }), await tx.domainEventOutbox.count({ where })] as const,
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return stream + outbox;
}

beforeAll(async () => {
  for (const key of Object.keys(users) as Array<keyof typeof users>) {
    const user = await prisma.user.create({ data: { username: `w20-${key}-${RUN}`, email: `w20-${key}-${RUN}@example.com` } });
    ids.users.push(user.id);
    users[key] = user.id;
    tokens[key] = jwt.sign({ userId: user.id, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
  }
  const workspace = await prisma.workspace.create({ data: { name: `W20 ${RUN}`, slug: `w20-${RUN}` } });
  workspaceId = workspace.id;
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.createMany({ data: [
    { workspaceId, userId: users.owner, role: 'owner' },
    { workspaceId, userId: users.member, role: 'member' },
    { workspaceId, userId: users.viewer, role: 'member' },
    { workspaceId, userId: users.leaver, role: 'member' },
  ] });
  const project = await prisma.project.create({ data: { name: `Schedules ${RUN}`, workspaceId, key: `SC${RUN.slice(0, 3).toUpperCase()}` } });
  projectId = project.id;
  ids.projects.push(projectId);
  await prisma.projectAccess.createMany({ data: [
    { projectId, userId: users.member, permission: 'full' },
    { projectId, userId: users.leaver, permission: 'full' },
    { projectId, userId: users.viewer, permission: 'view' },
  ] });
  teamKey = `S${RUN.slice(0, 3).toUpperCase()}`;
  const team = await prisma.team.create({ data: { name: `W20 ${RUN}`, key: teamKey, projectId } });
  teamId = team.id;
  await prisma.teamMember.createMany({ data: [
    { teamId, userId: users.owner, role: 'owner' },
    { teamId, userId: users.member, role: 'member' },
    { teamId, userId: users.leaver, role: 'member' },
  ] });
  labelId = (await prisma.label.create({ data: { projectId, name: `chore-${RUN}`, color: '#00ff00' } })).id;
  const other = await prisma.project.create({ data: { name: `Other ${RUN}`, workspaceId, key: `SO${RUN.slice(0, 3).toUpperCase()}` } });
  ids.projects.push(other.id);
  foreignLabelId = (await prisma.label.create({ data: { projectId: other.id, name: `foreign-${RUN}`, color: '#0000ff' } })).id;
});

afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }, { actorId: { in: ids.users } }] } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }, { actorId: { in: ids.users } }] } });
  await prisma.idempotencyRecord.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.task.deleteMany({ where: { OR: [{ creatorId: { in: ids.users } }, { projectId: { in: ids.projects } }] } });
  await prisma.project.deleteMany({ where: { id: { in: ids.projects } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('W20 schedules API', () => {
  it('creates a schedule (canonical zone, next slot in its zone), retry-safe with an Idempotency-Key', async () => {
    const before = new Date();
    const key = `sched-${RUN}`;
    const body = { ...WEEKLY, timezone: 'europe/berlin', description: 'Go through new issues', priority: 'high', labelIds: [labelId], assigneeId: users.member };
    const first = await create(body, tokens.owner, { 'Idempotency-Key': key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      projectId, title: 'Weekly triage', priority: 'high', labelIds: [labelId], assigneeId: users.member,
      cadence: 'weekly', weekday: 1, dayOfMonth: null, hour: 9, minute: 0, timezone: 'Europe/Berlin',
      cadenceText: 'Every Monday at 09:00 (Europe/Berlin)', lastRunAt: null, pausedAt: null, ownerId: users.owner, createdById: users.owner,
    });
    const expected = nextSlotAfter({ cadence: 'weekly', weekday: 1, hour: 9, minute: 0, timezone: 'Europe/Berlin' }, before);
    expect(first.body.nextRunAt).toBe(expected.toISOString());
    const replay = await create(body, tokens.owner, { 'Idempotency-Key': key });
    expect(replay.body.id).toBe(first.body.id);
    expect(await prisma.issueSchedule.count({ where: { projectId, title: 'Weekly triage' } })).toBe(1);
    expect(await countEvents('schedule:created', 'scheduleId', first.body.id as string)).toBe(1);
    // Creating a schedule creates no issue.
    expect(await prisma.task.count({ where: { projectId } })).toBe(0);

    const list = await http().get(`/api/projects/${projectId}/schedules`).set(as(tokens.viewer));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ items: [expect.objectContaining({ id: first.body.id })], limits: { active: MAX_ACTIVE_SCHEDULES_PER_PROJECT, total: MAX_SCHEDULES_PER_PROJECT } });
    await prisma.issueSchedule.delete({ where: { id: first.body.id as string } });
  });

  it('refuses inconsistent rules, unknown zones, foreign labels and non-member assignees', async () => {
    const cases: Array<[Body, string]> = [
      [{ ...WEEKLY, weekday: undefined }, 'weekday'],
      [{ ...WEEKLY, cadence: 'daily' }, 'weekly'],
      [{ ...WEEKLY, cadence: 'monthly', weekday: undefined }, 'dayOfMonth'],
      [{ ...WEEKLY, timezone: 'Mars/Olympus' }, 'time zone'],
      [{ ...WEEKLY, timezone: '+05:30' }, 'time zone'],
      [{ ...WEEKLY, labelIds: [foreignLabelId] }, 'labelIds'],
      [{ ...WEEKLY, assigneeId: users.viewer }, 'not a member'],
    ];
    for (const [body, message] of cases) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(String(res.body.message)).toContain(message);
    }
    for (const body of [{ ...WEEKLY, hour: 24 }, { ...WEEKLY, title: '' }, { ...WEEKLY, title: 'x'.repeat(201) }, { ...WEEKLY, dayOfMonth: 29 }, { ...WEEKLY, extra: true }]) {
      expect((await create(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await prisma.issueSchedule.count({ where: { projectId } })).toBe(0);
  });

  it('lets viewers read but not change schedules; strangers see nothing', async () => {
    const id = (await create(WEEKLY)).body.id as string;
    expect((await http().get(`/api/schedules/${id}`).set(as(tokens.viewer))).status).toBe(200);
    expect((await create(WEEKLY, tokens.viewer)).status).toBe(403);
    expect((await http().patch(`/api/schedules/${id}`).set(as(tokens.viewer)).send({ title: 'x' })).status).toBe(403);
    expect((await http().post(`/api/schedules/${id}/pause`).set(as(tokens.viewer))).status).toBe(403);
    expect((await http().post(`/api/schedules/${id}/run-now`).set(as(tokens.viewer))).status).toBe(403);
    expect((await http().delete(`/api/schedules/${id}`).set(as(tokens.viewer))).status).toBe(403);
    for (const res of [
      await http().get(`/api/schedules/${id}`).set(as(tokens.stranger)),
      await http().get(`/api/projects/${projectId}/schedules`).set(as(tokens.stranger)),
      await http().delete(`/api/schedules/${id}`).set(as(tokens.stranger)),
    ]) expect([403, 404]).toContain(res.status);
    expect((await http().get(`/api/schedules/${randomUUID()}`).set(as(tokens.owner))).body.code).toBe('SCHEDULE_NOT_FOUND');
    expect(await prisma.issueSchedule.count({ where: { id } })).toBe(1);
    await prisma.issueSchedule.delete({ where: { id } });
  });
});

describe('W20 schedule-run job', () => {
  it('creates the issue at its slot from the template, once, and keeps the local time across DST', async () => {
    const id = await dueSchedule({
      title: 'Standup notes {date}', description: 'Fill in', priority: 'low', labelIds: [labelId], assigneeId: users.member,
      cadence: 'daily', hour: 9, minute: 0, timezone: 'America/New_York',
    }, '2026-03-07T14:00:00Z');
    const result = await runDueSchedules({ now: at('2026-03-07T14:00:30Z') });
    expect(result.created).toBeGreaterThanOrEqual(1);
    const tasks = await scheduledTasks(id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task).toMatchObject({
      title: 'Standup notes 2026-03-07', description: 'Fill in', priority: 'low', status: 'todo', projectId, teamId,
      creatorId: users.owner, assigneeId: users.member, identifier: expect.stringMatching(new RegExp(`^${teamKey}-\\d+$`)),
    });
    expect(task.labels.map((row) => row.labelId)).toEqual([labelId]);
    expect(task.scheduleOccurrence).toMatchObject({ slotAt: at('2026-03-07T14:00:00Z'), kind: 'scheduled', outcome: 'created', skippedSlots: 0 });
    const schedule = await prisma.issueSchedule.findUniqueOrThrow({ where: { id } });
    // 09:00 EDT the next day (clocks sprang forward overnight).
    expect(schedule.nextRunAt).toEqual(at('2026-03-08T13:00:00Z'));
    expect(schedule.lastRunAt).toEqual(at('2026-03-07T14:00:30Z'));
    expect(await countEvents('task:created', 'id', task.id)).toBe(1);
    expect(await prisma.notification.count({ where: { userId: users.member, taskId: task.id, type: 'assignment' } })).toBe(1);

    // Same minute again: nothing is due any more.
    await runDueSchedules({ now: at('2026-03-07T14:00:50Z') });
    expect(await scheduledTasks(id)).toHaveLength(1);
    // The next slot, after the DST change.
    await runDueSchedules({ now: at('2026-03-08T13:00:05Z') });
    const after = await scheduledTasks(id);
    expect(after.map((row) => row.title)).toEqual(['Standup notes 2026-03-07', 'Standup notes 2026-03-08']);
    expect(after[1]?.number).toBe((after[0]?.number ?? 0) + 1);

    const detail = await http().get(`/api/schedules/${id}`).set(as(tokens.viewer));
    expect(detail.body.occurrences).toEqual([
      expect.objectContaining({ slotAt: '2026-03-08T13:00:00.000Z', outcome: 'created', task: expect.objectContaining({ title: 'Standup notes 2026-03-08' }) }),
      expect.objectContaining({ slotAt: '2026-03-07T14:00:00.000Z', outcome: 'created' }),
    ]);
    await prisma.issueSchedule.delete({ where: { id } });
  });

  it('two workers claiming the same due schedule create exactly one issue', async () => {
    const id = await dueSchedule({ ...WEEKLY, title: 'Race', cadence: 'daily', weekday: undefined, timezone: 'UTC' }, '2026-04-01T09:00:00Z');
    const now = at('2026-04-01T09:00:10Z');
    const results = await Promise.all([runDueSchedules({ now }), runDueSchedules({ now }), runDueSchedules({ now }), runDueSchedules({ now })]);
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
    expect(await scheduledTasks(id)).toHaveLength(1);
    expect(await prisma.issueScheduleOccurrence.count({ where: { scheduleId: id } })).toBe(1);
    expect((await prisma.issueSchedule.findUniqueOrThrow({ where: { id } })).nextRunAt).toEqual(at('2026-04-02T09:00:00Z'));
    await prisma.issueSchedule.delete({ where: { id } });
  });

  it('after downtime creates only the most recent missed slot and records how many were skipped', async () => {
    const id = await dueSchedule({ ...WEEKLY, title: 'Catch up', cadence: 'daily', weekday: undefined, timezone: 'UTC' }, '2026-05-01T09:00:00Z');
    await runDueSchedules({ now: at('2026-05-05T10:00:00Z') });
    const tasks = await scheduledTasks(id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.scheduleOccurrence).toMatchObject({ slotAt: at('2026-05-05T09:00:00Z'), skippedSlots: 4 });
    expect((await prisma.issueSchedule.findUniqueOrThrow({ where: { id } })).nextRunAt).toEqual(at('2026-05-06T09:00:00Z'));
    await prisma.issueSchedule.delete({ where: { id } });
  });

  it('pausing is immediate; resuming starts from now, without the slots missed while paused', async () => {
    const id = await dueSchedule({ ...WEEKLY, title: 'Paused', cadence: 'daily', weekday: undefined, timezone: 'UTC' }, '2026-06-01T09:00:00Z');
    const paused = await http().post(`/api/schedules/${id}/pause`).set(as(tokens.member));
    expect(paused.status).toBe(200);
    expect(paused.body.pausedAt).toEqual(expect.any(String));
    expect((await http().post(`/api/schedules/${id}/pause`).set(as(tokens.member))).body.pausedAt).toBe(paused.body.pausedAt);
    await runDueSchedules({ now: at('2026-06-03T10:00:00Z') });
    expect(await scheduledTasks(id)).toHaveLength(0);

    const before = Date.now();
    const resumed = await http().post(`/api/schedules/${id}/resume`).set(as(tokens.member));
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ pausedAt: null, pauseReason: null, ownerId: users.member });
    expect(new Date(resumed.body.nextRunAt as string).getTime()).toBeGreaterThan(before);
    await runDueSchedules({ now: at('2026-06-03T10:00:00Z') });
    expect(await scheduledTasks(id)).toHaveLength(0);
    await prisma.issueSchedule.delete({ where: { id } });
  });

  it('run now: one issue per minute (repeat and concurrent calls return it), also when paused; the job does not duplicate it', async () => {
    const created = await create({ ...WEEKLY, title: 'Manual' });
    const id = created.body.id as string;
    const http201 = await http().post(`/api/schedules/${id}/run-now`).set(as(tokens.member));
    expect(http201.status).toBe(201);
    expect(http201.body).toMatchObject({ created: true, occurrence: { kind: 'manual', outcome: 'created', task: expect.objectContaining({ title: 'Manual' }) } });
    expect(http201.body.schedule.nextRunAt).toBe(created.body.nextRunAt);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: http201.body.occurrence.task.id as string } })).creatorId).toBe(users.member);

    await http().post(`/api/schedules/${id}/pause`).set(as(tokens.owner));
    const now = at('2026-07-01T09:00:20Z');
    const runs = await Promise.all([1, 2, 3].map(() => runScheduleNow({ scheduleId: id, userId: users.owner, now })));
    expect(runs.filter((run) => run.created)).toHaveLength(1);
    expect(new Set(runs.map((run) => run.occurrence.id)).size).toBe(1);
    expect(await scheduledTasks(id)).toHaveLength(2);

    // The job's slot for the same minute was taken by "run now": it moves on.
    await http().post(`/api/schedules/${id}/resume`).set(as(tokens.owner));
    await prisma.issueSchedule.update({ where: { id }, data: { cadence: 'daily', weekday: null, timezone: 'UTC', nextRunAt: at('2026-07-01T09:00:00Z') } });
    await runDueSchedules({ now: at('2026-07-01T09:00:40Z') });
    expect(await scheduledTasks(id)).toHaveLength(2);
    expect((await prisma.issueSchedule.findUniqueOrThrow({ where: { id } })).nextRunAt).toEqual(at('2026-07-02T09:00:00Z'));
    await prisma.issueSchedule.delete({ where: { id } });
  });

  it('pauses itself when its owner can no longer create issues; whoever resumes becomes the owner', async () => {
    const id = await dueSchedule({ ...WEEKLY, title: 'Orphaned', cadence: 'daily', weekday: undefined, timezone: 'UTC' }, '2026-08-01T09:00:00Z', tokens.leaver);
    await prisma.teamMember.deleteMany({ where: { teamId, userId: users.leaver } });
    await prisma.projectAccess.deleteMany({ where: { projectId, userId: users.leaver } });
    await runDueSchedules({ now: at('2026-08-01T09:01:00Z') });
    expect(await scheduledTasks(id)).toHaveLength(0);
    const schedule = await prisma.issueSchedule.findUniqueOrThrow({ where: { id }, include: { occurrences: true } });
    expect(schedule).toMatchObject({ pausedAt: at('2026-08-01T09:01:00Z'), pauseReason: 'owner_lost_access', nextRunAt: at('2026-08-02T09:00:00Z') });
    expect(schedule.occurrences).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'owner_lost_access', taskId: null })]);
    // Paused: later slots are not even looked at.
    expect((await runDueSchedules({ now: at('2026-08-05T09:01:00Z') })).skipped).toBe(0);

    const resumed = await http().post(`/api/schedules/${id}/resume`).set(as(tokens.member));
    expect(resumed.body).toMatchObject({ ownerId: users.member, pausedAt: null, pauseReason: null });
    await prisma.issueSchedule.update({ where: { id }, data: { nextRunAt: at('2026-08-06T09:00:00Z') } });
    await runDueSchedules({ now: at('2026-08-06T09:00:30Z') });
    const tasks = await scheduledTasks(id);
    expect(tasks.map((task) => task.creatorId)).toEqual([users.member]);
    await prisma.issueSchedule.delete({ where: { id } });
  });

  it('PATCH changes the template or the rule; a new rule recomputes the next slot, a cadence change drops the old day', async () => {
    const created = await create({ ...WEEKLY, title: 'Edit me' });
    const id = created.body.id as string;
    const renamed = await http().patch(`/api/schedules/${id}`).set(as(tokens.member)).send({ title: 'Edited', labelIds: [labelId] });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'Edited', labelIds: [labelId], nextRunAt: created.body.nextRunAt, ownerId: users.member });
    const before = new Date();
    const daily = await http().patch(`/api/schedules/${id}`).set(as(tokens.owner)).send({ cadence: 'daily', hour: 6, timezone: 'Asia/Tokyo' });
    expect(daily.body).toMatchObject({ cadence: 'daily', weekday: null, hour: 6, timezone: 'Asia/Tokyo', cadenceText: 'Every day at 06:00 (Asia/Tokyo)' });
    expect(daily.body.nextRunAt).toBe(nextSlotAfter({ cadence: 'daily', hour: 6, minute: 0, timezone: 'Asia/Tokyo' }, before).toISOString());
    const monthly = await http().patch(`/api/schedules/${id}`).set(as(tokens.owner)).send({ cadence: 'monthly' });
    expect(monthly.status).toBe(400);
    expect((await http().patch(`/api/schedules/${id}`).set(as(tokens.owner)).send({ cadence: 'monthly', dayOfMonth: 15 })).body).toMatchObject({ dayOfMonth: 15, weekday: null });
    expect((await http().patch(`/api/schedules/${id}`).set(as(tokens.owner)).send({})).status).toBe(400);
    expect(await countEvents('schedule:updated', 'scheduleId', id)).toBe(3);
    await prisma.issueSchedule.delete({ where: { id } });
  });

  it('review fix: concurrent edits of the rule and of the template never leave an old hour with a new next slot', async () => {
    const created = await create({ ...WEEKLY, title: 'Raced', cadence: 'daily', weekday: undefined });
    const id = created.body.id as string;
    for (let round = 0; round < 8; round += 1) {
      const hour = 10 + round;
      await Promise.all([
        http().patch(`/api/schedules/${id}`).set(as(tokens.owner)).send({ hour }),
        http().patch(`/api/schedules/${id}`).set(as(tokens.member)).send({ title: `Raced ${round}` }),
      ]);
      const stored = await prisma.issueSchedule.findUniqueOrThrow({ where: { id } });
      const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(stored.nextRunAt));
      expect(stored.hour).toBe(hour);
      expect(localHour).toBe(hour);
    }
    await prisma.issueSchedule.delete({ where: { id } });
  });

  it('review fix: a schedule whose issue keeps failing backs off (left out of the sweep) and pauses itself after repeated failures', async () => {
    const id = await dueSchedule({ ...WEEKLY, title: 'Collides', cadence: 'daily', weekday: undefined, timezone: 'UTC' }, '2026-09-01T09:00:00Z');
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });
    // An issue already holds the team's next number (e.g. moved in with its old number): every insert collides.
    const blocker = await prisma.task.create({ data: { title: 'Holds the number', projectId, teamId, number: team.nextIssueNumber, identifier: `${team.key}-${team.nextIssueNumber}` } });
    try {
      let now = at('2026-09-01T09:00:30Z').getTime();
      expect((await runDueSchedules({ now: new Date(now) })).failed).toBe(1);
      // Within the backoff the schedule is not even examined.
      const quiet = await runDueSchedules({ now: new Date(now + 30_000) });
      expect(quiet.failed).toBe(0);
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        now += 61 * 60_000;
        await runDueSchedules({ now: new Date(now) });
      }
      const schedule = await prisma.issueSchedule.findUniqueOrThrow({ where: { id } });
      expect(schedule).toMatchObject({ pauseReason: 'creation_failed' });
      expect(schedule.pausedAt).not.toBeNull();
      expect(await scheduledTasks(id)).toHaveLength(0);
    } finally {
      await prisma.task.delete({ where: { id: blocker.id } });
      await prisma.issueSchedule.delete({ where: { id } });
    }
  });

  it('review fix: the schedule detail hides an issue that was moved to another project', async () => {
    const id = await dueSchedule({ ...WEEKLY, title: 'Moves away', cadence: 'daily', weekday: undefined, timezone: 'UTC' }, '2026-10-01T09:00:00Z');
    await runDueSchedules({ now: at('2026-10-01T09:00:30Z') });
    const [task] = await scheduledTasks(id);
    expect(task).toBeTruthy();
    const elsewhere = await prisma.project.create({ data: { name: `Elsewhere ${RUN}`, key: `EW${RUN.slice(0, 2).toUpperCase()}` } });
    ids.projects.push(elsewhere.id);
    await prisma.task.update({ where: { id: task?.id ?? '' }, data: { projectId: elsewhere.id } });
    const detail = await http().get(`/api/schedules/${id}`).set(as(tokens.viewer));
    expect(detail.body.occurrences[0]).toMatchObject({ outcome: 'created', task: null });
    await prisma.issueSchedule.delete({ where: { id } });
  });

  it('deleting keeps the issues it created; deleting the project removes its schedules', async () => {
    const id = (await create({ ...WEEKLY, title: 'Delete me' })).body.id as string;
    const run = await http().post(`/api/schedules/${id}/run-now`).set(as(tokens.owner));
    const taskId = run.body.occurrence.task.id as string;
    expect((await http().delete(`/api/schedules/${id}`).set(as(tokens.member))).status).toBe(204);
    expect(await prisma.issueSchedule.count({ where: { id } })).toBe(0);
    expect(await prisma.issueScheduleOccurrence.count({ where: { scheduleId: id } })).toBe(0);
    expect(await prisma.task.count({ where: { id: taskId } })).toBe(1);
    expect(await countEvents('schedule:deleted', 'scheduleId', id)).toBe(1);
    expect((await http().get(`/api/schedules/${id}`).set(as(tokens.owner))).status).toBe(404);

    const doomed = await prisma.project.create({ data: { name: `Doomed ${RUN}`, workspaceId, key: `SD${RUN.slice(0, 3).toUpperCase()}` } });
    ids.projects.push(doomed.id);
    const doomedTeam = await prisma.team.create({ data: { name: `Doomed ${RUN}`, key: `D${RUN.slice(0, 3).toUpperCase()}`, projectId: doomed.id } });
    await prisma.teamMember.create({ data: { teamId: doomedTeam.id, userId: users.owner, role: 'owner' } });
    const doomedSchedule = await create({ ...WEEKLY, title: 'Gone with the project' }, tokens.owner, {}, doomed.id);
    expect(doomedSchedule.status).toBe(201);
    expect((await http().delete(`/api/projects/${doomed.id}`).set(as(tokens.owner))).status).toBeLessThan(300);
    expect(await prisma.issueSchedule.count({ where: { id: doomedSchedule.body.id as string } })).toBe(0);
  });

  it(`allows ${MAX_ACTIVE_SCHEDULES_PER_PROJECT} active and ${MAX_SCHEDULES_PER_PROJECT} total schedules per project, also under concurrent creates`, async () => {
    const row = (index: number, pausedAt: Date | null = null) => ({
      projectId, title: `Bulk ${index}`, cadence: 'daily', hour: 9, minute: 0, timezone: 'UTC',
      nextRunAt: at('2099-01-01T09:00:00Z'), pausedAt, ownerId: users.owner, createdById: users.owner,
    });
    await prisma.issueSchedule.createMany({ data: Array.from({ length: MAX_ACTIVE_SCHEDULES_PER_PROJECT - 1 }, (_, index) => row(index)) });
    const racing = await Promise.all([1, 2, 3].map((index) => create({ ...WEEKLY, title: `Race ${index}` })));
    expect(racing.map((res) => res.status).sort()).toEqual([201, 409, 409]);
    expect(racing.find((res) => res.status === 409)?.body).toMatchObject({ code: 'SCHEDULE_QUOTA_EXCEEDED', details: { kind: 'active', limit: MAX_ACTIVE_SCHEDULES_PER_PROJECT } });
    expect(await prisma.issueSchedule.count({ where: { projectId, pausedAt: null } })).toBe(MAX_ACTIVE_SCHEDULES_PER_PROJECT);

    // A paused one frees a slot; resuming it while full is refused.
    const pausable = (racing.find((res) => res.status === 201)?.body.id ?? '') as string;
    await http().post(`/api/schedules/${pausable}/pause`).set(as(tokens.owner));
    expect((await create({ ...WEEKLY, title: 'Fits again' })).status).toBe(201);
    expect((await http().post(`/api/schedules/${pausable}/resume`).set(as(tokens.owner))).body.code).toBe('SCHEDULE_QUOTA_EXCEEDED');

    const total = await prisma.issueSchedule.count({ where: { projectId } });
    await prisma.issueSchedule.createMany({ data: Array.from({ length: MAX_SCHEDULES_PER_PROJECT - total }, (_, index) => row(100 + index, new Date())) });
    await prisma.issueSchedule.updateMany({ where: { projectId, title: 'Fits again' }, data: { pausedAt: new Date() } });
    const full = await create({ ...WEEKLY, title: 'One too many' });
    expect(full.body).toMatchObject({ code: 'SCHEDULE_QUOTA_EXCEEDED', details: { kind: 'total', limit: MAX_SCHEDULES_PER_PROJECT } });
    await prisma.issueSchedule.deleteMany({ where: { projectId } });
  });
});
