import { bangkokCalendar, bangkokYear } from './bangkokCalendar.js';
import { WORDS_UNIT, type EffortUnit } from './effort.js';
import { isNonWorkingDay, workingMinutesBetween, type WorkCalendar } from './workingHours.js';

export interface AcceptScheduleInput {
  enabled: boolean;
  nowMs: number;
  dueAtMs: number | null;
  effort: number | null;
  throughputPerHour: number;
  /** Working-day window + holidays. Embeds WorkCalendar directly (no flattened copy). */
  calendar: WorkCalendar;
  holidaysCuratedForSpan: boolean;
  /** Active metric unit — drives user-facing reason strings.
   *  Defaults to WORDS_UNIT (words mode) when omitted so all existing callers
   *  continue to emit the same byte-for-byte strings they do today. */
  unit?: Pick<EffortUnit, 'adj'>;
}

export type AcceptScheduleVerdict = { allow: true } | { allow: false; reason: string };

export function evaluateAcceptSchedule(i: AcceptScheduleInput): AcceptScheduleVerdict {
  if (!i.enabled) return { allow: true };

  const unit = i.unit ?? WORDS_UNIT;
  if (i.dueAtMs === null) return { allow: false, reason: 'deadline unknown' };
  if (i.effort === null) return { allow: false, reason: `${unit.adj} count unknown` };
  if (i.throughputPerHour <= 0)
    return {
      allow: false,
      reason: 'throughput not configured (throughputPerHour must be positive)',
    };
  if (!i.holidaysCuratedForSpan) {
    // Name the whole now→deadline span (F8) — naming only the deadline year is wrong
    // when the UNcurated year is the now-year (a past-deadline edge can put the deadline
    // in a curated year). Collapse to one year when the span stays within a single year.
    const yNow = bangkokYear(i.nowMs);
    const yDue = bangkokYear(i.dueAtMs);
    const y0 = Math.min(yNow, yDue);
    const y1 = Math.max(yNow, yDue);
    const range = y0 === y1 ? `${y0}` : `${y0}–${y1}`;
    return {
      allow: false,
      reason: `holiday calendar not confirmed for the job's date range (${range})`,
    };
  }

  const dl = bangkokCalendar(i.dueAtMs);
  if (isNonWorkingDay(dl.date, dl.weekday, i.calendar.workdays, i.calendar.holidays)) {
    const why = i.calendar.holidays.has(dl.date)
      ? `holiday: ${i.calendar.holidays.get(dl.date)}`
      : 'weekend';
    return { allow: false, reason: `deadline on a non-working day (${why})` };
  }

  if (i.dueAtMs <= i.nowMs) return { allow: false, reason: 'deadline already passed' };

  // Subtract a tiny epsilon before ceil (F10): a derived throughput (e.g. 100/9)
  // can make an EXACT integer-minute requirement land as N+ε (IEEE-754), which a
  // naive ceil would round up to N+1, falsely demanding one extra minute at the
  // boundary. The epsilon collapses N+ε back to N without affecting a genuine
  // fractional (N.5 stays N+1).
  const requiredMin = Math.ceil((i.effort / i.throughputPerHour) * 60 - 1e-9);
  const availMin = workingMinutesBetween(i.nowMs, i.dueAtMs, i.calendar, requiredMin);
  if (availMin >= requiredMin) return { allow: true };
  return {
    allow: false,
    reason: `cannot finish in time (need ~${Math.round((requiredMin / 60) * 10) / 10}h, have ~${Math.round((availMin / 60) * 10) / 10}h before deadline)`,
  };
}
