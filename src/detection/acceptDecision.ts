import { isEligibleTarget } from './eligibility.js';

/**
 * The accept decision for one detected job (pure). Combines language eligibility
 * (FR-006/007), the operations kill-switch (FR-012), and the configurable caps
 * (FR-025) into a single verdict the orchestration acts on:
 *   - `accept`   → attempt the bulk accept and record the FR-024 outcome
 *   - `skip`     → record `Skipped` with the reason (non-Malay, or a cap hit)
 *   - `disabled` → eligible but auto-accept is off → detect/log/notify only
 */
export type AcceptDecision =
  | { action: 'accept' }
  | { action: 'skip'; reason: string }
  | { action: 'disabled' };

export interface AcceptDecisionInput {
  targetLang: string | null;
  words: number | null;
  acceptEnabled: boolean;
  acceptLanguages: string[];
  /** 0 = no limit. */
  maxWords: number;
  acceptedThisCycle: number;
  /** 0 = no limit. */
  maxPerCycle: number;
}

export function decideAccept(i: AcceptDecisionInput): AcceptDecision {
  // Language eligibility is the first gate — a non-eligible job is Skipped (FR-007)
  // even when accept is disabled (it would never be accepted anyway).
  if (!isEligibleTarget(i.targetLang, i.acceptLanguages)) {
    return { action: 'skip', reason: `target not eligible (${i.targetLang ?? 'unknown'})` };
  }
  // Eligible, but the operations kill-switch is off (FR-012): no click.
  if (!i.acceptEnabled) return { action: 'disabled' };
  // Configurable caps (FR-025); 0 means unlimited. Unknown word count never trips
  // the word cap (we do not skip an eligible job on uncertainty).
  if (i.maxWords > 0 && i.words !== null && i.words > i.maxWords) {
    return { action: 'skip', reason: `exceeds max words (${i.words} > ${i.maxWords})` };
  }
  // WARNING (keep default 0 = unlimited): this caps how many jobs the bot *labels* to
  // accept, but the portal's bulk action ("Accept all tasks for this language in this
  // group") claims the WHOLE group in one click. With a cap > 0, sibling Malay jobs in
  // the group are grabbed on the portal but left accept_status='none' — and the
  // robustness pass (xtmPollCycle) then RE-ATTEMPTS them next cycle, hitting "Finish
  // task" → false accept_failed alerts (it does NOT self-correct). Use cap 0, or redefine
  // this as max-GROUPS, before ever setting it > 0. See [[xtm-accept-d6-finish-task]].
  if (i.maxPerCycle > 0 && i.acceptedThisCycle >= i.maxPerCycle) {
    return { action: 'skip', reason: `per-cycle accept cap reached (${i.maxPerCycle})` };
  }
  return { action: 'accept' };
}
