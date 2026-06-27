import { describe, it, expect } from 'vitest';
import { parseHHMM, parseWorkdays, resolveThroughput } from '../../src/schedule/parseSchedule.js';

describe('parseHHMM', () => {
  it('parses to minutes', () => {
    expect(parseHHMM('09:00')).toBe(540);
    expect(parseHHMM('18:00')).toBe(1080);
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('23:59')).toBe(1439);
  });
  it.each(['9:00', '24:00', '09:60', 'aa:bb', '', '09'])('rejects %s', (s) => {
    expect(() => parseHHMM(s)).toThrow();
  });
});

describe('parseWorkdays', () => {
  it('parses ranges and lists', () => {
    expect([...parseWorkdays('1-5')]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseWorkdays('1,3,5')].sort()).toEqual([1, 3, 5]);
    expect([...parseWorkdays('6-7')]).toEqual([6, 7]);
  });
  it.each(['', '0-5', '1-8', '8', 'a', '5-1'])('rejects %s', (s) => {
    expect(() => parseWorkdays(s)).toThrow();
  });
});

describe('resolveThroughput', () => {
  it('derives capacity / working-hours-per-day when no explicit', () => {
    expect(
      resolveThroughput({ maxWordsPerDay: 1000, hoursStartMin: 540, hoursEndMin: 1080 }),
    ).toBeCloseTo(1000 / 9, 5);
  });
  it('explicit override wins', () => {
    expect(
      resolveThroughput({
        explicit: 100,
        maxWordsPerDay: 1000,
        hoursStartMin: 540,
        hoursEndMin: 1080,
      }),
    ).toBe(100);
  });
  it('rescales with a different capacity/window', () => {
    expect(resolveThroughput({ maxWordsPerDay: 900, hoursStartMin: 540, hoursEndMin: 1080 })).toBe(
      100,
    ); // 900 / 9
  });
  it('equal start/end (disabled-gate misconfig) → 0, never Infinity/NaN (A2)', () => {
    // hoursEnd === hoursStart is allowed when the gate is DISABLED (the start<end refine is
    // gated on ENABLED so the kill-switch works). The 0 divisor must NOT yield Infinity.
    const got = resolveThroughput({ maxWordsPerDay: 1000, hoursStartMin: 540, hoursEndMin: 540 });
    expect(got).toBe(0);
    expect(Number.isFinite(got)).toBe(true);
  });
  it('equal start/end with a zero cap → 0, never NaN (A2)', () => {
    const got = resolveThroughput({ maxWordsPerDay: 0, hoursStartMin: 540, hoursEndMin: 540 });
    expect(got).toBe(0);
    expect(Number.isNaN(got)).toBe(false);
  });
});
