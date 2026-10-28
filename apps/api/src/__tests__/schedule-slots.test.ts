/**
 * W20 / FE-14 slot math (pure): cadences, local wall time in IANA zones
 * across daylight-saving gaps and overlaps (both hemispheres, a midnight
 * transition, a 30-minute shift), missed-slot catch-up, zone validation.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalTimeZone,
  describeScheduleRule,
  dueSlot,
  floorToMinute,
  nextSlotAfter,
  previousSlotAtOrBefore,
  renderScheduleTitle,
  zonedTimeToInstant,
  type ScheduleRule,
} from '../services/schedule-slots';

const at = (iso: string) => new Date(iso);
const iso = (date: Date) => date.toISOString();
const daily = (timezone: string, hour: number, minute = 0): ScheduleRule => ({ cadence: 'daily', hour, minute, timezone });

/** The next `count` slots after `from`. */
function slots(rule: ScheduleRule, from: string, count: number): string[] {
  const out: string[] = [];
  let cursor = at(from);
  for (let index = 0; index < count; index += 1) {
    cursor = nextSlotAfter(rule, cursor);
    out.push(iso(cursor));
  }
  return out;
}

describe('W20 schedule slots: time zones', () => {
  it('accepts IANA names (canonical spelling) and refuses offsets, unknown and malformed zones', () => {
    expect(canonicalTimeZone('europe/berlin')).toBe('Europe/Berlin');
    expect(canonicalTimeZone(' America/New_York ')).toBe('America/New_York');
    expect(canonicalTimeZone('UTC')).toBe('UTC');
    expect(canonicalTimeZone('Etc/GMT+5')).toBe('Etc/GMT+5');
    for (const bad of ['', 'Mars/Olympus', '+05:30', 'Europe/../etc', 'a'.repeat(65), 'Europe/Berlin; DROP']) {
      expect(canonicalTimeZone(bad), bad).toBeNull();
    }
  });

  it('keeps the local time across spring forward (New York, 2026-03-08)', () => {
    // 09:00 EST is 14:00Z, 09:00 EDT is 13:00Z.
    expect(slots(daily('America/New_York', 9), '2026-03-06T15:00:00Z', 3)).toEqual([
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
    ]);
  });

  it('fires a time skipped by the jump once, shifted by the gap (02:30 -> 03:30 EDT)', () => {
    expect(slots(daily('America/New_York', 2, 30), '2026-03-07T00:00:00Z', 3)).toEqual([
      '2026-03-07T07:30:00.000Z', // 02:30 EST
      '2026-03-08T07:30:00.000Z', // 02:30 does not exist: 03:30 EDT
      '2026-03-09T06:30:00.000Z', // 02:30 EDT
    ]);
  });

  it('fires a repeated time once, the first time (fall back: New York 01:30, Berlin 02:30)', () => {
    expect(slots(daily('America/New_York', 1, 30), '2026-10-31T00:00:00Z', 3)).toEqual([
      '2026-10-31T05:30:00.000Z', // 01:30 EDT
      '2026-11-01T05:30:00.000Z', // first 01:30 (EDT); the EST one an hour later is not a slot
      '2026-11-02T06:30:00.000Z', // 01:30 EST
    ]);
    expect(slots(daily('Europe/Berlin', 2, 30), '2026-10-24T00:00:00Z', 3)).toEqual([
      '2026-10-24T00:30:00.000Z', // 02:30 CEST
      '2026-10-25T00:30:00.000Z', // first 02:30 (CEST)
      '2026-10-26T01:30:00.000Z', // 02:30 CET
    ]);
    expect(iso(previousSlotAtOrBefore(daily('America/New_York', 1, 30), at('2026-11-01T06:45:00Z')))).toBe('2026-11-01T05:30:00.000Z');
  });

  it('handles the southern hemisphere, a transition at midnight and a 30-minute shift', () => {
    // Sydney springs forward on 2026-10-04 (AEST +10 -> AEDT +11).
    expect(slots(daily('Australia/Sydney', 9), '2026-10-02T12:00:00Z', 2)).toEqual(['2026-10-02T23:00:00.000Z', '2026-10-03T22:00:00.000Z']);
    // Santiago: 2026-09-06 00:00 -> 01:00, so 00:30 that day is 01:30 (-03).
    expect(slots(daily('America/Santiago', 0, 30), '2026-09-04T12:00:00Z', 3)).toEqual([
      '2026-09-05T04:30:00.000Z',
      '2026-09-06T04:30:00.000Z',
      '2026-09-07T03:30:00.000Z',
    ]);
    // Lord Howe moves by 30 minutes (02:00 -> 02:30 on 2026-10-04).
    expect(slots(daily('Australia/Lord_Howe', 2, 15), '2026-10-02T00:00:00Z', 3)).toEqual([
      '2026-10-02T15:45:00.000Z',
      '2026-10-03T15:45:00.000Z', // 02:15 does not exist: 02:45 (+11)
      '2026-10-04T15:15:00.000Z',
    ]);
    expect(iso(zonedTimeToInstant({ year: 2026, month: 3, day: 29 }, 2, 30, 'Europe/Berlin'))).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('W20 schedule slots: cadences', () => {
  it('weekdays skip the weekend; weekly lands on its weekday', () => {
    // 2026-10-30 is a Friday.
    expect(slots({ cadence: 'weekdays', hour: 9, minute: 0, timezone: 'UTC' }, '2026-10-30T10:00:00Z', 2)).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-03T09:00:00.000Z']);
    expect(slots({ cadence: 'weekly', weekday: 1, hour: 8, minute: 15, timezone: 'Europe/Berlin' }, '2026-10-26T07:15:00Z', 2)).toEqual([
      '2026-11-02T07:15:00.000Z', // the 26th's 08:15 CET is exactly `after`: not strictly later
      '2026-11-09T07:15:00.000Z',
    ]);
  });

  it('monthly uses its day in every month, February included', () => {
    expect(slots({ cadence: 'monthly', dayOfMonth: 28, hour: 23, minute: 59, timezone: 'Asia/Tokyo' }, '2027-01-28T15:00:00Z', 3)).toEqual([
      '2027-02-28T14:59:00.000Z',
      '2027-03-28T14:59:00.000Z',
      '2027-04-28T14:59:00.000Z',
    ]);
    expect(iso(previousSlotAtOrBefore({ cadence: 'monthly', dayOfMonth: 1, hour: 0, minute: 0, timezone: 'UTC' }, at('2026-03-15T00:00:00Z')))).toBe('2026-03-01T00:00:00.000Z');
  });

  it('describes rules and renders {date} in the schedule zone', () => {
    expect(describeScheduleRule({ cadence: 'weekdays', hour: 9, minute: 5, timezone: 'Europe/Berlin' })).toBe('Every weekday at 09:05 (Europe/Berlin)');
    expect(describeScheduleRule({ cadence: 'weekly', weekday: 0, hour: 18, minute: 0, timezone: 'UTC' })).toBe('Every Sunday at 18:00 (UTC)');
    expect(describeScheduleRule({ cadence: 'monthly', dayOfMonth: 22, hour: 7, minute: 30, timezone: 'UTC' })).toBe('Monthly on the 22nd at 07:30 (UTC)');
    expect(describeScheduleRule({ cadence: 'monthly', dayOfMonth: 11, hour: 7, minute: 30, timezone: 'UTC' })).toBe('Monthly on the 11th at 07:30 (UTC)');
    // 23:30Z on the 26th is already the 27th in Tokyo.
    expect(renderScheduleTitle('Standup {date} / {date}', at('2026-10-26T23:30:00Z'), 'Asia/Tokyo')).toBe('Standup 2026-10-27 / 2026-10-27');
    expect(renderScheduleTitle('No token', at('2026-10-26T23:30:00Z'), 'UTC')).toBe('No token');
    expect(iso(floorToMinute(at('2026-10-26T23:30:59.999Z')))).toBe('2026-10-26T23:30:00.000Z');
  });
});

describe('W20 schedule slots: due slots and catch-up', () => {
  const rule = daily('UTC', 9);

  it('is not due before its slot; on time it creates that slot and skips none', () => {
    expect(dueSlot(rule, at('2026-10-27T09:00:00Z'), at('2026-10-27T08:59:59Z'))).toBeNull();
    expect(dueSlot(rule, at('2026-10-27T09:00:00Z'), at('2026-10-27T09:00:20Z'))).toEqual({
      slotAt: at('2026-10-27T09:00:00Z'), skippedSlots: 0, nextRunAt: at('2026-10-28T09:00:00Z'),
    });
  });

  it('after downtime creates only the most recent missed slot and counts the others', () => {
    expect(dueSlot(rule, at('2026-10-20T09:00:00Z'), at('2026-10-24T10:00:00Z'))).toEqual({
      slotAt: at('2026-10-24T09:00:00Z'), skippedSlots: 4, nextRunAt: at('2026-10-25T09:00:00Z'),
    });
    // Down until just before today's slot: yesterday's is the one created.
    expect(dueSlot(rule, at('2026-10-20T09:00:00Z'), at('2026-10-24T08:00:00Z'))).toEqual({
      slotAt: at('2026-10-23T09:00:00Z'), skippedSlots: 3, nextRunAt: at('2026-10-24T09:00:00Z'),
    });
    // Weekdays: a weekend is not missed slots.
    expect(dueSlot({ ...rule, cadence: 'weekdays' }, at('2026-10-30T09:00:00Z'), at('2026-11-02T09:30:00Z'))).toEqual({
      slotAt: at('2026-11-02T09:00:00Z'), skippedSlots: 1, nextRunAt: at('2026-11-03T09:00:00Z'),
    });
  });

  it('treats an off-grid nextRunAt as the slot itself', () => {
    expect(dueSlot(rule, at('2026-10-27T09:30:00Z'), at('2026-10-27T09:45:00Z'))).toEqual({
      slotAt: at('2026-10-27T09:30:00Z'), skippedSlots: 0, nextRunAt: at('2026-10-28T09:00:00Z'),
    });
  });
});
