/**
 * The runtime half of Straker's shared vocabulary: the value lists the database CHECK
 * constraints are generated from, the Straker/XTM concept map, and the predicates that say
 * what each outcome *means* — which alerts, which counts against the ledger.
 *
 * ## Why this is not in `types.ts`
 *
 * The coverage gate excludes `**\/types.ts` repo-wide, on the sound assumption that a file
 * with that name holds only types and so has nothing to execute. These members execute:
 * `alertsOn` decides whether a result pages a human at 03:00, and the value lists become
 * SQL CHECK constraints in `strakerStore.ts`. Leaving them under a name the gate skips is
 * precisely the situation FR-013a describes — "a gate reporting green while not covering
 * the code it governs is worse than no gate at all" — so the code moved to meet the gate
 * rather than the gate being widened to excuse the code.
 *
 * `types.ts` keeps the type aliases, and stays honestly type-only.
 *
 * ## Consumers
 *
 * The three predicates encode the decision tables in data-model.md §3 and §4, and the code
 * that reads all three is the poll cycle (`pollCycle.ts`, T037 with the skip-reason recording
 * of T040). They were written and tested here before that caller existed, rather than being
 * left to arrive with it, because the meaning of an outcome is the part that must not drift.
 */

import { WORDS_UNIT, type EffortUnit } from '../schedule/effort.js';
import type { AcceptOutcome } from '../state/jobStore.js';

// --- Unit of effort ------------------------------------------------------------------
/** Raw word count — the same unit the XTM bot runs on (FR-009), as the same object. */
export const STRAKER_EFFORT_UNIT: EffortUnit = WORDS_UNIT;

// --- Claim outcome -------------------------------------------------------------------
/**
 * The result of the one irreversible action this feature performs (data-model §3).
 * Ordered as the data model lists them.
 */
export const CLAIM_OUTCOMES = ['won', 'lost', 'failed', 'unknown', 'recovered'] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

/**
 * Straker outcome → the XTM bot's equivalent, or `null` where the XTM bot has no such
 * state. Written as a table rather than prose so the comparison is executable: the
 * drift assertion below fails the typecheck the day the XTM bot grows a new outcome and
 * nobody thinks to look at this file.
 */
export const XTM_ACCEPT_OUTCOME_OF = {
  won: 'accepted',
  /** The XTM bot's `missing` — "(snatched)", in its own words — is a lost race. */
  lost: 'missing',
  failed: 'failed',
  /** No XTM equivalent: it re-reads after accepting, so it never holds an open question. */
  unknown: null,
  /** No XTM equivalent: reconciliation against the portal is Straker-only (FR-016a). */
  recovered: null,
} as const satisfies Record<ClaimOutcome, AcceptOutcome | null>;

/**
 * Compile-time drift detector for DC-2/V33. If the XTM bot adds a value to `AcceptOutcome`
 * that this map does not mention, `Exclude<...>` stops being `never` and `npm run typecheck`
 * fails here — naming the unmapped value in the error. That is the whole point: drift
 * between the two vocabularies must be a build failure, not something noticed during a
 * later extraction.
 */
type MappedXtmOutcome = NonNullable<(typeof XTM_ACCEPT_OUTCOME_OF)[ClaimOutcome]>;
type UnmappedXtmOutcome = Exclude<AcceptOutcome, MappedXtmOutcome>;
const _noXtmOutcomeDrift: UnmappedXtmOutcome extends never ? true : UnmappedXtmOutcome = true;
void _noXtmOutcomeDrift;

/**
 * Whether an outcome raises an operational alert.
 *
 * `lost` is the load-bearing `false` here: another vendor winning the offer is the single
 * most common non-win outcome and must never page anyone (FR-006, SC-007). `recovered`
 * alerts because a gap between the portal and our record means something upstream is
 * wrong, even though the work itself is fine.
 */
export function alertsOn(outcome: ClaimOutcome): boolean {
  return outcome === 'failed' || outcome === 'unknown' || outcome === 'recovered';
}

/**
 * Whether an outcome puts effort on the ledger. Work found by reconciliation counts even
 * when it pushes the day past its ceiling (FR-016d) — it is already committed on the
 * portal, so the ledger is recording reality rather than making a decision.
 */
export function countsTowardLedger(outcome: ClaimOutcome): boolean {
  return outcome === 'won' || outcome === 'recovered';
}

// --- Skip reason ---------------------------------------------------------------------
/**
 * Why an offer that appeared was never claimed (data-model §4). Recorded for every skip
 * (FR-010) in language a human reads without a decoder.
 */
export const SKIP_REASONS = [
  'ineligible_language',
  'outside_schedule',
  'deadline_on_non_working_day',
  'deadline_unreachable',
  'ceiling_reached',
  /** Distinct from `ceiling_reached`: this one recurs every day forever and needs a human. */
  'exceeds_daily_ceiling_entirely',
  'holiday_calendar_uncurated',
  'effort_unknown',
  'deadline_unknown',
  /**
   * Not "our rules said no" like the rest, but "we never got to ask": the cycle stopped
   * claiming part-way, after a barred account (contract §4a) or a session that expired
   * mid-run, and these offers were already decided `claim` when it did.
   *
   * It earns a row because FR-010 asks that every offer not claimed carry the reason, and
   * because FR-017's win rate is won ÷ **genuinely winnable** — these are winnable by our
   * own rules, so leaving them unrecorded inflates the rate exactly when the bot can win
   * nothing. A barred account does not self-heal, so without this the same offers stay
   * invisible every cycle for as long as the block lasts.
   *
   * Which condition stopped the cycle is a fact about the cycle, not about each offer, and
   * is logged once as `action: 'claiming_halted'`.
   */
  'claiming_halted',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * The two skip reasons that mean a contract assumption failed, not merely that one offer
 * was passed over — they alert as well as skip (FR-023a, V26).
 *
 * The offer list is assumed to carry everything the scheduling decision needs. When effort
 * or deadline is missing, that assumption has failed, and every later decision rests on it.
 * Treating those as ordinary skips would let the whole premise quietly stop holding.
 */
export function alertsOnSkip(reason: SkipReason): boolean {
  return reason === 'effort_unknown' || reason === 'deadline_unknown';
}
