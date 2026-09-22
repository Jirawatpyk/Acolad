/**
 * Whether to claim each offer in one read — the pure decision, and nothing else.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a **pure function**: offers in, a decision per offer out. It performs no I/O, reads
 * no store, writes no record, sends no announcement and — most importantly — never calls
 * the claim path itself. The poll cycle owns that call site (T037). Keeping the decision
 * separable is what lets the whole of FR-007a/b, FR-008..013 and SC-006 be tested without
 * a portal, a database or a clock, and what makes the audit V16 asks for a matter of
 * re-running this function rather than of reading logs.
 *
 * It adds **no scheduling logic of its own** (R6). Working hours, working days, the curated
 * Thai holiday calendar including substitute days, deadline reachability at the team's
 * throughput and the effective-deadline-day cutoff are all the live XTM bot's, reached
 * through `schedule/acceptSchedule.evaluateAcceptSchedule` and `straker/ledger.ts` exactly
 * as they stand. The one thing this file contributes is the wiring: ask, honour the answer,
 * and name the rule that blocked the offer in language a human reads (FR-010).
 *
 * ## The order the checks run in, and why that order
 *
 * 1. **Eligibility** — supplied as an answer, never computed here (the 44-direction rule is
 *    `eligibility.ts`). It is the outer filter because it is also the outer term of the
 *    win-rate denominator (FR-017): an offer the team would never take is recorded as
 *    ineligible rather than as a payload fault it was never going to act on.
 * 2. **The scheduling gate**, unchanged. It screens a missing effort or deadline before
 *    anything else, which is what makes the FR-023a alert fire for a contract failure
 *    instead of being masked by whatever else happened to be wrong.
 * 3. **Capacity**, last, through the ledger. Last because it is the only check whose answer
 *    depends on the decisions already taken in this same pass.
 *
 * There is deliberately **no "is the team at work right now" check**. An earlier draft
 * composed one here from the shared calendar primitives; it was removed, and the reasoning
 * — measured, not assumed — sits at the point in `decideOne` where it would have gone.
 * `outside_schedule` is the SkipReason nothing now produces.
 *
 * Capacity is last for a second reason: `StrakerLedger.checkCapacity` throws on an
 * unreadable deadline. The gate screening that first is not a courtesy, it is the
 * precondition.
 *
 * ## Why the refusal text comes from the gate and the label is derived
 *
 * A refusal carries two things: a `SkipReason` (an enum, for the record and the ledger of
 * outcomes) and a `detail` (prose, for the human). The prose is **the gate's own sentence**,
 * passed through verbatim — so what a human reads is what the rule actually said, and no
 * second wording can drift away from the first. The enum is derived by `classifyRefusal`,
 * which re-reads the same inputs in the same precedence the gate uses. That classifier runs
 * **only after the gate has already refused**, so it cannot permit anything; the worst a
 * drift between the two could do is file a correct refusal under the wrong label, which the
 * suite pins by comparing every `detail` against the gate's own output.
 */

import type { WorkIdentity } from './workKey.js';
import { evaluateAcceptSchedule } from '../schedule/acceptSchedule.js';
import { resolveHolidaysForSpan } from '../schedule/thaiHolidays.js';
import type { WorkCalendar } from '../schedule/workingHours.js';
import type { StrakerBotConfig } from './config.js';
import type { StrakerLedger } from './ledger.js';
import type { HeldWork } from './strakerStore.js';
import type { SkipReason } from './types.js';

/**
 * One offer, already reduced to the values a decision needs.
 *
 * Every field is a value the parser (T042) extracts; **no portal field name appears here
 * or anywhere below it** — that shape is what SC-000 still blocks, and this module is
 * built to not care. `eligible` likewise arrives as an answer rather than a rule, because
 * the 44-direction test is `eligibility.ts`'s (T041).
 */
export interface OfferForDecision {
  /** The portal's own opaque identifier. Never composed from other fields (R8). */
  readonly objId: string;
  /** For the record (FR-011a) and for the skip text — never for deciding eligibility. */
  readonly languageDirection: string;
  /** The eligibility answer, supplied. */
  readonly eligible: boolean;
  /** Raw word count (FR-009), or null when the payload carried none. */
  readonly effortWords: number | null;
  /** Deadline as epoch ms, or null when the payload carried none. */
  readonly deadlineMs: number | null;
  /**
   * True when the offer is not a translation — source and target are the same language,
   * which the portal signals by sending `target_lang: null` (observed 2026-09-17 on a DTP
   * preparation job). Such work is measured against its own daily budget and its own rate,
   * because a word count says much less about how long it takes.
   */
  readonly monolingual: boolean;
  /**
   * Job reference, file name, service and the key that ties this offer to its purchase order
   * and assigned job (`workKey.ts`). Never read by the decision; carried so the record, the
   * sheet and the card can name the work. Optional so callers that build offers by hand
   * need not invent one.
   */
  readonly identity?: WorkIdentity;
}

/** Claim it, or skip it and say which rule turned it away. There is no third answer. */
export type ClaimDecision =
  | {
      readonly objId: string;
      readonly languageDirection: string;
      readonly action: 'claim';
      /** Carried through so the hold is charged to the budget the decision was made against. */
      readonly monolingual: boolean;
      /** Non-null by construction: the gate refuses an offer with no effort. */
      readonly effortWords: number;
      /** Non-null by construction: the gate refuses an offer with no deadline. */
      readonly deadlineMs: number;
      /** The effective deadline day this work will be charged to, from the ledger. */
      readonly deadlineDay: string;
      readonly identity?: WorkIdentity;
    }
  | {
      readonly objId: string;
      readonly languageDirection: string;
      readonly action: 'skip';
      readonly reason: SkipReason;
      /** Human-readable, and for a gate refusal it is the gate's own sentence (FR-010). */
      readonly detail: string;
      /**
       * What the gate refused **on**, carried through rather than dropped at the decision.
       *
       * Nullable, unlike the claim variant, because two of the skip reasons exist precisely
       * when one of these is missing (`effort_unknown`, `deadline_unknown`). Null here means
       * the payload carried none; it does not mean the decision ignored them.
       *
       * They used to stop here, so the tracking record wrote blanks into the two columns it
       * labels "What the gate decided on" — and the sheet could not answer how many words
       * the ceiling turned away today, which is the one question the combined view exists
       * for. `ceiling_reached` and `deadline_unreachable` are decided by exactly these two
       * numbers and recorded neither.
       */
      readonly effortWords: number | null;
      readonly deadlineMs: number | null;
      readonly identity?: WorkIdentity;
    };

/**
 * The settings a decision reads, as a slice of the real config rather than a copy of its
 * field names — so renaming one in `config.ts` fails the typecheck here instead of quietly
 * leaving this module reading a field that no longer exists.
 *
 * The ceiling is absent on purpose: it belongs to the ledger, which owns it.
 */
export type ClaimDecisionSettings = Pick<
  StrakerBotConfig,
  | 'throughputWordsPerHour'
  | 'dtpThroughputWordsPerHour'
  | 'hoursStartMin'
  | 'hoursEndMin'
  | 'workdays'
>;

/**
 * The rate this kind of work is actually done at.
 *
 * Both figures are derived from their own ceiling over the working day (`config.ts`), so
 * this is not a second knob — it is the same knob read for the right kind of work. Feeding
 * a DTP offer the translation rate is not a rounding error: the two ceilings are an order
 * of magnitude apart, so the wrong one refuses work that fits, or admits work that does
 * not. Claiming is irreversible, so the second direction is the expensive one.
 */
function throughputFor(monolingual: boolean, settings: ClaimDecisionSettings): number {
  return monolingual ? settings.dtpThroughputWordsPerHour : settings.throughputWordsPerHour;
}

/** Only `checkCapacity` is reachable from here — deciding must not be able to record. */
export type CapacityChecker = Pick<StrakerLedger, 'checkCapacity'>;

export interface ClaimDecisionContext {
  readonly nowMs: number;
  readonly settings: ClaimDecisionSettings;
  readonly ledger: CapacityChecker;
  /**
   * ONE snapshot of held work for the whole pass, taken by the caller before it starts.
   * Passing it in rather than reading it per offer is what stops the bucket, the decision
   * and the caller's own reporting disagreeing about what is held (the XTM bot's C6
   * lesson) — and it is what keeps this function pure.
   */
  readonly held: readonly HeldWork[];
}

/**
 * Decide a whole read, in the order the portal returned it.
 *
 * **Portal order is the contract** (FR-007b). The offers are weighed one by one in the
 * order given and the budget is spent as they come; nothing is sorted. That was chosen for
 * determinism and speed over value ordering — sorting would add work to the race path for
 * a case that is rare at two or three offers a day.
 *
 * **Reaching the ceiling never ends the pass** (FR-007a). Every offer gets a decision, and
 * an offer whose work lands on a day that still has room is still claimed even when an
 * earlier day is full. Stopping early would corrupt the win-rate denominator, hide what the
 * team is turning away, and — in the caller — cut short the cycle reconciliation shares.
 *
 * A single offer is a batch of one; there is deliberately no separate single-offer entry,
 * because it would be the form that forgets to carry the budget forward.
 */
export function decideClaims(
  offers: readonly OfferForDecision[],
  ctx: ClaimDecisionContext,
): readonly ClaimDecision[] {
  const { nowMs, settings, ledger } = ctx;

  // A non-positive throughput makes every feasibility answer meaningless, and it is a
  // property of the configuration rather than of any one offer. Fail loud once, here,
  // rather than let the gate blame each offer in turn for a misconfiguration — and rather
  // than claim on an answer nobody could defend. `config.ts` already guarantees a positive
  // figure; this is the guard for a caller that assembled its settings by hand.
  //
  // Both rates are checked, not just the one this batch happens to need: the defect is in
  // the configuration either way, and a pass that happens to carry no DTP offer must not
  // report a broken DTP rate as healthy.
  for (const [name, rate] of [
    ['throughput', settings.throughputWordsPerHour],
    ['DTP throughput', settings.dtpThroughputWordsPerHour],
  ] as const) {
    if (!(rate > 0)) {
      throw new Error(
        `Straker ${name} must be a positive words-per-hour figure, got ${String(rate)}`,
      );
    }
  }

  // The pass's own copy of the held set, advanced as offers are claimed. Without the
  // advance, two offers that each fit alone and cannot both fit would both be claimed —
  // an irreversible over-commitment no later check can undo (SC-006).
  const held: HeldWork[] = [...ctx.held];
  const decisions: ClaimDecision[] = [];

  for (const offer of offers) {
    const decision = decideOne(offer, nowMs, settings, ledger, held);
    decisions.push(decision);
    if (decision.action === 'claim') {
      held.push({
        objId: decision.objId,
        effortWords: decision.effortWords,
        deadlineMs: decision.deadlineMs,
        heldSinceMs: nowMs,
        kind: offer.monolingual ? 'monolingual' : 'translation',
        releasedAtMs: null,
      });
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// One offer
// ---------------------------------------------------------------------------

function decideOne(
  offer: OfferForDecision,
  nowMs: number,
  settings: ClaimDecisionSettings,
  ledger: CapacityChecker,
  held: readonly HeldWork[],
): ClaimDecision {
  if (!offer.eligible) {
    return skip(
      offer,
      'ineligible_language',
      `language direction ${offer.languageDirection} is not one this account claims`,
    );
  }

  // Resolve the curated calendar across every Bangkok year the now→deadline span touches —
  // the same resolution the XTM bot performs, so an uncurated year fails closed here for
  // exactly the reason it fails closed there (FR-012).
  const { holidays, curated } = resolveHolidaysForSpan(nowMs, offer.deadlineMs);
  const calendar: WorkCalendar = {
    workdays: settings.workdays,
    hoursStartMin: settings.hoursStartMin,
    hoursEndMin: settings.hoursEndMin,
    holidays,
  };

  // The gate, unchanged, on the four things it takes: effort, deadline, throughput, and
  // the calendar (plus whether that calendar can be trusted for the span). Nothing
  // Straker-shaped crosses this boundary.
  const verdict = evaluateAcceptSchedule({
    enabled: true,
    nowMs,
    dueAtMs: offer.deadlineMs,
    effort: offer.effortWords,
    throughputPerHour: throughputFor(offer.monolingual, settings),
    calendar,
    holidaysCuratedForSpan: curated,
  });
  if (!verdict.allow) {
    return skip(offer, classifyRefusal(offer, curated), verdict.reason);
  }

  const { effortWords, deadlineMs } = offer;
  if (effortWords === null || deadlineMs === null) {
    // Unreachable: the gate refuses a missing number before it looks at anything else, so
    // `allow: true` already guarantees both are present. Kept anyway, because the cost is
    // one branch and the alternative is a cast — and a cast is what would let a future
    // change to the gate produce a claim for numbers we do not have.
    return skip(
      offer,
      deadlineMs === null ? 'deadline_unknown' : 'effort_unknown',
      'the scheduling gate allowed an offer with no effort or deadline — refusing to claim on numbers we do not have',
    );
  }

  // NOTE: there is deliberately no "is the team at work right now" check here.
  //
  // The reused gate does not ask that question — it asks whether the work FITS in working
  // time before its deadline — and the spec's assumption is that the scheduling rules are
  // "reused unchanged". Adding a current-moment refusal would be changing the rules, not
  // reusing them. The purpose of working hours is that the WORK can be done, which the
  // feasibility check above already enforces; the claim itself takes a moment and commits
  // nobody to working at that moment.
  //
  // The measurement settles it: two of the three offers the capture probe has seen arrived
  // at 06:38 Bangkok and were gone within 204 seconds. Gating on the instant would refuse
  // two thirds of the observed volume and gain nothing, because by 09:00 the offer no
  // longer exists. A bot built to race but asleep fifteen hours a day contradicts FR-001.
  //
  // Consequence, recorded rather than hidden: `outside_schedule` is a SkipReason nothing
  // now produces. It stays in the vocabulary because data-model §4 settled it and a future
  // decision could reinstate the check — see spec.md §Clarifications, 2026-09-15.

  const capacity = ledger.checkCapacity(
    {
      objId: offer.objId,
      effortWords,
      deadlineMs,
      kind: offer.monolingual ? 'monolingual' : 'translation',
    },
    nowMs,
    held,
  );
  if (!capacity.fits) return skip(offer, capacity.reason, capacity.detail);

  return {
    objId: offer.objId,
    languageDirection: offer.languageDirection,
    action: 'claim',
    monolingual: offer.monolingual,
    effortWords,
    deadlineMs,
    deadlineDay: capacity.deadlineDay,
    ...(offer.identity === undefined ? {} : { identity: offer.identity }),
  };
}

/**
 * Which rule the gate refused on.
 *
 * Runs **only after `allow === false`**, so it decides nothing — it labels a refusal that
 * has already happened. The order below mirrors the gate's own precedence; the gate's
 * throughput check cannot be reached because `decideClaims` screens that once, up front.
 */
function classifyRefusal(offer: OfferForDecision, curated: boolean): SkipReason {
  if (offer.deadlineMs === null) return 'deadline_unknown';
  if (offer.effortWords === null) return 'effort_unknown';
  if (!curated) return 'holiday_calendar_uncurated';

  // No weekday check here any more. The gate never refuses a deadline for falling on a day
  // off (the shared scheduling standard, 2026-09-18) — and reading the weekday first would
  // mislabel the refusal it does make: weekend work that does not fit in Friday's hours
  // would be recorded as "due on a weekend" rather than "cannot be done in time".
  // `deadline_on_non_working_day` stays in `SKIP_REASONS` for the rows written before.
  //
  // What is left is a deadline already past and a deadline the crew cannot reach at the
  // configured throughput. Both mean the same thing to the team: the work cannot be done
  // in time, and the gate's own sentence says which of the two it was.
  return 'deadline_unreachable';
}

function skip(offer: OfferForDecision, reason: SkipReason, detail: string): ClaimDecision {
  return {
    objId: offer.objId,
    languageDirection: offer.languageDirection,
    action: 'skip',
    reason,
    detail,
    effortWords: offer.effortWords,
    deadlineMs: offer.deadlineMs,
    ...(offer.identity === undefined ? {} : { identity: offer.identity }),
  };
}
