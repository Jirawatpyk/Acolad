import { describe, it, expect } from 'vitest';
import { formatReadableDate } from '../../src/reporting/dateFormat.js';

describe('formatReadableDate (readable Bangkok-local dates)', () => {
  it('formats a UTC ISO timestamp to Bangkok DD/MM/YYYY HH:mm', () => {
    expect(formatReadableDate('2026-06-22T10:11:25.007Z')).toBe('22/06/2026 17:11');
  });

  it('formats a +07:00 ISO timestamp without shifting it twice', () => {
    expect(formatReadableDate('2026-06-22T21:38+07:00')).toBe('22/06/2026 21:38');
  });

  it('returns empty for null/empty and passes an unparseable value through unchanged', () => {
    expect(formatReadableDate(null)).toBe('');
    expect(formatReadableDate('')).toBe('');
    expect(formatReadableDate('not-a-date')).toBe('not-a-date');
  });

  it('shows a date-only value as a bare date (no spurious 07:00 from the +07 shift)', () => {
    expect(formatReadableDate('2026-06-20')).toBe('20/06/2026');
  });

  it('carries the date across the +07 shift on a late-UTC timestamp (day rollover)', () => {
    expect(formatReadableDate('2026-06-21T19:30:00.000Z')).toBe('22/06/2026 02:30');
  });
});
