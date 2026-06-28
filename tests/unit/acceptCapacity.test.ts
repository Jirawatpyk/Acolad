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
});
