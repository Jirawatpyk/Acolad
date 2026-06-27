import { bangkokYear } from './bangkokCalendar.js';
import { CURATED_YEARS, HOLIDAYS } from './thaiHolidaysData.js';

export interface ThaiHolidayLookup {
  /** Bangkok `YYYY-MM-DD` → holiday name. ReadonlyMap so a caller mutating the returned
   *  map can never poison the memoized per-year cache (`resolveHolidaysForSpan` still
   *  builds and returns a fresh mutable Map, which is assignable to ReadonlyMap). */
  holidays: ReadonlyMap<string, string>;
  curated: boolean;
}

// Memoize the per-year lookup (F12): the source data is static and the gate calls
// this every cycle for the now/deadline years. Callers only READ the returned map
// (resolveHolidaysForSpan copies entries into a fresh map; the cycle reads `.curated`),
// so sharing the cached instance is safe.
const lookupCache = new Map<number, ThaiHolidayLookup>();

export function getThaiHolidays(year: number): ThaiHolidayLookup {
  const cached = lookupCache.get(year);
  if (cached) return cached;
  const data = HOLIDAYS[String(year)] ?? {};
  const result: ThaiHolidayLookup = {
    holidays: new Map(Object.entries(data)),
    curated: CURATED_YEARS.has(year),
  };
  lookupCache.set(year, result);
  return result;
}

/** Merge the holidays for every Bangkok year the now→deadline span touches —
 *  INCLUSIVE of intermediate years (F4): a span longer than a year (e.g. now Dec
 *  2026 → deadline Feb 2028) must merge 2027's holidays and fail-close if 2027 is
 *  uncurated, not just look at the two endpoint years. */
export function resolveHolidaysForSpan(nowMs: number, dueAtMs: number | null): ThaiHolidayLookup {
  const y0 = bangkokYear(nowMs);
  const y1 = dueAtMs !== null && Number.isFinite(dueAtMs) ? bangkokYear(dueAtMs) : y0;
  const holidays = new Map<string, string>();
  let curated = true;
  // Bound the iteration: the 400-day feasibility cap (workingMinutesBetween) means dates
  // beyond ~1 year out are never counted anyway, so a garbage far-future deadline (e.g.
  // year 9999) must not loop thousands of times. yLo..yLo+2 covers every legitimate span
  // and still fail-closes (an uncurated intermediate year flips curated=false).
  const yLo = Math.min(y0, y1);
  const yHi = Math.min(Math.max(y0, y1), yLo + 2);
  for (let y = yLo; y <= yHi; y++) {
    const r = getThaiHolidays(y);
    for (const [d, name] of r.holidays) holidays.set(d, name);
    if (!r.curated) curated = false;
  }
  return { holidays, curated };
}
