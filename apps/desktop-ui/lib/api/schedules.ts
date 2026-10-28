import type { Task } from '@/types/task';
import { apiFetch } from './fetch';
import { idempotencyHeaders } from './idempotency';

/**
 * W20 / FE-14 recurring issues (apps/api `/api/projects/:id/schedules`,
 * `/api/schedules/:id`). A schedule creates one issue from its template at
 * each slot (cadence + local time in its IANA zone); it never runs them.
 */

export type ScheduleCadence = 'daily' | 'weekdays' | 'weekly' | 'monthly';
export type SchedulePriority = 'low' | 'medium' | 'high';

export interface Schedule {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: SchedulePriority;
  labelIds: string[];
  assigneeId: string | null;
  cadence: ScheduleCadence;
  /** weekly: 0 (Sunday) - 6 (Saturday). */
  weekday: number | null;
  /** monthly: 1 - 28. */
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  timezone: string;
  /** The server's wording, e.g. "Every weekday at 09:00 (Europe/Berlin)". */
  cadenceText: string;
  nextRunAt: string;
  lastRunAt: string | null;
  pausedAt: string | null;
  /** Set when the schedule paused itself (e.g. `owner_lost_access`); null when a person paused it. */
  pauseReason: string | null;
  ownerId: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleOccurrence {
  id: string;
  slotAt: string;
  kind: 'scheduled' | 'manual';
  outcome: 'created' | 'skipped';
  reason: string | null;
  /** Earlier missed slots this one stands in for (the service was down). */
  skippedSlots: number;
  createdAt: string;
  task: { id: string; identifier: string | null; title: string; status: Task['status']; archived: boolean } | null;
}

export interface ScheduleDetail extends Schedule {
  occurrences: ScheduleOccurrence[];
}

export interface ScheduleList {
  items: Schedule[];
  limits: { active: number; total: number };
}

/** What the form sends (create: all of it; update: the same shape, applied as a whole). */
export interface ScheduleInput {
  title: string;
  description: string | null;
  priority: SchedulePriority;
  labelIds: string[];
  assigneeId: string | null;
  cadence: ScheduleCadence;
  weekday?: number | null;
  dayOfMonth?: number | null;
  hour: number;
  minute: number;
  timezone: string;
}

/**
 * Query keys, under the project scope so project-wide invalidation reaches
 * them. (Kept here until they move into `lib/query/keys.ts`.)
 */
export const scheduleKeys = {
  list: (projectId: string) => ['ol', 'project', projectId, 'schedules', 'list'] as const,
  detail: (scheduleId: string) => ['ol', 'schedules', scheduleId] as const,
  /** The project's team members (assignee choices) and its team. */
  assignees: (projectId: string) => ['ol', 'project', projectId, 'schedules', 'assignees'] as const,
};

const path = (scheduleId: string, suffix = '') => `/api/schedules/${encodeURIComponent(scheduleId)}${suffix}`;

export function fetchProjectSchedules(projectId: string): Promise<ScheduleList> {
  return apiFetch<ScheduleList>(`/api/projects/${encodeURIComponent(projectId)}/schedules`);
}

export function fetchSchedule(scheduleId: string): Promise<ScheduleDetail> {
  return apiFetch<ScheduleDetail>(path(scheduleId));
}

/** Keyed: the same key and body return the same schedule (no duplicate on retry). */
export function createSchedule(projectId: string, body: ScheduleInput, idempotencyKey: string): Promise<Schedule> {
  return apiFetch<Schedule>(`/api/projects/${encodeURIComponent(projectId)}/schedules`, {
    method: 'POST',
    body: JSON.stringify(scheduleBody(body)),
    headers: idempotencyHeaders(idempotencyKey),
  });
}

/** The caller becomes the schedule's owner: future issues are created as them. */
export function updateSchedule(scheduleId: string, body: ScheduleInput): Promise<Schedule> {
  return apiFetch<Schedule>(path(scheduleId), { method: 'PATCH', body: JSON.stringify(scheduleBody(body)) });
}

export function pauseSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch<Schedule>(path(scheduleId, '/pause'), { method: 'POST' });
}

export function resumeSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch<Schedule>(path(scheduleId, '/resume'), { method: 'POST' });
}

/** One issue now; a second call in the same minute returns it (`created: false`). */
export function runScheduleNow(scheduleId: string): Promise<{ created: boolean; occurrence: ScheduleOccurrence; schedule: Schedule }> {
  return apiFetch<{ created: boolean; occurrence: ScheduleOccurrence; schedule: Schedule }>(path(scheduleId, '/run-now'), { method: 'POST' });
}

/** Issues the schedule already created are kept. */
export function deleteSchedule(scheduleId: string): Promise<void> {
  return apiFetch<void>(path(scheduleId), { method: 'DELETE' });
}

/** The rule fields the server accepts for a cadence (it refuses a weekday on a daily schedule). */
export function scheduleBody(input: ScheduleInput): ScheduleInput {
  const { weekday, dayOfMonth, ...rest } = input;
  return {
    ...rest,
    ...(input.cadence === 'weekly' ? { weekday: weekday ?? 1 } : {}),
    ...(input.cadence === 'monthly' ? { dayOfMonth: dayOfMonth ?? 1 } : {}),
  };
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function ordinal(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

/** The device's IANA zone (the form's default). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "Every Monday at 09:00", plus the zone when it is not the device's. */
export function describeCadence(schedule: Pick<Schedule, 'cadence' | 'weekday' | 'dayOfMonth' | 'hour' | 'minute' | 'timezone'>, deviceZone = localTimeZone()): string {
  const time = `${two(schedule.hour)}:${two(schedule.minute)}`;
  const when = schedule.cadence === 'daily'
    ? 'Every day'
    : schedule.cadence === 'weekdays'
      ? 'Every weekday'
      : schedule.cadence === 'weekly'
        ? `Every ${WEEKDAYS[schedule.weekday ?? 1] ?? 'week'}`
        : `Monthly on the ${ordinal(schedule.dayOfMonth ?? 1)}`;
  return schedule.timezone === deviceZone ? `${when} at ${time}` : `${when} at ${time} (${schedule.timezone})`;
}

/** "Tue, Oct 28, 09:00" in the device's zone (where the user reads it). */
export function formatLocalDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(date);
}

/** What the list says about when the schedule creates its next issue. */
export function nextRunText(schedule: Pick<Schedule, 'nextRunAt' | 'pausedAt'>, timeZone?: string): string {
  return schedule.pausedAt ? 'Paused' : `Next: ${formatLocalDateTime(schedule.nextRunAt, timeZone)}`;
}

/** Why a schedule paused itself, in words (null when a person paused it). */
export function pauseReasonText(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'owner_lost_access') return 'Paused automatically: its owner can no longer create issues in this project. Resuming makes you the owner.';
  if (reason === 'project_has_no_team') return 'Paused automatically: the project has no team to number its issues.';
  if (reason === 'creation_failed') return 'Paused automatically: creating its issue failed several times in a row. Check the template (labels, assignee) and resume.';
  return `Paused automatically (${reason}).`;
}

/** IANA zones for the picker: the runtime's list when it has one, else a short common set. */
export function timeZoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  const zones = typeof intl.supportedValuesOf === 'function'
    ? intl.supportedValuesOf('timeZone')
    : ['UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
  return [...new Set(['UTC', current, ...zones])];
}
