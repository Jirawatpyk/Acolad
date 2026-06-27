import { bangkokCalendar, bangkokDateString, bangkokEpochMs } from './bangkokCalendar.js';

export interface WorkCalendar {
  /** ISO weekdays that are working days (1=Mon..7=Sun). Read-only — only `.has` is used. */
  workdays: ReadonlySet<number>;
  /** Daily window start, minutes since midnight (0–1439). */
  hoursStartMin: number;
  /** Daily window end, minutes since midnight (0–1439). */
  hoursEndMin: number;
  /** Bangkok `YYYY-MM-DD` → holiday name. Read-only — only `.has`/`.get`/iteration is used. */
  holidays: ReadonlyMap<string, string>;
}

export function isNonWorkingDay(
  dateStr: string,
  weekday: number,
  workdays: ReadonlySet<number>,
  holidays: ReadonlyMap<string, string>,
): boolean {
  return !workdays.has(weekday) || holidays.has(dateStr);
}

const DAY_MS = 86_400_000;
const MAX_DAYS = 400; // hard safety cap so a pathological deadline never unbounds the loop

/** Working minutes within `cal`'s configured daily window on working days, overlapping
 *  [startMs, endMs]. */
export function workingMinutesBetween(
  startMs: number,
  endMs: number,
  cal: WorkCalendar,
  capMinutes?: number,
): number {
  if (endMs <= startMs) return 0;
  let total = 0;
  // The end date is loop-invariant — compute it once (F12) instead of re-deriving it
  // every iteration of the day-by-day walk.
  const endDate = bangkokDateString(endMs);
  // Iterate Bangkok dates from the start date to the end date inclusive.
  let cursor = startMs;
  for (let days = 0; days <= MAX_DAYS; days++) {
    const { date, weekday } = bangkokCalendar(cursor);
    if (!isNonWorkingDay(date, weekday, cal.workdays, cal.holidays)) {
      const winStart = bangkokEpochMs(date, cal.hoursStartMin);
      const winEnd = bangkokEpochMs(date, cal.hoursEndMin);
      const overlap = Math.min(endMs, winEnd) - Math.max(startMs, winStart);
      if (overlap > 0) total += overlap / 60_000;
      if (capMinutes !== undefined && total >= capMinutes) return total;
    }
    // Advance to the next Bangkok date (use noon to dodge any boundary edge).
    const next = bangkokEpochMs(date, 0) + DAY_MS + DAY_MS / 2;
    if (bangkokDateString(next) > endDate) break;
    cursor = next;
  }
  return total;
}
