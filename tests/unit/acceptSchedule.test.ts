import { describe, it, expect } from 'vitest';
import {
  evaluateAcceptSchedule,
  type AcceptScheduleInput,
} from '../../src/schedule/acceptSchedule.js';

const at = (iso: string): number => Date.parse(iso);
const base = (over: Partial<AcceptScheduleInput> = {}): AcceptScheduleInput => ({
  enabled: true,
  nowMs: at('2026-06-22T15:00:00+07:00'), // Monday 15:00
  dueAtMs: at('2026-06-22T18:00:00+07:00'),
  words: 300,
  acceptedWordsToday: 0,
  maxWordsPerDay: 1000,
  hoursStartMin: 540,
  hoursEndMin: 1080,
  workdays: new Set([1, 2, 3, 4, 5]),
  throughputWordsPerHour: 100, // round so requiredMin = words * 0.6
  holidays: new Map(),
  holidaysCuratedForSpan: true,
  ...over,
});

describe('evaluateAcceptSchedule', () => {
  it('disabled → always allow', () => {
    expect(evaluateAcceptSchedule(base({ enabled: false, dueAtMs: null }))).toEqual({
      allow: true,
    });
  });
  it('capacity reached → block', () => {
    expect(evaluateAcceptSchedule(base({ acceptedWordsToday: 1000 }))).toEqual({
      allow: false,
      reason: 'daily word cap reached (1000/1000)',
    });
  });
  it('deadline unknown → block', () => {
    expect(evaluateAcceptSchedule(base({ dueAtMs: null })).allow).toBe(false);
  });
  it('word count unknown → block', () => {
    expect(evaluateAcceptSchedule(base({ words: null })).allow).toBe(false);
  });
  it('uncurated span year → block', () => {
    expect(evaluateAcceptSchedule(base({ holidaysCuratedForSpan: false })).allow).toBe(false);
  });
  it('uncurated reason names the whole span, not just the (curated) deadline year — F8', () => {
    // now in an UNCURATED year (2099); deadline in a CURATED year (2026, past relative
    // to now). The old reason named only the deadline year ("2026") — which IS curated —
    // confusingly suggesting the wrong year to fix. The reason must name the span so it
    // is always correct.
    const v = evaluateAcceptSchedule(
      base({
        nowMs: at('2099-06-22T10:00:00+07:00'),
        dueAtMs: at('2026-06-22T18:00:00+07:00'),
        holidaysCuratedForSpan: false,
      }),
    );
    expect(v.allow).toBe(false);
    if (!v.allow) {
      expect(v.reason).toContain('2099'); // the actually-uncurated (now) year
      expect(v.reason).toContain('2026');
      expect(v.reason).not.toBe('holiday calendar not confirmed for 2026'); // not the old single-year form
    }
  });
  it('uncurated reason collapses to a single year when now and deadline share a year — F8', () => {
    const v = evaluateAcceptSchedule(
      base({
        nowMs: at('2099-01-02T10:00:00+07:00'),
        dueAtMs: at('2099-06-22T18:00:00+07:00'),
        holidaysCuratedForSpan: false,
      }),
    );
    expect(v.allow).toBe(false);
    if (!v.allow) {
      expect(v.reason).toContain('2099');
      expect(v.reason).not.toContain('–'); // single year → no en-dash range
    }
  });
  it('feasibility ceil holds at an exact integer boundary under FP (derived throughput) — F10', () => {
    // throughput = 100/9 ≈ 11.111 (cap 100 over a 9h day); 65 words →
    // 65 / (100/9) * 60 = 351 EXACTLY, but IEEE-754 yields 351.00000000000006 → a
    // naive Math.ceil = 352 (one spurious minute), wrongly blocking a job with
    // exactly 351 working minutes available (09:00→14:51). The epsilon collapses it.
    const v = evaluateAcceptSchedule(
      base({
        nowMs: at('2026-06-22T09:00:00+07:00'),
        dueAtMs: at('2026-06-22T14:51:00+07:00'), // 351 working minutes (09:00→14:51)
        words: 65,
        throughputWordsPerHour: 100 / 9,
      }),
    );
    expect(v).toEqual({ allow: true });
  });
  it('deadline on a weekend → block', () => {
    expect(evaluateAcceptSchedule(base({ dueAtMs: at('2026-06-20T12:00:00+07:00') })).allow).toBe(
      false,
    ); // Sat
  });
  it('deadline on a holiday → block', () => {
    expect(
      evaluateAcceptSchedule(
        base({
          dueAtMs: at('2026-06-24T12:00:00+07:00'),
          holidays: new Map([['2026-06-24', 'Test Holiday']]),
        }),
      ).allow,
    ).toBe(false); // Wed holiday
  });
  it('feasibility boundary: avail==required → allow, required-1 → block', () => {
    // 300 words @ 100/h = 180 min required; 15:00→18:00 = 180 avail
    expect(evaluateAcceptSchedule(base({ words: 300 })).allow).toBe(true);
    // 301 words → ceil(180.6)=181 > 180 → block
    expect(evaluateAcceptSchedule(base({ words: 301 })).allow).toBe(false);
  });
  it('deadline already passed → block', () => {
    expect(evaluateAcceptSchedule(base({ dueAtMs: at('2026-06-22T14:00:00+07:00') })).allow).toBe(
      false,
    );
  });
  it('words=0 → allow (deliverable instantly)', () => {
    expect(evaluateAcceptSchedule(base({ words: 0 })).allow).toBe(true);
  });
  it('far-deadline weekend job is feasible → allow', () => {
    expect(
      evaluateAcceptSchedule(
        base({
          nowMs: at('2026-06-21T14:00:00+07:00'),
          dueAtMs: at('2026-06-26T18:00:00+07:00'),
          words: 600,
        }),
      ),
    ).toEqual({ allow: true });
  });
});
