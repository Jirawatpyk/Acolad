import { describe, it, expect } from 'vitest';
import {
  evaluateAcceptSchedule,
  type AcceptScheduleInput,
} from '../../src/schedule/acceptSchedule.js';
import { bangkokCalendar } from '../../src/schedule/bangkokCalendar.js';

const at = (iso: string): number => Date.parse(iso);
// Default 09:00–18:00 Mon–Fri calendar, no holidays. A test overriding a calendar field
// passes a partial `calendar` (merged onto this default) via base()'s calendar merge.
const DEFAULT_CAL: AcceptScheduleInput['calendar'] = {
  hoursStartMin: 540,
  hoursEndMin: 1080,
  workdays: new Set([1, 2, 3, 4, 5]),
  holidays: new Map(),
};
const base = (
  over: Partial<Omit<AcceptScheduleInput, 'calendar'>> & {
    calendar?: Partial<AcceptScheduleInput['calendar']>;
  } = {},
): AcceptScheduleInput => {
  const { calendar, ...rest } = over;
  return {
    enabled: true,
    nowMs: at('2026-06-22T15:00:00+07:00'), // Monday 15:00
    dueAtMs: at('2026-06-22T18:00:00+07:00'),
    effort: 300,
    throughputPerHour: 100, // round so requiredMin = effort * 0.6
    holidaysCuratedForSpan: true,
    ...rest,
    calendar: { ...DEFAULT_CAL, ...calendar },
  };
};

describe('evaluateAcceptSchedule', () => {
  it('disabled → always allow', () => {
    expect(evaluateAcceptSchedule(base({ enabled: false, dueAtMs: null }))).toEqual({
      allow: true,
    });
  });
  it('deadline unknown → block', () => {
    expect(evaluateAcceptSchedule(base({ dueAtMs: null })).allow).toBe(false);
  });
  it('word count unknown → block', () => {
    expect(evaluateAcceptSchedule(base({ effort: null })).allow).toBe(false);
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
        effort: 65,
        throughputPerHour: 100 / 9,
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
          calendar: { holidays: new Map([['2026-06-24', 'Test Holiday']]) },
        }),
      ).allow,
    ).toBe(false); // Wed holiday
  });
  it('feasibility boundary: avail==required → allow, required-1 → block', () => {
    // 300 words @ 100/h = 180 min required; 15:00→18:00 = 180 avail
    expect(evaluateAcceptSchedule(base({ effort: 300 })).allow).toBe(true);
    // 301 words → ceil(180.6)=181 > 180 → block
    expect(evaluateAcceptSchedule(base({ effort: 301 })).allow).toBe(false);
  });
  it('deadline already passed → block', () => {
    expect(evaluateAcceptSchedule(base({ dueAtMs: at('2026-06-22T14:00:00+07:00') })).allow).toBe(
      false,
    );
  });
  it('words=0 → allow (deliverable instantly)', () => {
    expect(evaluateAcceptSchedule(base({ effort: 0 })).allow).toBe(true);
  });
  it('throughputWordsPerHour=0 with words>0 → block with "throughput not configured" reason', () => {
    // Guard: a caller passing 0 throughput with words>0 would yield Infinity hours required,
    // which should block with a clear reason rather than a confusing NaN/Infinity in the output.
    const v = evaluateAcceptSchedule(base({ throughputPerHour: 0, effort: 300 }));
    expect(v.allow).toBe(false);
    if (!v.allow)
      expect(v.reason).toBe('throughput not configured (throughputWordsPerHour must be positive)');
  });
  it('far-deadline weekend job is feasible → allow', () => {
    expect(
      evaluateAcceptSchedule(
        base({
          nowMs: at('2026-06-21T14:00:00+07:00'),
          dueAtMs: at('2026-06-26T18:00:00+07:00'),
          effort: 600,
        }),
      ),
    ).toEqual({ allow: true });
  });

  it('now AFTER the daily window end (19:00) with a same-day deadline → 0 working minutes left → block (S4)', () => {
    // `now` 19:00 (past the 18:00 window end) on a Monday; deadline 23:00 the SAME Monday.
    // The deadline day is a working day (so it is NOT blocked as a non-working deadline) and
    // it has NOT passed — but there are 0 working minutes between 19:00 and 23:00 because the
    // window closed at 18:00. The gate must block on feasibility, reporting ~0h available.
    const v = evaluateAcceptSchedule(
      base({
        nowMs: at('2026-06-22T19:00:00+07:00'), // Monday, after the 18:00 close
        dueAtMs: at('2026-06-22T23:00:00+07:00'), // same Monday, still in the future
        effort: 300, // needs ~3h, but 0h remain today
      }),
    );
    expect(v.allow).toBe(false);
    if (!v.allow) {
      expect(v.reason).toContain('cannot finish in time');
      expect(v.reason).toContain('have ~0h'); // 0 working minutes remain after the window closed
    }
  });

  it('null-effort reason uses the active unit adjective (words byte-for-byte; wwc uses WWC)', () => {
    // words mode: reason must be byte-for-byte 'word count unknown' (no regression)
    const words = evaluateAcceptSchedule(base({ effort: null, unit: { adj: 'word' } }));
    expect(words).toEqual({ allow: false, reason: 'word count unknown' });
    // wwc mode: reason must say 'WWC count unknown'
    const wwc = evaluateAcceptSchedule(base({ effort: null, unit: { adj: 'WWC' } }));
    expect(wwc).toEqual({ allow: false, reason: 'WWC count unknown' });
    // default (no unit): must also give the old exact string for backward-compat
    const def = evaluateAcceptSchedule(base({ effort: null }));
    expect(def).toEqual({ allow: false, reason: 'word count unknown' });
  });

  it('S2 (PIN): a date-only dueDate "2026-07-15" is treated as 07:00 Bangkok — before the 09:00 work start', () => {
    // Date-only ISO strings parse as UTC midnight (ECMAScript), which in Bangkok (+07:00) is
    // 07:00 local — BEFORE the 09:00 working-window start. Pin the current parse semantics.
    const dueAtMs = at('2026-07-15'); // Date.parse('2026-07-15') → 2026-07-15T00:00:00Z
    expect(bangkokCalendar(dueAtMs).minutesOfDay).toBe(7 * 60); // 07:00 Bangkok, not 00:00

    // Consequence in the gate: a tiny job due "2026-07-15" (a working Wednesday) with `now` at
    // 06:00 the SAME day is REJECTED — there are 0 working minutes before the 07:00 cutoff,
    // even though the full 09:00–18:00 day afterward could finish it.
    // FLAG FOR TEAM: this can FALSE-REJECT a same-day-deadline job that is actually doable — a
    // date-only deadline arguably means end-of-day, not 07:00. Behavior pinned here, NOT changed.
    const v = evaluateAcceptSchedule(
      base({
        nowMs: at('2026-07-15T06:00:00+07:00'),
        dueAtMs,
        effort: 1,
      }),
    );
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toContain('cannot finish in time');
  });
});
