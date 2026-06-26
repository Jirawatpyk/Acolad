/**
 * The TEAM'S observed holidays (standard Thai นักขัตฤกษ์). Cabinet special /
 * substitution days (วันหยุดพิเศษ/ชดเชย ครม.) are intentionally EXCLUDED — the team
 * works them. Weekends are handled by ACCEPT_WORKDAYS, not here.
 * Curate the next year before December (an uncurated year pauses auto-accept, C3).
 */
export const CURATED_YEARS: Set<number> = new Set([2026, 2027]);

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
  '2027': {
    '2027-01-01': "New Year's Day",
    // … team to curate the full 2027 list before December 2026 (placeholder year marker).
    '2027-04-13': 'Songkran Festival',
    '2027-04-14': 'Songkran Festival',
    '2027-04-15': 'Songkran Festival',
    '2027-12-31': "New Year's Eve",
  },
};
