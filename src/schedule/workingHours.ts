import { bangkokCalendar, bangkokDateString, bangkokEpochMs } from './bangkokCalendar.js';

export interface WorkCalendar {
  workdays: Set<number>;
  hoursStartMin: number;
  hoursEndMin: number;
  holidays: Map<string, string>;
}

export function isNonWorkingDay(
  dateStr: string,
  weekday: number,
  workdays: Set<number>,
  holidays: Map<string, string>,
): boolean {
  return !workdays.has(weekday) || holidays.has(dateStr);
}

const DAY_MS = 86_400_000;
const MAX_DAYS = 400; // hard safety cap so a pathological deadline never unbounds the loop

/** Working minutes (09:00–18:00 on working days) overlapping [startMs, endMs]. */
export function workingMinutesBetween(
  startMs: number,
  endMs: number,
  cal: WorkCalendar,
  capMinutes?: number,
): number {
  if (endMs <= startMs) return 0;
  let total = 0;
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
    if (bangkokDateString(next) > bangkokDateString(endMs)) break;
    cursor = next;
  }
  return total;
}
