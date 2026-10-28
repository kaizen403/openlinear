/**
 * W20 / FE-14: when a recurring issue is due, computed in the schedule's own
 * IANA time zone with `Intl.DateTimeFormat` only (no date library).
 *
 * A slot is a wall-clock time on a matching local date: every day, Monday to
 * Friday, one weekday, or one day of the month (1-28, so every month has it).
 * Across daylight-saving changes the rules are those of Temporal's
 * `disambiguation: 'compatible'`, which is what "every day at 09:00" means
 * to people:
 *   - a time that does not exist that day (clocks jump 02:00 -> 03:00, a
 *     slot at 02:30) fires after the jump, shifted by its length (03:30);
 *   - a time that happens twice (clocks fall back, 01:30) fires once, the
 *     first time.
 *
 * Everything here is pure; `services/schedules.ts` stores the results.
 */

export const SCHEDULE_CADENCES = ['daily', 'weekdays', 'weekly', 'monthly'] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

export interface ScheduleRule {
  cadence: ScheduleCadence;
  /** weekly only: 0 (Sunday) - 6 (Saturday). */
  weekday?: number | null;
  /** monthly only: 1 - 28. */
  dayOfMonth?: number | null;
  hour: number;
  minute: number;
  /** IANA name, canonical (see `canonicalTimeZone`). */
  timezone: string;
}

export interface LocalDate {
  year: number;
  /** 1 - 12 */
  month: number;
  day: number;
}

interface WallTime extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Monthly slots (day <= 28) are at most 31 days apart; searches look a little further. */
const SEARCH_DAYS = 70;
/** Missed slots counted one by one at most (daily: 27 years); beyond, the count saturates. */
export const MAX_COUNTED_MISSED_SLOTS = 10_000;

const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * The canonical spelling of an IANA time zone (`europe/berlin` -> `Europe/Berlin`),
 * or null when the runtime does not know it. Offsets such as `+05:30` are refused:
 * a schedule follows a place, including its daylight-saving changes.
 */
export function canonicalTimeZone(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64 || !IANA_NAME.test(trimmed)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// Formatters are expensive to build; stored schedules use a bounded set of
// canonical zone names.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    if (formatters.size >= 1_000) formatters.clear();
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

function wallTime(instantMs: number, timeZone: string): WallTime {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    // Some ICU versions still print midnight as 24 with h23.
    hour: (values.hour ?? 0) % 24,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** Offset of the zone at an instant (local wall time minus UTC), in ms. */
function offsetMs(instantMs: number, timeZone: string): number {
  const wall = wallTime(instantMs, timeZone);
  const wholeSecond = instantMs - (((instantMs % 1000) + 1000) % 1000);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - wholeSecond;
}

/**
 * The instant a local wall time happens in `timeZone` (seconds = 0). Gap:
 * shifted forward by the gap; overlap: the earlier instant (see the header).
 */
export function zonedTimeToInstant(date: LocalDate, hour: number, minute: number, timeZone: string): Date {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // One transition at most within a day either side: the offsets in force
  // before and after it are the only candidates.
  const before = offsetMs(asUtc - DAY_MS, timeZone);
  const after = offsetMs(asUtc + DAY_MS, timeZone);
  const matches = [...new Set([before, after])]
    .map((offset) => asUtc - offset)
    .filter((candidate) => {
      const wall = wallTime(candidate, timeZone);
      return wall.year === date.year && wall.month === date.month && wall.day === date.day && wall.hour === hour && wall.minute === minute;
    })
    .sort((a, b) => a - b);
  return new Date(matches[0] ?? asUtc - before);
}

/** The local date of an instant in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const { year, month, day } = wallTime(instant.getTime(), timeZone);
  return { year, month, day };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/** 0 (Sunday) - 6 (Saturday). */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function matchesDate(rule: ScheduleRule, date: LocalDate): boolean {
  switch (rule.cadence) {
    case 'daily':
      return true;
    case 'weekdays': {
      const weekday = weekdayOf(date);
      return weekday >= 1 && weekday <= 5;
    }
    case 'weekly':
      return weekdayOf(date) === rule.weekday;
    case 'monthly':
      return date.day === rule.dayOfMonth;
  }
}

function slotOn(rule: ScheduleRule, date: LocalDate): Date {
  return zonedTimeToInstant(date, rule.hour, rule.minute, rule.timezone);
}

/** The first slot strictly after `after`. */
export function nextSlotAfter(rule: ScheduleRule, after: Date): Date {
  // Start a day early: a gap-shifted slot of the previous local date can land after midnight.
  let date = addDays(localDateOf(after, rule.timezone), -1);
  for (let index = 0; index < SEARCH_DAYS; index += 1) {
    if (matchesDate(rule, date)) {
      const slot = slotOn(rule, date);
      if (slot.getTime() > after.getTime()) return slot;
    }
    date = addDays(date, 1);
  }
  throw new Error(`No ${rule.cadence} slot within ${SEARCH_DAYS} days`);
}

/** The last slot at or before `at`. */
export function previousSlotAtOrBefore(rule: ScheduleRule, at: Date): Date {
  let date = addDays(localDateOf(at, rule.timezone), 1);
  for (let index = 0; index < SEARCH_DAYS; index += 1) {
    if (matchesDate(rule, date)) {
      const slot = slotOn(rule, date);
      if (slot.getTime() <= at.getTime()) return slot;
    }
    date = addDays(date, -1);
  }
  throw new Error(`No ${rule.cadence} slot within ${SEARCH_DAYS} days`);
}

export interface DueSlot {
  /** The one slot to create an issue for now: the most recent one that is due. */
  slotAt: Date;
  /** Due slots before it that get no issue (the service was down or behind). */
  skippedSlots: number;
  /** The slot after `now`. */
  nextRunAt: Date;
}

/**
 * What a due schedule does now. `nextRunAt` is the first slot that has not
 * been handled yet; when several slots passed since (downtime), only the most
 * recent gets an issue and the others are counted, never created: a schedule
 * never floods a project after an outage. Null when nothing is due.
 */
export function dueSlot(rule: ScheduleRule, nextRunAt: Date, now: Date): DueSlot | null {
  if (nextRunAt.getTime() > now.getTime()) return null;
  let slotAt = previousSlotAtOrBefore(rule, now);
  let skippedSlots = 0;
  if (slotAt.getTime() < nextRunAt.getTime()) {
    // `nextRunAt` is not on the rule's grid (should not happen): it is the slot.
    slotAt = nextRunAt;
  } else {
    let cursor = nextRunAt;
    while (cursor.getTime() < slotAt.getTime() && skippedSlots < MAX_COUNTED_MISSED_SLOTS) {
      skippedSlots += 1;
      cursor = nextSlotAfter(rule, cursor);
    }
  }
  return { slotAt: floorToMinute(slotAt), skippedSlots, nextRunAt: nextSlotAfter(rule, now) };
}

/** Slots are whole minutes (the occurrence key and the "run now" grain). */
export function floorToMinute(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** `YYYY-MM-DD` of an instant in the schedule's zone (the `{date}` title token). */
export function isoLocalDate(instant: Date, timeZone: string): string {
  const { year, month, day } = localDateOf(instant, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The issue title for a slot: `{date}` becomes the slot's local date. */
export function renderScheduleTitle(template: string, slotAt: Date, timeZone: string): string {
  return template.includes('{date}') ? template.split('{date}').join(isoLocalDate(slotAt, timeZone)) : template;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function ordinal(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

/** "Every weekday at 09:00 (Europe/Berlin)". */
export function describeScheduleRule(rule: ScheduleRule): string {
  const time = `${String(rule.hour).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`;
  const when = rule.cadence === 'daily'
    ? 'Every day'
    : rule.cadence === 'weekdays'
      ? 'Every weekday'
      : rule.cadence === 'weekly'
        ? `Every ${WEEKDAY_NAMES[rule.weekday ?? 0] ?? 'week'}`
        : `Monthly on the ${ordinal(rule.dayOfMonth ?? 1)}`;
  return `${when} at ${time} (${rule.timezone})`;
}
