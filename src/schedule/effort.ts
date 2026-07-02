import type { XtmJobState } from '../detection/types.js';

export type EffortMetric = 'wwc' | 'words';

/** Display labels for the active effort metric. */
export interface EffortUnit {
  adj: string;
  noun: string;
}

/** Canonical unit labels (C8) — the ONE place the label shapes live. Every consumer
 *  (config transform, capacity/schedule defaults, alerts, reports) must reference
 *  these instead of re-declaring `{ adj, noun }` literals, so the user-visible
 *  strings can never drift between call sites. */
export const WORDS_UNIT: EffortUnit = { adj: 'word', noun: 'words' };
export const WWC_UNIT: EffortUnit = { adj: 'WWC', noun: 'WWC' };

/** Canonical display unit for the given metric. */
export function unitOf(metric: EffortMetric): EffortUnit {
  return metric === 'wwc' ? WWC_UNIT : WORDS_UNIT;
}

/** Effort under the active metric. 'wwc': File WWC, falling back to raw words when WWC is null OR 0
 *  (WWC ≤ words → never over-accepts; the 0-guard defends a scrape-0 on a real job). 'words': raw words. */
export function effortOf(
  job: Pick<XtmJobState, 'words' | 'fileWwc'>,
  metric: EffortMetric,
): number | null {
  if (metric === 'words') return job.words;
  return job.fileWwc && job.fileWwc > 0 ? job.fileWwc : job.words;
}
