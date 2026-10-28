import { z } from 'zod';
import { SCHEDULE_CADENCES } from '../services/schedule-slots';

/**
 * W20 / FE-14 recurring issues: the issue template and when it recurs. The
 * DB CHECKs in migration 20261027210000_w20_issue_schedules mirror these.
 */

export const MAX_SCHEDULE_LABELS = 20;

const template = {
  /** `{date}` is replaced by the slot's local date (YYYY-MM-DD). */
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).nullable(),
  priority: z.enum(['low', 'medium', 'high']),
  labelIds: z.array(z.string().uuid()).max(MAX_SCHEDULE_LABELS),
  assigneeId: z.string().uuid().nullable(),
};

const rule = {
  cadence: z.enum(SCHEDULE_CADENCES),
  /** weekly: 0 (Sunday) - 6 (Saturday). */
  weekday: z.number().int().min(0).max(6).nullable(),
  /** monthly: 1 - 28 (every month has it). */
  dayOfMonth: z.number().int().min(1).max(28).nullable(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  /** IANA name, e.g. `Europe/Berlin` (checked against the runtime's zone data). */
  timezone: z.string().trim().min(1).max(64),
};

export const createScheduleBodySchema = z.object({
  title: template.title,
  description: template.description.optional(),
  priority: template.priority.optional(),
  labelIds: template.labelIds.optional(),
  assigneeId: template.assigneeId.optional(),
  cadence: rule.cadence,
  weekday: rule.weekday.optional(),
  dayOfMonth: rule.dayOfMonth.optional(),
  hour: rule.hour,
  minute: rule.minute,
  timezone: rule.timezone,
}).strict();

export const updateScheduleBodySchema = z.object({
  title: template.title.optional(),
  description: template.description.optional(),
  priority: template.priority.optional(),
  labelIds: template.labelIds.optional(),
  assigneeId: template.assigneeId.optional(),
  cadence: rule.cadence.optional(),
  weekday: rule.weekday.optional(),
  dayOfMonth: rule.dayOfMonth.optional(),
  hour: rule.hour.optional(),
  minute: rule.minute.optional(),
  timezone: rule.timezone.optional(),
}).strict().refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export type CreateScheduleBody = z.infer<typeof createScheduleBodySchema>;
export type UpdateScheduleBody = z.infer<typeof updateScheduleBodySchema>;
