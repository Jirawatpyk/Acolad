import { describe, it, expect } from 'vitest';
import {
  getThaiHolidays,
  resolveHolidaysForSpan,
  holidaysForEffectiveDay,
} from '../../src/schedule/thaiHolidays.js';

describe('getThaiHolidays', () => {
  it('returns curated=true and seeded dates (incl. in-lieu) for 2026', () => {
    const r = getThaiHolidays(2026);
    expect(r.curated).toBe(true);
    expect(r.holidays.get('2026-01-01')).toBeTruthy(); // New Year นักขัตฤกษ์
    expect(r.holidays.get('2026-12-07')).toBeTruthy(); // King Bhumibol b'day in-lieu (ชดเชย)
  });
  it('returns curated=false for a far un-seeded year', () => {
    const r = getThaiHolidays(2099);
    expect(r.curated).toBe(false);
    expect(r.holidays.size).toBe(0);
  });
  it('returns curated=true for 2027 and includes a fixed + an in-lieu date', () => {
    const r = getThaiHolidays(2027);
    expect(r.curated).toBe(true);
    expect(r.holidays.get('2027-04-13')).toBeTruthy(); // Songkran (fixed นักขัตฤกษ์)
    expect(r.holidays.get('2027-12-06')).toBeTruthy(); // King Bhumibol b'day in-lieu (ชดเชย)
  });
});

describe('resolveHolidaysForSpan', () => {
  it('merges the deadline-year and reports curated only if all touched years are curated', () => {
    const now = Date.parse('2026-12-31T10:00:00+07:00');
    const due2026 = Date.parse('2026-12-31T18:00:00+07:00');
    expect(resolveHolidaysForSpan(now, due2026).curated).toBe(true);
    const due2099 = Date.parse('2099-01-05T18:00:00+07:00');
    expect(resolveHolidaysForSpan(now, due2099).curated).toBe(false);
  });
  it('a 2026-now → 2099-deadline span fail-closes (2099 uncurated)', () => {
    const now = Date.parse('2026-12-20T10:00:00+07:00');
    const due2099 = Date.parse('2099-01-10T18:00:00+07:00');
    expect(resolveHolidaysForSpan(now, due2099).curated).toBe(false);
  });
  it('includes INTERMEDIATE years in the span — merges a middle year holiday (F4)', () => {
    // now 2025 → due 2027 spans 2026 in the MIDDLE. The merged holiday set MUST
    // include 2026 นักขัตฤกษ์ (e.g. 2026-01-01); the old endpoints-only logic
    // ({2025, 2027}) skipped 2026 entirely, so a 2026 deadline-day holiday would
    // be treated as a working day (a fail-closed bypass).
    const now = Date.parse('2025-12-20T10:00:00+07:00');
    const due = Date.parse('2027-01-10T18:00:00+07:00');
    const r = resolveHolidaysForSpan(now, due);
    expect(r.holidays.get('2026-01-01')).toBeTruthy(); // intermediate year merged in
    expect(r.curated).toBe(false); // 2025 uncurated → still fail-closed
  });
  it('null deadline → only the now-year', () => {
    expect(resolveHolidaysForSpan(Date.parse('2026-06-22T10:00:00+07:00'), null).curated).toBe(
      true,
    );
  });
});

describe('holidaysForEffectiveDay', () => {
  it('merges the current Bangkok year and the next (the effective-day mapper span)', () => {
    // now in 2026 → the map must carry BOTH 2026 and 2027 holidays so a deadline early next
    // year (and its walk-back across New Year) resolves against curated data.
    const m = holidaysForEffectiveDay(Date.parse('2026-06-30T12:00:00+07:00'));
    expect(m.get('2026-01-01')).toBeTruthy(); // current year
    expect(m.get('2027-01-01')).toBeTruthy(); // next year
  });
});
