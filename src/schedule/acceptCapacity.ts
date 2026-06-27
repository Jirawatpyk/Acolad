export interface CapacityMember {
  jobKey: string;
  words: number;
  deadlineDate: string;
}
export type GroupCapacityVerdict =
  | { accept: true; subtotalsByDay: Map<string, number> }
  | { accept: false; reason: string; capExhaustedDay?: string };

/** Decide a whole bulk group all-or-nothing, bucketed by deadline day. `bucketFor(d)` =
 *  words already due on day d (held + this cycle's optimistic advances). */
export function decideGroupCapacity(
  members: CapacityMember[],
  bucketFor: (deadlineDate: string) => number,
  cap: number,
): GroupCapacityVerdict {
  const subtotalsByDay = new Map<string, number>();
  for (const mem of members)
    subtotalsByDay.set(mem.deadlineDate, (subtotalsByDay.get(mem.deadlineDate) ?? 0) + mem.words);

  if (cap > 0) {
    for (const [day, subtotal] of subtotalsByDay) {
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
