import { bangkokYear } from './bangkokCalendar.js';
import { CURATED_YEARS, HOLIDAYS } from './thaiHolidaysData.js';

export function getThaiHolidays(year: number): { holidays: Map<string, string>; curated: boolean } {
  const data = HOLIDAYS[String(year)] ?? {};
  return { holidays: new Map(Object.entries(data)), curated: CURATED_YEARS.has(year) };
}

/** Merge the holidays for every Bangkok year the now→deadline span touches. */
export function resolveHolidaysForSpan(
  nowMs: number,
  dueAtMs: number | null,
): { holidays: Map<string, string>; curated: boolean } {
  const years = new Set<number>([bangkokYear(nowMs)]);
  if (dueAtMs !== null && Number.isFinite(dueAtMs)) years.add(bangkokYear(dueAtMs));
  const holidays = new Map<string, string>();
  let curated = true;
  for (const y of years) {
    const r = getThaiHolidays(y);
    for (const [d, name] of r.holidays) holidays.set(d, name);
    if (!r.curated) curated = false;
  }
  return { holidays, curated };
}
