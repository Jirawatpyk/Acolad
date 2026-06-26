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
  if (!i.holidaysCuratedForSpan)
    return {
      allow: false,
      reason: `holiday calendar not confirmed for ${bangkokCalendar(i.dueAtMs).date.slice(0, 4)}`,
    };

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
  const requiredMin = Math.ceil((i.words / i.throughputWordsPerHour) * 60);
  const availMin = workingMinutesBetween(i.nowMs, i.dueAtMs, cal, requiredMin);
  if (availMin >= requiredMin) return { allow: true };
  return {
    allow: false,
    reason: `cannot finish in time (need ~${Math.round((requiredMin / 60) * 10) / 10}h, have ~${Math.round((availMin / 60) * 10) / 10}h before deadline)`,
  };
}
