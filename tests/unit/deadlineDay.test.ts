import { describe, it, expect } from 'vitest';
import { deadlineDayOf, deadlineMsOf } from '../../src/schedule/deadlineDay.js';

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
