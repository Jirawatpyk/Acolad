/** Parse a strict `HH:MM` (24 h) string to minutes since midnight (0–1439). Throws on
 *  any malformed input so the config schema fails fast at startup. */
export function parseHHMM(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) throw new Error(`invalid HH:MM time: '${s}'`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Parse a workday spec (`1-5`, `1,3,5`, ISO weekday 1=Mon..7=Sun) into a day-of-week
 *  Set. Throws on an out-of-range token, a backwards range, or an empty result. */
export function parseWorkdays(s: string): Set<number> {
  const out = new Set<number>();
  for (const part of s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const range = /^([1-7])-([1-7])$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b) throw new Error(`invalid workday range: '${part}'`);
      for (let d = a; d <= b; d++) out.add(d);
    } else if (/^[1-7]$/.test(part)) {
      out.add(Number(part));
    } else {
      throw new Error(`invalid workday token: '${part}'`);
    }
  }
  if (out.size === 0) throw new Error(`ACCEPT_WORKDAYS parsed to an empty set: '${s}'`);
  return out;
}

/**
 * Resolve the words-per-hour throughput used by the feasibility check. An explicit
 * value wins; otherwise it is DERIVED as `maxWordsPerDay / workingHoursPerDay`, so
 * `hoursStart`/`hoursEnd` are required for the derived path — narrowing the daily
 * window rescales (raises) the implied throughput.
 *
 * Guard: when `hoursEndMin <= hoursStartMin` (allowed while the schedule gate is
 * DISABLED — the start<end refine is gated on ENABLED so the kill-switch always works)
 * the divisor is 0, which would yield Infinity/NaN. Return 0 instead so a disabled
 * misconfiguration can never poison the config with a non-finite throughput. When the
 * gate is ENABLED the start<end refine still guarantees workingHoursPerDay>0, so the
 * real throughput is unaffected.
 */
export function resolveThroughput(o: {
  explicit?: number;
  maxWordsPerDay: number;
  hoursStartMin: number;
  hoursEndMin: number;
}): number {
  if (o.explicit !== undefined) return o.explicit;
  const workingHoursPerDay = (o.hoursEndMin - o.hoursStartMin) / 60;
  return workingHoursPerDay > 0 ? o.maxWordsPerDay / workingHoursPerDay : 0;
}
