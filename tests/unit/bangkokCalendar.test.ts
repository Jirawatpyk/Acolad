import { describe, it, expect } from 'vitest';
import {
  bangkokCalendar,
  bangkokDateString,
  bangkokYear,
  bangkokEpochMs,
} from '../../src/schedule/bangkokCalendar.js';

const at = (iso: string): number => Date.parse(iso); // TZ-explicit inputs only

describe('bangkokCalendar', () => {
  it('reads Bangkok local parts from a +07:00 instant', () => {
    const c = bangkokCalendar(at('2026-06-22T15:30:00+07:00')); // Monday
    expect(c).toEqual({ date: '2026-06-22', weekday: 1, minutesOfDay: 15 * 60 + 30 });
  });

  it('maps Sunday to ISO weekday 7', () => {
    expect(bangkokCalendar(at('2026-06-21T10:00:00+07:00')).weekday).toBe(7); // Sunday
  });

  it('crosses the Bangkok midnight boundary correctly (UTC input)', () => {
    // 2026-06-26T16:30:00Z == 23:30 on the 26th Bangkok
    expect(bangkokDateString(Date.parse('2026-06-26T16:30:00Z'))).toBe('2026-06-26');
    // 2026-06-26T17:30:00Z == 00:30 on the 27th Bangkok
    expect(bangkokDateString(Date.parse('2026-06-26T17:30:00Z'))).toBe('2026-06-27');
  });

  it('minutesOfDay at edges', () => {
    expect(bangkokCalendar(at('2026-06-22T00:00:00+07:00')).minutesOfDay).toBe(0);
    expect(bangkokCalendar(at('2026-06-22T23:59:00+07:00')).minutesOfDay).toBe(23 * 60 + 59);
  });

  it('bangkokYear handles year rollover at Bangkok midnight', () => {
    expect(bangkokYear(Date.parse('2026-12-31T17:30:00Z'))).toBe(2027); // 00:30 Bangkok 1 Jan
  });

  it('bangkokEpochMs round-trips with bangkokCalendar', () => {
    const ms = bangkokEpochMs('2026-06-22', 9 * 60);
    expect(ms).toBe(at('2026-06-22T09:00:00+07:00'));
    const c = bangkokCalendar(ms);
    expect([c.date, c.minutesOfDay]).toEqual(['2026-06-22', 540]);
  });
});
