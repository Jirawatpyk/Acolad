/**
 * The TEAM'S observed holidays (standard Thai นักขัตฤกษ์). Cabinet special /
 * substitution days (วันหยุดพิเศษ/ชดเชย ครม.) are intentionally EXCLUDED — the team
 * works them. Weekends are handled by ACCEPT_WORKDAYS, not here.
 * Curate the next year before December (an uncurated year pauses auto-accept, C3).
 */
export const CURATED_YEARS: Set<number> = new Set([2026]);

export const HOLIDAYS: Record<string, Record<string, string>> = {
  '2026': {
    '2026-01-01': "New Year's Day",
    '2026-03-03': 'Makha Bucha Day',
    '2026-04-06': 'Chakri Memorial Day',
    '2026-04-13': 'Songkran Festival',
    '2026-04-14': 'Songkran Festival',
    '2026-04-15': 'Songkran Festival',
    '2026-05-01': 'National Labour Day',
    '2026-05-04': 'Coronation Day',
    '2026-06-01': "Queen Suthida's Birthday",
    '2026-06-03': "Queen Suthida's Birthday (observed date varies — team to confirm)",
    '2026-07-28': "King Vajiralongkorn's Birthday",
    '2026-07-29': 'Asarnha Bucha Day',
    '2026-07-30': 'Buddhist Lent Day',
    '2026-08-12': "Queen Mother's Birthday / Mother's Day",
    '2026-10-13': 'King Bhumibol Memorial Day',
    '2026-10-23': 'Chulalongkorn Day',
    '2026-12-05': "King Bhumibol's Birthday / Father's Day",
    '2026-12-10': 'Constitution Day',
    '2026-12-31': "New Year's Eve",
  },
  // 2027 to be added (both HOLIDAYS and CURATED_YEARS) by the team before it is
  // needed — curate with real นักขัตฤกษ์ dates before December 2026. Until then 2027
  // stays uncurated so any job with a 2027-deadline span fail-closes (per-job Reject).
  // The holiday_calendar_stale SYSTEM alert fires only when the CURRENT Bangkok year is
  // uncurated — not for a far deadline into an uncurated future year.
};
