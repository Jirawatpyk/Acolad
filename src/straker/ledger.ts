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
 * even when it pushes the day past its ceiling (FR-016d): the ledger reports the breach so
 * the caller can warn, and the ceiling then blocks further claims for that day as normal.
 *
 * Effort is the **raw word count** (`STRAKER_EFFORT_UNIT`) so the combined view adds like
 * for like with the XTM bot.
 */

import { decideGroupCapacity } from '../schedule/acceptCapacity.js';
import { effectiveDeadlineDay } from '../schedule/deadlineDay.js';
import { holidaysForEffectiveDay } from '../schedule/thaiHolidays.js';
import { STRAKER_EFFORT_UNIT } from './outcomePolicy.js';
import type { SkipReason } from './types.js';
import type { HeldWork, StrakerStore } from './strakerStore.js';

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
}

/** Work being recorded **after** it is committed. The deadline may be unreadable — a
 *  recovery cannot be refused just because a number was missing from it. */
export interface CommittedWork {
  readonly objId: string;
  readonly effortWords: number;
  readonly deadlineMs: number | null;
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
      /** The effective deadline day this hold was charged to. */
      readonly deadlineDay: string;
      /** The day's total **after** this hold. */
      readonly committedEffort: number;
      readonly ceiling: number;
      /** True when this hold took the day past its ceiling — the FR-016d warning. */
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
    private readonly dailyCeiling: number,
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
    if (!Number.isFinite(dailyCeiling) || dailyCeiling <= 0) {
      throw new Error(
        `Straker daily ceiling must be a positive word count, got ${String(dailyCeiling)}`,
      );
    }
  }

  /** Straker's own daily ceiling, in raw words. */
  get ceiling(): number {
    return this.dailyCeiling;
  }

  /**
   * Committed effort per effective deadline day, summed over held work.
   *
   * `held` may be passed so that one snapshot of the held set serves a whole cycle — the
   * bucket, the decision and `heldWorkMissingDeadline` must never be able to disagree
   * about what is held (the XTM bot's C6 lesson).
   */
  committedByDay(
    nowMs: number,
    held: readonly HeldWork[] = this.store.heldWork(),
  ): ReadonlyMap<string, number> {
    const holidays = this.holidaysAt(nowMs);
    const byDay = new Map<string, number>();
    for (const work of held) {
      const day = this.dayOf(work.deadlineMs, holidays);
      if (day === null) continue; // surfaced by heldWorkMissingDeadline, never silently dropped
      byDay.set(day, (byDay.get(day) ?? 0) + work.effortWords);
    }
    return byDay;
  }

  /** Committed effort against one effective deadline day. */
  committedOn(deadlineDay: string, nowMs: number, held?: readonly HeldWork[]): number {
    return this.committedByDay(nowMs, held).get(deadlineDay) ?? 0;
  }

  /** Ceiling minus what is committed, floored at zero — a day past its ceiling has no
   *  negative room to offer, it simply has none. */
  remainingOn(deadlineDay: string, nowMs: number, held?: readonly HeldWork[]): number {
    return Math.max(0, this.dailyCeiling - this.committedOn(deadlineDay, nowMs, held));
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
   * Would claiming this offer fit inside the ceiling of the day its work lands on?
   *
   * Called **before** the irreversible claim. The decision itself is
   * `schedule/acceptCapacity.decideGroupCapacity`, reused rather than reimplemented, with
   * a single member because Straker claims one offer at a time (FR-004) where the XTM bot
   * claims a whole language group at once.
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

    const byDay = this.committedByDay(nowMs, held);
    const verdict = decideGroupCapacity(
      [{ effort: candidate.effortWords, deadlineDate: deadlineDay }],
      (day) => byDay.get(day) ?? 0,
      this.dailyCeiling,
      STRAKER_EFFORT_UNIT,
    );

    if (verdict.accept) {
      const committedEffort = byDay.get(deadlineDay) ?? 0;
      return {
        fits: true,
        deadlineDay,
        committedEffort,
        remaining: Math.max(0, this.dailyCeiling - committedEffort),
      };
    }
    return {
      fits: false,
      reason:
        verdict.kind === 'over_cap_permanent'
          ? 'exceeds_daily_ceiling_entirely'
          : 'ceiling_reached',
      detail: verdict.reason,
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
    });

    const day = this.dayOf(work.deadlineMs, this.holidaysAt(nowMs));
    if (day === null) {
      return {
        deadlineDay: null,
        // No day means no day total and no day to have breached. The row is surfaced by
        // heldWorkMissingDeadline instead, which is the honest signal here.
        committedEffort: null,
        ceiling: this.dailyCeiling,
        ceilingExceeded: false,
      };
    }

    const committedEffort = this.committedOn(day, nowMs);
    return {
      deadlineDay: day,
      committedEffort,
      ceiling: this.dailyCeiling,
      ceilingExceeded: committedEffort > this.dailyCeiling,
    };
  }

  /** The work is finished or is no longer ours — its budget returns by leaving the held
   *  set. False when there was nothing open to release, so a repeat pass is a no-op. The
   *  identity is resolved to a key by the store, by the same rule it stored it under, so
   *  this forwarding cannot introduce a spelling the held row will not answer to. */
  release(objId: string, atMs: number): boolean {
    return this.store.release(objId, atMs);
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
