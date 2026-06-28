/**
 * Daily 09:00 Bangkok "Daily Report" helpers.
 *
 * TZ-IMPORTANT: The bot has no process timezone set. All Bangkok math is done
 * by adding 7 h to the epoch milliseconds then reading UTC parts — NEVER
 * getHours()/toLocaleString()/process.env.TZ.
 */

import { buildCard, type CardRow } from './chatCard.js';
import { formatReadableDate } from './dateFormat.js';
import { dash } from './cardText.js';
import { bangkokCalendar, bangkokDateString } from '../schedule/bangkokCalendar.js';
import { deadlineMsOf } from '../schedule/deadlineDay.js';
import { isNonWorkingDay } from '../schedule/workingHours.js';
import type { XtmJobState } from '../detection/types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the Bangkok calendar date as 'YYYY-MM-DD' for the given epoch ms.
 * Thin delegate to the canonical `bangkokDateString` so every Bangkok-date read keys off
 * one function. (It once also fed the meta word-counter, which was removed in PR #15.)
 */
export function bangkokDate(nowMs: number): string {
  return bangkokDateString(nowMs);
}

/**
 * Returns true when the daily report is due: today is a working day (not a weekend
 * or Thai holiday), Bangkok time has reached `hour` (default 9 = 09:00), and
 * today's Bangkok date has not already been sent.
 *
 * Fail-open on uncurated years: an empty `holidays` map means the year's data is
 * not yet curated — only weekends are skipped; the report still fires on weekdays.
 * A missed report is worse than an extra one.
 *
 * @param nowMs        Current epoch ms (from injected Clock).
 * @param lastSentDate The value stored in meta, or null if never sent.
 * @param workdays     ISO weekdays that count as working days (1=Mon..7=Sun).
 * @param holidays     Bangkok YYYY-MM-DD → holiday name (empty = uncurated, fail-open).
 * @param hour         Bangkok hour threshold (default 9 = 09:00).
 */
export function dueDailyReport(
  nowMs: number,
  lastSentDate: string | null,
  workdays: ReadonlySet<number>,
  holidays: ReadonlyMap<string, string>,
  hour = 9,
): boolean {
  const { date, weekday, minutesOfDay } = bangkokCalendar(nowMs);
  if (isNonWorkingDay(date, weekday, workdays, holidays)) return false;
  return minutesOfDay >= hour * 60 && date !== lastSentDate;
}

/**
 * Builds the Google Chat cardsV2 payload for the daily in-progress jobs report.
 *
 * Layout:
 * - "Due today" headline: words whose Bangkok deadline date is today (day-bucket,
 *   not instant) — includes night-accepted jobs due today even if already past NOW.
 * - "⚠️ Overdue" row (instant-based): present only when at least one held job's
 *   deadline ms is strictly before nowMs.
 * - Up to 5 job rows, sorted by deadline asc (null/unparseable → last).
 * - "(+N more)" marker when N > 0.
 *
 * TOTAL function — never throws for any held input (null/unparseable dueDate,
 * null words, empty list).
 *
 * @param held           Jobs currently in lifecycle_status='accepted'.
 * @param nowMs          Current epoch ms (for the date header / card ID / overdue).
 * @param xtmUrl         Deep-link to XTM Active task list.
 * @param maxWordsPerDay Daily word cap from config (0 = no cap).
 */
export function buildDailyReportCard(
  held: XtmJobState[],
  nowMs: number,
  xtmUrl: string,
  maxWordsPerDay: number,
): { cardsV2: unknown[] } {
  const today = bangkokDate(nowMs);

  // Returns the deadline as epoch ms, or +Infinity for null/unparseable (sorts last).
  // Canonical parse (F8) — same one the capacity gate + store bucket use.
  const dueMs = (j: XtmJobState): number => deadlineMsOf(j.dueDate) ?? Number.POSITIVE_INFINITY;

  // Pass 1: compute "Due today" word bucket and collect overdue jobs.
  // Only jobs with a parseable finite deadline contribute to either metric.
  let dueTodayWords = 0;
  const overdue: XtmJobState[] = [];
  for (const j of held) {
    const ms = dueMs(j);
    if (!Number.isFinite(ms)) continue;
    if (ms < nowMs) overdue.push(j);
    if (bangkokDate(ms) === today) dueTodayWords += j.words ?? 0; // day-bucket (not instant)
  }

  const usage =
    maxWordsPerDay > 0
      ? `${dueTodayWords} words (cap ${maxWordsPerDay}/day per deadline)`
      : `${dueTodayWords} words (no cap)`;

  const rows: CardRow[] = [{ label: 'Due today', value: usage }];

  if (overdue.length > 0) {
    const w = overdue.reduce((a, j) => a + (j.words ?? 0), 0);
    rows.push({ emoji: '⚠️', label: 'Overdue', value: `${overdue.length} job(s) · ${w} words` });
  }

  // Pass 2: top-5 job rows, sorted by deadline asc (tie-break by jobKey).
  const sorted = [...held].sort((a, b) => dueMs(a) - dueMs(b) || a.jobKey.localeCompare(b.jobKey));
  const top = sorted.slice(0, 5);
  const overdueSet = new Set(overdue.map((j) => j.jobKey));
  for (const j of top) {
    const label = dash(j.projectName);
    const value = `${formatReadableDate(j.dueDate ?? j.dueRaw ?? null) || '—'} · ${dash(j.fileName)} · ${j.words != null ? `${j.words}w` : '—'}`;
    // Use a ternary rather than `emoji: undefined` — exactOptionalPropertyTypes forbids the latter.
    rows.push(overdueSet.has(j.jobKey) ? { emoji: '⚠️', label, value } : { label, value });
  }
  const more = sorted.length - top.length;
  if (more > 0) rows.push({ label: '—', value: `(+${more} more)` });

  // Header date: `today` is already a Bangkok 'YYYY-MM-DD' (from bangkokDate), so reverse its
  // parts to 'DD/MM/YYYY' — no parse round-trip / slice fragility.
  const headerDate = today.split('-').reverse().join('/');

  return buildCard({
    cardId: `daily-${today}`,
    headerTitle: `📋 Daily Report — ${headerDate}`,
    rows,
    buttonUrl: xtmUrl,
    buttonText: 'Open in XTM',
  });
}
