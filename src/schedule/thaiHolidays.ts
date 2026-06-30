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

/** Holidays merged across `[Y-1 .. Y+2]` (Bangkok years) — the full span the effective-deadline-day
 *  mapper can touch, kept in lock-step with what FEASIBILITY resolves (`resolveHolidaysForSpan`
 *  bounds a now→deadline span to `yLo..yLo+2`, i.e. up to `Y+2` for the ~400-day feasibility cap).
 *  Both ends matter:
 *   - **Y-1 (back-walk guard):** the effective-day walk moves BACKWARD — an early-January
 *     before-09:00 deadline (evaluated when now is already in year Y) walks into Dec 31 of Y-1
 *     (New Year's Eve, a curated holiday). Without Y-1 loaded it reads as a working day → bucket
 *     under-counts → over-accept (the irreversible direction).
 *   - **Y+2 (far-deadline guard):** near year-end, a held job's deadline + 400-day reach can land
 *     in Y+2. With only `[Y-1..Y+1]` the mapper would read a Y+2 holiday as a working day → the
 *     same under-count → over-accept, while feasibility (which spans to Y+2) had already vetted it.
 *     Merging to Y+2 keeps the two from diverging.
 *  An uncurated year just merges an empty map (safe). Built fresh (a mutable Map assignable to
 *  ReadonlyMap) so callers can iterate/merge it freely without poisoning the per-year cache. Used
 *  by the effective-deadline-day mapper in the cycle (capacity) and the daily report so both
 *  bucket against the same curated calendar that feasibility uses. */
export function holidaysForEffectiveDay(nowMs: number): ReadonlyMap<string, string> {
  const y = bangkokYear(nowMs);
  const out = new Map<string, string>();
  // [Y-1 .. Y+2] inclusive — matches resolveHolidaysForSpan's yLo+2 reach plus the Y-1 back-walk.
  for (let yr = y - 1; yr <= y + 2; yr++) {
    for (const [d, name] of getThaiHolidays(yr).holidays) out.set(d, name);
  }
  return out;
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
