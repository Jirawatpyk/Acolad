/**
 * Which open holds are duplicates a languageless purchase order left behind (2026-09-23).
 *
 * Pure, and in its own module, because the script that acts on it releases held work — which
 * is how the ceiling is handed back — and the decision of what counts as a duplicate is the
 * part worth pinning down under test. (`winRate.ts` / `winRateReport.ts` split for the same
 * reason; the split also keeps `dropPhantomHolds.ts` free of exports, so importing it can
 * never run it.)
 *
 * ## The condition, and the three clauses that make it safe
 *
 *   an OPEN hold whose key names no language, **that reconciliation created as a recovery**,
 *   whose reference and service also have an open hold whose key DOES name a language —
 *   and no more of them per reference than there are such siblings.
 *
 * **The recovery clause is the one that matters most, and the first cut did not have it.** A
 * key naming no language does not by itself mean the row is bogus. Two shapes are honest:
 *
 * - a real **DTP** job, which has no target at all;
 * - a real **monolingual translation** claim of a reference whose other jobs are bilingual —
 *   `reconcile.ts` goes out of its way to protect exactly this row, settling an unknown claim
 *   before the bucket can answer for it, and a cleanup that then released it would undo that
 *   protection and hand back a ceiling the team still owes against.
 *
 * DTP is spared by the sibling clause (no bilingual siblings to have). The monolingual claim
 * is not — it sits in the same bucket as its siblings by design — so it is spared by where
 * the row came from: a phantom was written by `recoverOrder` and carries a `recovery` event,
 * while a real claim carries a `claim` event. The caller passes in which ids have one.
 *
 * The count clause is the weaker guard, for a bucket whose numbers do not line up. Each
 * phantom duplicates one keyed sibling, so more bucket-keyed recoveries than siblings means
 * at least one of them is work nobody recorded twice. Oldest first, by `held_since_ms` and
 * then `objId` — the order `heldWork()` already returns and `transferKeyless` already picks
 * by — and {@link PhantomReport.unexplained} counts what was left alone for a human.
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

export interface PhantomReport {
  readonly phantoms: readonly Phantom[];
  /**
   * Bucket-keyed recoveries left alone because their reference had fewer keyed siblings than
   * recoveries. Non-zero means the numbers do not line up and a human should look before the
   * rest is released — not that anything is wrong with what IS listed.
   */
  readonly unexplained: readonly string[];
}

/**
 * @param rows every OPEN held row.
 * @param recoveredObjIds the ids reconciliation recorded a `recovery` event for. A phantom
 *   always has one; a real claim of the same shape never does. Without it this cannot tell a
 *   monolingual claim from a duplicate, and would release live work.
 */
export function phantomHolds(
  rows: readonly HoldToJudge[],
  recoveredObjIds: ReadonlySet<string>,
): PhantomReport {
  const bucketOf = (row: HoldToJudge): string | null =>
    workBucket(row.identity?.jobRef, row.identity?.service);
  // `key === bucket` is what "this key names no language" means — see `workBucket`.
  const namesNoLanguage = (row: HoldToJudge): boolean => {
    const key = row.identity?.workKey ?? null;
    const bucket = bucketOf(row);
    return key !== null && bucket !== null && key === bucket;
  };

  // Holds whose key names a language, by bucket: the siblings a phantom duplicates.
  const keyedByBucket = new Map<string, string[]>();
  for (const row of rows) {
    const bucket = bucketOf(row);
    if (bucket === null || (row.identity?.workKey ?? null) === null) continue;
    if (namesNoLanguage(row)) continue;
    keyedByBucket.set(bucket, [...(keyedByBucket.get(bucket) ?? []), row.objId]);
  }

  const phantoms: Phantom[] = [];
  const unexplained: string[] = [];
  const takenPerBucket = new Map<string, number>();
  // `rows` arrives in `heldWork()` order (held_since_ms, then obj_id), so "oldest first"
  // needs no sort here — and the caller keeps that guarantee by not reordering.
  for (const row of rows) {
    if (!namesNoLanguage(row)) continue;
    const bucket = bucketOf(row);
    const key = row.identity?.workKey;
    if (bucket === null || key == null) continue;
    const siblings = keyedByBucket.get(bucket);
    if (siblings === undefined || siblings.length === 0) continue; // a real DTP job
    if (!recoveredObjIds.has(row.objId)) continue; // a real claim, not a recovery
    const taken = takenPerBucket.get(bucket) ?? 0;
    if (taken >= siblings.length) {
      unexplained.push(row.objId);
      continue;
    }
    takenPerBucket.set(bucket, taken + 1);
    phantoms.push({ objId: row.objId, workKey: key, heldSinceMs: row.heldSinceMs, siblings });
  }
  return { phantoms, unexplained };
}
