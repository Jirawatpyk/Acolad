import type { XtmJobState } from '../detection/types.js';

export type EffortMetric = 'wwc' | 'words';

/** Effort under the active metric. 'wwc': File WWC, falling back to raw words when WWC is null OR 0
 *  (WWC ≤ words → never over-accepts; the 0-guard defends a scrape-0 on a real job). 'words': raw words. */
export function effortOf(
  job: Pick<XtmJobState, 'words' | 'fileWwc'>,
  metric: EffortMetric,
): number | null {
  if (metric === 'words') return job.words;
  return job.fileWwc && job.fileWwc > 0 ? job.fileWwc : job.words;
}
