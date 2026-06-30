import { describe, it, expect } from 'vitest';
import {
  deadlineDayOf,
  deadlineMsOf,
  effectiveDeadlineDay,
  makeEffectiveDayOf,
} from '../../src/schedule/deadlineDay.js';
import { holidaysForEffectiveDay } from '../../src/schedule/thaiHolidays.js';

// All literals TZ-explicit (+07:00 / Z) so the Bangkok day is identical under TZ=UTC.
describe('deadlineDay helpers (F8 — canonical parse + null handling)', () => {
  describe('deadlineMsOf', () => {
    it('returns the epoch ms for a parseable deadline', () => {
      expect(deadlineMsOf('2026-06-24T18:00:00+07:00')).toBe(
        Date.parse('2026-06-24T18:00:00+07:00'),
      );
    });
    it('returns null for null / empty / unparseable input', () => {
      expect(deadlineMsOf(null)).toBeNull();
      expect(deadlineMsOf('')).toBeNull();
      expect(deadlineMsOf('not-a-date')).toBeNull();
    });
  });

  describe('deadlineDayOf', () => {
    it('returns the Bangkok YYYY-MM-DD for a parseable deadline', () => {
      // 18:00 Bangkok stays on the same date.
      expect(deadlineDayOf('2026-06-24T18:00:00+07:00')).toBe('2026-06-24');
    });
    it('rolls a late-UTC instant onto the correct Bangkok date (+07:00)', () => {
      // 24th 18:00 UTC == 25th 01:00 Bangkok.
      expect(deadlineDayOf('2026-06-24T18:00:00Z')).toBe('2026-06-25');
    });
    it('returns null for null / empty / unparseable input', () => {
      expect(deadlineDayOf(null)).toBeNull();
      expect(deadlineDayOf('')).toBeNull();
      expect(deadlineDayOf('garbage')).toBeNull();
    });
  });
});

// All literals TZ-explicit (+07:00) so the Bangkok day is identical under TZ=UTC. Anchor
// weekdays (verified against the rest of the suite): 2026-06-29 = Mon, -30 = Tue, 07-01 = Wed,
// 06-26 = Fri, 06-27 = Sat, 06-28 = Sun. 2026-06-01 is a real curated in-lieu holiday (Mon).
describe('effectiveDeadlineDay (the "cutoff" — the WORKING DAY the work lands on)', () => {
  const WORKDAYS = new Set([1, 2, 3, 4, 5]); // Mon–Fri
  const NO_HOLIDAYS = new Map<string, string>();
  const HOURS_START = 9 * 60; // 09:00
  const dayOf = (iso: string, holidays = NO_HOLIDAYS): string =>
    effectiveDeadlineDay(Date.parse(iso), HOURS_START, WORKDAYS, holidays);

  it('a before-09:00 deadline on a working day rolls back to the previous working day', () => {
    // Wed 06:33 < 09:00 → its work must finish the previous working day (Tue 30/06).
    expect(dayOf('2026-07-01T06:33:00+07:00')).toBe('2026-06-30');
  });

  it('a deadline exactly at 09:00 rolls back to the previous working day (0 working minutes at/before it)', () => {
    // A 09:00 deadline has ZERO working minutes available on its OWN day:
    // workingMinutesBetween(now, 09:00) overlaps [09:00,18:00] with [..,09:00] = 0. So the work
    // must finish the PREVIOUS working day — feasibility already allocates it there. The capacity
    // bucket key must agree (strictly-greater cutoff), else the prior day under-counts → over-accept.
    expect(dayOf('2026-07-01T09:00:00+07:00')).toBe('2026-06-30');
  });

  it('a deadline one minute past 09:00 (09:01) stays the same day (1 working minute exists)', () => {
    expect(dayOf('2026-07-01T09:01:00+07:00')).toBe('2026-07-01');
  });

  it('an after-hours same-day deadline (22:51 ≥ 09:00) stays the same day', () => {
    expect(dayOf('2026-06-30T22:51:00+07:00')).toBe('2026-06-30');
  });

  it('a Monday before-09:00 deadline rolls back across the weekend to the previous Friday', () => {
    // Mon 06:00 → walk back: Sun, Sat (both non-working) → Fri 26/06.
    expect(dayOf('2026-06-29T06:00:00+07:00')).toBe('2026-06-26');
  });

  it('a Tuesday afternoon deadline (14:00) stays the same day', () => {
    expect(dayOf('2026-06-30T14:00:00+07:00')).toBe('2026-06-30');
  });

  it('a deadline ON a non-working day rolls back to the previous working day (weekend)', () => {
    // Sat 12:00 is itself a non-working day → previous working day = Fri 26/06.
    expect(dayOf('2026-06-27T12:00:00+07:00')).toBe('2026-06-26');
  });

  it('rolls back across a curated holiday AND the weekend to the previous working day', () => {
    // Tue 06:00 < 09:00 → walk back: Mon 06-01 is a real in-lieu holiday, Sun, Sat → Fri 05-29.
    const holidays = new Map([['2026-06-01', 'Visakha Bucha Day (in lieu)']]);
    expect(dayOf('2026-06-02T06:00:00+07:00', holidays)).toBe('2026-05-29');
  });

  it('throws (fail-loud) when the work calendar has NO working day in 400 days back (corrupt calendar)', () => {
    // An all-non-working calendar (empty workdays) can never satisfy the walk-back. Returning the
    // deadline's own (wrong) day would silently mis-bucket capacity → over-accept on the
    // irreversible bulk path; so it must throw rather than guess.
    const noWorkdays = new Set<number>();
    expect(() =>
      effectiveDeadlineDay(
        Date.parse('2026-06-30T12:00:00+07:00'),
        9 * 60,
        noWorkdays,
        NO_HOLIDAYS,
      ),
    ).toThrow(/corrupt work calendar/);
  });

  it('back-walks into the PREVIOUS year using the real holidaysForEffectiveDay map (New-Year edge)', () => {
    // 2027-01-01 06:00 (Fri New Year's Day, before 09:00) → walk back. The previous calendar day
    // 2026-12-31 (Thu) is New Year's Eve — a curated holiday in the PRIOR year, so the walk must
    // skip it and land on 2026-12-30 (Wed). Built with the SAME holidaysForEffectiveDay map the
    // cycle uses, so this guards that the prior year is merged in (else 12-31 reads as a working
    // day → bucket under-counts → over-accept, the irreversible direction).
    const dueMs = Date.parse('2027-01-01T06:00:00+07:00');
    const holidays = holidaysForEffectiveDay(dueMs); // built from a year-2027 instant
    expect(effectiveDeadlineDay(dueMs, 9 * 60, new Set([1, 2, 3, 4, 5]), holidays)).toBe(
      '2026-12-30',
    );
  });
});

describe('makeEffectiveDayOf (reusable mapper bound to a work calendar)', () => {
  const WORKDAYS = new Set([1, 2, 3, 4, 5]);
  const NO_HOLIDAYS = new Map<string, string>();
  const map = makeEffectiveDayOf(9 * 60, WORKDAYS, NO_HOLIDAYS);

  it('maps a parseable before-09:00 deadline to the previous working day', () => {
    expect(map('2026-07-01T06:33:00+07:00')).toBe('2026-06-30');
  });

  it('maps a parseable after-09:00 deadline to its own day', () => {
    expect(map('2026-07-01T14:00:00+07:00')).toBe('2026-07-01');
  });

  it('maps null / empty / unparseable input to null (the skipped/missing case)', () => {
    expect(map(null)).toBeNull();
    expect(map('')).toBeNull();
    expect(map('garbage')).toBeNull();
  });
});
