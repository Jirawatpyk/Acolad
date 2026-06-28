export interface CapacityMember {
  jobKey: string;
  words: number;
  deadlineDate: string;
}
export type GroupCapacityVerdict =
  | { accept: true; subtotalsByDay: Map<string, number> }
  | { accept: false; reason: string; capExhaustedDay?: string };

/** Decide a whole bulk group all-or-nothing, bucketed by deadline day. `bucketFor(d)` =
 *  words already due on day d (held + this cycle's optimistic advances).
 *  PRECONDITION: `bucketFor` returns a NON-NEGATIVE count (a negative bucket would
 *  understate per-day load and let an over-cap group slip through). */
export function decideGroupCapacity(
  members: CapacityMember[],
  bucketFor: (deadlineDate: string) => number,
  cap: number,
): GroupCapacityVerdict {
  const subtotalsByDay = new Map<string, number>();
  for (const mem of members)
    subtotalsByDay.set(mem.deadlineDate, (subtotalsByDay.get(mem.deadlineDate) ?? 0) + mem.words);

  if (cap > 0) {
    // Check days in ascending deadline-date order so the blocked reason / capExhaustedDay
    // names the EARLIEST overflowing day (spec: "in deadline order"). The accept/reject
    // OUTCOME is order-independent — only which day is named when multiple days overflow.
    for (const [day, subtotal] of [...subtotalsByDay.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const bucket = bucketFor(day);
      if (bucket + subtotal > cap) {
        if (subtotal > cap)
          return {
            accept: false,
            reason: `group words due ${day} (${subtotal}) exceed the daily cap (${cap}) — accept manually`,
          };
        return {
          accept: false,
          reason: `daily word cap reached for ${day} (${bucket}+${subtotal} > ${cap})`,
          capExhaustedDay: day,
        };
      }
    }
  }
  return { accept: true, subtotalsByDay };
}
