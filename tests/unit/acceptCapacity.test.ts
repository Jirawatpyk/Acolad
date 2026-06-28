import { describe, it, expect } from 'vitest';
import { decideGroupCapacity, type CapacityMember } from '../../src/schedule/acceptCapacity.js';

const m = (jobKey: string, words: number, deadlineDate: string): CapacityMember => ({
  jobKey,
  words,
  deadlineDate,
});
const empty = () => 0;

describe('decideGroupCapacity', () => {
  it('accepts and returns per-day subtotals when every day fits', () => {
    const v = decideGroupCapacity(
      [m('a', 800, '2026-06-23'), m('b', 800, '2026-06-24')],
      empty,
      1000,
    );
    expect(v.accept).toBe(true);
    if (v.accept) {
      expect(v.subtotalsByDay.get('2026-06-23')).toBe(800);
      expect(v.subtotalsByDay.get('2026-06-24')).toBe(800);
    }
  });

  it('blocks the whole group when one day fills the budget (capExhaustedDay set)', () => {
    const v = decideGroupCapacity(
      [m('a', 300, '2026-06-23')],
      (d) => (d === '2026-06-23' ? 800 : 0),
      1000,
    );
    expect(v).toEqual({
      accept: false,
      reason: expect.stringContaining('daily word cap reached for 2026-06-23'),
      capExhaustedDay: '2026-06-23',
    });
  });

  it('blocks with "exceed the daily cap" (no capExhaustedDay) when one day alone > cap', () => {
    const v = decideGroupCapacity([m('a', 1500, '2026-06-23')], empty, 1000);
    expect(v.accept).toBe(false);
    if (!v.accept) {
      expect(v.reason).toContain('exceed the daily cap');
      expect(v.capExhaustedDay).toBeUndefined();
    }
  });

  it('cap=0 means no limit', () => {
    expect(decideGroupCapacity([m('a', 99999, '2026-06-23')], empty, 0).accept).toBe(true);
  });

  it('cross-day: one overflowing day blocks the group including the fitting day', () => {
    const v = decideGroupCapacity(
      [m('a', 100, '2026-06-23'), m('b', 1100, '2026-06-24')],
      empty,
      1000,
    );
    expect(v.accept).toBe(false);
    if (!v.accept) expect(v.reason).toContain('2026-06-24');
  });

  it('accepts at the exact cap boundary (bucket + subtotal === cap, not > cap)', () => {
    // bucketFor=600, member words=400, cap=1000 → 600+400=1000 is NOT over cap → accept.
    const v = decideGroupCapacity([m('a', 400, '2026-06-23')], () => 600, 1000);
    expect(v.accept).toBe(true);
  });

  it('names the EARLIEST overflowing day when multiple days overflow (deadline order)', () => {
    // Members supplied in DESCENDING date order so insertion order ≠ deadline order.
    // Both days overflow (bucket 700 + subtotal 400 = 1100 > 1000); the blocked reason
    // must name the earliest day (2026-06-24), not whichever was inserted first.
    const v = decideGroupCapacity(
      [m('a', 400, '2026-06-25'), m('b', 400, '2026-06-24')],
      () => 700,
      1000,
    );
    expect(v.accept).toBe(false);
    if (!v.accept) {
      expect(v.capExhaustedDay).toBe('2026-06-24');
      expect(v.reason).toContain('2026-06-24');
    }
  });
});
