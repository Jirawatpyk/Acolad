/**
 * The win rate (FR-017) and its companion turn-away count (FR-017a), computed over the
 * offer-event rows the store already holds. SC-004 / V22.
 *
 * ## The measure, and where the whole difficulty of it lives
 *
 * **Win rate = offers won ÷ offers that were genuinely winnable.** The division is
 * trivial; the denominator is the measure. FR-017 defines winnable exactly — *"the language
 * direction was eligible **and** the scheduling gate would have permitted the claim"* — and
 * both ways of getting it wrong produce a plausible-looking number that says the opposite
 * of the truth:
 *
 * - Put the offers our own rules turned away into the denominator, and a bot that was
 *   obediently declining work reads as a bot losing races it never entered. Tuning then
 *   goes after the polling rhythm when the actual lever is a ceiling or a throughput figure.
 * - Count only what we attempted, and a bot that passes over most of the work reads as
 *   brilliant.
 *
 * That is also why FR-017a exists and why this module returns both figures from one pass:
 * **a low rate with a high turn-away count is a configuration question; a low rate with a
 * low one is a speed question**, and they call for opposite responses. Reporting either
 * alone makes the other invisible.
 *
 * ## The classification, row by row
 *
 * Two tables below decide it, and both are `satisfies Record<…>` so a new outcome or a new
 * skip reason cannot be added to the vocabulary without a decision being made here — the
 * same drift-as-a-build-failure discipline `outcomePolicy.ts` uses for the XTM concept map.
 *
 * | Standing | Numerator | Denominator | Companion count | Why |
 * |---|---|---|---|---|
 * | `won` | ✓ | ✓ | — | The race was entered and won |
 * | `recovered` | ✓ | ✓ | — | The portal says the work is ours. data-model §3: `unknown` and `recovered` are the same event before and after reconciliation, so a recovery is a claim of ours that landed |
 * | `lost` | — | ✓ | — | A race entered and lost on speed. This is the outcome the measure exists to count, and the one FR-006 forbids alerting on |
 * | `failed` | — | ✓ | — | See the divergence note below |
 * | `unknown` | — | ✓ | — | See the `unknown` note below |
 * | `claiming_halted` | — | ✓ | **no** | Our rules did **not** turn it away (data-model §4) |
 * | every other skip reason | — | — | ✓ | Our own rules refused it, so it was never winnable |
 * | no decision recorded | — | — | — | Neither side; reported on its own |
 *
 * ### `claiming_halted` is in the denominator and out of the companion count
 *
 * It is the one skip reason that is not a refusal. The offer passed eligibility, passed the
 * gate, passed capacity — and the cycle stopped before it could be attempted, after a barred
 * account or a session that expired mid-run. data-model §4 records that it was added
 * precisely because these offers "quietly shrank FR-017's *genuinely winnable* denominator
 * at the one time the bot can win nothing". Filing it with the turn-aways would restore that
 * bug under a new name: a barred account would *raise* the win rate, because the only offers
 * left in the denominator would be the ones claimed before the block landed.
 *
 * ### `unknown` counts against the rate while it is unknown, and the figure self-corrects
 *
 * The claim may or may not have landed. The denominator is not in question — the offer was
 * eligible and gate-permitted, so it was winnable under FR-017's own test. The numerator is,
 * and the answer taken here is **not a win until it is known to be one**:
 *
 * - A measure of wins that counts a maybe as a win is optimistic exactly when the system is
 *   in its least trustworthy state. This is the same conservative direction FR-005a takes
 *   for the lost-race signal, where an unrecognised rejection is a fault rather than a
 *   normal loss, for the same reason: the flattering reading is the one that hides a fault.
 * - Excluding it from **both** sides was rejected. A claim path that answers nothing would
 *   then leave the rate untouched while the bot's real standing is unmeasured — the measure
 *   would go quiet precisely when it has something to say.
 *
 * **What happens to the figure afterwards**: `unknown` is temporary by design. It is the one
 * outcome the store lets a later write overwrite (`isSettled` in `strakerStore.ts` excludes
 * it), and FR-016a reconciles against the portal on start and every 15 minutes, with SC-009
 * bounding the gap at that one interval. So an unknown resolves within about 15 minutes,
 * either into the numerator — as a `recovery` row, or by the claim row itself settling to
 * `won` — or into a settled non-win. The rate is therefore a **lower bound while any
 * unknown is pending**, it can only rise as they settle, and {@link WinRate.unknownPending}
 * is reported beside it so nobody reads a temporarily depressed figure as a verdict.
 *
 * ### `failed` is in the denominator, and data-model §3 was corrected to agree
 *
 * This was a real disagreement between two artefacts, found when this module was written.
 * data-model §3's table said a `failed` claim counts toward "neither"; **FR-017 settled it
 * the other way and the table was corrected on 2026-09-15**, with the reasoning recorded
 * under it. In short:
 *
 * - FR-017's definition of winnable is a test about **our rules**, not about what happened
 *   afterwards — "the language direction was eligible **and** the scheduling gate would
 *   have permitted the claim" — and it names exactly one exclusion, "offers the team's own
 *   rules turned away". A failed claim passes the test and is not that exclusion.
 * - Excluding it produces the pathology this measure exists to prevent. A wholly broken
 *   claim path — every attempt failing — would report `n/a (0 of 0)` rather than 0%, which
 *   reads as "nothing happened" rather than "everything failed".
 *
 * The reading behind the old table was not unreasonable — a fault says nothing about the
 * polling rhythm, which is what SC-004 tunes — so {@link WinRate.failed} is still reported
 * as its own line, and anyone who wants the race-only figure can compute
 * `won ÷ (winnable − failed)` from the numbers printed. Nothing is hidden either way.
 *
 * ## Counting rule: identities, not events, and not sightings
 *
 * The spec counts distinct offers "by offer identity, never by sighting", and the store
 * holds at most one row per `(objId, eventType)` — so one offer legitimately produces a
 * `skip`, then a `claim`, then a `recovery`. All of an identity's rows resolve to **one**
 * standing, by the precedence in {@link classifyOffer}: a settled positive dominates
 * everything (a claim that reconciliation later found on the portal is a win, whatever the
 * claim row said), and among the non-wins a settled fact outranks the open question.
 *
 * ## No I/O, by construction
 *
 * The whole of FR-017 is decided by the two tables and one pass over an array. There is no
 * store, no clock, no filesystem and no network here, so the measure is testable without a
 * database — and, more importantly, it **cannot be reached from the claim path**. This is a
 * reporting-time computation over rows that already exist; `winRateReport.ts` is the only
 * thing that opens a file, and it opens it read-only.
 */

import { SKIP_REASONS, type ClaimOutcome, type SkipReason } from './outcomePolicy.js';
import type { OfferEvent, SkipEvent } from './strakerStore.js';

// ---------------------------------------------------------------------------
// The classification tables
// ---------------------------------------------------------------------------

/**
 * Which side of the ratio each claim outcome lands on. `'won'` means numerator **and**
 * denominator — there is no outcome that is a win without having been winnable.
 *
 * Exhaustive by typecheck: a sixth `ClaimOutcome` cannot join the vocabulary without this
 * map naming it, which is the point. Defaulting a new outcome to either side silently is
 * how a denominator rots.
 */
export const WIN_RATE_SIDE_OF_OUTCOME = {
  won: 'won',
  /** The portal says the work is ours — a claim that landed (data-model §3, FR-016b). */
  recovered: 'won',
  /** A race entered and lost on speed. Exactly what the measure is for (FR-006). */
  lost: 'winnable',
  /** Winnable by our rules, not won. data-model §3's table said `Neither` until 2026-09-15;
   *  FR-017 settled it the other way and the table was corrected — see the note under it. */
  failed: 'winnable',
  /** Not a win until it is known to be one; reconciliation may move it. See the docstring. */
  unknown: 'winnable',
} as const satisfies Record<ClaimOutcome, 'won' | 'winnable'>;

/**
 * The order the non-win outcomes are read in when one offer carries more than one: a
 * settled fact outranks the open question.
 *
 * Ranked separately from the table above because the table answers "which side" and this
 * answers "which of the non-wins to report", and conflating them would make the precedence
 * a property of declaration order — the kind of thing a tidy-up reorders without noticing.
 */
const NON_WIN_PRECEDENCE = ['lost', 'failed', 'unknown'] as const;

/**
 * Compile-time guard, in the same idiom as `outcomePolicy.ts`'s XTM drift detector: every
 * outcome the table calls `'winnable'` must be ranked above. Mark a sixth outcome
 * `'winnable'` and forget to rank it and `npm run typecheck` fails here, naming it —
 * rather than the offer silently falling through to `undecided` and leaving the
 * denominator quietly short, which is the failure this whole module exists to prevent.
 */
type WinnableOutcome = {
  [K in ClaimOutcome]: (typeof WIN_RATE_SIDE_OF_OUTCOME)[K] extends 'winnable' ? K : never;
}[ClaimOutcome];
type UnrankedWinnableOutcome = Exclude<WinnableOutcome, (typeof NON_WIN_PRECEDENCE)[number]>;
const _everyWinnableOutcomeIsRanked: UnrankedWinnableOutcome extends never
  ? true
  : UnrankedWinnableOutcome = true;
void _everyWinnableOutcomeIsRanked;

/**
 * Which side of the ratio each skip reason lands on.
 *
 * `'turned_away'` is FR-017a's companion count and is **excluded from the denominator**;
 * `'winnable'` stays in the denominator as an offer we could have had and did not get.
 * Exactly one reason is `'winnable'` today, and it is the one that is not a refusal.
 */
export const WIN_RATE_SIDE_OF_SKIP = {
  ineligible_language: 'turned_away',
  /** Produced by nothing since 2026-09-15 (spec §Clarifications); classified for the day
   *  a current-moment refusal is reinstated, so it cannot land in the denominator then. */
  outside_schedule: 'turned_away',
  deadline_on_non_working_day: 'turned_away',
  deadline_unreachable: 'turned_away',
  ceiling_reached: 'turned_away',
  exceeds_daily_ceiling_entirely: 'turned_away',
  holiday_calendar_uncurated: 'turned_away',
  /**
   * The payload lacked a number the gate needs, so the gate refused: not winnable under
   * FR-017's test, because the gate did not permit the claim. It might have been winnable
   * had the payload been complete, which is unknowable — so it is counted with the
   * turn-aways and broken out by reason, where a rising count reads as the contract
   * failure it is (FR-023a) rather than as a policy decision.
   */
  effort_unknown: 'turned_away',
  deadline_unknown: 'turned_away',
  /** Our rules said yes and the cycle stopped first — see the file docstring. */
  claiming_halted: 'winnable',
} as const satisfies Record<SkipReason, 'turned_away' | 'winnable'>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What one offer identity amounted to, after all of its rows are read together. */
export type OfferStanding =
  /** Numerator and denominator. `viaRecovery` when the only evidence is a recovery row. */
  | { readonly kind: 'won'; readonly viaRecovery: boolean }
  | { readonly kind: 'lost' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unknown' }
  /** Winnable, never attempted: the cycle halted before reaching it (data-model §4). */
  | { readonly kind: 'halted' }
  /** Our own rules refused it — FR-017a's companion count, outside the denominator. */
  | { readonly kind: 'turned_away'; readonly reason: SkipReason }
  /** Seen, but no decision was ever recorded. Neither side; reported on its own. */
  | { readonly kind: 'undecided' };

/**
 * A measurement period, applied to `occurredAtMs`. Half-open — `fromMs` inclusive, `toMs`
 * exclusive — so two adjacent periods can never count the same event twice.
 */
/**
 * Below this many winnable offers the figure is a weak signal. SC-004 sets a target only
 * after roughly two weeks of baseline, which at the stated 2-3 offers a day is about thirty
 * offers; ten is the point below which a single race moves the rate by ten points or more.
 *
 * Lives here rather than in either consumer because two places now render a win rate — the
 * ops script and the 09:00 report (T076) — and a threshold that could differ between them
 * would let the same figure be called a weak signal in one and a result in the other.
 */
export const WEAK_SIGNAL_BELOW = 10;

export interface WinRateWindow {
  readonly fromMs?: number;
  readonly toMs?: number;
}

/**
 * One period's measurement. Every count is over distinct offer identities.
 *
 * Two invariants hold for any input, and both are asserted by the suite:
 * - `winnable = won + lost + failed + unknownPending + haltedBeforeAttempt`
 * - `offers = winnable + turnedAway + undecided`
 */
export interface WinRate {
  /** Distinct offers with at least one event in the period. */
  readonly offers: number;
  /** FR-017 numerator: offers won, reconciliation's recoveries included. */
  readonly won: number;
  /** How many of `won` are known only through reconciliation — a gap worth watching (FR-016b). */
  readonly recovered: number;
  readonly lost: number;
  readonly failed: number;
  /** Claims still unresolved. While this is above zero, `ratePct` is a lower bound. */
  readonly unknownPending: number;
  /** Winnable offers the cycle never got to attempt (barred account, expired session). */
  readonly haltedBeforeAttempt: number;
  /** FR-017 denominator: offers that were genuinely winnable. */
  readonly winnable: number;
  /** `won / winnable` as a percentage, or **null when nothing was winnable** — 0 of 0 is
   *  not 0%, and reporting it as 0% would invent a defeat out of an empty period. */
  readonly ratePct: number | null;
  /** FR-017a: offers our own rules turned away. */
  readonly turnedAway: number;
  /** That total by rule, in vocabulary order, listing only rules that turned something away. */
  readonly turnedAwayByReason: ReadonlyMap<SkipReason, number>;
  /** Seen with no decision recorded — neither won, nor refused, nor attempted. */
  readonly undecided: number;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Resolve every row recorded about **one** offer into a single standing.
 *
 * Precedence, and why it runs in this order:
 *
 * 1. **A win dominates everything.** If any row says `won` or `recovered`, the work is the
 *    team's. A `recovered` row alongside a `lost` or `unknown` claim is reconciliation
 *    correcting our record against the portal, and the portal is authoritative.
 * 2. **Among non-wins, a settled fact outranks the open question** — `lost`, then `failed`,
 *    then `unknown`. An offer whose claim row still reads `unknown` has not been settled by
 *    anything, which is the only state that leaves the rate provisional.
 * 3. **A claim of any kind outranks a skip row.** A skip row can be a previous cycle's
 *    refusal — the ceiling was full on Monday and the offer was claimed on Tuesday — and
 *    both rows survive, because the store upserts one row per `(objId, eventType)`.
 * 4. Only then the skip row, read through {@link WIN_RATE_SIDE_OF_SKIP}. Where several
 *    skip rows arrive (the store holds one, but a caller may assemble more), the latest
 *    occurrence wins, since the newest refusal is the one still standing.
 * 5. No decision of any kind — a sighting row alone, or nothing — is `undecided` rather
 *    than being folded into either side. An offer that appeared and produced no decision is
 *    a defect signal; hiding it in a denominator or in the turn-aways is how it stays
 *    hidden.
 */
export function classifyOffer(events: readonly OfferEvent[]): OfferStanding {
  const outcomes = new Set<ClaimOutcome>();
  let latestSkip: SkipEvent | null = null;

  for (const event of events) {
    if (event.eventType === 'skip') {
      if (latestSkip === null || event.occurredAtMs >= latestSkip.occurredAtMs) {
        latestSkip = event;
      }
      continue;
    }
    if (event.eventType === 'sighting') continue;
    outcomes.add(event.outcome);
  }

  // Both branches read the table rather than a list of names repeated here. A table the
  // logic does not consult is a comment that can disagree with the code.
  const wins = [...outcomes].filter((o) => WIN_RATE_SIDE_OF_OUTCOME[o] === 'won');
  if (wins.length > 0) return { kind: 'won', viaRecovery: !outcomes.has('won') };

  for (const outcome of NON_WIN_PRECEDENCE) {
    if (outcomes.has(outcome)) return { kind: outcome };
  }

  if (latestSkip !== null) {
    const reason = latestSkip.skipReason;
    // The table decides, not the reason's name: `'winnable'` means "our rules said yes and
    // the attempt never happened", which is `claiming_halted` today and is the classification
    // any future non-refusal skip would have to justify joining.
    return WIN_RATE_SIDE_OF_SKIP[reason] === 'winnable'
      ? { kind: 'halted' }
      : { kind: 'turned_away', reason };
  }

  return { kind: 'undecided' };
}

// ---------------------------------------------------------------------------
// The measure
// ---------------------------------------------------------------------------

/**
 * Measure a period from the store's event rows (`StrakerStore.listEvents()`).
 *
 * Events are filtered to the window **first** and then grouped, so an offer whose rows
 * straddle a boundary is classified on the rows inside the window only. That is the
 * deliberate reading of "measured over a period": a claim won last month does not make this
 * month look better, and the half-open window means two adjacent periods never both claim
 * the same event.
 */
export function computeWinRate(events: readonly OfferEvent[], window?: WinRateWindow): WinRate {
  const fromMs = window?.fromMs ?? Number.NEGATIVE_INFINITY;
  const toMs = window?.toMs ?? Number.POSITIVE_INFINITY;

  const byOffer = new Map<string, OfferEvent[]>();
  for (const event of events) {
    if (event.occurredAtMs < fromMs || event.occurredAtMs >= toMs) continue;
    const bucket = byOffer.get(event.objId);
    if (bucket === undefined) byOffer.set(event.objId, [event]);
    else bucket.push(event);
  }

  let won = 0;
  let recovered = 0;
  let lost = 0;
  let failed = 0;
  let unknownPending = 0;
  let haltedBeforeAttempt = 0;
  let undecided = 0;
  const turnedAwayCounts = new Map<SkipReason, number>();

  for (const offerEvents of byOffer.values()) {
    const standing = classifyOffer(offerEvents);
    switch (standing.kind) {
      case 'won':
        won++;
        if (standing.viaRecovery) recovered++;
        break;
      case 'lost':
        lost++;
        break;
      case 'failed':
        failed++;
        break;
      case 'unknown':
        unknownPending++;
        break;
      case 'halted':
        haltedBeforeAttempt++;
        break;
      case 'turned_away':
        turnedAwayCounts.set(standing.reason, (turnedAwayCounts.get(standing.reason) ?? 0) + 1);
        break;
      case 'undecided':
        undecided++;
        break;
    }
  }

  const winnable = won + lost + failed + unknownPending + haltedBeforeAttempt;
  let turnedAway = 0;
  // Rebuilt in vocabulary order rather than in first-seen order, so two runs over the same
  // period print the same report, and only with the rules that actually refused something.
  const turnedAwayByReason = new Map<SkipReason, number>();
  for (const reason of SKIP_REASONS) {
    const count = turnedAwayCounts.get(reason);
    if (count === undefined) continue;
    turnedAwayByReason.set(reason, count);
    turnedAway += count;
  }

  return {
    offers: byOffer.size,
    won,
    recovered,
    lost,
    failed,
    unknownPending,
    haltedBeforeAttempt,
    winnable,
    // 0 of 0 is not 0%: an empty period is unmeasured, not lost.
    ratePct: winnable === 0 ? null : (won / winnable) * 100,
    turnedAway,
    turnedAwayByReason,
    undecided,
  };
}
