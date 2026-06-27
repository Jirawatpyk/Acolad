import { bangkokCalendar } from './bangkokCalendar.js';
import { isNonWorkingDay, workingMinutesBetween, type WorkCalendar } from './workingHours.js';

export interface AcceptScheduleInput {
  enabled: boolean;
  nowMs: number;
  dueAtMs: number | null;
  words: number | null;
  acceptedWordsToday: number;
  maxWordsPerDay: number;
  hoursStartMin: number;
  hoursEndMin: number;
  workdays: Set<number>;
  throughputWordsPerHour: number;
  holidays: Map<string, string>;
  holidaysCuratedForSpan: boolean;
}

export type AcceptScheduleVerdict = { allow: true } | { allow: false; reason: string };

export function evaluateAcceptSchedule(i: AcceptScheduleInput): AcceptScheduleVerdict {
  if (!i.enabled) return { allow: true };

  if (i.maxWordsPerDay > 0 && i.acceptedWordsToday >= i.maxWordsPerDay)
    return {
      allow: false,
      reason: `daily word cap reached (${i.acceptedWordsToday}/${i.maxWordsPerDay})`,
    };

  if (i.dueAtMs === null) return { allow: false, reason: 'deadline unknown' };
  if (i.words === null) return { allow: false, reason: 'word count unknown' };
  if (!i.holidaysCuratedForSpan) {
    // Name the whole now→deadline span (F8) — naming only the deadline year is wrong
    // when the UNcurated year is the now-year (a past-deadline edge can put the deadline
    // in a curated year). Collapse to one year when the span stays within a single year.
    const ya = bangkokCalendar(i.nowMs).date.slice(0, 4);
    const yb = bangkokCalendar(i.dueAtMs).date.slice(0, 4);
    // Sort so the range never renders backwards (e.g. a past-deadline edge where now > due).
    const [y0, y1] = ya <= yb ? [ya, yb] : [yb, ya];
    const range = y0 === y1 ? y0 : `${y0}–${y1}`;
    return {
      allow: false,
      reason: `holiday calendar not confirmed for the job's date range (${range})`,
    };
  }

  const dl = bangkokCalendar(i.dueAtMs);
  if (isNonWorkingDay(dl.date, dl.weekday, i.workdays, i.holidays)) {
    const why = i.holidays.has(dl.date) ? `holiday: ${i.holidays.get(dl.date)}` : 'weekend';
    return { allow: false, reason: `deadline on a non-working day (${why})` };
  }

  if (i.dueAtMs <= i.nowMs) return { allow: false, reason: 'deadline already passed' };

  const cal: WorkCalendar = {
    workdays: i.workdays,
    hoursStartMin: i.hoursStartMin,
    hoursEndMin: i.hoursEndMin,
    holidays: i.holidays,
  };
  // Subtract a tiny epsilon before ceil (F10): a derived throughput (e.g. 100/9)
  // can make an EXACT integer-minute requirement land as N+ε (IEEE-754), which a
  // naive ceil would round up to N+1, falsely demanding one extra minute at the
  // boundary. The epsilon collapses N+ε back to N without affecting a genuine
  // fractional (N.5 stays N+1).
  const requiredMin = Math.ceil((i.words / i.throughputWordsPerHour) * 60 - 1e-9);
  const availMin = workingMinutesBetween(i.nowMs, i.dueAtMs, cal, requiredMin);
  if (availMin >= requiredMin) return { allow: true };
  return {
    allow: false,
    reason: `cannot finish in time (need ~${Math.round((requiredMin / 60) * 10) / 10}h, have ~${Math.round((availMin / 60) * 10) / 10}h before deadline)`,
  };
}
