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
import { deadlineMsOf, deadlineDayOf } from '../schedule/deadlineDay.js';
import { isNonWorkingDay } from '../schedule/workingHours.js';
import type { XtmJobState } from '../detection/types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
 * - "Due today" headline: words whose EFFECTIVE deadline day (the working day the work
 *   lands on — see `effectiveDay`) is today, so the headline matches the capacity cap.
 *   Includes a job due tomorrow-early-morning (before the 09:00 work-start), whose work
 *   is really today's. Day-bucket, not instant — covers night-accepted jobs due today.
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
 * @param effectiveDay   Maps a dueDate → the Bangkok working day its work lands on (or null
 *                       for null/unparseable). The loop passes the effective-deadline-day mapper
 *                       so "Due today" matches the cap; the default is the raw deadline date
 *                       (`deadlineDayOf`) so the report stays usable standalone (byte-for-byte
 *                       legacy bucketing for callers without a work calendar).
 * @param capEnforced    Whether the per-deadline cap is actually enforced — i.e. the schedule gate
 *                       is ON (`ACCEPT_SCHEDULE_ENABLED=1`). Defaults to true. When false the
 *                       headline must NOT advertise "cap N/day" (accept runs 24/7 with no cap when
 *                       the gate is off; claiming an enforced limit would mislead). The effective-
 *                       day "Due today" workload view is still valid and is shown either way.
 */
export function buildDailyReportCard(
  held: XtmJobState[],
  nowMs: number,
  xtmUrl: string,
  maxWordsPerDay: number,
  effectiveDay: (dueDate: string | null) => string | null = deadlineDayOf,
  capEnforced = true,
): { cardsV2: unknown[] } {
  const today = bangkokDateString(nowMs);

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
    // Bucket by the EFFECTIVE day (the work-day the work lands on) so the headline matches the
    // capacity cap — a before-09:00 deadline tomorrow is today's work; an after-09:00 one is not.
    if (effectiveDay(j.dueDate) === today) dueTodayWords += j.words ?? 0;
  }

  // Advertise the enforced cap ONLY when the gate is on AND a positive cap is configured.
  // Gate off (capEnforced=false) → accept is 24/7 with no cap, so "(no cap)" is the honest text;
  // cap=0 also means no cap. Either way, never claim a limit that isn't enforced.
  const usage =
    capEnforced && maxWordsPerDay > 0
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
  // Explicit empty-state row so operators can tell "nothing in progress" apart from a broken /
  // truncated card (the old card carried this; the held-derived rewrite had dropped it).
  if (held.length === 0) rows.push({ label: '—', value: 'No jobs in progress' });
  const more = sorted.length - top.length;
  if (more > 0) rows.push({ label: '—', value: `(+${more} more)` });

  // Header date: `today` is already a Bangkok 'YYYY-MM-DD' (from bangkokDateString), so reverse its
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
