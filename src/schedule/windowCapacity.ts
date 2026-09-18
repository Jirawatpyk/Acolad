/**
 * Capacity across the working time before a deadline — the shared scheduling standard
 * (owner decision, 2026-09-18). Used by every bot that claims work; a new bot calls this
 * rather than growing a rule of its own.
 *
 * ## The rule
 *
 * Work is keyed to its **effective deadline day** (`deadlineDay.effectiveDeadlineDay`), and a
 * deadline has the working time before it. New work fits when, for every deadline day d from
 * the new work's earliest onward:
 *
 *     work due on or before d  ≤  what the working time left through d can hold
 *
 * — earliest-deadline-first, which is how a team works a queue. "What the working time left
 * can hold" is {@link capacityThrough}: one working day's capacity pro-rated over the working
 * minutes actually left until d ends, never less than one day.
 *
 * ## What it replaced, and why
 *
 * Both bots used to charge each deadline day alone against a per-day cap
 * (`acceptCapacity.decideGroupCapacity`). That refused a 4,000-word job due Wednesday on the
 * Monday before at 3,500 a day — permanently — though the three days before it hold 10,500.
 * A first cut of this rule counted whole *days*, and review found it admitted two 3,400-word
 * jobs due tomorrow at 17:45 into about 3,600 words of real time; hence working time left,
 * not days touched.
 *
 * Three consequences worth knowing before reading a verdict:
 * - Work due EARLY can be refused on account of a commitment due LATER: it would be worked
 *   first and eat the time the later one counts on. The breach is named on the later day.
 * - Held work already past its deadline counts as due today — still owed, done first.
 * - `over_cap_permanent` means bigger than the whole window, not bigger than one day. Waiting
 *   only shrinks the window, so only a human can take it on.
 *
 * Pure: no clock, no I/O. Callers pass the moment, the calendar and what they already hold.
 */

import { bangkokDateString, bangkokEpochMs } from './bangkokCalendar.js';
import { WORDS_UNIT, type EffortUnit } from './effort.js';
import { workingMinutesBetween, type WorkCalendar } from './workingHours.js';

/**
 * What one working day holds: the owner's ceiling, or what the throughput gets through in a
 * working day if that is less.
 *
 * The feasibility gate measures each offer at the throughput; measuring the day at the SAME
 * rate is what stops the two disagreeing. Only a lower rate changes anything, and only by more
 * than rounding: a rate derived as ceiling ÷ working hours multiplies back to the ceiling
 * within a few ulps, and that is treated as equal. A higher rate leaves the ceiling in charge —
 * the ceiling is how much the owner will take on, not how fast the team is.
 */
export function dayCapacityFor(
  ceiling: number,
  ratePerHour: number | undefined,
  cal: Pick<WorkCalendar, 'hoursStartMin' | 'hoursEndMin'>,
): number {
  if (ratePerHour === undefined) return ceiling;
  const throughDay = (ratePerHour * (cal.hoursEndMin - cal.hoursStartMin)) / 60;
  return throughDay < ceiling * (1 - 1e-9) ? throughDay : ceiling;
}

/**
 * What can still be done from `nowMs` until `day`'s working hours end, at `dayCapacity` per
 * working day.
 *
 * Pro-rated over the working minutes actually left, so a day already over contributes nothing.
 * **Floored at one working day**: held work may be partly done and nothing here can know how
 * far, so pro-rating a short window on top of counting that work in full would refuse work that
 * fits. With the floor, a deadline is never given less than the per-day rule gave it; the
 * pro-rating only trims the extra days a longer window adds.
 */
export function capacityThrough(
  nowMs: number,
  day: string,
  dayCapacity: number,
  cal: WorkCalendar,
): number {
  const perDay = cal.hoursEndMin - cal.hoursStartMin;
  const left = workingMinutesBetween(nowMs, bangkokEpochMs(day, cal.hoursEndMin), cal);
  return Math.max(dayCapacity, (dayCapacity * left) / perDay);
}

/** Work due on or before `day`. Anything keyed to a day before `today` is overdue and counts
 *  as due today: it is still owed, and it is what the team does first. */
export function dueThrough(
  dueByDay: ReadonlyMap<string, number>,
  day: string,
  today: string,
): number {
  let sum = 0;
  for (const [d, effort] of dueByDay) {
    if ((d < today ? today : d) <= day) sum += effort;
  }
  return sum;
}

/** New work being weighed, on the effective deadline day it lands on. A group (XTM claims a
 *  whole language group in one click) is several of these, possibly on different days. */
export interface WindowAddition {
  readonly effort: number;
  readonly deadlineDay: string;
}

export interface WindowCapacityInput {
  readonly nowMs: number;
  /** Effort already committed per effective deadline day — held work, plus anything this pass
   *  has already decided to take. Must be non-negative. */
  readonly dueByDay: ReadonlyMap<string, number>;
  readonly additions: readonly WindowAddition[];
  /** One working day's capacity — see {@link dayCapacityFor}. */
  readonly dayCapacity: number;
  /** The working calendar, holidays included, that the effective days were computed with. */
  readonly calendar: WorkCalendar;
  /** Unit named in the reason text. Defaults to words. */
  readonly unit?: EffortUnit;
}

/** A refusal names the day it is about and the two figures that did not fit, so a caller can
 *  report the breach without re-deriving it. */
export type WindowVerdict =
  | { readonly accept: true; readonly subtotalsByDay: ReadonlyMap<string, number> }
  | {
      readonly accept: false;
      /** Bigger than the whole window with nothing else held: only a human can take it on. */
      readonly kind: 'over_cap_permanent';
      readonly reason: string;
      readonly day: string;
      readonly demand: number;
      readonly capacity: number;
    }
  | {
      readonly accept: false;
      /** Would fit on its own; what is already held leaves no room. Clears as work finishes. */
      readonly kind: 'budget_reached';
      readonly reason: string;
      readonly capExhaustedDay: string;
      readonly demand: number;
      readonly capacity: number;
    };

/**
 * Decide new work — one offer or a whole group — all-or-nothing against the window.
 *
 * The permanent case is checked first and wins, so a member no amount of waiting can fit is
 * never masked by an earlier day that is merely full and would otherwise be re-offered forever.
 */
export function decideWindowCapacity(i: WindowCapacityInput): WindowVerdict {
  const unit = i.unit ?? WORDS_UNIT;
  const subtotalsByDay = new Map<string, number>();
  for (const a of i.additions) {
    subtotalsByDay.set(a.deadlineDay, (subtotalsByDay.get(a.deadlineDay) ?? 0) + a.effort);
  }
  if (subtotalsByDay.size === 0) return { accept: true, subtotalsByDay };

  const today = bangkokDateString(i.nowMs);
  // Judge days never earlier than today: `dueThrough` already counts work past its deadline as
  // due today, so a past-day addition must be checked AT today, or it drops out of every sum.
  const addedDays = [
    ...new Set([...subtotalsByDay.keys()].map((d) => (d < today ? today : d))),
  ].sort();
  const fromDay = addedDays[0] as string;
  const capacity = (day: string): number =>
    capacityThrough(i.nowMs, day, i.dayCapacity, i.calendar);
  // Reasons carry no figure that moves with the clock. XTM re-announces a still-rejected job
  // whenever its reason text changes (#15), so the working-time capacity — which shrinks every
  // working minute — would repost the same refusal to Chat on every poll. The figures are on
  // the verdict (`demand`, `capacity`) for the caller to log instead; XTM does.
  // A reason can still change now and then — the breach moves to an earlier day as the window
  // shrinks, turns permanent, or overdue work rolls into a new today at midnight. Each is a
  // real change in why, so one re-announcement per change is intended, not a leak.
  const perDay = Math.floor(i.dayCapacity);

  for (const day of addedDays) {
    const demand = dueThrough(subtotalsByDay, day, today);
    const cap = capacity(day);
    if (demand > cap) {
      return {
        accept: false,
        kind: 'over_cap_permanent',
        reason:
          `${demand} ${unit.noun} due by ${day} exceed what the working time left through it ` +
          `can hold (${perDay} ${unit.noun} a working day) — accept manually`,
        day,
        demand,
        capacity: Math.floor(cap),
      };
    }
  }

  const days = [...new Set([...i.dueByDay.keys(), ...addedDays])]
    .filter((d) => d >= fromDay)
    .sort();
  for (const day of days) {
    const demand = dueThrough(i.dueByDay, day, today) + dueThrough(subtotalsByDay, day, today);
    const cap = capacity(day);
    if (demand > cap) {
      return {
        accept: false,
        kind: 'budget_reached',
        reason:
          `${unit.adj} cap reached for ${day}: ${demand} ${unit.noun} would be due by then, more ` +
          `than the working time left through it can hold (${perDay} ${unit.noun} a working day)`,
        capExhaustedDay: day,
        demand,
        capacity: Math.floor(cap),
      };
    }
  }
  return { accept: true, subtotalsByDay };
}
