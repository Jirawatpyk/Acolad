/**
 * Which open holds are duplicates a languageless purchase order left behind (2026-09-23).
 *
 * Pure, and in its own module, because the script that acts on it releases held work — which
 * is how the ceiling is handed back — and the decision of what counts as a duplicate is the
 * part worth pinning down under test. (`winRate.ts` / `winRateReport.ts` split for the same
 * reason; the split also keeps `dropPhantomHolds.ts` free of exports, so importing it can
 * never run it.)
 *
 * ## The condition, and the clause that makes it safe
 *
 *   an OPEN hold whose key names no language, whose reference and service ALSO have an open
 *   hold whose key DOES name a language.
 *
 * That second clause is the whole safety argument. A real DTP job's key names no language
 * either — legitimately, because the job has no target — and releasing one would hand back a
 * ceiling the team still owes work against. But a DTP job has no sibling hold keyed by
 * language, so it is never matched. A per-hour job's phantom always does: the claims that won
 * the work are exactly those siblings.
 *
 * Matched through {@link workBucket} rather than on the stored `jobRef`/`service` strings,
 * which are `optionalText` (trimmed only) while the key is folded — an offer's `Translation`
 * and an order's `translation` are one service, and comparing the raw fields would miss
 * exactly the rows this is meant to find.
 */

import { workBucket } from './workKey.js';

/** Enough of a held row to judge it by. Structural, so the caller can pass the store's. */
export interface HoldToJudge {
  readonly objId: string;
  readonly identity?:
    | {
        readonly jobRef: string | null;
        readonly service: string | null;
        readonly workKey: string | null;
      }
    | undefined;
  readonly heldSinceMs: number;
}

export interface Phantom {
  readonly objId: string;
  readonly workKey: string;
  readonly heldSinceMs: number;
  /** The keyed holds of the same reference and service — the proof this one is a duplicate. */
  readonly siblings: readonly string[];
}

export function phantomHolds(rows: readonly HoldToJudge[]): Phantom[] {
  const bucketOf = (row: HoldToJudge): string | null =>
    workBucket(row.identity?.jobRef, row.identity?.service);

  // Holds whose key names a language, by bucket: the siblings a phantom duplicates.
  const keyedByBucket = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.identity?.workKey ?? null;
    const bucket = bucketOf(row);
    if (key === null || bucket === null || key === bucket) continue;
    keyedByBucket.set(bucket, [...(keyedByBucket.get(bucket) ?? []), row.objId]);
  }

  const found: Phantom[] = [];
  for (const row of rows) {
    const key = row.identity?.workKey ?? null;
    const bucket = bucketOf(row);
    // `key === bucket` is what "this key names no language" means — see `workBucket`.
    if (key === null || bucket === null || key !== bucket) continue;
    const siblings = keyedByBucket.get(bucket);
    if (siblings === undefined || siblings.length === 0) continue; // a real DTP job
    found.push({ objId: row.objId, workKey: key, heldSinceMs: row.heldSinceMs, siblings });
  }
  return found;
}
