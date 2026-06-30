/**
 * Canonical "deadline day of a job" helpers (F8). The triple
 * `Date.parse(dueDate)` + `Number.isFinite` + `bangkokDateString` was duplicated in
 * three places (the capacity gate, the per-deadline-day store bucket, and the daily
 * report). Centralising it here guarantees they all parse + null-handle identically,
 * so the gate's count, the bucket, and the report can never diverge.
 */
import { bangkokCalendar, bangkokDateString, bangkokEpochMs } from './bangkokCalendar.js';
import { isNonWorkingDay } from './workingHours.js';

const DAY_MS = 86_400_000;
const MAX_DAYS = 400; // hard safety cap (mirrors workingMinutesBetween) so the walk never unbounds

/**
 * The deadline as epoch milliseconds, or `null` when the `dueDate` string is
 * null / empty / unparseable. Single source of truth for "when is this job due".
 */
export function deadlineMsOf(dueDate: string | null): number | null {
  const t = dueDate ? Date.parse(dueDate) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * The Bangkok deadline DAY (`YYYY-MM-DD`) of a job, or `null` for a
 * null / empty / unparseable deadline.
 */
export function deadlineDayOf(dueDate: string | null): string | null {
  const ms = deadlineMsOf(dueDate);
  return ms === null ? null : bangkokDateString(ms);
}

/**
 * The "effective deadline day" — the Bangkok WORKING DAY the job's work actually lands on,
 * which the capacity cap buckets by (NOT the raw deadline calendar date).
 *
 * A deadline whose Bangkok time is BEFORE the work-day start (09:00) cannot be worked that
 * calendar day, so the team must finish it the PREVIOUS working day. Feasibility is already
 * work-day-aware (`workingMinutesBetween` counts 0 minutes before 09:00); this aligns the
 * capacity bucket key with that.
 *
 * Rule (reuses `bangkokCalendar` + `isNonWorkingDay`):
 *  - The deadline's own day, when it is a working day AND the deadline is at/after the work-day
 *    start — covers an after-hours same-day deadline like 22:51 (still that day's work).
 *  - Otherwise (before the work-day start, OR the deadline falls on a non-working day) → the
 *    previous working day (its 18:00 is the last working minute at/before the deadline).
 *
 * Only ever called with a parseable deadline (callers null-handle first via `deadlineMsOf`).
 */
export function effectiveDeadlineDay(
  dueMs: number,
  hoursStartMin: number,
  workdays: ReadonlySet<number>,
  holidays: ReadonlyMap<string, string>,
): string {
  const cal = bangkokCalendar(dueMs);
  if (
    !isNonWorkingDay(cal.date, cal.weekday, workdays, holidays) &&
    cal.minutesOfDay >= hoursStartMin
  ) {
    return cal.date;
  }
  // Walk back from just before midnight of the deadline's date to the previous working day.
  let cursor = bangkokEpochMs(cal.date, 0) - 1; // 23:59:59.999 of the prior Bangkok calendar day
  for (let i = 0; i < MAX_DAYS; i++) {
    const c = bangkokCalendar(cursor);
    if (!isNonWorkingDay(c.date, c.weekday, workdays, holidays)) return c.date;
    cursor -= DAY_MS;
  }
  return cal.date; // unbounded fallback — unreachable for any sane work calendar
}

/**
 * Build a reusable effective-deadline-day mapper bound to a work calendar: maps a raw `dueDate`
 * string → the Bangkok working day its work lands on, or `null` for a null/empty/unparseable
 * deadline (the skipped/missing case). Shared by the capacity seed + per-member bucket key (the
 * cycle) and the daily report's "Due today" so all three bucket identically.
 */
export function makeEffectiveDayOf(
  hoursStartMin: number,
  workdays: ReadonlySet<number>,
  holidays: ReadonlyMap<string, string>,
): (dueDate: string | null) => string | null {
  return (dueDate) => {
    const ms = deadlineMsOf(dueDate);
    return ms === null ? null : effectiveDeadlineDay(ms, hoursStartMin, workdays, holidays);
  };
}
