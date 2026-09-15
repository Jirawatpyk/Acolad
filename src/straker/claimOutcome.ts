/**
 * What the portal's answer to a claim attempt means (FR-005, FR-005a). Pure: it sees the
 * answer already translated into our own vocabulary, never an HTTP status or a portal code.
 *
 * The translation happens at the edge of `claim.ts` (FR-027 / DC-1), which is what keeps
 * portal-specific result codes out of the decision and orchestration logic — and what lets
 * this rule be tested without a transport.
 */

import type { ClaimOutcome } from './outcomePolicy.js';

/** The portal's answer to a claim attempt, in our words rather than its own. */
export type ClaimResponse =
  /** The portal committed the work to the team. */
  | { readonly kind: 'accepted' }
  /** The portal refused, and told us why in its own code. */
  | { readonly kind: 'rejected'; readonly signal: string }
  /** The request produced no answer at all — it may or may not have landed. */
  | { readonly kind: 'no_answer'; readonly reason: string };

/**
 * Rejection signals confirmed to mean "another vendor took it first".
 *
 * **Empty on purpose.** FR-005a requires the lost-race signal to be identified positively
 * and explicitly, against a real offer, under supervision — that is release precondition
 * RP-4, and nothing has claimed a real offer yet. Until one does, no rejection may be read
 * as a normal loss.
 *
 * The emptiness is load-bearing rather than a placeholder: `lost` is the only outcome that
 * never alerts, so a rejection guessed into it would hide a broken claim path behind
 * silence, looking exactly like a bot that keeps arriving second. Adding the confirmed
 * value to this array is the entire change once RP-4 is satisfied.
 */
export const CONFIRMED_LOST_RACE_SIGNALS: readonly string[] = [];

/**
 * Classify a claim attempt's answer.
 *
 * The asymmetry is deliberate: `accepted` and a *confirmed* lost-race signal are recognised
 * positively, and **everything else is a fault**. An unrecognised rejection is never
 * inferred to be a lost race merely by not looking like anything else.
 *
 * `lostRaceSignals` is a parameter rather than a direct read of the constant so a test can
 * exercise the recognised path before RP-4 confirms a real value.
 */
export function classifyClaim(
  response: ClaimResponse,
  lostRaceSignals: readonly string[] = CONFIRMED_LOST_RACE_SIGNALS,
): ClaimOutcome {
  if (response.kind === 'accepted') return 'won';

  // No answer leaves a question the bot cannot settle. Calling it lost would close it
  // wrongly and leave the team owing work that reached no record; reconciliation against
  // the portal settles it instead, and the claim is never retried (R7, FR-016a).
  if (response.kind === 'no_answer') return 'unknown';

  // Exact membership after trimming and case-folding. Whitespace and case are transport
  // noise; a prefix or substring match is not — that is how an unverified rejection starts
  // being read as a normal loss.
  const signal = response.signal.trim().toLowerCase();
  const recognised = lostRaceSignals.some((known) => known.trim().toLowerCase() === signal);
  return recognised ? 'lost' : 'failed';
}
