/**
 * Straker's per-portal ledger (FR-009, data-model §5).
 *
 * ## Three properties, and why each is the one that matters
 *
 * **Keyed by the effective deadline day.** The key is the working day the work actually
 * lands on — computed by `schedule/deadlineDay.effectiveDeadlineDay`, the same rule the
 * XTM bot uses — not the day the offer was claimed. A deadline before the working day
 * starts, or on a weekend or holiday, is charged to the previous working day, because that
 * is when the work has to be done. The XTM bot re-keyed from claim day to deadline day
 * (PR #14) and then added the before-09:00 cutoff (PR #19) after each mis-charged a day.
 * Nothing here re-derives that rule; a home-grown date rule is how the two drift apart.
 *
 * **Derived from held work, never a running counter.** Every figure below is a sum over
 * `StrakerStore.heldWork()` taken at read time. This is what makes finishing a job return
 * its budget: the row leaves the held set and the day's total drops, with nobody having to
 * remember to decrement anything. The XTM bot shipped a counter first and had to replace
 * it, which is the single most expensive lesson available to this file.
 *
 * **A ceiling per working day, spent earliest-deadline-first (2026-09-18).** The ceiling
 * is how many words the team takes on per working day, and a deadline has every working
 * day before it. So an offer fits when, for every deadline day d from its own onward, the
 * work due on or before d fits in `ceiling × working days from today through d`. Until the
 * owner's ruling of 2026-09-18 each job was charged whole to its deadline day alone, which
 * made a 4,000-word job due Wednesday unclaimable on Monday at 3,500 a day — for good —
 * though the three days before it hold 10,500. Judged on the deadline day itself the two
 * rules agree; they part only when there are days to spare. The day KEY above is unchanged:
 * it still places each job, the window is what the key is now measured against.
 *
 * **Straker's ceiling is Straker's own.** It is supplied by the caller from
 * `StrakerBotConfig.maxWordsPerDay` and is never read from, nor shared with, the XTM bot's
 * figures. That the two can sum past the crew's real capacity is an accepted consequence,
 * mitigated by the combined daily report (FR-018) rather than by enforcement here.
 *
 * ## Deciding and recording are different acts
 *
 * `checkCapacity` **decides**, before the irreversible claim, and can refuse.
 * `hold` **records**, after the fact, and never refuses — by the time it is called the
 * work is already committed on the portal. Work found by reconciliation therefore counts
 * even when it pushes a day past what its window can hold (FR-016d): the ledger reports the
 * breach so the caller can warn, and the ceiling then blocks further claims as normal.
 *
 * Effort is the **raw word count** (`STRAKER_EFFORT_UNIT`) so the combined view adds like
 * for like with the XTM bot.
 */

import { bangkokCalendar, bangkokEpochMs } from '../schedule/bangkokCalendar.js';
import { effectiveDeadlineDay } from '../schedule/deadlineDay.js';
import { isNonWorkingDay } from '../schedule/workingHours.js';
import { holidaysForEffectiveDay } from '../schedule/thaiHolidays.js';
import type { SkipReason } from './types.js';
import { WORK_KINDS, type HeldWork, type StrakerStore, type WorkKind } from './strakerStore.js';

/** Exactly what the ledger touches on the store — declared so the dependency is visible
 *  and so a reader can see that the ledger keeps no state of its own. */
export type LedgerStore = Pick<StrakerStore, 'heldWork' | 'hold' | 'release'>;

/** The team's working calendar. Read from the SAME settings the XTM bot reads: only the
 *  ceiling and throughput are Straker's own, never the question of when the team works. */
export interface LedgerWorkCalendar {
  /** Minutes past midnight at which the working day starts (Bangkok). */
  readonly hoursStartMin: number;
  /** ISO weekday numbers that are working days (1 = Monday). */
  readonly workdays: ReadonlySet<number>;
}

/** An offer being weighed **before** the claim. A decision needs a deadline; an offer
 *  without one is skipped with `deadline_unknown` and alerted (FR-023a) long before it
 *  reaches the ledger. */
export interface LedgerCandidate {
  readonly objId: string;
  readonly effortWords: number;
  readonly deadlineMs: number;
  readonly kind: WorkKind;
}

/** Work being recorded **after** it is committed. The deadline may be unreadable — a
 *  recovery cannot be refused just because a number was missing from it. */
/** One daily budget per kind of work — see {@link committedByDay} for why they are separate. */
export type CeilingPerKind = Readonly<Record<WorkKind, number>>;

export interface CommittedWork {
  readonly objId: string;
  readonly effortWords: number;
  readonly deadlineMs: number | null;
  /** Which daily budget this work is charged to. Translation and DTP do not share one. */
  readonly kind: WorkKind;
}

/** The two capacity outcomes are kept apart because they need different human responses:
 *  `ceiling_reached` clears itself as held work finishes, while
 *  `exceeds_daily_ceiling_entirely` recurs every day forever until someone acts. */
export type CapacitySkipReason = Extract<
  SkipReason,
  'ceiling_reached' | 'exceeds_daily_ceiling_entirely'
>;

export type CapacityVerdict =
  | {
      readonly fits: true;
      readonly deadlineDay: string;
      /** Already committed against that day, before this offer. */
      readonly committedEffort: number;
      readonly remaining: number;
    }
  | {
      readonly fits: false;
      readonly reason: CapacitySkipReason;
      /** Plain language, for the tracking record and the skip announcement (FR-010). */
      readonly detail: string;
      readonly deadlineDay: string;
    };

/**
 * What a hold did to the day it landed on — or, in the second shape, the admission that it
 * landed on no day at all.
 *
 * Two shapes rather than one with nullable fields, because a single shape has to answer
 * "what is the day's total?" for work that has no day, and the only available answers are
 * wrong: 0 reads as "that day has nothing committed" for a hold that may be thousands of
 * words. The union lets the type say what is actually known, and makes the caller look at
 * `deadlineDay` before it can read a total.
 */
export type HoldResult =
  | {
      /** The effective deadline day this hold was charged to — or, when it caused a breach,
       *  the first deadline day whose window it overran, which is the day worth naming. */
      readonly deadlineDay: string;
      /** Work due on or before `deadlineDay`, **after** this hold. */
      readonly committedEffort: number;
      /** What the working days from today through `deadlineDay` can hold — the ceiling
       *  times that many days. Equal to the ceiling itself only for a one-day window. */
      readonly ceiling: number;
      /** True when this hold took some deadline past what its window can hold — the
       *  FR-016d warning. */
      readonly ceilingExceeded: boolean;
    }
  | {
      /** The deadline could not be read; the work is held but bucketed nowhere, and is
       *  named by `heldWorkMissingDeadline` so the caller alerts instead of guessing. */
      readonly deadlineDay: null;
      /** No day, so no day total. Not zero — zero would be a claim about a day. */
      readonly committedEffort: null;
      readonly ceiling: number;
      /** No day, so no ceiling of a day to have breached. */
      readonly ceilingExceeded: false;
    };

export class StrakerLedger {
  constructor(
    private readonly store: LedgerStore,
    /** Straker's own daily ceiling, in raw words. */
    private readonly ceilings: CeilingPerKind,
    private readonly calendar: LedgerWorkCalendar,
    /** The curated Thai work calendar, injectable for tests. Note this is the *reporting*
     *  resolution (`holidaysForEffectiveDay`), which merges what it has: refusing to claim
     *  when a year is uncurated is the scheduling gate's job (`holiday_calendar_uncurated`,
     *  FR-012), and duplicating that decision here would give two places the power to
     *  refuse for the same reason. */
    private readonly holidaysAt: (
      nowMs: number,
    ) => ReadonlyMap<string, string> = holidaysForEffectiveDay,
  ) {
    // A zero ceiling is a misconfiguration, not "unlimited". The XTM bot carries a
    // neighbouring knob where 0 does mean unlimited, and reading this one the same way
    // would silently remove the ceiling on an irreversible action.
    for (const kind of WORK_KINDS) {
      const ceiling = ceilings[kind];
      if (!Number.isFinite(ceiling) || ceiling <= 0) {
        throw new Error(
          `Straker daily ceiling for ${kind} must be a positive word count, got ${String(ceiling)}`,
        );
      }
    }
  }

  /** Straker's own daily ceiling, in raw words. */
  ceilingFor(kind: WorkKind): number {
    return this.ceilings[kind];
  }

  /**
   * Committed effort per effective deadline day, summed over held work.
   *
   * `held` may be passed so that one snapshot of the held set serves a whole cycle — the
   * bucket, the decision and `heldWorkMissingDeadline` must never be able to disagree
   * about what is held (the XTM bot's C6 lesson).
   *
   * `kind` is required and sits ahead of that optional snapshot on purpose. It used to
   * default to `'translation'`, which on a two-budget ledger means a caller that forgets it
   * gets a confidently wrong number rather than a compiler error — and the wrong number
   * here ends in an irreversible over-claim.
   */
  committedByDay(
    nowMs: number,
    kind: WorkKind,
    held: readonly HeldWork[] = this.store.heldWork(),
  ): ReadonlyMap<string, number> {
    const holidays = this.holidaysAt(nowMs);
    const byDay = new Map<string, number>();
    for (const work of held) {
      // Each kind is summed against its own budget. A word of DTP preparation and a word of
      // translation are both "a word" and are not remotely the same commitment, so adding
      // them would let a morning of formatting refuse an afternoon of translation.
      if (work.kind !== kind) continue;
      const day = this.dayOf(work.deadlineMs, holidays);
      if (day === null) continue; // surfaced by heldWorkMissingDeadline, never silently dropped
      byDay.set(day, (byDay.get(day) ?? 0) + work.effortWords);
    }
    return byDay;
  }

  /** Committed effort against one effective deadline day, for one kind of work. */
  committedOn(
    deadlineDay: string,
    nowMs: number,
    kind: WorkKind,
    held?: readonly HeldWork[],
  ): number {
    return this.committedByDay(nowMs, kind, held).get(deadlineDay) ?? 0;
  }

  /** Ceiling minus what is committed, floored at zero — a day past its ceiling has no
   *  negative room to offer, it simply has none. */
  remainingOn(
    deadlineDay: string,
    nowMs: number,
    kind: WorkKind,
    held?: readonly HeldWork[],
  ): number {
    return Math.max(0, this.ceilings[kind] - this.committedOn(deadlineDay, nowMs, kind, held));
  }

  /**
   * Identities of held work whose deadline cannot be resolved to a day — exactly the rows
   * `committedByDay` leaves out. Partnered with it deliberately: work that is held but
   * counted nowhere under-states the day's load, and an under-stated day is how an
   * irreversible claim slips past a ceiling. The caller alerts on a non-empty result.
   */
  heldWorkMissingDeadline(
    nowMs: number,
    held: readonly HeldWork[] = this.store.heldWork(),
  ): string[] {
    const holidays = this.holidaysAt(nowMs);
    return held.filter((w) => this.dayOf(w.deadlineMs, holidays) === null).map((w) => w.objId);
  }

  /**
   * Would claiming this offer keep every deadline from its own onward within the working
   * days before it? See {@link firstBreach} for the rule and the module docstring for why.
   *
   * Called **before** the irreversible claim. This used to delegate to
   * `schedule/acceptCapacity.decideGroupCapacity`, which judges one deadline day in
   * isolation; that is the XTM bot's rule and stays the XTM bot's rule. Straker stopped
   * using it on 2026-09-18, when a job due in three days' time was refused for being larger
   * than one.
   */
  checkCapacity(
    candidate: LedgerCandidate,
    nowMs: number,
    held?: readonly HeldWork[],
  ): CapacityVerdict {
    const holidays = this.holidaysAt(nowMs);
    const deadlineDay = this.dayOf(candidate.deadlineMs, holidays);
    if (deadlineDay === null) {
      // The gate screens a missing deadline first (FR-023a). Reaching here means a caller
      // bug, and answering "it fits" would put an unmeasured commitment on the ledger.
      throw new Error(
        `cannot weigh offer ${candidate.objId} against the ceiling: its deadline is unreadable`,
      );
    }

    const ceiling = this.ceilings[candidate.kind];
    const byDay = this.committedByDay(nowMs, candidate.kind, held);
    const today = bangkokCalendar(nowMs).date;
    const window = this.workingDaysThrough(today, deadlineDay, holidays);

    // Bigger than every working day before its deadline put together: no amount of waiting
    // makes room, so it needs a human and must not be re-offered to the ceiling every pass.
    if (candidate.effortWords > ceiling * window) {
      return {
        fits: false,
        reason: 'exceeds_daily_ceiling_entirely',
        detail:
          `${candidate.effortWords} words due ${deadlineDay} exceed the ${ceiling * window} ` +
          `words the ${window} working day(s) from ${today} through ${deadlineDay} can hold ` +
          `(${ceiling} words a day) — accept manually`,
        deadlineDay,
      };
    }

    const breach = this.firstBreach(nowMs, holidays, byDay, ceiling, {
      day: deadlineDay,
      effort: candidate.effortWords,
    });
    const before = this.demandThrough(deadlineDay, byDay, today);
    if (breach === null) {
      return {
        fits: true,
        deadlineDay,
        committedEffort: before,
        remaining: Math.max(0, ceiling * window - before),
      };
    }
    return {
      fits: false,
      reason: 'ceiling_reached',
      detail:
        `${breach.demand} words would be due by ${breach.day}, and the ${breach.days} working ` +
        `day(s) from ${today} through it hold ${breach.capacity} (${ceiling} words a day)`,
      deadlineDay,
    };
  }

  /**
   * Put committed work on the ledger. **Never refuses**: by the time this is called the
   * portal has already committed the work to the team, whether we claimed it or
   * reconciliation found it. Refusing here would leave the team holding work that counts
   * against nothing, which is the exact failure FR-016d exists to prevent.
   *
   * The returned `ceilingExceeded` is the warning the caller raises. After it, the ceiling
   * blocks further claims for that day through `checkCapacity` as normal.
   */
  hold(work: CommittedWork, nowMs: number): HoldResult {
    this.store.hold({
      objId: work.objId,
      effortWords: work.effortWords,
      deadlineMs: work.deadlineMs,
      heldSinceMs: nowMs,
      kind: work.kind,
    });

    const day = this.dayOf(work.deadlineMs, this.holidaysAt(nowMs));
    if (day === null) {
      return {
        deadlineDay: null,
        // No day means no day total and no day to have breached. The row is surfaced by
        // heldWorkMissingDeadline instead, which is the honest signal here.
        committedEffort: null,
        ceiling: this.ceilings[work.kind],
        ceilingExceeded: false,
      };
    }

    // The warning follows the same rule the claim path does. Judged per deadline day it
    // would page on every legitimately multi-day job reconciliation finds.
    const holidays = this.holidaysAt(nowMs);
    const ceiling = this.ceilings[work.kind];
    const byDay = this.committedByDay(nowMs, work.kind);
    const today = bangkokCalendar(nowMs).date;
    const breach = this.firstBreach(nowMs, holidays, byDay, ceiling, { day, effort: 0 });
    if (breach !== null) {
      return {
        deadlineDay: breach.day,
        committedEffort: breach.demand,
        ceiling: breach.capacity,
        ceilingExceeded: true,
      };
    }
    return {
      deadlineDay: day,
      committedEffort: this.demandThrough(day, byDay, today),
      ceiling: ceiling * this.workingDaysThrough(today, day, holidays),
      ceilingExceeded: false,
    };
  }

  /** The work is finished or is no longer ours — its budget returns by leaving the held
   *  set. False when there was nothing open to release, so a repeat pass is a no-op. The
   *  identity is resolved to a key by the store, by the same rule it stored it under, so
   *  this forwarding cannot introduce a spelling the held row will not answer to. */
  release(objId: string, atMs: number): boolean {
    return this.store.release(objId, atMs);
  }

  /**
   * The earliest deadline day, on or after `from.day`, by which more work is due than the
   * working days up to it can hold — or null when every such day is within its capacity.
   *
   * Earliest-deadline-first: for every deadline day d, the work due on or before d must fit
   * in `ceiling × working days from today through d`. Adding work due on `from.day` changes
   * the sum for that day and every later one, which is why a job due early can be refused
   * on account of a commitment due later — it would be worked first and eat that time.
   * Days before `from.day` are not re-checked: they are unchanged by this work, and a day
   * already over (recovered work can put it there) does not make a later day any fuller.
   */
  private firstBreach(
    nowMs: number,
    holidays: ReadonlyMap<string, string>,
    byDay: ReadonlyMap<string, number>,
    ceiling: number,
    from: { readonly day: string; readonly effort: number },
  ): { day: string; demand: number; capacity: number; days: number } | null {
    const today = bangkokCalendar(nowMs).date;
    const days = [...new Set([...byDay.keys(), from.day])].filter((d) => d >= from.day).sort();
    for (const day of days) {
      const demand = this.demandThrough(day, byDay, today) + from.effort;
      const window = this.workingDaysThrough(today, day, holidays);
      const capacity = ceiling * window;
      if (demand > capacity) return { day, demand, capacity, days: window };
    }
    return null;
  }

  /** Work due on or before `day`. Held work already past its deadline day counts as due
   *  today: it is still owed, and it is what the team does first. */
  private demandThrough(day: string, byDay: ReadonlyMap<string, number>, today: string): number {
    let sum = 0;
    for (const [d, words] of byDay) {
      const due = d < today ? today : d;
      if (due <= day) sum += words;
    }
    return sum;
  }

  /** Working days from `from` through `to`, both inclusive, in Bangkok dates. Zero when
   *  `to` is before `from`. Walked day by day: the span is days, not years. */
  private workingDaysThrough(
    from: string,
    to: string,
    holidays: ReadonlyMap<string, string>,
  ): number {
    let count = 0;
    for (let ms = bangkokEpochMs(from, 12 * 60); ; ms += 86_400_000) {
      const { date, weekday } = bangkokCalendar(ms);
      if (date > to) return count;
      if (!isNonWorkingDay(date, weekday, this.calendar.workdays, holidays)) count += 1;
    }
  }

  /** The working day a deadline's work lands on, or null when there is no readable
   *  deadline to place. */
  private dayOf(deadlineMs: number | null, holidays: ReadonlyMap<string, string>): string | null {
    if (deadlineMs === null || !Number.isFinite(deadlineMs)) return null;
    return effectiveDeadlineDay(
      deadlineMs,
      this.calendar.hoursStartMin,
      this.calendar.workdays,
      holidays,
    );
  }
}
