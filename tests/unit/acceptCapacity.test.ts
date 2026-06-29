import { describe, it, expect } from 'vitest';
import { decideGroupCapacity, type CapacityMember } from '../../src/schedule/acceptCapacity.js';

// T2: CapacityMember has no jobKey (decideGroupCapacity never reads it).
const m = (words: number, deadlineDate: string): CapacityMember => ({ words, deadlineDate });
const empty = () => 0;

describe('decideGroupCapacity', () => {
  it('accepts and returns per-day subtotals when every day fits', () => {
    const v = decideGroupCapacity([m(800, '2026-06-23'), m(800, '2026-06-24')], empty, 1000);
    expect(v.accept).toBe(true);
    if (v.accept) {
      expect(v.subtotalsByDay.get('2026-06-23')).toBe(800);
      expect(v.subtotalsByDay.get('2026-06-24')).toBe(800);
    }
  });

  it("blocks the whole group with kind 'budget_reached' when one day fills the budget", () => {
    const v = decideGroupCapacity([m(300, '2026-06-23')], (d) => (d === '2026-06-23' ? 800 : 0), 1000);
    // T1: the reject discriminant is explicit; capExhaustedDay is non-optional on this kind.
    expect(v).toEqual({
      accept: false,
      kind: 'budget_reached',
      reason: expect.stringContaining('daily word cap reached for 2026-06-23'),
      capExhaustedDay: '2026-06-23',
    });
  });

  it("blocks with kind 'over_cap_permanent' (no capExhaustedDay) when one day alone > cap", () => {
    const v = decideGroupCapacity([m(1500, '2026-06-23')], empty, 1000);
    expect(v.accept).toBe(false);
    if (!v.accept) {
      expect(v.kind).toBe('over_cap_permanent'); // the permanent discriminant, not the optional field
      expect(v.reason).toContain('exceed the daily cap');
    }
  });

  it('cap=0 means no limit', () => {
    expect(decideGroupCapacity([m(99999, '2026-06-23')], empty, 0).accept).toBe(true);
  });

  it('cross-day: one overflowing day blocks the group including the fitting day', () => {
    const v = decideGroupCapacity([m(100, '2026-06-23'), m(1100, '2026-06-24')], empty, 1000);
    expect(v.accept).toBe(false);
    if (!v.accept) expect(v.reason).toContain('2026-06-24');
  });

  it('accepts at the exact cap boundary (bucket + subtotal === cap, not > cap)', () => {
    // bucketFor=600, member words=400, cap=1000 → 600+400=1000 is NOT over cap → accept.
    const v = decideGroupCapacity([m(400, '2026-06-23')], () => 600, 1000);
    expect(v.accept).toBe(true);
  });

  it('F3: a later subtotal>cap (permanent) day wins over an earlier budget-filled (retryable) day', () => {
    // Earlier day 06-23: bucket 900 + subtotal 200 = 1100 > cap, but subtotal(200) ≤ cap →
    // the retryable "daily word cap reached" case. Later day 06-24: subtotal 1500 alone > cap →
    // the PERMANENT "exceed the daily cap — accept manually" case. The permanent case must win:
    // an early return on the retryable day would silently re-reject the over-cap job forever and
    // never tell ops to accept it manually.
    const v = decideGroupCapacity(
      [m(200, '2026-06-23'), m(1500, '2026-06-24')],
      (d) => (d === '2026-06-23' ? 900 : 0),
      1000,
    );
    expect(v.accept).toBe(false);
    if (!v.accept) {
      expect(v.kind).toBe('over_cap_permanent'); // NOT the retryable budget-reached verdict
      expect(v.reason).toContain('exceed the daily cap');
      expect(v.reason).toContain('accept manually');
      expect(v.reason).toContain('2026-06-24'); // names the over-cap (permanent) day
    }
  });

  it('F3: names the EARLIEST subtotal>cap day when multiple days are over-cap', () => {
    const v = decideGroupCapacity([m(1500, '2026-06-25'), m(1200, '2026-06-24')], empty, 1000);
    expect(v.accept).toBe(false);
    if (!v.accept) {
      expect(v.kind).toBe('over_cap_permanent');
      expect(v.reason).toContain('2026-06-24'); // earliest over-cap day, regardless of insertion order
    }
  });

  it('names the EARLIEST overflowing day when multiple days overflow (deadline order)', () => {
    // Members supplied in DESCENDING date order so insertion order ≠ deadline order.
    // Both days overflow (bucket 700 + subtotal 400 = 1100 > 1000); the blocked reason
    // must name the earliest day (2026-06-24), not whichever was inserted first.
    const v = decideGroupCapacity([m(400, '2026-06-25'), m(400, '2026-06-24')], () => 700, 1000);
    // T1: assert the discriminant + the exhausted day via toMatchObject (no narrowing dance).
    expect(v).toMatchObject({
      accept: false,
      kind: 'budget_reached',
      capExhaustedDay: '2026-06-24',
    });
    if (!v.accept) expect(v.reason).toContain('2026-06-24');
  });
});
