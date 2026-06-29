export interface CapacityMember {
  words: number;
  deadlineDate: string;
}
export type GroupCapacityVerdict =
  | { accept: true; subtotalsByDay: ReadonlyMap<string, number> }
  | { accept: false; kind: 'over_cap_permanent'; reason: string }
  | { accept: false; kind: 'budget_reached'; reason: string; capExhaustedDay: string };

/** Decide a whole bulk group all-or-nothing, bucketed by deadline day. `bucketFor(d)` =
 *  words already due on day d (held + this cycle's optimistic advances).
 *  PRECONDITION: `bucketFor` returns a NON-NEGATIVE count (a negative bucket would
 *  understate per-day load and let an over-cap group slip through).
 *
 *  A reject carries an explicit `kind` discriminant (not an optional flag), so the caller never
 *  infers meaning from the presence/absence of a field:
 *   - 'over_cap_permanent': a day's group subtotal ALONE exceeds the cap — no amount of waiting
 *     clears it, so ops must accept it manually. Carries NO `capExhaustedDay` (nothing re-arms it).
 *   - 'budget_reached': the day fits alone but the running bucket + subtotal overflows — retryable
 *     as held jobs finish. Carries the overflowing `capExhaustedDay` (drives the deduped alert). */
export function decideGroupCapacity(
  members: CapacityMember[],
  bucketFor: (deadlineDate: string) => number,
  cap: number,
): GroupCapacityVerdict {
  const subtotalsByDay = new Map<string, number>();
  for (const mem of members)
    subtotalsByDay.set(mem.deadlineDate, (subtotalsByDay.get(mem.deadlineDate) ?? 0) + mem.words);

  if (cap > 0) {
    // Days in ascending deadline-date order so the named day is the EARLIEST relevant one
    // (spec: "in deadline order"). The accept/reject OUTCOME is order-independent.
    const days = [...subtotalsByDay.entries()].sort(([a], [b]) => a.localeCompare(b));

    // F3: the PERMANENT case wins. A day whose group subtotal ALONE exceeds the cap can never
    // be auto-accepted (no amount of waiting clears it) — ops must accept it manually. Scan for
    // it FIRST (earliest such day) so an earlier, merely budget-filled (retryable) day does not
    // mask it via an early return and leave the over-cap job silently re-rejected forever.
    for (const [day, subtotal] of days) {
      if (subtotal > cap)
        return {
          accept: false,
          kind: 'over_cap_permanent',
          reason: `group words due ${day} (${subtotal}) exceed the daily cap (${cap}) — accept manually`,
        };
    }

    // No permanent overflow: block on the EARLIEST day whose running bucket + subtotal exceeds
    // the cap. This is the retryable "budget reached" case — it frees up as held jobs finish.
    for (const [day, subtotal] of days) {
      const bucket = bucketFor(day);
      if (bucket + subtotal > cap)
        return {
          accept: false,
          kind: 'budget_reached',
          reason: `daily word cap reached for ${day} (${bucket}+${subtotal} > ${cap})`,
          capExhaustedDay: day,
        };
    }
  }
  return { accept: true, subtotalsByDay };
}
