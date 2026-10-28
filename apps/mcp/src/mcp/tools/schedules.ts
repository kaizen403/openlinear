import * as z from 'zod';
import type { ApiSchedule } from '../../openlinear/api';
import { deriveIdempotencyKey } from '../idempotency';
import { id, IdempotencyKeyArg, IssuePriority } from '../inputs';
import { IdempotencyShape } from '../shapes';
import { defineTool, READ_ONLY } from '../tool';

/**
 * W20 recurring issues: a schedule creates one issue from its template on a
 * cadence (every day, weekday, week or month at a local time in an IANA time
 * zone). It only creates issues; running them stays a person's decision.
 */

const ScheduleShape = z.object({
  id: z.string().describe('Schedule UUID'),
  projectId: z.string(),
  title: z.string().describe('Issue title template ({date} becomes each issue date)'),
  priority: z.string(),
  labelIds: z.array(z.string()),
  assigneeId: z.string().nullable(),
  cadence: z.string().describe('daily | weekdays | weekly | monthly'),
  weekday: z.number().int().nullable().describe('weekly: 0 = Sunday … 6 = Saturday'),
  dayOfMonth: z.number().int().nullable().describe('monthly: 1-28'),
  time: z.string().describe('Local time HH:MM in the schedule time zone'),
  timezone: z.string(),
  cadenceText: z.string().describe('In words, e.g. "Every weekday at 09:00 (Europe/Berlin)"'),
  nextRunAt: z.string().describe('When the next issue is created (UTC)'),
  lastRunAt: z.string().nullable(),
  paused: z.boolean(),
  pauseReason: z.string().nullable().describe('Set when it paused itself, e.g. owner_lost_access'),
});

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function toSchedule(schedule: ApiSchedule): z.infer<typeof ScheduleShape> {
  return {
    id: schedule.id,
    projectId: schedule.projectId,
    title: schedule.title,
    priority: schedule.priority,
    labelIds: schedule.labelIds,
    assigneeId: schedule.assigneeId ?? null,
    cadence: schedule.cadence,
    weekday: schedule.weekday,
    dayOfMonth: schedule.dayOfMonth,
    time: `${two(schedule.hour)}:${two(schedule.minute)}`,
    timezone: schedule.timezone,
    cadenceText: schedule.cadenceText,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt ?? null,
    paused: Boolean(schedule.pausedAt),
    pauseReason: schedule.pauseReason ?? null,
  };
}

export const listSchedules = defineTool({
  name: 'openlinear_list_schedules',
  title: 'List recurring issues',
  description: "List a project's recurring-issue schedules: what each creates, when (cadence in words, next run) and whether it is paused. Check here before creating one that may already exist.",
  input: z.strictObject({ projectId: id('Project') }),
  output: z.object({ schedules: z.array(ScheduleShape) }),
  annotations: READ_ONLY,
  scopes: ['read', 'tasks:read'],
  async run({ projectId }, { api, signal }) {
    const items = await api.listSchedules(projectId, signal);
    return { schedules: items.map(toSchedule) };
  },
});

export const createSchedule = defineTool({
  name: 'openlinear_create_schedule',
  title: 'Create a recurring issue',
  description:
    'Create an issue automatically on a schedule in a project: every day, every weekday (Mon-Fri), every week on a weekday, or every month on a day (1-28), at a local time in an IANA time zone (daylight saving handled). Each run creates one issue from the template; it never runs the issue. A project has at most 25 active schedules. Safe to retry.',
  input: z.strictObject({
    projectId: id('Project'),
    title: z.string().trim().min(1).max(200).describe('Issue title; {date} becomes each issue date (YYYY-MM-DD in the schedule time zone)'),
    description: z.string().max(10000).optional().describe('Markdown'),
    priority: IssuePriority.optional().describe('Priority of each created issue (default medium)'),
    labelIds: z.array(id('Label')).max(20).optional().describe('Labels of the same project'),
    assigneeId: id('User').optional().describe("A member of the project's team"),
    cadence: z.enum(['daily', 'weekdays', 'weekly', 'monthly']).describe('daily, weekdays (Mon-Fri), weekly (needs weekday) or monthly (needs dayOfMonth)'),
    weekday: z.number().int().min(0).max(6).optional().describe('Required for weekly: 0 = Sunday … 6 = Saturday'),
    dayOfMonth: z.number().int().min(1).max(28).optional().describe('Required for monthly: 1-28'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour').describe('Local time HH:MM (24-hour)'),
    timezone: z.string().trim().min(1).max(64).describe('IANA time zone, e.g. Europe/Berlin or America/New_York'),
    idempotencyKey: IdempotencyKeyArg.optional(),
  }),
  output: z.object({ schedule: ScheduleShape, idempotency: IdempotencyShape }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run(args, { api, signal, toolName }) {
    const key = await deriveIdempotencyKey(toolName, 'schedule', args);
    const [hour, minute] = args.time.split(':').map(Number);
    const created = await api.createSchedule(
      args.projectId,
      {
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.labelIds ? { labelIds: args.labelIds } : {}),
        ...(args.assigneeId ? { assigneeId: args.assigneeId } : {}),
        cadence: args.cadence,
        ...(args.weekday !== undefined ? { weekday: args.weekday } : {}),
        ...(args.dayOfMonth !== undefined ? { dayOfMonth: args.dayOfMonth } : {}),
        hour: hour ?? 0,
        minute: minute ?? 0,
        timezone: args.timezone,
      },
      key,
      signal,
    );
    return { schedule: toSchedule(created.value), idempotency: { key, replayed: created.replayed } };
  },
});
