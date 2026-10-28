import { prisma, type IssueSchedule, type Prisma } from '@openlinear/db';
import { HttpError, ValidationError } from '../errors';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, projectTarget, taskTarget } from '../events/targets';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { logger } from '../logger';
import { createNotification } from '../routes/notifications';
import type { CreateScheduleBody, UpdateScheduleBody } from '../schemas/schedules';
import { logActivity } from './activity';
import type { IdempotentCommand } from './idempotency';
import { assertProjectAccess, assertTeamRole, isOwnershipError } from './ownership';
import {
  canonicalTimeZone,
  describeScheduleRule,
  dueSlot,
  floorToMinute,
  nextSlotAfter,
  renderScheduleTitle,
  type ScheduleCadence,
  type ScheduleRule,
} from './schedule-slots';
import { flattenTaskLabels, insertProjectTasks, resolveProjectTeamId, resolveProjectWorkspaceId } from './tasks';

/**
 * W20 / FE-14: recurring issues. See docs/reports/revamp-2026-10-26/schedules.md.
 *
 * A schedule belongs to one project and holds an issue template plus a rule
 * (cadence, local time, IANA zone; slot math in `schedule-slots.ts`). The
 * `schedule-run` job (every minute) claims each due schedule with
 * `FOR UPDATE SKIP LOCKED` and, in one transaction, creates the issue (team
 * numbering via `insertProjectTasks`), records the occurrence — unique per
 * (schedule, slot), the idempotency key — and advances `nextRunAt`. After
 * downtime only the most recent missed slot gets an issue; the others are
 * counted on it. "Run now" creates one issue per schedule per minute.
 *
 * Issues are created as the schedule's owner (who created, last changed or
 * resumed it), with that person's current access: when the owner can no
 * longer create issues in the project, the slot is recorded as skipped and
 * the schedule pauses itself until someone resumes it (and becomes owner).
 * Schedules only create issues; running them stays a person's decision.
 */

/** Active (not paused) schedules per project. */
export const MAX_ACTIVE_SCHEDULES_PER_PROJECT = 25;
/** All schedules per project, paused included. */
export const MAX_SCHEDULES_PER_PROJECT = 50;
/** Due schedules one job run handles; the rest wait for the next minute. */
export const SCHEDULE_SWEEP_LIMIT = 100;
const OCCURRENCES_SHOWN = 20;
const TEAM_ROLES = ['owner', 'admin', 'member'] as const;

export type ScheduleSkipReason = 'owner_lost_access' | 'project_has_no_team';

/** A schedule whose issue keeps failing to be created pauses itself after this many attempts in a row. */
export const SCHEDULE_FAILURES_BEFORE_PAUSE = 5;
/**
 * Failing schedules back off (1, 2, 4 … 60 min) and are left out of the
 * sweep meanwhile, so a few broken ones never starve the rest. Per process:
 * a restart retries once more, which is harmless.
 */
const scheduleFailures = new Map<string, { count: number; retryAt: number }>();

function failureBackoffMs(count: number): number {
  return Math.min(60, 2 ** Math.max(0, count - 1)) * 60_000;
}

export interface ScheduleView {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: 'low' | 'medium' | 'high';
  labelIds: string[];
  assigneeId: string | null;
  cadence: ScheduleCadence;
  weekday: number | null;
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  timezone: string;
  /** "Every weekday at 09:00 (Europe/Berlin)". */
  cadenceText: string;
  nextRunAt: string;
  lastRunAt: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  ownerId: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface OccurrenceView {
  id: string;
  slotAt: string;
  kind: 'scheduled' | 'manual';
  outcome: 'created' | 'skipped';
  reason: string | null;
  skippedSlots: number;
  createdAt: string;
  /** Null when skipped, or when the issue was deleted since. */
  task: { id: string; identifier: string | null; title: string; status: string; archived: boolean } | null;
}

type CreatedTask = Awaited<ReturnType<typeof insertProjectTasks>>[number];

function isCadence(value: string): value is ScheduleCadence {
  return value === 'daily' || value === 'weekdays' || value === 'weekly' || value === 'monthly';
}

function ruleOf(row: Pick<IssueSchedule, 'cadence' | 'weekday' | 'dayOfMonth' | 'hour' | 'minute' | 'timezone'>): ScheduleRule {
  if (!isCadence(row.cadence)) throw new HttpError(500, 'SCHEDULE_CORRUPT', 'A stored schedule has an unknown cadence');
  return { cadence: row.cadence, weekday: row.weekday, dayOfMonth: row.dayOfMonth, hour: row.hour, minute: row.minute, timezone: row.timezone };
}

export function scheduleView(row: IssueSchedule): ScheduleView {
  const rule = ruleOf(row);
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    priority: row.priority,
    labelIds: row.labelIds,
    assigneeId: row.assigneeId,
    cadence: rule.cadence,
    weekday: row.weekday,
    dayOfMonth: row.dayOfMonth,
    hour: row.hour,
    minute: row.minute,
    timezone: row.timezone,
    cadenceText: describeScheduleRule(rule),
    nextRunAt: row.nextRunAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    pauseReason: row.pauseReason,
    ownerId: row.ownerId,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const occurrenceSelect = {
  id: true, slotAt: true, kind: true, outcome: true, reason: true, skippedSlots: true, createdAt: true,
  task: { select: { id: true, identifier: true, title: true, status: true, archived: true, projectId: true } },
} satisfies Prisma.IssueScheduleOccurrenceSelect;

/**
 * An occurrence as a reader of the schedule's project may see it: the issue
 * it created only while that issue is still in the project (a moved issue's
 * title and status belong to wherever it went).
 */
function occurrenceView(row: Prisma.IssueScheduleOccurrenceGetPayload<{ select: typeof occurrenceSelect }>, projectId: string): OccurrenceView {
  const task = row.task && row.task.projectId === projectId
    ? { id: row.task.id, identifier: row.task.identifier, title: row.task.title, status: row.task.status, archived: row.task.archived }
    : null;
  return {
    id: row.id,
    slotAt: row.slotAt.toISOString(),
    kind: row.kind === 'manual' ? 'manual' : 'scheduled',
    outcome: row.outcome === 'skipped' ? 'skipped' : 'created',
    reason: row.reason,
    skippedSlots: row.skippedSlots,
    createdAt: row.createdAt.toISOString(),
    task,
  };
}

async function loadSchedule(scheduleId: string): Promise<IssueSchedule> {
  const schedule = await prisma.issueSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new HttpError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found');
  return schedule;
}

/** Full project access plus team membership: the caller creates issues (or becomes the owner who does). */
async function assertMayCreateIssues(projectId: string, userId: string): Promise<string> {
  await assertProjectAccess(projectId, userId, 'full');
  const teamId = await resolveProjectTeamId(projectId);
  await assertTeamRole(teamId, userId, TEAM_ROLES);
  return teamId;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface RuleInput {
  cadence: ScheduleCadence;
  weekday: number | null;
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  timezone: string;
}

/** A consistent rule with a canonical zone, or 400. */
function normalizeRule(input: RuleInput): ScheduleRule {
  const timezone = canonicalTimeZone(input.timezone);
  if (!timezone) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Unknown time zone "${input.timezone}"; use an IANA name such as Europe/Berlin`, { field: 'timezone' });
  }
  if ((input.cadence === 'weekly') !== (input.weekday !== null)) {
    throw new HttpError(400, 'VALIDATION_ERROR', input.cadence === 'weekly' ? 'A weekly schedule needs a weekday (0 = Sunday … 6 = Saturday)' : 'weekday applies to weekly schedules only', { field: 'weekday' });
  }
  if ((input.cadence === 'monthly') !== (input.dayOfMonth !== null)) {
    throw new HttpError(400, 'VALIDATION_ERROR', input.cadence === 'monthly' ? 'A monthly schedule needs a dayOfMonth (1-28)' : 'dayOfMonth applies to monthly schedules only', { field: 'dayOfMonth' });
  }
  return { ...input, timezone };
}

async function assertTemplateReferences(input: { projectId: string; teamId: string; labelIds?: string[]; assigneeId?: string | null }): Promise<void> {
  const labelIds = [...new Set(input.labelIds ?? [])];
  if (labelIds.length > 0) {
    const found = await prisma.label.findMany({ where: { id: { in: labelIds }, projectId: input.projectId }, select: { id: true } });
    if (found.length !== labelIds.length) {
      const known = new Set(found.map((label) => label.id));
      throw new ValidationError(`Invalid labelIds: ${labelIds.filter((id) => !known.has(id)).join(', ')}`);
    }
  }
  if (input.assigneeId) {
    const member = await prisma.teamMember.findUnique({ where: { teamId_userId: { teamId: input.teamId, userId: input.assigneeId } }, select: { id: true } });
    if (!member) throw new ValidationError(`User is not a member of this project's team: ${input.assigneeId}`);
  }
}

/** Serializes quota checks per project (create and resume). */
async function lockProjectSchedules(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`openlinear-schedules:project:${projectId}`}, 0))`;
}

async function assertQuota(tx: Prisma.TransactionClient, projectId: string, input: { addingRow: boolean; excludeId?: string }): Promise<void> {
  const notThis = input.excludeId ? { id: { not: input.excludeId } } : {};
  const active = await tx.issueSchedule.count({ where: { projectId, pausedAt: null, ...notThis } });
  if (active >= MAX_ACTIVE_SCHEDULES_PER_PROJECT) {
    throw new HttpError(409, 'SCHEDULE_QUOTA_EXCEEDED', `A project can have ${MAX_ACTIVE_SCHEDULES_PER_PROJECT} active schedules; pause or delete one first`, { limit: MAX_ACTIVE_SCHEDULES_PER_PROJECT, active, kind: 'active' });
  }
  if (input.addingRow) {
    const total = await tx.issueSchedule.count({ where: { projectId } });
    if (total >= MAX_SCHEDULES_PER_PROJECT) {
      throw new HttpError(409, 'SCHEDULE_QUOTA_EXCEEDED', `A project can have ${MAX_SCHEDULES_PER_PROJECT} schedules; delete one first`, { limit: MAX_SCHEDULES_PER_PROJECT, total, kind: 'total' });
    }
  }
}

async function appendScheduleEvent(tx: Prisma.TransactionClient, type: 'schedule:created' | 'schedule:updated' | 'schedule:deleted', schedule: { id: string; projectId: string }, actorId: string): Promise<void> {
  await appendToTarget(tx, await projectTarget(tx, schedule.projectId), type, { scheduleId: schedule.id, projectId: schedule.projectId }, actorId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listSchedules(input: { projectId: string; userId: string }) {
  await assertProjectAccess(input.projectId, input.userId, 'view');
  const rows = await prisma.issueSchedule.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_SCHEDULES_PER_PROJECT,
  });
  return {
    items: rows.map(scheduleView),
    limits: { active: MAX_ACTIVE_SCHEDULES_PER_PROJECT, total: MAX_SCHEDULES_PER_PROJECT },
  };
}

/** One schedule with its most recent occurrences (newest first). */
export async function getSchedule(input: { scheduleId: string; userId: string }) {
  const schedule = await loadSchedule(input.scheduleId);
  await assertProjectAccess(schedule.projectId, input.userId, 'view');
  const occurrences = await prisma.issueScheduleOccurrence.findMany({
    where: { scheduleId: schedule.id },
    orderBy: [{ slotAt: 'desc' }, { id: 'asc' }],
    take: OCCURRENCES_SHOWN,
    select: occurrenceSelect,
  });
  return { ...scheduleView(schedule), occurrences: occurrences.map((row) => occurrenceView(row, schedule.projectId)) };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** `POST /api/projects/:id/schedules` as an idempotent command (W04a keys). */
export async function authorizeCreateSchedule(input: { projectId: string; userId: string; body: CreateScheduleBody; now?: Date }): Promise<IdempotentCommand<null, ScheduleView>> {
  const teamId = await assertMayCreateIssues(input.projectId, input.userId);
  const { body } = input;
  const rule = normalizeRule({
    cadence: body.cadence, weekday: body.weekday ?? null, dayOfMonth: body.dayOfMonth ?? null,
    hour: body.hour, minute: body.minute, timezone: body.timezone,
  });
  return {
    resolveWorkspaceId: () => resolveProjectWorkspaceId(input.projectId),
    prepare: async () => {
      await assertTemplateReferences({ projectId: input.projectId, teamId, labelIds: body.labelIds, assigneeId: body.assigneeId });
      return null;
    },
    mutate: async (tx) => {
      await lockProjectSchedules(tx, input.projectId);
      await assertQuota(tx, input.projectId, { addingRow: true });
      const row = await tx.issueSchedule.create({
        data: {
          projectId: input.projectId,
          title: body.title,
          description: body.description ?? null,
          priority: body.priority ?? 'medium',
          labelIds: [...new Set(body.labelIds ?? [])],
          assigneeId: body.assigneeId ?? null,
          ...rule,
          nextRunAt: nextSlotAfter(rule, input.now ?? new Date()),
          ownerId: input.userId,
          createdById: input.userId,
        },
      });
      await appendScheduleEvent(tx, 'schedule:created', row, input.userId);
      return { status: 201, body: scheduleView(row) };
    },
  };
}

/**
 * Change the template and/or the rule. A new rule recomputes the next slot
 * from now. The caller becomes the owner (issues are created as them).
 */
export async function updateSchedule(input: { scheduleId: string; userId: string; body: UpdateScheduleBody; now?: Date }): Promise<ScheduleView> {
  const existing = await loadSchedule(input.scheduleId);
  const teamId = await assertMayCreateIssues(existing.projectId, input.userId);
  const { body } = input;
  await assertTemplateReferences({ projectId: existing.projectId, teamId, labelIds: body.labelIds, assigneeId: body.assigneeId });
  const row = await transactionWithEvents(async (tx) => {
    // The rule is merged into the row as it is now (locked), so a concurrent
    // edit of other fields cannot write back an old hour or cadence.
    const current = await lockSchedule(tx, existing.id);
    const cadence = body.cadence ?? ruleOf(current).cadence;
    const rule = normalizeRule({
      cadence,
      // A cadence change drops the stored day it no longer uses.
      weekday: body.weekday !== undefined ? body.weekday : cadence === 'weekly' ? current.weekday : null,
      dayOfMonth: body.dayOfMonth !== undefined ? body.dayOfMonth : cadence === 'monthly' ? current.dayOfMonth : null,
      hour: body.hour ?? current.hour,
      minute: body.minute ?? current.minute,
      timezone: body.timezone ?? current.timezone,
    });
    const ruleChanged = (['cadence', 'weekday', 'dayOfMonth', 'hour', 'minute', 'timezone'] as const).some((field) => rule[field] !== current[field]);
    const updated = await tx.issueSchedule.update({
      where: { id: existing.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.labelIds !== undefined ? { labelIds: [...new Set(body.labelIds)] } : {}),
        ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
        ...rule,
        ...(ruleChanged ? { nextRunAt: nextSlotAfter(rule, input.now ?? new Date()) } : {}),
        ownerId: input.userId,
      },
    }).catch((err: unknown) => {
      throw notFoundIfGone(err);
    });
    await appendScheduleEvent(tx, 'schedule:updated', updated, input.userId);
    return updated;
  }, PRISMA_TX_OPTIONS);
  return scheduleView(row);
}

/** After repeated failures: paused with a reason the owner sees; resuming retries from the next slot. */
async function pauseFailingSchedule(scheduleId: string, now: Date): Promise<void> {
  await transactionWithEvents(async (tx) => {
    const updated = await tx.issueSchedule.updateMany({ where: { id: scheduleId, pausedAt: null }, data: { pausedAt: now, pauseReason: 'creation_failed' } });
    if (updated.count === 0) return;
    const row = await tx.issueSchedule.findUnique({ where: { id: scheduleId } });
    if (row) await appendScheduleEvent(tx, 'schedule:updated', row, row.ownerId);
  }, PRISMA_TX_OPTIONS);
}

/** The schedule row, locked for this transaction (404 when it was deleted meanwhile). */
async function lockSchedule(tx: Prisma.TransactionClient, scheduleId: string): Promise<IssueSchedule> {
  await tx.$queryRaw`SELECT id FROM "issue_schedules" WHERE id = ${scheduleId} FOR UPDATE`;
  const row = await tx.issueSchedule.findUnique({ where: { id: scheduleId } });
  if (!row) throw new HttpError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found');
  return row;
}

/** A row deleted between the read and the write answers like a missing schedule. */
function notFoundIfGone(err: unknown): unknown {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'P2025') return new HttpError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found');
  return err;
}

/** Immediate: a paused schedule is never due. Pausing a paused schedule changes nothing. */
export async function pauseSchedule(input: { scheduleId: string; userId: string; now?: Date }): Promise<ScheduleView> {
  const existing = await loadSchedule(input.scheduleId);
  await assertProjectAccess(existing.projectId, input.userId, 'full');
  if (existing.pausedAt) return scheduleView(existing);
  const row = await transactionWithEvents(async (tx) => {
    const updated = await tx.issueSchedule.update({ where: { id: existing.id }, data: { pausedAt: input.now ?? new Date(), pauseReason: null } })
      .catch((err: unknown) => { throw notFoundIfGone(err); });
    await appendScheduleEvent(tx, 'schedule:updated', updated, input.userId);
    return updated;
  }, PRISMA_TX_OPTIONS);
  return scheduleView(row);
}

/**
 * Resume from now: slots missed while paused are not created. Counts toward
 * the active quota; the caller becomes the owner.
 */
export async function resumeSchedule(input: { scheduleId: string; userId: string; now?: Date }): Promise<ScheduleView> {
  const existing = await loadSchedule(input.scheduleId);
  await assertMayCreateIssues(existing.projectId, input.userId);
  if (!existing.pausedAt) return scheduleView(existing);
  const row = await transactionWithEvents(async (tx) => {
    await lockProjectSchedules(tx, existing.projectId);
    const current = await lockSchedule(tx, existing.id);
    if (!current.pausedAt) return current;
    await assertQuota(tx, existing.projectId, { addingRow: false, excludeId: existing.id });
    const updated = await tx.issueSchedule.update({
      where: { id: existing.id },
      data: { pausedAt: null, pauseReason: null, nextRunAt: nextSlotAfter(ruleOf(current), input.now ?? new Date()), ownerId: input.userId },
    }).catch((err: unknown) => { throw notFoundIfGone(err); });
    await appendScheduleEvent(tx, 'schedule:updated', updated, input.userId);
    return updated;
  }, PRISMA_TX_OPTIONS);
  return scheduleView(row);
}

/** Immediate. Issues the schedule already created stay. */
export async function deleteSchedule(input: { scheduleId: string; userId: string }): Promise<void> {
  const existing = await loadSchedule(input.scheduleId);
  await assertProjectAccess(existing.projectId, input.userId, 'full');
  await transactionWithEvents(async (tx) => {
    const removed = await tx.issueSchedule.deleteMany({ where: { id: existing.id } });
    if (removed.count > 0) await appendScheduleEvent(tx, 'schedule:deleted', existing, input.userId);
  }, PRISMA_TX_OPTIONS);
}

// ---------------------------------------------------------------------------
// Creating issues
// ---------------------------------------------------------------------------

/**
 * The issue for one slot plus its occurrence, inside the caller's
 * transaction (which holds the schedule row lock). Labels deleted since are
 * left out; an assignee who left the team is dropped.
 */
async function createScheduledIssue(
  tx: Prisma.TransactionClient,
  schedule: IssueSchedule,
  input: { slotAt: Date; kind: 'scheduled' | 'manual'; skippedSlots: number; actorId: string; teamId: string },
): Promise<{ task: CreatedTask; occurrenceId: string }> {
  const labelIds = schedule.labelIds.length === 0 ? [] : (await tx.label.findMany({
    where: { id: { in: schedule.labelIds }, projectId: schedule.projectId },
    select: { id: true },
  })).map((label) => label.id);
  const assigneeId = schedule.assigneeId && (await tx.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.teamId, userId: schedule.assigneeId } },
    select: { id: true },
  })) ? schedule.assigneeId : null;
  const [task] = await insertProjectTasks(tx, {
    projectId: schedule.projectId,
    teamId: input.teamId,
    userId: input.actorId,
    items: [{
      title: renderScheduleTitle(schedule.title, input.slotAt, schedule.timezone),
      description: schedule.description,
      priority: schedule.priority,
      status: 'todo',
      labelIds,
      assigneeIds: assigneeId ? [assigneeId] : [],
    }],
  });
  if (!task) throw new Error('insertProjectTasks returned no task');
  const occurrence = await tx.issueScheduleOccurrence.create({
    data: {
      scheduleId: schedule.id,
      slotAt: input.slotAt,
      kind: input.kind,
      outcome: 'created',
      skippedSlots: input.skippedSlots,
      taskId: task.id,
      createdById: input.actorId,
    },
    select: { id: true },
  });
  // The normal task event (W04b outbox): boards add the issue live.
  const dto = flattenTaskLabels(task);
  await appendToTarget(tx, await taskTarget(tx, task), 'task:created', dto, input.actorId);
  return { task, occurrenceId: occurrence.id };
}

/** After commit: activity and the assignee's notification, as for any new issue. */
async function publishScheduledIssue(task: CreatedTask, actorId: string, scheduleId: string): Promise<void> {
  await logActivity({
    taskId: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    userId: actorId,
    action: 'task_created',
    payload: { title: task.title, status: task.status, priority: task.priority, identifier: task.identifier, source: 'schedule', scheduleId },
  });
  if (task.assigneeId && task.assigneeId !== actorId) {
    await createNotification({
      recipientUserId: task.assigneeId,
      actorUserId: actorId,
      type: 'assignment',
      taskId: task.id,
      body: `Assigned to you: ${task.title}`,
    });
  }
}

async function lockScheduleRow(tx: Prisma.TransactionClient, scheduleId: string): Promise<IssueSchedule> {
  await tx.$queryRaw`SELECT id FROM "issue_schedules" WHERE id = ${scheduleId} FOR UPDATE`;
  const schedule = await tx.issueSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new HttpError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found');
  return schedule;
}

/**
 * "Run now": one issue for the current minute, created by the caller, even
 * when the schedule is paused. Idempotent per minute: a repeat (or a slot the
 * job already handled this minute) returns that occurrence with
 * `created: false`. Does not move `nextRunAt`.
 */
export async function runScheduleNow(input: { scheduleId: string; userId: string; now?: Date }) {
  const existing = await loadSchedule(input.scheduleId);
  const teamId = await assertMayCreateIssues(existing.projectId, input.userId);
  const now = input.now ?? new Date();
  const slotAt = floorToMinute(now);
  const outcome = await transactionWithEvents(async (tx) => {
    const schedule = await lockScheduleRow(tx, existing.id);
    const taken = await tx.issueScheduleOccurrence.findUnique({ where: { scheduleId_slotAt: { scheduleId: schedule.id, slotAt } }, select: { id: true } });
    if (taken) return { created: false as const, occurrenceId: taken.id, schedule, task: null };
    const { task, occurrenceId } = await createScheduledIssue(tx, schedule, { slotAt, kind: 'manual', skippedSlots: 0, actorId: input.userId, teamId });
    const updated = await tx.issueSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: now } });
    await appendScheduleEvent(tx, 'schedule:updated', updated, input.userId);
    return { created: true as const, occurrenceId, schedule: updated, task };
  }, PRISMA_TX_OPTIONS);
  if (outcome.task) await publishScheduledIssue(outcome.task, input.userId, existing.id);
  const occurrence = await prisma.issueScheduleOccurrence.findUniqueOrThrow({ where: { id: outcome.occurrenceId }, select: occurrenceSelect });
  return { created: outcome.created, occurrence: occurrenceView(occurrence, outcome.schedule.projectId), schedule: scheduleView(outcome.schedule) };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface ScheduleSweepResult {
  examined: number;
  created: number;
  /** Slots recorded as skipped (the schedule paused itself). */
  skipped: number;
  /** Claimed by another worker, paused, changed or no longer due. */
  notClaimed: number;
  failed: number;
}

type FireOutcome = 'created' | 'skipped' | 'notClaimed';

/** Whether the owner may still create issues in the project, and the team that numbers them. */
async function ownerAccess(projectId: string, ownerId: string): Promise<{ ok: true; teamId: string } | { ok: false; reason: ScheduleSkipReason }> {
  const team = await prisma.team.findFirst({ where: { projectId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!team) return { ok: false, reason: 'project_has_no_team' };
  try {
    await assertProjectAccess(projectId, ownerId, 'full');
    await assertTeamRole(team.id, ownerId, TEAM_ROLES);
  } catch (err) {
    if (isOwnershipError(err)) return { ok: false, reason: 'owner_lost_access' };
    throw err;
  }
  return { ok: true, teamId: team.id };
}

async function fireDueSchedule(candidate: { id: string; projectId: string; ownerId: string }, now: Date): Promise<FireOutcome> {
  // Access is read before the claim (global client), so the transaction only
  // uses its own connection; it is re-validated against the claimed row.
  const access = await ownerAccess(candidate.projectId, candidate.ownerId);
  const fired = await transactionWithEvents(async (tx): Promise<{ outcome: FireOutcome; task?: CreatedTask; actorId?: string }> => {
    // Another worker holding the row has it; skip instead of waiting. Due-ness
    // is re-read after the lock (in JS: raw timestamp parameters would be
    // compared in the session time zone).
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "issue_schedules" WHERE id = ${candidate.id} FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return { outcome: 'notClaimed' };
    const schedule = await tx.issueSchedule.findUnique({ where: { id: candidate.id } });
    if (!schedule || schedule.pausedAt || schedule.ownerId !== candidate.ownerId || schedule.projectId !== candidate.projectId) return { outcome: 'notClaimed' };
    const due = dueSlot(ruleOf(schedule), schedule.nextRunAt, now);
    if (!due) return { outcome: 'notClaimed' };
    const taken = await tx.issueScheduleOccurrence.findUnique({ where: { scheduleId_slotAt: { scheduleId: schedule.id, slotAt: due.slotAt } }, select: { id: true } });
    if (taken) {
      // "Run now" already created this minute's issue: move on.
      await tx.issueSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: due.nextRunAt } });
      await appendScheduleEvent(tx, 'schedule:updated', schedule, schedule.ownerId);
      return { outcome: 'notClaimed' };
    }
    if (!access.ok) {
      await tx.issueScheduleOccurrence.create({
        data: { scheduleId: schedule.id, slotAt: due.slotAt, kind: 'scheduled', outcome: 'skipped', reason: access.reason, skippedSlots: due.skippedSlots },
      });
      await tx.issueSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: due.nextRunAt, pausedAt: now, pauseReason: access.reason } });
      await appendScheduleEvent(tx, 'schedule:updated', schedule, schedule.ownerId);
      return { outcome: 'skipped' };
    }
    const { task } = await createScheduledIssue(tx, schedule, { slotAt: due.slotAt, kind: 'scheduled', skippedSlots: due.skippedSlots, actorId: schedule.ownerId, teamId: access.teamId });
    await tx.issueSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: due.nextRunAt, lastRunAt: now } });
    await appendScheduleEvent(tx, 'schedule:updated', schedule, schedule.ownerId);
    return { outcome: 'created', task, actorId: schedule.ownerId };
  }, PRISMA_TX_OPTIONS);
  if (fired.task && fired.actorId) await publishScheduledIssue(fired.task, fired.actorId, candidate.id);
  return fired.outcome;
}

/**
 * The `schedule-run` job: every due schedule (oldest slot first, at most
 * `limit`) gets its issue. Safe to run on several workers at once: each
 * schedule is claimed with SKIP LOCKED and its slot is unique. A schedule
 * that fails is logged and retried on the next run.
 */
export async function runDueSchedules(options: { now?: Date; limit?: number } = {}): Promise<ScheduleSweepResult> {
  const now = options.now ?? new Date();
  const backingOff = [...scheduleFailures.entries()].filter(([, failure]) => failure.retryAt > now.getTime()).map(([id]) => id);
  const due = await prisma.issueSchedule.findMany({
    where: { pausedAt: null, nextRunAt: { lte: now }, ...(backingOff.length > 0 ? { id: { notIn: backingOff } } : {}) },
    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
    take: options.limit ?? SCHEDULE_SWEEP_LIMIT,
    select: { id: true, projectId: true, ownerId: true },
  });
  const result: ScheduleSweepResult = { examined: due.length, created: 0, skipped: 0, notClaimed: 0, failed: 0 };
  for (const candidate of due) {
    try {
      result[await fireDueSchedule(candidate, now)] += 1;
      scheduleFailures.delete(candidate.id);
    } catch (err) {
      result.failed += 1;
      const count = (scheduleFailures.get(candidate.id)?.count ?? 0) + 1;
      if (count >= SCHEDULE_FAILURES_BEFORE_PAUSE) {
        scheduleFailures.delete(candidate.id);
        logger.error({ err, scheduleId: candidate.id, failures: count }, '[schedules] creating a scheduled issue keeps failing; pausing the schedule');
        await pauseFailingSchedule(candidate.id, now).catch((pauseErr: unknown) => logger.error({ err: pauseErr, scheduleId: candidate.id }, '[schedules] could not pause a failing schedule'));
      } else {
        scheduleFailures.set(candidate.id, { count, retryAt: now.getTime() + failureBackoffMs(count) });
        logger.error({ err, scheduleId: candidate.id, failures: count }, '[schedules] creating a scheduled issue failed; retrying after a backoff');
      }
    }
  }
  if (result.examined > 0) logger.info(result, '[schedules] due schedules');
  return result;
}
