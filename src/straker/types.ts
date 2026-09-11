/**
 * Straker's shared vocabulary (FR-028 / DC-2).
 *
 * DC-2 requires both portals to use the same names, with the same meanings, for the
 * concepts they share — an offer sighting, a claim outcome, a unit of effort, a gate
 * decision — even though no shared interface exists yet. That is what keeps the deferred
 * `packages/core` extraction mechanical rather than a redesign.
 *
 * Two of the four are satisfied by REUSE rather than by agreement, which is the stronger
 * form: an effort unit and a gate decision are imported from `src/schedule/` and
 * re-exported here, so the two bots cannot drift apart structurally. The other two are
 * Straker-native because the actions genuinely differ, and the mapping below is what makes
 * that difference visible instead of leaving it to be discovered later.
 *
 * ## Concept map — Straker ↔ XTM
 *
 * | Concept        | Straker                      | XTM                                  | Relationship |
 * |----------------|------------------------------|--------------------------------------|--------------|
 * | Offer sighting | `OfferSighting`              | `BaseJobState` + `AppearanceEventType` | Same model (one continuous period of visibility, re-appearance starts a new one); Straker's is the probe's own tracker, reused |
 * | Claim outcome  | `ClaimOutcome`               | `AcceptOutcome`                      | **Deliberately different words** — the spec keeps "claim" and "accept" apart because the actions differ in mechanics, failure modes and reversibility. `XTM_ACCEPT_OUTCOME_OF` below is the mapping, and it is type-checked for drift |
 * | Effort unit    | `STRAKER_EFFORT_UNIT`        | `WORDS_UNIT`                         | **The same object.** Raw word count on both (FR-009), so the combined daily view adds like for like |
 * | Gate decision  | `GateDecision`               | `AcceptScheduleVerdict`              | **The same type.** Straker calls `evaluateAcceptSchedule` unchanged (R6) |
 *
 * `unknown` and `recovered` have no XTM equivalent, and that absence is itself meaningful:
 * the XTM bot re-reads the portal after accepting, so it never holds an unresolved outcome,
 * while Straker records only after an irreversible claim and settles the gap by reconciling.
 */

import { WORDS_UNIT, type EffortUnit } from '../schedule/effort.js';
import type { AcceptScheduleVerdict } from '../schedule/acceptSchedule.js';
import type { AcceptOutcome } from '../state/jobStore.js';

// --- Offer sighting ------------------------------------------------------------------
// Re-exported, not redefined: the capture probe's pure tracker already owns this
// transition and is the thing the bot reuses (T017). `OfferSighting` is the name the data
// model uses; `TrackedOffer` is what the probe called it. One implementation, two names,
// and this line is where they are tied together.
export type {
  TrackedOffer as OfferSighting,
  VanishedOffer as EndedOfferSighting,
  TrackerState as SightingState,
} from './offerTracker.js';

// --- Unit of effort ------------------------------------------------------------------
/** Raw word count — the same unit the XTM bot runs on (FR-009), as the same object. */
export const STRAKER_EFFORT_UNIT: EffortUnit = WORDS_UNIT;

// --- Gate decision -------------------------------------------------------------------
/** The verdict `evaluateAcceptSchedule` returns, unchanged. Straker adds no gate logic. */
export type GateDecision = AcceptScheduleVerdict;

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
  /** The XTM bot's `missing` — someone else took it — is the same event as a lost race. */
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
 *
 * `effort_unknown` and `deadline_unknown` are not ordinary skips: they also alert
 * (FR-023a), because they mean the unverified assumption that the offer list carries
 * everything the decision needs has failed, and every later decision rests on it.
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
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** The two skip reasons that mean a contract assumption failed, not merely that one
 *  offer was passed over — they alert as well as skip (FR-023a, V26). */
export function alertsOnSkip(reason: SkipReason): boolean {
  return reason === 'effort_unknown' || reason === 'deadline_unknown';
}
