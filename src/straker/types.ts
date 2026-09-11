/**
 * Straker's shared vocabulary — the TYPES half (FR-028 / DC-2).
 *
 * DC-2 requires both portals to use the same names, with the same meanings, for the
 * concepts they share — an offer sighting, a claim outcome, a unit of effort, a gate
 * decision — even though no shared interface exists yet. That is what keeps the deferred
 * `packages/core` extraction mechanical rather than a redesign.
 *
 * Two of the four are satisfied by REUSE rather than by agreement, which is the stronger
 * form: an effort unit and a gate decision come from `src/schedule/`, so the two bots
 * cannot drift apart structurally. The other two are Straker-native because the actions
 * genuinely differ, and the concept map in `outcomePolicy.ts` is what makes that difference
 * visible instead of leaving it to be discovered later.
 *
 * **This file is deliberately type-only.** Its runtime siblings — the value lists, the
 * XTM concept map and the outcome predicates — live in `outcomePolicy.ts`, because the
 * coverage gate excludes `**\/types.ts` repo-wide and executable code must not hide behind
 * a name the gate skips (FR-013a).
 *
 * ## Concept map — Straker ↔ XTM
 *
 * | Concept        | Straker                      | XTM                                    | Relationship |
 * |----------------|------------------------------|----------------------------------------|--------------|
 * | Offer sighting | `OfferSighting`              | `BaseJobState` + `AppearanceEventType` | Same model (one continuous period of visibility, re-appearance starts a new one); Straker's is the probe's own tracker, reused |
 * | Claim outcome  | `ClaimOutcome`               | `AcceptOutcome`                        | **Deliberately different words** — the spec keeps "claim" and "accept" apart because the actions differ in mechanics, failure modes and reversibility. `XTM_ACCEPT_OUTCOME_OF` is the mapping, and it is type-checked for drift |
 * | Effort unit    | `STRAKER_EFFORT_UNIT`        | `WORDS_UNIT`                           | **The same object.** Raw word count on both (FR-009), so the combined daily view adds like for like |
 * | Gate decision  | `GateDecision`               | `AcceptScheduleVerdict`                | **The same type.** Straker calls `evaluateAcceptSchedule` unchanged (R6) |
 */

import type { AcceptScheduleVerdict } from '../schedule/acceptSchedule.js';

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

// --- Gate decision -------------------------------------------------------------------
/** The verdict `evaluateAcceptSchedule` returns, unchanged. Straker adds no gate logic. */
export type GateDecision = AcceptScheduleVerdict;

// --- Claim outcome and skip reason ---------------------------------------------------
// The types are re-exported here so the vocabulary still reads as one thing; the values
// and the predicates that give them meaning live in `outcomePolicy.ts`.
export type { ClaimOutcome, SkipReason } from './outcomePolicy.js';
