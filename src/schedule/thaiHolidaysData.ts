/**
 * The TEAM'S observed holidays = standard Thai นักขัตฤกษ์ PLUS วันหยุดชดเชย (in-lieu
 * days when a holiday falls on a weekend — INCLUDED). Ad-hoc cabinet special holidays
 * (วันหยุดพิเศษ / long-weekend bridges) are EXCLUDED — the team works them. Weekends are
 * handled by ACCEPT_WORKDAYS, not here.
 * Curate the next year before December (an uncurated year pauses auto-accept, C3).
 */
export const CURATED_YEARS: ReadonlySet<number> = new Set([2026, 2027]);

export const HOLIDAYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '2026': {
    '2026-01-01': "New Year's Day",
    '2026-03-03': 'Makha Bucha Day',
    '2026-04-06': 'Chakri Memorial Day',
    '2026-04-13': 'Songkran Festival',
    '2026-04-14': 'Songkran Festival',
    '2026-04-15': 'Songkran Festival',
    '2026-05-01': 'National Labour Day',
    '2026-05-04': 'Coronation Day',
    '2026-05-31': 'Visakha Bucha Day',
    '2026-06-01': 'Visakha Bucha Day (in lieu)',
    '2026-06-03': "Queen Suthida's Birthday",
    '2026-07-28': "King Vajiralongkorn's Birthday",
    '2026-07-29': 'Asarnha Bucha Day',
    '2026-07-30': 'Buddhist Lent Day',
    '2026-08-12': "Queen Mother's Birthday / Mother's Day",
    '2026-10-13': 'King Bhumibol Memorial Day',
    '2026-10-23': 'Chulalongkorn Day',
    '2026-12-05': "King Bhumibol's Birthday / Father's Day",
    '2026-12-07': "King Bhumibol's Birthday / Father's Day (in lieu)",
    '2026-12-10': 'Constitution Day',
    '2026-12-31': "New Year's Eve",
  },
  // Fixed-date holidays + their in-lieu substitutions are deterministic. The LUNAR dates
  // (Makha 02-21, Visakha 05-20, Asarnha 07-18, Buddhist Lent 07-19) and their in-lieu
  // were researched/computed Jun 2026 — reconfirm against the official Royal Thai
  // Government Gazette 2027 holiday announcement when published.
  '2027': {
    '2027-01-01': "New Year's Day",
    '2027-02-21': 'Makha Bucha Day',
    '2027-02-22': 'Makha Bucha Day (in lieu)',
    '2027-04-06': 'Chakri Memorial Day',
    '2027-04-13': 'Songkran Festival',
    '2027-04-14': 'Songkran Festival',
    '2027-04-15': 'Songkran Festival',
    '2027-05-01': 'National Labour Day',
    '2027-05-03': 'National Labour Day (in lieu)',
    '2027-05-04': 'Coronation Day',
    '2027-05-20': 'Visakha Bucha Day',
    '2027-06-03': "Queen Suthida's Birthday",
    '2027-07-18': 'Asarnha Bucha Day',
    '2027-07-19': 'Buddhist Lent Day',
    '2027-07-20': 'Asarnha Bucha Day (in lieu)',
    '2027-07-28': "King Vajiralongkorn's Birthday",
    '2027-08-12': "Queen Mother's Birthday / Mother's Day",
    '2027-10-13': 'King Bhumibol Memorial Day',
    '2027-10-23': 'Chulalongkorn Day',
    '2027-10-25': 'Chulalongkorn Day (in lieu)',
    '2027-12-05': "King Bhumibol's Birthday / Father's Day",
    '2027-12-06': "King Bhumibol's Birthday / Father's Day (in lieu)",
    '2027-12-10': 'Constitution Day',
    '2027-12-31': "New Year's Eve",
  },
};
