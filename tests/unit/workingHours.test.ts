import { describe, it, expect } from 'vitest';
import {
  workingMinutesBetween,
  isNonWorkingDay,
  type WorkCalendar,
} from '../../src/schedule/workingHours.js';

const at = (iso: string): number => Date.parse(iso);
const CAL: WorkCalendar = {
  workdays: new Set([1, 2, 3, 4, 5]),
  hoursStartMin: 540, // 09:00
  hoursEndMin: 1080, // 18:00
  holidays: new Map([['2026-06-24', 'Test Holiday']]), // a Wednesday
};

describe('isNonWorkingDay', () => {
  it('weekend and holiday true, weekday false', () => {
    expect(isNonWorkingDay('2026-06-20', 6, CAL.workdays, CAL.holidays)).toBe(true); // Sat
    expect(isNonWorkingDay('2026-06-21', 7, CAL.workdays, CAL.holidays)).toBe(true); // Sun
    expect(isNonWorkingDay('2026-06-24', 3, CAL.workdays, CAL.holidays)).toBe(true); // holiday
    expect(isNonWorkingDay('2026-06-22', 1, CAL.workdays, CAL.holidays)).toBe(false); // Mon
  });
});

describe('workingMinutesBetween', () => {
  it('same-day partial window', () => {
    expect(
      workingMinutesBetween(at('2026-06-22T15:00:00+07:00'), at('2026-06-22T18:00:00+07:00'), CAL),
    ).toBe(180);
  });
  it('clamps now before 09:00 and deadline after 18:00 to the window', () => {
    expect(
      workingMinutesBetween(at('2026-06-22T07:00:00+07:00'), at('2026-06-22T20:00:00+07:00'), CAL),
    ).toBe(540);
  });
  it('both ends interior', () => {
    expect(
      workingMinutesBetween(at('2026-06-22T10:30:00+07:00'), at('2026-06-22T16:30:00+07:00'), CAL),
    ).toBe(360);
  });
  it('overnight gap counts only working windows', () => {
    expect(
      workingMinutesBetween(at('2026-06-22T17:00:00+07:00'), at('2026-06-23T10:00:00+07:00'), CAL),
    ).toBe(120);
  });
  it('weekend gap (Fri 17:00 -> Mon 10:00) = 60 + 60', () => {
    expect(
      workingMinutesBetween(at('2026-06-19T17:00:00+07:00'), at('2026-06-22T10:00:00+07:00'), CAL),
    ).toBe(120);
  });
  it('a holiday mid-span is skipped', () => {
    // Tue 17:00 -> Thu 10:00 with Wed 24th a holiday = Tue 17-18 (60) + Thu 9-10 (60)
    expect(
      workingMinutesBetween(at('2026-06-23T17:00:00+07:00'), at('2026-06-25T10:00:00+07:00'), CAL),
    ).toBe(120);
  });
  it('end <= start returns 0', () => {
    expect(
      workingMinutesBetween(at('2026-06-22T15:00:00+07:00'), at('2026-06-22T15:00:00+07:00'), CAL),
    ).toBe(0);
  });
  it('deadline exactly 18:00 counts to the boundary; 09:00 gives that day 0', () => {
    expect(
      workingMinutesBetween(at('2026-06-22T17:30:00+07:00'), at('2026-06-22T18:00:00+07:00'), CAL),
    ).toBe(30);
    expect(
      workingMinutesBetween(at('2026-06-22T18:30:00+07:00'), at('2026-06-23T09:00:00+07:00'), CAL),
    ).toBe(0);
  });
  it('capMinutes early-exits at/over the cap', () => {
    const got = workingMinutesBetween(
      at('2026-06-22T09:00:00+07:00'),
      at('2026-07-31T18:00:00+07:00'),
      CAL,
      100,
    );
    expect(got).toBeGreaterThanOrEqual(100);
  });
  it('far infeasible deadline stays bounded by the 400-day cap', () => {
    // ~3 years out, no cap → bounded iteration, finite large total
    const got = workingMinutesBetween(
      at('2026-06-22T09:00:00+07:00'),
      at('2029-06-22T18:00:00+07:00'),
      CAL,
    );
    expect(Number.isFinite(got)).toBe(true);
    expect(got).toBeGreaterThan(0);
  });
});
