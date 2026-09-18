import { describe, expect, it } from 'vitest';
import { WORDS_UNIT, WWC_UNIT } from '../../src/schedule/effort.js';
import {
  capacityThrough,
  dayCapacityFor,
  decideWindowCapacity,
  dueThrough,
} from '../../src/schedule/windowCapacity.js';
import type { WorkCalendar } from '../../src/schedule/workingHours.js';

/**
 * The shared scheduling standard (2026-09-18) — the capacity half.
 *
 * Both bots charge work to its effective deadline day, and a deadline has the working time
 * before it: for every deadline day d from the new work's earliest onward, everything due on
 * or before d must fit in what the working time left through d can hold. Every timestamp is
 * written with an explicit +07:00 so these tests mean the same in CI (UTC) as on the office
 * machine (Bangkok).
 */

const at = (iso: string): number => Date.parse(iso);

const CAL: WorkCalendar = {
  hoursStartMin: 9 * 60,
  hoursEndMin: 18 * 60,
  workdays: new Set([1, 2, 3, 4, 5]),
  holidays: new Map(),
};

// September 2026: Mon 14 · Tue 15 · Wed 16 · Thu 17 · Fri 18 · Sat 19 · Sun 20
const MON_0900 = at('2026-09-14T09:00:00+07:00');
const MON_1745 = at('2026-09-14T17:45:00+07:00');
const DAY = 3_500;

const decide = (
  nowMs: number,
  dueByDay: Record<string, number>,
  additions: { effort: number; deadlineDay: string }[],
) =>
  decideWindowCapacity({
    nowMs,
    dueByDay: new Map(Object.entries(dueByDay)),
    additions,
    dayCapacity: DAY,
    calendar: CAL,
  });

describe('dayCapacityFor — one working day holds the smaller of the ceiling and the rate', () => {
  it('is the ceiling when no rate is given', () => {
    expect(dayCapacityFor(DAY, undefined, CAL)).toBe(DAY);
  });

  it('is exactly the ceiling for the rate derived from it, not a hair under', () => {
    // 3,500 / 9 multiplies back to 3,500 within a few ulps. Treating that as "less" would
    // move every figure by a hair; the derived rate is what both bots run on live.
    expect(dayCapacityFor(DAY, DAY / 9, CAL)).toBe(DAY);
    expect(dayCapacityFor(30_000, 30_000 / 9, CAL)).toBe(30_000);
  });

  it('is what the rate gets through in a working day when that is less', () => {
    expect(dayCapacityFor(DAY, 200, CAL)).toBe(1_800);
  });

  it('leaves the ceiling in charge when the rate is higher', () => {
    expect(dayCapacityFor(DAY, 1_000, CAL)).toBe(DAY);
  });
});

describe('capacityThrough — the working time left, never less than one day', () => {
  it('gives a full window its full days at the start of one', () => {
    expect(capacityThrough(MON_0900, '2026-09-16', DAY, CAL)).toBe(10_500);
  });

  it('counts only the working time actually left in today', () => {
    // Monday 17:45 → Tuesday 18:00 is 15 + 540 minutes.
    expect(capacityThrough(MON_1745, '2026-09-15', DAY, CAL)).toBeCloseTo((DAY * 555) / 540, 6);
  });

  it('never goes below one working day', () => {
    // Monday 14:00 has four hours left of Monday; the floor keeps it at a day's ceiling.
    expect(capacityThrough(at('2026-09-14T14:00:00+07:00'), '2026-09-14', DAY, CAL)).toBe(DAY);
  });

  it('gives a weekend no working time of its own', () => {
    expect(capacityThrough(at('2026-09-19T03:00:00+07:00'), '2026-09-21', DAY, CAL)).toBe(DAY);
  });
});

describe('dueThrough — work due on or before a day', () => {
  it('counts overdue work as due today, since it is still owed and done first', () => {
    const due = new Map([
      ['2026-09-11', 3_000], // last Friday
      ['2026-09-14', 400],
      ['2026-09-16', 1_000],
    ]);

    expect(dueThrough(due, '2026-09-14', '2026-09-14')).toBe(3_400);
    expect(dueThrough(due, '2026-09-16', '2026-09-14')).toBe(4_400);
  });
});

describe('decideWindowCapacity', () => {
  it('accepts 4,000 words due Wednesday on the Monday before — the case that started this', () => {
    expect(decide(MON_0900, {}, [{ effort: 4_000, deadlineDay: '2026-09-16' }])).toMatchObject({
      accept: true,
    });
  });

  it('refuses the second of two 3,400-word jobs due tomorrow when seen at 17:45 (review C-1)', () => {
    const v = decide(MON_1745, { '2026-09-15': 3_400 }, [
      { effort: 3_400, deadlineDay: '2026-09-15' },
    ]);

    expect(v).toMatchObject({
      accept: false,
      kind: 'budget_reached',
      capExhaustedDay: '2026-09-15',
    });
  });

  it('refuses early work that would eat the time a later commitment counts on', () => {
    // 600 due Monday fits Monday alone, but it is done first and leaves Wednesday's 10,000 in
    // 9,900 of room. The breach is named on Wednesday, the day that would be missed.
    const v = decide(MON_0900, { '2026-09-16': 10_000 }, [
      { effort: 600, deadlineDay: '2026-09-14' },
    ]);

    expect(v).toMatchObject({
      accept: false,
      kind: 'budget_reached',
      capExhaustedDay: '2026-09-16',
    });
  });

  it('counts held work past its deadline against today', () => {
    const v = decide(MON_0900, { '2026-09-11': 3_000 }, [
      { effort: 600, deadlineDay: '2026-09-14' },
    ]);

    expect(v).toMatchObject({ accept: false, kind: 'budget_reached' });
  });

  it('calls work bigger than the whole window permanent, because waiting only shrinks it', () => {
    const v = decide(MON_0900, {}, [{ effort: 10_501, deadlineDay: '2026-09-16' }]);

    expect(v).toMatchObject({ accept: false, kind: 'over_cap_permanent' });
    if (!v.accept) expect(v.reason).toMatch(/accept manually/);
  });

  it('lets the permanent case win over a merely full day, so it is not re-offered forever', () => {
    // Monday is full (retryable); the Wednesday member is bigger than the whole window (not).
    // Reporting the retryable one would hide the job a human must accept by hand.
    const v = decide(MON_0900, { '2026-09-14': DAY }, [
      { effort: 100, deadlineDay: '2026-09-14' },
      { effort: 11_000, deadlineDay: '2026-09-16' },
    ]);

    expect(v).toMatchObject({ accept: false, kind: 'over_cap_permanent' });
  });

  it('weighs a whole group together — its members add up on the days they share', () => {
    // XTM claims a language group in one click. Two 2,000-word members due Monday are 4,000
    // due Monday, which one day cannot hold, though each alone would fit.
    const v = decide(MON_0900, {}, [
      { effort: 2_000, deadlineDay: '2026-09-14' },
      { effort: 2_000, deadlineDay: '2026-09-14' },
    ]);

    expect(v).toMatchObject({ accept: false, kind: 'over_cap_permanent' });
  });

  it('reports the group subtotal per deadline day on accept, for the caller to advance', () => {
    const v = decide(MON_0900, {}, [
      { effort: 1_000, deadlineDay: '2026-09-14' },
      { effort: 500, deadlineDay: '2026-09-16' },
      { effort: 250, deadlineDay: '2026-09-14' },
    ]);

    expect(v.accept).toBe(true);
    if (v.accept) {
      expect([...v.subtotalsByDay.entries()].sort()).toEqual([
        ['2026-09-14', 1_250],
        ['2026-09-16', 500],
      ]);
    }
  });

  it('accepts an empty group without judging anything', () => {
    expect(decide(MON_0900, { '2026-09-14': 99_999 }, [])).toMatchObject({ accept: true });
  });

  it('is exact at the boundary — a full window fits, one more does not', () => {
    expect(decide(MON_0900, {}, [{ effort: 10_500, deadlineDay: '2026-09-16' }]).accept).toBe(true);
    expect(
      decide(MON_0900, { '2026-09-16': 10_500 }, [{ effort: 1, deadlineDay: '2026-09-16' }]),
    ).toMatchObject({ accept: false, kind: 'budget_reached' });
  });

  it('weighs new work already past its deadline day as due today, never as nothing', () => {
    // Callers screen this out with feasibility first (no working time is left before such a
    // deadline), but the standard must not depend on that: a new bot calling it alone would
    // otherwise see its work vanish from every sum and accept any amount of it.
    const MON_0600 = at('2026-09-14T06:00:00+07:00');
    const late = [{ effort: 99_999, deadlineDay: '2026-09-11' }]; // last Friday

    expect(decide(MON_0600, {}, late)).toMatchObject({
      accept: false,
      kind: 'over_cap_permanent',
      day: '2026-09-14',
    });
    // …and still permanent, not merely "full", when later held work exists.
    expect(decide(MON_0600, { '2026-09-18': 100 }, late)).toMatchObject({
      kind: 'over_cap_permanent',
    });
  });

  it('gives the same reason a minute later, so a standing refusal is not re-announced', () => {
    // The working time left shrinks every working minute; a reason that quoted it would read as
    // a new refusal on every poll, and XTM reposts a rejection whose reason text changes.
    const later = MON_0900 + 60_000;
    const budget = (now: number) =>
      decide(now, { '2026-09-16': 8_000 }, [{ effort: 3_000, deadlineDay: '2026-09-16' }]);
    const permanent = (now: number) =>
      decide(now, {}, [{ effort: 12_000, deadlineDay: '2026-09-16' }]);

    for (const verdictAt of [budget, permanent]) {
      const [a, b] = [verdictAt(MON_0900), verdictAt(later)];
      expect(a.accept || b.accept).toBe(false);
      if (!a.accept && !b.accept) {
        expect(b.capacity).toBeLessThan(a.capacity); // the window did shrink…
        expect(b.reason).toBe(a.reason); // …and the reason did not move with it
      }
    }
  });

  it('names the unit it was given, so WWC reads as WWC', () => {
    const v = decideWindowCapacity({
      nowMs: MON_0900,
      dueByDay: new Map([['2026-09-14', DAY]]),
      additions: [{ effort: 1, deadlineDay: '2026-09-14' }],
      dayCapacity: DAY,
      calendar: CAL,
      unit: WWC_UNIT,
    });

    expect(v.accept).toBe(false);
    if (!v.accept) {
      expect(v.reason).toContain('WWC');
      expect(v.reason).not.toContain('words');
    }
    expect(WORDS_UNIT.noun).toBe('words'); // the default the other tests read
  });
});
